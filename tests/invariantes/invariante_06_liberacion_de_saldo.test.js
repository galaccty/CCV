import '../helpers/entorno.js';
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { estadoInvariante } from '../helpers/pendiente.js';
import { opcionesConBase, prisma, cerrarConexion } from '../helpers/base.js';
import {
  crearCatalogo,
  crearPedidoDePrueba,
  crearPagoDePrueba,
  crearReembolsoDePrueba,
  crearUsuarioDirecto,
} from '../helpers/datos.js';
import {
  liberarSaldos,
  liberarSubPedido,
  subPedidosElegiblesParaLiberar,
} from '../../src/services/liberacion.js';
import {
  abrirDisputa,
  resolverDisputa,
} from '../../src/services/disputas.js';

/**
 * INVARIANTE 6 - entregado y el dinero movido son hechos distintos.
 *
 * La Etapa 2 comprueba que un sub_pedido con un reembolso pendiente no es
 * elegible para liberar saldo. La Etapa 4c-1 agrega que una disputa abierta
 * tampoco lo es. La Etapa 4d ya escribe el saldo: este archivo verifica tanto
 * la elegibilidad como el efecto real del job.
 */

export const ESTADO = estadoInvariante({
  aplica: true,
  etapa: 'Etapa 2 / Etapa 4',
  motivo:
    'El job 4d libera solo despues de la retencion y respeta reembolsos pendientes y disputas abiertas.',
});

const UN_DIA = 24 * 60 * 60 * 1000;

const CON_BASE = await opcionesConBase();

after(async () => {
  await cerrarConexion();
});

