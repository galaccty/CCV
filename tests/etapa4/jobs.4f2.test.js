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
import { registrarMovimiento } from '../../src/services/ledger.js';
import { autoEntregar } from '../../src/jobs/autoEntregar.js';
import { expirarPagos } from '../../src/jobs/expirarPagos.js';
import { bloquearLocalesVencidos } from '../../src/jobs/bloquearLocalesVencidos.js';
import { CLAVES_JOBS, ejecutarJob } from '../../src/jobs/ejecutarJob.js';

/**
 * JOBS DE LA ETAPA 4F-2
 * =====================
 * Auto-entrega, expiracion digital y bloqueo diario. Todas las pruebas pasan
 * ids concretos a los jobs para no procesar datos de otros archivos que corren
 * en paralelo contra la misma base.
 */

const CON_BASE = await opcionesConBase();
const UN_DIA = 24 * 60 * 60 * 1000;

after(async () => {
  await cerrarConexion();
});

async function crearSubEnviado({
  metodoPago = 'efectivo',
  diasDesdeEnvio = 10,
  comision = 2000n,
  precio = 10000n,
  cantidad = 1,
} = {}) {
  const { local, variante } = await crearCatalogo({ precio, stockInicial: 10 });
  const { pedido, subPedido, detalle } = await crearPedidoDePrueba({
    local,
    variante,
    cantidad,
    comision,
    metodoPago,
    estadoPedido: 'en_proceso',
    estadoSubPedido: 'enviado',
  });

  await prisma.historialEstadoSubPedido.create({
    data: {
      subPedidoId: subPedido.id,
      estadoAnterior: 'preparando',
      estadoNuevo: 'enviado',
      cambiadoPor: null,
      fecha: new Date(Date.now() - diasDesdeEnvio * UN_DIA),
    },
  });

  const pago = await crearPagoDePrueba({
    pedido,
    metodoPago,
    estado: metodoPago === 'efectivo' ? 'pendiente' : 'aprobado',
  });

  return { local, variante, pedido, subPedido, detalle, pago };
}

describe('job auto_entrega', () => {
  test('entrega en efectivo y genera la comision una sola vez', CON_BASE, async () => {
    const escenario = await crearSubEnviado({
      metodoPago: 'efectivo',
      comision: 2000n,
      precio: 10000n,
    });
    const ahora = new Date();

    const primero = await autoEntregar({
      ahora,
      subPedidoIds: [escenario.subPedido.id],
    });
    assert.equal(primero.entregados, 1);
    assert.equal(primero.errores, 0);

    const sub = await prisma.subPedido.findUnique({
      where: { id: escenario.subPedido.id },
    });
    assert.equal(sub.estado, 'entregado');
    assert.equal(sub.entregaConfirmadaPor, 'sistema');
    assert.ok(sub.fechaEntrega);

    const pagos = await prisma.pago.findMany({
      where: { pedidoId: escenario.pedido.id },
    });
    assert.equal(pagos.length, 1);
    assert.equal(pagos[0].estado, 'aprobado');

    const comisiones = await prisma.ledger.findMany({
      where: { subPedidoId: escenario.subPedido.id, tipo: 'comision' },
    });
    assert.equal(comisiones.length, 1);
    assert.equal(comisiones[0].monto, 2000n);
    assert.equal(comisiones[0].localId, escenario.local.id);

    const cuenta = await prisma.cuentaLocal.findUnique({
      where: { localId: escenario.local.id },
    });
    assert.equal(cuenta.saldoDeuda, 2000n);

    const segundo = await autoEntregar({
      ahora,
      subPedidoIds: [escenario.subPedido.id],
    });
    assert.equal(segundo.entregados, 0);
    assert.equal(
      await prisma.ledger.count({
        where: { subPedidoId: escenario.subPedido.id, tipo: 'comision' },
      }),
      1,
    );
  });

  test('dos instancias simultaneas respetan el candado del job', CON_BASE, async () => {
    const escenario = await crearSubEnviado({ metodoPago: 'efectivo' });
    const ahora = new Date();

    let marcarEmpezado;
    const empezo = new Promise((resolve) => {
      marcarEmpezado = resolve;
    });
    let liberar;
    const espera = new Promise((resolve) => {
      liberar = resolve;
    });

    const primera = ejecutarJob({
      nombre: 'auto_entrega',
      clave: CLAVES_JOBS.auto_entrega,
      ejecutar: async () => {
        marcarEmpezado();
        await espera;
        return autoEntregar({
          ahora,
          subPedidoIds: [escenario.subPedido.id],
        });
      },
    });

    await empezo;

    const segunda = await ejecutarJob({
      nombre: 'auto_entrega',
      clave: CLAVES_JOBS.auto_entrega,
      ejecutar: () =>
        autoEntregar({ ahora, subPedidoIds: [escenario.subPedido.id] }),
    });
    assert.deepEqual(segunda, { ejecutado: false, motivo: 'ocupado' });

    liberar();
    const resultado = await primera;
    assert.equal(resultado.ejecutado, true);
    assert.equal(resultado.resultado.entregados, 1);

    assert.equal(
      await prisma.ledger.count({
        where: { subPedidoId: escenario.subPedido.id, tipo: 'comision' },
      }),
      1,
    );
  });
});

