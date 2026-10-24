import '../helpers/entorno.js';
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { opcionesConBase, prisma, cerrarConexion } from '../helpers/base.js';
import {
  crearCatalogo,
  crearPagoDePrueba,
  crearPedidoDePrueba,
  crearUsuarioDirecto,
} from '../helpers/datos.js';
import { withTransaccion } from '../../src/lib/transaccion.js';
import { registrarMovimiento } from '../../src/services/ledger.js';
import {
  liberarSaldos,
  liberarSubPedido,
  subPedidosElegiblesParaLiberar,
} from '../../src/services/liberacion.js';
import {
  abrirDisputa,
  resolverDisputa,
} from '../../src/services/disputas.js';
import {
  completarReembolso,
  crearReembolso,
  fallarReembolso,
} from '../../src/services/reembolsos.js';

/**
 * JOB DE LIBERACION DE SALDO - ETAPA 4d
 * =====================================
 * Cubre el efecto real del job: retencion, reembolsos pendientes, disputas,
 * reembolsos parciales/totales, locales suspendidos y concurrencia.
 *
 * Como `node --test` corre archivos en paralelo contra la misma base, todas
 * las llamadas al job se restringen con `subPedidoIds` a los datos de esta
 * prueba.
 */

const CON_BASE = await opcionesConBase();
const UN_DIA = 24 * 60 * 60 * 1000;

after(async () => {
  await cerrarConexion();
});

async function crearEscenario({
  ahora = new Date(),
  cantidad = 1,
  precio = 10000n,
  comision = 2000n,
  costoEnvio = 0n,
  metodoPago = 'tarjeta',
  estadoSubPedido = 'entregado',
  fechaEntrega = new Date(ahora.getTime() - 6 * UN_DIA),
} = {}) {
  const { local, variante } = await crearCatalogo({ precio });
  const pedido = await crearPedidoDePrueba({
    local,
    variante,
    cantidad,
    comision,
    costoEnvio,
    metodoPago,
    estadoPedido: 'completado',
    estadoSubPedido,
  });

  await prisma.subPedido.update({
    where: { id: pedido.subPedido.id },
    data: { fechaEntrega },
  });

  const pago = await crearPagoDePrueba({
    pedido: pedido.pedido,
    metodoPago,
    estado: 'aprobado',
  });

  if (comision > 0n) {
    await withTransaccion(() =>
      registrarMovimiento({
        tipo: 'comision',
        monto: comision,
        subPedidoId: pedido.subPedido.id,
        pagoId: pago.id,
        localId: metodoPago === 'efectivo' ? local.id : null,
      }),
    );
  }

  return { ...pedido, local, pago };
}

async function reembolsar(escenario, cantidad) {
  const reembolso = await crearReembolso({
    subPedidoId: escenario.subPedido.id,
    datos: {
      motivo: 'Prueba de liberacion',
      lineas: [{ detalle_id: escenario.detalle.id, cantidad }],
    },
  });
  await completarReembolso({ reembolsoId: reembolso.id });
  return reembolso;
}

function movimientosDe(subPedidoId, localId = undefined) {
  return prisma.ledger.findMany({
    where: {
      subPedidoId,
      ...(localId === undefined ? {} : { localId }),
    },
    orderBy: { id: 'asc' },
  });
}