describe('invariante 6 - entregado y el dinero movido son hechos distintos', () => {
  test('un reembolso pendiente bloquea la liberacion del saldo', CON_BASE, async () => {
    const { local, variante } = await crearCatalogo({ precio: 10000n });
    const fechaEntregaVieja = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000);

    const conReembolso = await crearPedidoDePrueba({
      local,
      variante,
      estadoPedido: 'completado',
      estadoSubPedido: 'entregado',
    });
    await prisma.subPedido.update({
      where: { id: conReembolso.subPedido.id },
      data: { fechaEntrega: fechaEntregaVieja },
    });
    const pago = await crearPagoDePrueba({
      pedido: conReembolso.pedido,
      estado: 'aprobado',
    });
    await crearReembolsoDePrueba({
      pago,
      subPedido: conReembolso.subPedido,
      monto: conReembolso.subPedido.total,
      estado: 'pendiente',
    });

    // Control: mismo estado y misma fecha, pero sin reembolso pendiente. Si el
    // control no apareciera, la prueba no probaria nada (podria estar fallando
    // por la fecha o por el estado).
    const control = await crearPedidoDePrueba({
      local,
      variante,
      estadoPedido: 'completado',
      estadoSubPedido: 'entregado',
    });
    await prisma.subPedido.update({
      where: { id: control.subPedido.id },
      data: { fechaEntrega: fechaEntregaVieja },
    });

    const elegibles = await subPedidosElegiblesParaLiberar();

    assert.ok(
      !elegibles.includes(conReembolso.subPedido.id),
      'el sub-pedido con reembolso pendiente no debe ser elegible',
    );
    assert.ok(
      elegibles.includes(control.subPedido.id),
      'el control sin reembolso pendiente si debe ser elegible',
    );

    const bloqueado = await prisma.subPedido.findUnique({
      where: { id: conReembolso.subPedido.id },
    });
    assert.equal(bloqueado.saldoLiberadoEn, null);

    // La base tambien lo impide directamente: no depende de que el job use la
    // consulta de elegibilidad.
    await assert.rejects(
      () =>
        prisma.subPedido.update({
          where: { id: conReembolso.subPedido.id },
          data: { saldoLiberadoEn: new Date() },
        }),
      /reembolso_pendiente/i,
    );

    const sigueBloqueado = await prisma.subPedido.findUnique({
      where: { id: conReembolso.subPedido.id },
    });
    assert.equal(sigueBloqueado.saldoLiberadoEn, null);
  });

  test('no se libera saldo antes de dias_retencion', CON_BASE, async () => {
    const ahora = new Date();
    const { local, variante } = await crearCatalogo({ precio: 10000n });
    const pedido = await crearPedidoDePrueba({
      local,
      variante,
      estadoPedido: 'completado',
      estadoSubPedido: 'entregado',
    });
    await prisma.subPedido.update({
      where: { id: pedido.subPedido.id },
      data: {
        fechaEntrega: new Date(ahora.getTime() - 4 * UN_DIA),
      },
    });

    const resultado = await liberarSubPedido({
      subPedidoId: pedido.subPedido.id,
      ahora,
    });

    assert.equal(resultado.liberado, false);
    assert.equal(resultado.motivo, 'no_elegible');

    const sub = await prisma.subPedido.findUnique({
      where: { id: pedido.subPedido.id },
    });
    assert.equal(sub.saldoLiberadoEn, null);

    const movimientos = await prisma.ledger.count({
      where: { subPedidoId: pedido.subPedido.id },
    });
    assert.equal(movimientos, 0);
  });

  test('una disputa abierta excluye el sub-pedido de la liberacion', CON_BASE, async () => {
    const { local, variante } = await crearCatalogo({ precio: 10000n });
    const fechaEntregaVieja = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000);

    const conDisputa = await crearPedidoDePrueba({
      local,
      variante,
      estadoPedido: 'completado',
      estadoSubPedido: 'entregado',
    });
    await prisma.subPedido.update({
      where: { id: conDisputa.subPedido.id },
      data: { fechaEntrega: fechaEntregaVieja },
    });

    await abrirDisputa({
      usuario: conDisputa.comprador,
      subPedidoId: conDisputa.subPedido.id,
      datos: {
        motivo: 'Producto en mal estado',
        lineas: [{ detalle_id: conDisputa.detalle.id, cantidad: 1 }],
      },
    });

    const control = await crearPedidoDePrueba({
      local,
      variante,
      estadoPedido: 'completado',
      estadoSubPedido: 'entregado',
    });
    await prisma.subPedido.update({
      where: { id: control.subPedido.id },
      data: { fechaEntrega: fechaEntregaVieja },
    });

    const elegibles = await subPedidosElegiblesParaLiberar();
    assert.ok(!elegibles.includes(conDisputa.subPedido.id));
    assert.ok(elegibles.includes(control.subPedido.id));

    const bloqueado = await prisma.subPedido.findUnique({
      where: { id: conDisputa.subPedido.id },
    });
    assert.equal(bloqueado.estado, 'en_disputa');
    assert.equal(bloqueado.saldoLiberadoEn, null);

    // Aunque un bug dejara el sub-pedido en `entregado`, la consulta debe
    // mirar la disputa abierta y no solo el estado del sub-pedido.
    await prisma.subPedido.update({
      where: { id: conDisputa.subPedido.id },
      data: { estado: 'entregado' },
    });
    const sigueFuera = await subPedidosElegiblesParaLiberar();
    assert.ok(!sigueFuera.includes(conDisputa.subPedido.id));
  });

  test('resolver a favor del vendedor devuelve el sub-pedido a la liberacion', CON_BASE, async () => {
    const { local, variante } = await crearCatalogo({ precio: 10000n });
    const fechaEntregaVieja = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000);
    const admin = await crearUsuarioDirecto({
      nombre: 'Admin',
      roles: ['admin'],
    });

    const pedido = await crearPedidoDePrueba({
      local,
      variante,
      estadoPedido: 'completado',
      estadoSubPedido: 'entregado',
    });
    await prisma.subPedido.update({
      where: { id: pedido.subPedido.id },
      data: { fechaEntrega: fechaEntregaVieja },
    });

    const disputa = await abrirDisputa({
      usuario: pedido.comprador,
      subPedidoId: pedido.subPedido.id,
      datos: {
        motivo: 'Disputa que gana el vendedor',
        lineas: [{ detalle_id: pedido.detalle.id, cantidad: 1 }],
      },
    });

    const antes = await subPedidosElegiblesParaLiberar();
    assert.ok(!antes.includes(pedido.subPedido.id));

    await resolverDisputa({
      disputaId: disputa.id,
      admin,
      datos: {
        favor: 'vendedor',
        resolucion: 'El vendedor aporto la evidencia de entrega.',
      },
    });

    const despues = await subPedidosElegiblesParaLiberar();
    assert.ok(
      despues.includes(pedido.subPedido.id),
      'al cerrar la disputa sin reembolso, el reloj de retencion sigue y el sub-pedido vuelve a ser elegible',
    );

    const sub = await prisma.subPedido.findUnique({
      where: { id: pedido.subPedido.id },
    });
    assert.equal(sub.estado, 'entregado');
    assert.equal(sub.saldoLiberadoEn, null);
  });

  test('el job corre en la fecha correcta', CON_BASE, async () => {
    const ahora = new Date();
    const { local, variante } = await crearCatalogo({ precio: 10000n });
    const pedido = await crearPedidoDePrueba({
      local,
      variante,
      comision: 2000n,
      estadoPedido: 'completado',
      estadoSubPedido: 'entregado',
    });
    await prisma.subPedido.update({
      where: { id: pedido.subPedido.id },
      data: {
        fechaEntrega: new Date(ahora.getTime() - 5 * UN_DIA),
      },
    });

    const resultado = await liberarSaldos({
      ahora,
      subPedidoIds: [pedido.subPedido.id],
    });

    assert.equal(resultado.liberados, 1);

    const sub = await prisma.subPedido.findUnique({
      where: { id: pedido.subPedido.id },
    });
    assert.ok(sub.saldoLiberadoEn);

    const movimientos = await prisma.ledger.findMany({
      where: { subPedidoId: pedido.subPedido.id },
      orderBy: { id: 'asc' },
    });
    assert.deepEqual(
      movimientos.map((movimiento) => [
        movimiento.tipo,
        movimiento.localId,
        movimiento.monto,
      ]),
      [['liberacion', local.id, 8000n]],
    );
  });
});
