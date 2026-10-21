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
} from '../helpers/datos.js';

/**
 * INVARIANTE 5 - los snapshots de sub_pedido nunca se modifican.
 *
 * Activo desde la Etapa 2. La base tiene triggers que rechazan cualquier
 * UPDATE sobre los montos, el nombre del local y las lineas congeladas. Un
 * cambio de precio en el catalogo no toca lo que el comprador ya acepto, y un
 * reembolso tampoco reescribe el pedido.
 *
 * El "neto" no es una columna: se deriva de subtotal_productos - comision.
 * Guardarlo permitiria que se desincronice del ledger.
 */

export const ESTADO = estadoInvariante({
  aplica: true,
  etapa: 'Etapa 2',
  motivo: 'sub_pedido y detalle_producto ya existen y tienen triggers de inmutabilidad.',
});

const CON_BASE = await opcionesConBase();

after(async () => {
  await cerrarConexion();
});

describe('invariante 5 - los snapshots de sub_pedido nunca se modifican', () => {
  test('cambiar el precio del producto no altera el pedido', CON_BASE, async () => {
    const { local, variante } = await crearCatalogo({ precio: 10000 });
    const { pedido, subPedido, detalle } = await crearPedidoDePrueba({
      local,
      variante,
      cantidad: 2,
      precioUnitario: 10000,
      comision: 1000,
    });

    assert.equal(detalle.precioUnitario, 10000);
    assert.equal(subPedido.total, 20000);

    // El catalogo cambia de precio. El pedido ya creado no se entera.
    await prisma.$executeRaw`
      UPDATE "producto_variante" SET "precio" = ${99999} WHERE "id" = ${variante.id}
    `;

    const detalleGuardado = await prisma.detalleProducto.findUnique({
      where: { id: detalle.id },
    });
    const pedidoGuardado = await prisma.pedido.findUnique({ where: { id: pedido.id } });
    const varianteActualizada = await prisma.productoVariante.findUnique({
      where: { id: variante.id },
    });

    assert.equal(detalleGuardado.precioUnitario, 10000);
    assert.equal(pedidoGuardado.total, 20000);
    assert.equal(varianteActualizada.precio, 99999);

    // Y el snapshot tampoco se puede reescribir a mano.
    await assert.rejects(
      () =>
        prisma.detalleProducto.update({
          where: { id: detalle.id },
          data: { precioUnitario: 1 },
        }),
      /snapshots|no se modifican|restrict/i,
    );

    await assert.rejects(
      () =>
        prisma.subPedido.update({
          where: { id: subPedido.id },
          data: { total: 1 },
        }),
      /snapshots|no se modifican|restrict/i,
    );
  });

  test('un reembolso no altera subtotal_productos, comision ni total', CON_BASE, async () => {
    const { local, variante } = await crearCatalogo({ precio: 15000 });
    const { pedido, subPedido } = await crearPedidoDePrueba({
      local,
      variante,
      cantidad: 1,
      precioUnitario: 15000,
      comision: 2000,
    });
    const pago = await crearPagoDePrueba({ pedido, monto: 15000 });
    const reembolso = await crearReembolsoDePrueba({
      pago,
      subPedido,
      monto: 15000,
    });

    // El proceso real completa el reembolso y actualiza el pago en la misma
    // transaccion. Los triggers diferidos verifican la consistencia al commit.
    await prisma.$transaction(async (tx) => {
      await tx.reembolso.update({
        where: { id: reembolso.id },
        data: { estado: 'completado' },
      });
      await tx.pago.update({
        where: { id: pago.id },
        data: { montoReembolsado: 15000, estado: 'reembolsado' },
      });
      await tx.subPedido.update({
        where: { id: subPedido.id },
        data: { estado: 'reembolsado' },
      });
    });

    const subDespues = await prisma.subPedido.findUnique({
      where: { id: subPedido.id },
    });
    const pedidoDespues = await prisma.pedido.findUnique({ where: { id: pedido.id } });

    assert.equal(subDespues.estado, 'reembolsado');
    assert.equal(subDespues.subtotalProductos, 15000);
    assert.equal(subDespues.comision, 2000);
    assert.equal(subDespues.total, 15000);
    assert.equal(subDespues.nombreLocal, subPedido.nombreLocal);
    assert.equal(pedidoDespues.total, 15000);

    // Un reembolso no es una excusa para tocar los snapshots.
    await assert.rejects(
      () =>
        prisma.subPedido.update({
          where: { id: subPedido.id },
          data: { comision: 0 },
        }),
      /snapshots|no se modifican|restrict/i,
    );
  });

  test('el neto siempre se deriva, no se guarda en una columna', CON_BASE, async () => {
    const columnas = await prisma.$queryRaw`
      SELECT column_name
        FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'sub_pedido'
    `;

    assert.equal(
      columnas.some((c) => c.column_name === 'neto'),
      false,
      'sub_pedido no debe tener una columna neto: se calcula como subtotal_productos - comision',
    );

    const { local, variante } = await crearCatalogo({ precio: 10000 });
    const { subPedido } = await crearPedidoDePrueba({
      local,
      variante,
      precioUnitario: 10000,
      comision: 500,
    });

    assert.equal(subPedido.subtotalProductos - subPedido.comision, 9500);
  });
});
