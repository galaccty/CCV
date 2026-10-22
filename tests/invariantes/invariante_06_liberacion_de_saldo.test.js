import '../helpers/entorno.js';
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { pendiente, estadoInvariante } from '../helpers/pendiente.js';
import { opcionesConBase, prisma, cerrarConexion } from '../helpers/base.js';
import {
  crearCatalogo,
  crearPedidoDePrueba,
  crearPagoDePrueba,
  crearReembolsoDePrueba,
} from '../helpers/datos.js';
import { subPedidosElegiblesParaLiberar } from '../../src/services/liberacion.js';
import { abrirDisputa } from '../../src/services/disputas.js';

/**
 * INVARIANTE 6 - entregado y el dinero movido son hechos distintos.
 *
 * La Etapa 2 ya puede comprobar una parte: un sub_pedido con un reembolso
 * pendiente no es elegible para liberar saldo. La Etapa 4c-1 agrega la otra:
 * una disputa abierta tampoco es elegible. El job que escribe el saldo sigue
 * en la Etapa 4d.
 */

export const ESTADO = estadoInvariante({
  aplica: true,
  etapa: 'Etapa 2 / Etapa 4',
  motivo:
    'La elegibilidad ya excluye reembolsos pendientes y disputas abiertas; el job llega en la Etapa 4d.',
});

const cuandoAplique = pendiente('Etapa 4', ESTADO.motivo);

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

  test('no se libera saldo antes de dias_retencion', cuandoAplique, () => {
    // A activar en la Etapa 4
    //   marcar entregado con retencion de 5 dias y verificar que a los 4 dias saldo_liberado_en sigue nulo
    assert.ok(true);
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

  test('el job corre en la fecha correcta', cuandoAplique, () => {
    // A activar en la Etapa 4
    //   con fecha_entrega + dias_retencion llegada, verificar que el job libera y llena saldo_liberado_en
    assert.ok(true);
  });
});
