import './helpers/entorno.js';
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { opcionesConBase, prisma, cerrarConexion } from './helpers/base.js';
import {
  crearUsuarioDirecto,
  crearCatalogo,
  crearPedidoDePrueba,
  crearPagoDePrueba,
  crearReembolsoDePrueba,
} from './helpers/datos.js';
import { crearVariante } from '../src/services/stock.js';

/**
 * RESTRICCIONES DE INTEGRIDAD DE LA SECCION 4.13
 * ==============================================
 * Cada regla tiene una prueba que INTENTA violarla. No alcanza con que la
 * regla este escrita: hay que comprobar que la base la rechaza.
 *
 *   1. pedido.total = suma de sub_pedido.total
 *   2. suma de reembolsos de un pago <= pago.monto
 *   3. suma de reembolsos de una linea <= su monto original
 *   4. pago.monto_reembolsado = suma de reembolsos completados
 *   5. categoria_global.rubro_id nulo o igual a local.rubro_id
 *
 * Ademas se prueba el CHECK de saldos no negativos de cuenta_local.
 */

const CON_BASE = await opcionesConBase();

after(async () => {
  await cerrarConexion();
});

const CONFIG_SNAPSHOT = {
  porcentaje_comision: 5,
  comision_minima: 2000,
  pedido_minimo: 30000,
  tarifa_base_envio: 2000,
  tarifa_por_km: 800,
  dias_retencion: 5,
  tomado_en: new Date().toISOString(),
};

