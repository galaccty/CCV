import '../helpers/entorno.js';
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { opcionesConBase, prisma, cerrarConexion } from '../helpers/base.js';
import {
  crearCatalogo,
  crearPagoDePrueba,
  crearPedidoDePrueba,
} from '../helpers/datos.js';
import { withTransaccion } from '../../src/lib/transaccion.js';
import {
  dividirRedondeando,
  multiplicar,
  porcentajeABasisPuntos,
} from '../../src/lib/dinero.js';
import { registrarMovimiento } from '../../src/services/ledger.js';
import { calcularMontoLiberacion } from '../../src/services/liberacion.js';
import {
  completarReembolso,
  crearReembolso,
} from '../../src/services/reembolsos.js';

const CON_BASE = await opcionesConBase();

after(async () => {
  await cerrarConexion();
});

async function asentar(datos) {
  return withTransaccion(() => registrarMovimiento(datos));
}

async function crearEscenario({
  cantidad,
  precio,
  comision,
  metodoPago = 'tarjeta',
  liberar = false,
}) {
  const { local, variante } = await crearCatalogo({ precio });
  const pedido = await crearPedidoDePrueba({
    local,
    variante,
    cantidad,
    comision,
    metodoPago,
    estadoPedido: 'en_proceso',
    estadoSubPedido: 'entregado',
  });
  const pago = await crearPagoDePrueba({
    pedido: pedido.pedido,
    metodoPago,
    estado: 'aprobado',
  });

  if (comision > 0n) {
    await asentar({
      tipo: 'comision',
      monto: comision,
      subPedidoId: pedido.subPedido.id,
      pagoId: pago.id,
      localId: metodoPago === 'efectivo' ? local.id : null,
    });
  }

  if (liberar) {
    await asentar({
      tipo: 'liberacion',
      monto: calcularMontoLiberacion(pedido.subPedido),
      localId: local.id,
      subPedidoId: pedido.subPedido.id,
    });
    await prisma.subPedido.update({
      where: { id: pedido.subPedido.id },
      data: { saldoLiberadoEn: new Date() },
    });
  }

  return { ...pedido, local, pago };
}

async function reembolsar(escenario, cantidad) {
  const reembolso = await crearReembolso({
    subPedidoId: escenario.subPedido.id,
    datos: {
      motivo: 'Conciliacion de comision',
      lineas: [{ detalle_id: escenario.detalle.id, cantidad }],
    },
  });
  await completarReembolso({ reembolsoId: reembolso.id });
  return reembolso;
}

async function comisionObjetivo(subPedidoId) {
  const sub = await prisma.subPedido.findUnique({
    where: { id: subPedidoId },
    include: { pedido: { select: { configSnapshot: true } } },
  });
  const lineas = await prisma.reembolsoLinea.aggregate({
    where: {
      reembolso: { subPedidoId, estado: 'completado' },
    },
    _sum: { monto: true },
  });

  const restante = sub.subtotalProductos - (lineas._sum.monto ?? 0n);
  if (restante <= 0n) return 0n;

  const config = sub.pedido.configSnapshot ?? {};
  const porcentaje = config.porcentaje_comision ?? 0;
  const minima = BigInt(config.comision_minima ?? 0);
  const proporcional = dividirRedondeando(
    multiplicar(restante, BigInt(porcentajeABasisPuntos(porcentaje))),
    10000n,
  );
  return proporcional > minima ? proporcional : minima;
}

async function ingresoNetoComision(subPedidoId) {
  const [comisiones, reversas] = await Promise.all([
    prisma.ledger.aggregate({
      where: { subPedidoId, localId: null, tipo: 'comision' },
      _sum: { monto: true },
    }),
    prisma.ledger.aggregate({
      where: { subPedidoId, localId: null, tipo: 'reversa_comision' },
      _sum: { monto: true },
    }),
  ]);
  return (comisiones._sum.monto ?? 0n) - (reversas._sum.monto ?? 0n);
}

async function conciliarDigital(escenario) {
  const objetivo = await comisionObjetivo(escenario.subPedido.id);
  const neto = await ingresoNetoComision(escenario.subPedido.id);
  assert.equal(neto, objetivo, 'el ingreso neto de comision debe ser el objetivo');
  await conciliarCuenta(escenario.local.id);
}