describe('job liberar_saldos - Etapa 4d', () => {
  test('libera una sola vez y el envio queda a favor del vendedor', CON_BASE, async () => {
    const ahora = new Date();
    const escenario = await crearEscenario({
      ahora,
      cantidad: 3,
      precio: 10000n,
      comision: 2000n,
      costoEnvio: 2000n,
    });

    const resultado = await liberarSaldos({
      ahora,
      subPedidoIds: [escenario.subPedido.id],
    });

    assert.equal(resultado.liberados, 1);
    assert.equal(resultado.errores, 0);

    const sub = await prisma.subPedido.findUnique({
      where: { id: escenario.subPedido.id },
    });
    assert.ok(sub.saldoLiberadoEn);

    const movimientos = await movimientosDe(
      escenario.subPedido.id,
      escenario.local.id,
    );
    assert.deepEqual(
      movimientos.map((movimiento) => [
        movimiento.tipo,
        movimiento.monto,
      ]),
      [['liberacion', 30000n]],
    );

    const cuenta = await prisma.cuentaLocal.findUnique({
      where: { localId: escenario.local.id },
    });
    assert.equal(cuenta.saldoPorPagar, 30000n);

    // La segunda corrida encuentra el sub-pedido ya cerrado.
    const repetido = await liberarSaldos({
      ahora,
      subPedidoIds: [escenario.subPedido.id],
    });
    assert.equal(repetido.revisados, 0);
    assert.equal(repetido.liberados, 0);
    assert.equal(
      await prisma.ledger.count({
        where: {
          subPedidoId: escenario.subPedido.id,
          tipo: 'liberacion',
        },
      }),
      1,
    );
  });

  test('un reembolso pendiente bloquea y uno fallido desbloquea', CON_BASE, async () => {
    const ahora = new Date();
    const escenario = await crearEscenario({ ahora });

    const pendiente = await crearReembolso({
      subPedidoId: escenario.subPedido.id,
      datos: {
        motivo: 'Reembolso que se va a fallar',
        lineas: [{ detalle_id: escenario.detalle.id, cantidad: 1 }],
      },
    });

    const bloqueado = await liberarSaldos({
      ahora,
      subPedidoIds: [escenario.subPedido.id],
    });
    assert.equal(bloqueado.revisados, 0);
    assert.equal(bloqueado.liberados, 0);

    const subBloqueado = await prisma.subPedido.findUnique({
      where: { id: escenario.subPedido.id },
    });
    assert.equal(subBloqueado.saldoLiberadoEn, null);

    await fallarReembolso({ reembolsoId: pendiente.id });

    const desbloqueado = await liberarSaldos({
      ahora,
      subPedidoIds: [escenario.subPedido.id],
    });
    assert.equal(desbloqueado.liberados, 1);

    const movimientos = await movimientosDe(
      escenario.subPedido.id,
      escenario.local.id,
    );
    assert.deepEqual(
      movimientos.map((movimiento) => [
        movimiento.tipo,
        movimiento.monto,
      ]),
      [['liberacion', 8000n]],
    );
  });

  test('una disputa abierta bloquea y al resolverla a favor del vendedor se libera', CON_BASE, async () => {
    const ahora = new Date();
    const escenario = await crearEscenario({ ahora });

    const disputa = await abrirDisputa({
      usuario: escenario.comprador,
      subPedidoId: escenario.subPedido.id,
      datos: {
        motivo: 'Producto en mal estado',
        lineas: [{ detalle_id: escenario.detalle.id, cantidad: 1 }],
      },
    });

    const bloqueado = await liberarSaldos({
      ahora,
      subPedidoIds: [escenario.subPedido.id],
    });
    assert.equal(bloqueado.liberados, 0);

    const sinMovimientos = await movimientosDe(
      escenario.subPedido.id,
      escenario.local.id,
    );
    assert.equal(sinMovimientos.length, 0);

    const admin = await crearUsuarioDirecto({
      nombre: 'Admin liberacion',
      roles: ['admin'],
    });
    await resolverDisputa({
      disputaId: disputa.id,
      admin,
      datos: {
        favor: 'vendedor',
        resolucion: 'La entrega esta documentada.',
      },
    });

    const liberado = await liberarSaldos({
      ahora,
      subPedidoIds: [escenario.subPedido.id],
    });
    assert.equal(liberado.liberados, 1);

    const movimientos = await movimientosDe(
      escenario.subPedido.id,
      escenario.local.id,
    );
    assert.deepEqual(
      movimientos.map((movimiento) => [
        movimiento.tipo,
        movimiento.monto,
      ]),
      [['liberacion', 8000n]],
    );
  });

  test('la base tambien rechaza liberar con una disputa abierta', CON_BASE, async () => {
    const ahora = new Date();
    const escenario = await crearEscenario({ ahora });

    await abrirDisputa({
      usuario: escenario.comprador,
      subPedidoId: escenario.subPedido.id,
      datos: {
        motivo: 'Disputa para probar el trigger',
        lineas: [{ detalle_id: escenario.detalle.id, cantidad: 1 }],
      },
    });

    await assert.rejects(
      () =>
        prisma.subPedido.update({
          where: { id: escenario.subPedido.id },
          data: { saldoLiberadoEn: new Date() },
        }),
      /disputa_abierta/i,
    );
  });

  test('un reembolso total previo cierra la ventana sin asientos locales', CON_BASE, async () => {
    const ahora = new Date();
    const escenario = await crearEscenario({
      ahora,
      cantidad: 1,
      precio: 10000n,
      comision: 2000n,
    });

    await reembolsar(escenario, 1);

    const subReembolsado = await prisma.subPedido.findUnique({
      where: { id: escenario.subPedido.id },
    });
    assert.equal(subReembolsado.estado, 'reembolsado');

    const resultado = await liberarSaldos({
      ahora,
      subPedidoIds: [escenario.subPedido.id],
    });
    assert.equal(resultado.liberados, 1);
    assert.equal(resultado.sinAsientos, 1);

    const subLiberado = await prisma.subPedido.findUnique({
      where: { id: escenario.subPedido.id },
    });
    assert.ok(subLiberado.saldoLiberadoEn);

    const movimientosLocal = await movimientosDe(
      escenario.subPedido.id,
      escenario.local.id,
    );
    assert.equal(movimientosLocal.length, 0);

    const cuenta = await prisma.cuentaLocal.findUnique({
      where: { localId: escenario.local.id },
    });
    assert.equal(cuenta.saldoPorPagar, 0n);
  });

  test('un reembolso total de productos previo libera solo el envio', CON_BASE, async () => {
    const ahora = new Date();
    const escenario = await crearEscenario({
      ahora,
      cantidad: 1,
      precio: 10000n,
      comision: 2000n,
      costoEnvio: 2000n,
    });

    await reembolsar(escenario, 1);

    const subReembolsado = await prisma.subPedido.findUnique({
      where: { id: escenario.subPedido.id },
    });
    assert.equal(subReembolsado.estado, 'reembolsado');

    const resultado = await liberarSaldos({
      ahora,
      subPedidoIds: [escenario.subPedido.id],
    });
    assert.equal(resultado.liberados, 1);

    const movimientos = await movimientosDe(
      escenario.subPedido.id,
      escenario.local.id,
    );
    assert.deepEqual(
      movimientos.map((movimiento) => [
        movimiento.tipo,
        movimiento.monto,
      ]),
      [
        ['liberacion', 10000n],
        ['reversa_comision', 2000n],
        ['reembolso', 10000n],
      ],
    );

    const cuenta = await prisma.cuentaLocal.findUnique({
      where: { localId: escenario.local.id },
    });
    assert.equal(cuenta.saldoPorPagar, 2000n);
  });

  test('se libera aunque el local este suspendido', CON_BASE, async () => {
    const ahora = new Date();
    const escenario = await crearEscenario({ ahora });

    await prisma.local.update({
      where: { id: escenario.local.id },
      data: { estado: 'suspendido' },
    });

    const resultado = await liberarSaldos({
      ahora,
      subPedidoIds: [escenario.subPedido.id],
    });
    assert.equal(resultado.liberados, 1);

    const cuenta = await prisma.cuentaLocal.findUnique({
      where: { localId: escenario.local.id },
    });
    assert.equal(cuenta.saldoPorPagar, 8000n);
  });

  test('el efectivo entregado no se libera: el vendedor ya cobro', CON_BASE, async () => {
    const ahora = new Date();
    const escenario = await crearEscenario({
      ahora,
      metodoPago: 'efectivo',
    });

    const elegibles = await subPedidosElegiblesParaLiberar({
      ahora,
      subPedidoIds: [escenario.subPedido.id],
    });
    assert.deepEqual(elegibles, []);

    const resultado = await liberarSaldos({
      ahora,
      subPedidoIds: [escenario.subPedido.id],
    });
    assert.equal(resultado.liberados, 0);

    const sub = await prisma.subPedido.findUnique({
      where: { id: escenario.subPedido.id },
    });
    assert.equal(sub.saldoLiberadoEn, null);

    const cuenta = await prisma.cuentaLocal.findUnique({
      where: { localId: escenario.local.id },
    });
    assert.equal(cuenta.saldoPorPagar, 0n);
    assert.equal(cuenta.saldoDeuda, 2000n);
  });

  test('un ajuste de redondeo de un peso lleva la comision al objetivo', CON_BASE, async () => {
    const ahora = new Date();
    const escenario = await crearEscenario({
      ahora,
      cantidad: 1,
      precio: 10000n,
      comision: 1999n,
    });

    const resultado = await liberarSaldos({
      ahora,
      subPedidoIds: [escenario.subPedido.id],
    });
    assert.equal(resultado.liberados, 1);

    const movimientos = await movimientosDe(
      escenario.subPedido.id,
      escenario.local.id,
    );
    assert.deepEqual(
      movimientos.map((movimiento) => [
        movimiento.tipo,
        movimiento.monto,
      ]),
      [
        ['liberacion', 8001n],
        ['ajuste_redondeo', 1n],
      ],
    );

    const cuenta = await prisma.cuentaLocal.findUnique({
      where: { localId: escenario.local.id },
    });
    assert.equal(cuenta.saldoPorPagar, 8000n);
  });

  test('dos jobs simultaneos liberan una sola vez', CON_BASE, async () => {
    const ahora = new Date();
    const escenario = await crearEscenario({ ahora });

    const [primero, segundo] = await Promise.all([
      liberarSaldos({
        ahora,
        subPedidoIds: [escenario.subPedido.id],
      }),
      liberarSaldos({
        ahora,
        subPedidoIds: [escenario.subPedido.id],
      }),
    ]);

    assert.equal(primero.liberados + segundo.liberados, 1);
    assert.equal(
      await prisma.ledger.count({
        where: {
          subPedidoId: escenario.subPedido.id,
          tipo: 'liberacion',
        },
      }),
      1,
    );

    const cuenta = await prisma.cuentaLocal.findUnique({
      where: { localId: escenario.local.id },
    });
    assert.equal(cuenta.saldoPorPagar, 8000n);
  });

  test('una disputa que se abre mientras corre el job no libera dinero disputado', CON_BASE, async () => {
    const ahora = new Date();
    const escenario = await crearEscenario({ ahora });

    let marcarDisputa;
    const disputaIniciada = new Promise((resolve) => {
      marcarDisputa = resolve;
    });
    let terminarDisputa;
    const esperaDisputa = new Promise((resolve) => {
      terminarDisputa = resolve;
    });

    const transaccionDisputa = withTransaccion(async (tx) => {
      await tx.disputa.create({
        data: {
          subPedidoId: escenario.subPedido.id,
          usuarioId: escenario.comprador.id,
          tipo: 'digital',
          motivo: 'Disputa concurrente',
          montoReclamado: 10000n,
          estadoSubPedidoAnterior: 'entregado',
        },
      });
      marcarDisputa();
      await esperaDisputa;
    });

    await disputaIniciada;

    try {
      const durante = await liberarSaldos({
        ahora,
        subPedidoIds: [escenario.subPedido.id],
      });
      assert.equal(durante.liberados, 0);
      assert.equal(durante.omitidos, 1);
    } finally {
      terminarDisputa();
    }

    await transaccionDisputa;

    const sub = await prisma.subPedido.findUnique({
      where: { id: escenario.subPedido.id },
    });
    assert.equal(sub.estado, 'en_disputa');
    assert.equal(sub.saldoLiberadoEn, null);

    const despues = await liberarSaldos({
      ahora,
      subPedidoIds: [escenario.subPedido.id],
    });
    assert.equal(despues.liberados, 0);
    assert.equal(
      await prisma.ledger.count({
        where: {
          subPedidoId: escenario.subPedido.id,
          localId: escenario.local.id,
        },
      }),
      0,
    );
  });

  test('si el job gana, la disputa posterior se rechaza sin dinero disputado', CON_BASE, async () => {
    const ahora = new Date();
    const escenario = await crearEscenario({ ahora });

    const resultado = await liberarSaldos({
      ahora,
      subPedidoIds: [escenario.subPedido.id],
    });
    assert.equal(resultado.liberados, 1);

    await assert.rejects(
      () =>
        abrirDisputa({
          usuario: escenario.comprador,
          subPedidoId: escenario.subPedido.id,
          datos: {
            motivo: 'Llego tarde',
            lineas: [{ detalle_id: escenario.detalle.id, cantidad: 1 }],
          },
        }),
      (err) => err.codigo === 'saldo_ya_liberado',
    );

    const disputas = await prisma.disputa.count({
      where: { subPedidoId: escenario.subPedido.id },
    });
    assert.equal(disputas, 0);

    const cuenta = await prisma.cuentaLocal.findUnique({
      where: { localId: escenario.local.id },
    });
    assert.equal(cuenta.saldoPorPagar, 8000n);
  });

  test('liberarSubPedido no toca un sub-pedido que aun no cumplio la retencion', CON_BASE, async () => {
    const ahora = new Date();
    const escenario = await crearEscenario({
      ahora,
      fechaEntrega: new Date(ahora.getTime() - 4 * UN_DIA),
    });

    const resultado = await liberarSubPedido({
      subPedidoId: escenario.subPedido.id,
      ahora,
    });
    assert.equal(resultado.liberado, false);
    assert.equal(resultado.motivo, 'no_elegible');
  });
});