describe('restricciones de integridad 4.13', () => {
  test('pedido.total distinto de la suma de sus sub_pedidos se rechaza', CON_BASE, async () => {
    const comprador = await crearUsuarioDirecto();
    const { local } = await crearCatalogo({ precio: 10000n });

    await assert.rejects(
      () =>
        prisma.$transaction(async (tx) => {
          const pedido = await tx.pedido.create({
            data: {
              usuarioId: comprador.id,
              direccionTexto: 'Calle 1 # 2-3, Bogota',
              direccionLatitud: 4.65,
              direccionLongitud: -74.05,
              total: 1n,
              metodoPago: 'tarjeta',
              estado: 'pendiente_pago',
              configSnapshot: CONFIG_SNAPSHOT,
            },
          });

          await tx.subPedido.create({
            data: {
              pedidoId: pedido.id,
              localId: local.id,
              nombreLocal: local.nombre,
              subtotalProductos: 30000n,
              costoEnvio: 0n,
              comision: 0n,
              total: 30000n,
              estado: 'por_aceptar',
            },
          });
        }),
      /total.*no coincide|sub_pedidos|check/i,
    );

    const pedidos = await prisma.pedido.count({
      where: { usuarioId: comprador.id },
    });
    assert.equal(pedidos, 0, 'la transaccion completa se revierte');
  });

  test('la suma de reembolsos de un pago no puede superar pago.monto', CON_BASE, async () => {
    const { local, variante } = await crearCatalogo({ precio: 10000n });
    const { pedido, subPedido } = await crearPedidoDePrueba({
      local,
      variante,
      cantidad: 4,
      costoEnvio: 0n,
    });
    const pago = await crearPagoDePrueba({ pedido, monto: 30000n });

    await crearReembolsoDePrueba({
      pago,
      subPedido,
      monto: 20000n,
    });

    await assert.rejects(
      () =>
        crearReembolsoDePrueba({
          pago,
          subPedido,
          monto: 20000n,
        }),
      /reembolsos|supera|monto del pago/i,
    );

    const reembolsos = await prisma.reembolso.findMany({
      where: { pagoId: pago.id },
    });
    assert.equal(reembolsos.length, 1);
  });

  test('la suma de reembolsos de una linea no puede superar su total original', CON_BASE, async () => {
    const { local, variante } = await crearCatalogo({ precio: 10000n });
    const { pedido, subPedido } = await crearPedidoDePrueba({
      local,
      variante,
      cantidad: 3,
      costoEnvio: 0n,
    });
    // El pago puede ser mayor que el pedido; lo que se prueba es la linea.
    const pago = await crearPagoDePrueba({ pedido, monto: 40000n });

    await crearReembolsoDePrueba({
      pago,
      subPedido,
      monto: 20000n,
    });

    await assert.rejects(
      () =>
        crearReembolsoDePrueba({
          pago,
          subPedido,
          monto: 20000n,
        }),
      /reembolsos|supera|total original|sub_pedido|linea/i,
    );

    const suma = await prisma.reembolso.aggregate({
      where: { subPedidoId: subPedido.id },
      _sum: { monto: true },
    });
    assert.equal(suma._sum.monto, 20000n);
  });

  test('pago.monto_reembolsado debe coincidir con los reembolsos completados', CON_BASE, async () => {
    const { local, variante } = await crearCatalogo({ precio: 10000n });
    const { pedido } = await crearPedidoDePrueba({ local, variante });

    await assert.rejects(
      () =>
        prisma.pago.create({
          data: {
            tipoPago: 'pedido',
            pedidoId: pedido.id,
            referencia: `MISMATCH-${Date.now()}-${Math.random()}`,
            metodoPago: 'tarjeta',
            monto: pedido.total,
            montoReembolsado: 1n,
          },
        }),
      /monto_reembolsado|reembolsos completados|no coincide/i,
    );

    const pagos = await prisma.pago.count({
      where: { pedidoId: pedido.id },
    });
    assert.equal(pagos, 0);
  });

  test('un producto no puede usar una categoria de otro rubro', CON_BASE, async () => {
    const vendedor = await crearUsuarioDirecto({
      nombre: 'Vendedor de rubro',
      roles: ['vendedor'],
    });
    const rubroLocal = await prisma.rubro.create({
      data: { nombre: `rubro-local-${Date.now()}-${Math.random()}` },
    });
    const rubroAjeno = await prisma.rubro.create({
      data: { nombre: `rubro-ajeno-${Date.now()}-${Math.random()}` },
    });
    const local = await prisma.local.create({
      data: {
        usuarioId: vendedor.id,
        rubroId: rubroLocal.id,
        nombre: 'Local del rubro correcto',
        latitud: 4.65,
        longitud: -74.05,
        estado: 'activo',
      },
    });
    const categoriaAjena = await prisma.categoriaGlobal.create({
      data: {
        nombre: `categoria-ajena-${Date.now()}-${Math.random()}`,
        rubroId: rubroAjeno.id,
      },
    });

    await assert.rejects(
      () =>
        prisma.producto.create({
          data: {
            localId: local.id,
            categoriaGlobalId: categoriaAjena.id,
            nombre: 'Producto con rubro equivocado',
            activo: true,
          },
        }),
      /rubro|categoria|check/i,
    );

    const productos = await prisma.producto.count({
      where: { localId: local.id },
    });
    assert.equal(productos, 0);
  });

  test('la cuenta de un local no puede tener saldos negativos', CON_BASE, async () => {
    const { local } = await crearCatalogo({ precio: 10000n });
    // El trigger ccv_cuenta_local_por_local ya creo la cuenta al insertar
    // el local. Se usa esa fila en vez de crear una segunda.
    const cuenta = await prisma.cuentaLocal.findUnique({
      where: { localId: local.id },
    });
    assert.ok(cuenta, 'el trigger debe haber creado la cuenta del local');

    await assert.rejects(
      () =>
        prisma.cuentaLocal.update({
          where: { localId: local.id },
          data: { saldoDeuda: -1n },
        }),
      /saldos_no_negativos|check|negativ/i,
    );

    const cuentaDb = await prisma.cuentaLocal.findUnique({
      where: { localId: local.id },
    });
    assert.equal(cuentaDb.saldoDeuda, 0n);
    assert.equal(cuenta.saldoDeuda, 0n);
  });

  test('un pedido no puede tener dos pagos', CON_BASE, async () => {
    const { local, variante } = await crearCatalogo({ precio: 10000n });
    const { pedido } = await crearPedidoDePrueba({ local, variante });
    await crearPagoDePrueba({ pedido });

    await assert.rejects(
      () =>
        prisma.pago.create({
          data: {
            tipoPago: 'pedido',
            pedidoId: pedido.id,
            referencia: `SEGUNDO-${Date.now()}-${Math.random()}`,
            metodoPago: 'tarjeta',
            monto: pedido.total,
          },
        }),
      /P2002|unique|duplicad/i,
    );

    const pagos = await prisma.pago.count({ where: { pedidoId: pedido.id } });
    assert.equal(pagos, 1);
  });

  test('un pedido no puede tener total negativo', CON_BASE, async () => {
    const comprador = await crearUsuarioDirecto();

    await assert.rejects(
      () =>
        prisma.pedido.create({
          data: {
            usuarioId: comprador.id,
            direccionTexto: 'Calle 1 # 2-3, Bogota',
            direccionLatitud: 4.65,
            direccionLongitud: -74.05,
            total: -1n,
            metodoPago: 'tarjeta',
            estado: 'pendiente_pago',
            configSnapshot: CONFIG_SNAPSHOT,
          },
        }),
      /pedido_total_no_negativo/i,
    );
  });

  test('un sub_pedido no puede tener montos negativos', CON_BASE, async () => {
    const { local, variante } = await crearCatalogo({ precio: 10000n });
    const { pedido } = await crearPedidoDePrueba({ local, variante });

    await assert.rejects(
      () =>
        prisma.subPedido.create({
          data: {
            pedidoId: pedido.id,
            localId: local.id,
            nombreLocal: local.nombre,
            subtotalProductos: -1n,
            costoEnvio: 0n,
            comision: 0n,
            total: -1n,
            estado: 'por_aceptar',
          },
        }),
      /sub_pedido_montos_no_negativos/i,
    );
  });

  test('un pago no puede tener monto cero', CON_BASE, async () => {
    const { local, variante } = await crearCatalogo({ precio: 10000n });
    const { pedido } = await crearPedidoDePrueba({ local, variante });

    await assert.rejects(
      () =>
        prisma.pago.create({
          data: {
            tipoPago: 'pedido',
            pedidoId: pedido.id,
            referencia: `CERO-${Date.now()}-${Math.random()}`,
            metodoPago: 'tarjeta',
            monto: 0n,
          },
        }),
      /pago_monto_positivo/i,
    );
  });

  test('pago.monto_reembolsado no puede superar pago.monto', CON_BASE, async () => {
    const { local, variante } = await crearCatalogo({ precio: 10000n });
    const { pedido } = await crearPedidoDePrueba({ local, variante });

    await assert.rejects(
      () =>
        prisma.pago.create({
          data: {
            tipoPago: 'pedido',
            pedidoId: pedido.id,
            referencia: `EXCEDE-${Date.now()}-${Math.random()}`,
            metodoPago: 'tarjeta',
            monto: 1000n,
            montoReembolsado: 2000n,
          },
        }),
      /pago_reembolsado_valido/i,
    );
  });

  test('un reembolso no puede tener monto cero', CON_BASE, async () => {
    const { local, variante } = await crearCatalogo({ precio: 10000n });
    const { pedido, subPedido } = await crearPedidoDePrueba({
      local,
      variante,
    });
    const pago = await crearPagoDePrueba({ pedido });

    await assert.rejects(
      () =>
        prisma.reembolso.create({
          data: {
            pagoId: pago.id,
            subPedidoId: subPedido.id,
            tipo: 'digital',
            monto: 0n,
            motivo: 'prueba de CHECK',
          },
        }),
      /reembolso_monto_positivo/i,
    );
  });

  test('el ledger no acepta montos negativos', CON_BASE, async () => {
    await assert.rejects(
      () =>
        prisma.ledger.create({
          data: { tipo: 'ajuste', monto: -1n },
        }),
      /ledger_monto_no_negativo/i,
    );
  });

  test('una variante no puede tener precio negativo', CON_BASE, async () => {
    const { variante } = await crearCatalogo({ precio: 10000n });

    await assert.rejects(
      () =>
        prisma.$executeRawUnsafe(
          'UPDATE "producto_variante" SET "precio" = -1 WHERE "id" = $1',
          variante.id,
        ),
      /producto_variante_precio_no_negativo/i,
    );

    const varianteDb = await prisma.productoVariante.findUnique({
      where: { id: variante.id },
    });
    assert.equal(varianteDb.precio, 10000n);
  });

  test('una linea no puede tener cantidad cero ni precio negativo', CON_BASE, async () => {
    const { local, producto, variante } = await crearCatalogo({
      precio: 10000n,
    });
    const { subPedido } = await crearPedidoDePrueba({ local, variante });
    const varianteCantidad = await crearVariante(prisma, {
      productoId: producto.id,
      atributos: { talla: 'S' },
      precio: 10000n,
      stock: 1,
    });
    const variantePrecio = await crearVariante(prisma, {
      productoId: producto.id,
      atributos: { talla: 'L' },
      precio: 10000n,
      stock: 1,
    });

    await assert.rejects(
      () =>
        prisma.detalleProducto.create({
          data: {
            subPedidoId: subPedido.id,
            varianteId: varianteCantidad.id,
            nombreProducto: 'Cantidad cero',
            cantidad: 0,
            precioUnitario: 10000n,
          },
        }),
      /detalle_cantidad_positiva/i,
    );

    await assert.rejects(
      () =>
        prisma.detalleProducto.create({
          data: {
            subPedidoId: subPedido.id,
            varianteId: variantePrecio.id,
            nombreProducto: 'Precio negativo',
            cantidad: 1,
            precioUnitario: -1n,
          },
        }),
      /detalle_precio_no_negativo/i,
    );
  });
});