async function conciliarCuenta(localId) {
  const movimientos = await prisma.ledger.findMany({
    where: { localId },
    orderBy: { id: 'asc' },
  });
  const comisionesEfectivo = new Set(
    movimientos
      .filter((movimiento) => movimiento.tipo === 'comision')
      .map((movimiento) => movimiento.subPedidoId),
  );

  const saldos = {
    saldoDeuda: 0n,
    saldoPorPagar: 0n,
    saldoCongelado: 0n,
  };
  const sumar = (campo, monto) => {
    saldos[campo] += monto;
  };

  for (const movimiento of movimientos) {
    const monto = movimiento.monto;
    switch (movimiento.tipo) {
      case 'comision':
        sumar('saldoDeuda', monto);
        break;
      case 'reversa_comision':
        if (comisionesEfectivo.has(movimiento.subPedidoId)) {
          sumar('saldoDeuda', -monto);
        } else {
          sumar('saldoPorPagar', monto);
        }
        break;
      case 'liberacion':
      case 'reversa_pago_a_local':
        sumar('saldoPorPagar', monto);
        break;
      case 'pago_a_local':
      case 'reembolso':
        sumar('saldoPorPagar', -monto);
        break;
      case 'deuda_reembolso':
      case 'reversa_cobro_deuda':
        sumar('saldoDeuda', monto);
        break;
      case 'cobro_deuda':
        sumar('saldoDeuda', -monto);
        break;
      case 'congelacion':
        sumar('saldoPorPagar', -monto);
        sumar('saldoCongelado', monto);
        break;
      case 'descongelacion':
        sumar('saldoCongelado', -monto);
        sumar('saldoPorPagar', monto);
        break;
      case 'venta':
      case 'pago_recibido':
      case 'ingreso_publicidad':
      case 'ajuste':
        break;
      default:
        throw new Error(
          `El escenario de conciliacion no cubre el movimiento ${movimiento.tipo}.`,
        );
    }
  }

  const cuenta = await prisma.cuentaLocal.findUnique({ where: { localId } });
  assert.ok(cuenta);
  assert.deepEqual(
    {
      saldoDeuda: cuenta.saldoDeuda,
      saldoPorPagar: cuenta.saldoPorPagar,
      saldoCongelado: cuenta.saldoCongelado,
    },
    saldos,
    'los saldos del local deben cuadrar con el ledger',
  );
}

describe('reembolsos - conciliacion de comision y saldos', () => {
  test('total antes de liberar revierte toda la comision de plataforma', CON_BASE, async () => {
    const escenario = await crearEscenario({
      cantidad: 1,
      precio: 10000n,
      comision: 2000n,
    });

    await reembolsar(escenario, 1);

    assert.equal(await comisionObjetivo(escenario.subPedido.id), 0n);
    assert.equal(await ingresoNetoComision(escenario.subPedido.id), 0n);
    await conciliarCuenta(escenario.local.id);
  });

  test('parcial y total despues de liberar concilian en cada paso', CON_BASE, async () => {
    const escenario = await crearEscenario({
      cantidad: 10,
      precio: 10000n,
      comision: 5000n,
      liberar: true,
    });

    await reembolsar(escenario, 5);
    await conciliarDigital(escenario);

    const parcial = await prisma.subPedido.findUnique({
      where: { id: escenario.subPedido.id },
    });
    assert.equal(parcial.estado, 'reembolsado_parcial');
    assert.equal(
      await ingresoNetoComision(escenario.subPedido.id),
      2500n,
      'la comision de la mitad no reembolsada sigue siendo ingreso',
    );

    await reembolsar(escenario, 5);
    await conciliarDigital(escenario);

    const total = await prisma.subPedido.findUnique({
      where: { id: escenario.subPedido.id },
    });
    assert.equal(total.estado, 'reembolsado');
    assert.equal(await ingresoNetoComision(escenario.subPedido.id), 0n);
  });

  test('en efectivo la reversa local reduce la deuda sin ingreso de plataforma', CON_BASE, async () => {
    const escenario = await crearEscenario({
      cantidad: 1,
      precio: 10000n,
      comision: 2000n,
      metodoPago: 'efectivo',
    });

    assert.equal((await prisma.cuentaLocal.findUnique({
      where: { localId: escenario.local.id },
    })).saldoDeuda, 2000n);

    await reembolsar(escenario, 1);

    assert.equal(await ingresoNetoComision(escenario.subPedido.id), 0n);
    await conciliarCuenta(escenario.local.id);
    const cuenta = await prisma.cuentaLocal.findUnique({
      where: { localId: escenario.local.id },
    });
    assert.equal(cuenta.saldoDeuda, 0n);
  });
});