describe('job expirar_pagos', () => {
  test('expira el pago y cancela el pedido una sola vez', CON_BASE, async () => {
    const { local, variante } = await crearCatalogo({
      precio: 10000n,
      stockInicial: 5,
    });
    const { pedido, subPedido } = await crearPedidoDePrueba({
      local,
      variante,
      metodoPago: 'tarjeta',
      estadoPedido: 'pendiente_pago',
      estadoSubPedido: 'por_aceptar',
    });
    const pago = await crearPagoDePrueba({
      pedido,
      metodoPago: 'tarjeta',
      estado: 'pendiente',
    });

    const ahora = new Date(Date.now() + 31 * 60 * 1000);
    const primero = await expirarPagos({ ahora, pagoIds: [pago.id] });
    assert.equal(primero.expirados, 1);

    const pagoDb = await prisma.pago.findUnique({ where: { id: pago.id } });
    assert.equal(pagoDb.estado, 'expirado');

    const pedidoDb = await prisma.pedido.findUnique({
      where: { id: pedido.id },
    });
    assert.equal(pedidoDb.estado, 'cancelado');

    const subDb = await prisma.subPedido.findUnique({
      where: { id: subPedido.id },
    });
    assert.equal(subDb.estado, 'cancelado');

    const segundo = await expirarPagos({ ahora, pagoIds: [pago.id] });
    assert.equal(segundo.expirados, 0);
    assert.equal(
      await prisma.auditoriaAdmin.count({
        where: { accion: 'expirar_pago', objetoId: String(pago.id) },
      }),
      1,
    );
  });
});

describe('job bloqueo_deuda', () => {
  test('bloquea un local con fecha vencida y es idempotente', CON_BASE, async () => {
    const { local } = await crearCatalogo({ precio: 10000n });
    const ahora = new Date();

    await withTransaccion((tx) =>
      registrarMovimiento({
        tipo: 'comision',
        monto: 60000n,
        localId: local.id,
      }),
    );

    await prisma.cuentaLocal.update({
      where: { localId: local.id },
      data: { fechaLimitePago: new Date(Date.UTC(2020, 0, 1)) },
    });

    const primero = await bloquearLocalesVencidos({
      ahora,
      localIds: [local.id],
    });
    assert.equal(primero.bloqueados, 1);

    const localDb = await prisma.local.findUnique({ where: { id: local.id } });
    assert.equal(localDb.estado, 'bloqueado');

    const segundo = await bloquearLocalesVencidos({
      ahora,
      localIds: [local.id],
    });
    assert.equal(segundo.bloqueados, 0);
    assert.equal(
      await prisma.auditoriaAdmin.count({
        where: {
          accion: 'bloquear_local_por_deuda',
          objetoId: String(local.id),
        },
      }),
      1,
    );
  });

  test('no bloquea un local que acaba de pagar', CON_BASE, async () => {
    const { local } = await crearCatalogo({ precio: 10000n });
    const ahora = new Date();

    await withTransaccion(async (tx) => {
      await registrarMovimiento({
        tipo: 'comision',
        monto: 1000n,
        localId: local.id,
      });
      await registrarMovimiento({
        tipo: 'cobro_deuda',
        monto: 1000n,
        localId: local.id,
      });
    });

    // El pago dejo la deuda en cero, pero no recalculo el estado: la fecha
    // vieja sigue alli hasta que el job llame a recalcularEstadoLocal().
    await prisma.cuentaLocal.update({
      where: { localId: local.id },
      data: { fechaLimitePago: new Date(Date.UTC(2020, 0, 1)) },
    });

    const resultado = await bloquearLocalesVencidos({
      ahora,
      localIds: [local.id],
    });
    assert.equal(resultado.revisados, 1);
    assert.equal(resultado.bloqueados, 0);

    const localDb = await prisma.local.findUnique({ where: { id: local.id } });
    const cuentaDb = await prisma.cuentaLocal.findUnique({
      where: { localId: local.id },
    });
    assert.equal(localDb.estado, 'activo');
    assert.equal(cuentaDb.fechaLimitePago, null);
  });
});
