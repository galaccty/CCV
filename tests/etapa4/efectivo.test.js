import '../helpers/entorno.js';
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { opcionesConBase, prisma, cerrarConexion } from '../helpers/base.js';
import {
  cliente,
  crearUsuarioConSesion,
} from '../helpers/http.js';
import { crearCatalogoParaVendedor, crearUsuarioDirecto } from '../helpers/datos.js';
import { ajustarStock } from '../../src/services/stock.js';
import { aceptarSubPedido } from '../../src/services/subPedidos.js';

/**
 * PEDIDOS EN EFECTIVO - ETAPA 4b
 * ==============================
 * El checkout no descuenta stock. Crea el pedido `en_proceso`, un pago
 * pendiente con referencia `CCV-EF-*` y deja el sub-pedido por aceptar.
 */

const CON_BASE = await opcionesConBase();

after(async () => {
  await cerrarConexion();
});

function clave(prefijo = 'efectivo') {
  return `${prefijo}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function cuerpoCheckout(varianteId, cantidad, extra = {}) {
  return {
    direccion: {
      texto: 'Calle 1 # 2-3, Bogota',
      latitud: 4.65,
      longitud: -74.05,
    },
    metodo_pago: 'efectivo',
    items: [{ variante_id: varianteId, cantidad }],
    ...extra,
  };
}

async function montarCatalogo() {
  const vendedor = await crearUsuarioConSesion({
    nombre: 'Vendedor efectivo',
    roles: ['vendedor'],
  });
  const catalogo = await crearCatalogoParaVendedor({
    vendedorId: vendedor.id,
    precio: 10000n,
    stockInicial: 10,
  });
  const comprador = await crearUsuarioConSesion({
    nombre: 'Comprador efectivo',
    roles: ['comprador'],
  });
  return { vendedor, comprador, ...catalogo };
}

async function pedidoEfectivo() {
  const datos = await montarCatalogo();
  const r = await datos.comprador.cliente.post(
    '/api/v1/pedidos',
    cuerpoCheckout(datos.variante.id, 3),
    { 'Idempotency-Key': clave() },
  );
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const pedido = await prisma.pedido.findUnique({
    where: { id: r.body.id },
    include: { subPedidos: true, pagos: true },
  });
  return { ...datos, respuesta: r, pedido, subPedido: pedido.subPedidos[0] };
}

describe('checkout en efectivo', () => {
  test('crea pedido en_proceso y un pago pendiente sin tocar el stock', CON_BASE, async () => {
    const { respuesta, pedido, subPedido, variante } = await pedidoEfectivo();

    assert.equal(respuesta.body.estado, 'en_proceso');
    assert.equal(respuesta.body.metodo_pago, 'efectivo');
    assert.equal(pedido.estado, 'en_proceso');
    assert.equal(pedido.metodoPago, 'efectivo');
    assert.equal(subPedido.estado, 'por_aceptar');
    assert.equal(pedido.pagos.length, 1);

    const pago = pedido.pagos[0];
    assert.equal(pago.metodoPago, 'efectivo');
    assert.equal(pago.estado, 'pendiente');
    assert.equal(pago.monto, pedido.total);
    assert.match(pago.referencia, /^CCV-EF-[0-9a-f]{32}$/);

    const varianteDespues = await prisma.productoVariante.findUnique({
      where: { id: variante.id },
    });
    assert.equal(varianteDespues.stock, 10);
  });

  test('el total del pago sale del backend y no del cliente', CON_BASE, async () => {
    const { comprador, variante } = await montarCatalogo();

    const r = await comprador.cliente.post(
      '/api/v1/pedidos',
      cuerpoCheckout(variante.id, 3, {
        total: 1,
        subtotal: 1,
        comision: 1,
      }),
      { 'Idempotency-Key': clave() },
    );

    assert.equal(r.status, 201, JSON.stringify(r.body));
    const pago = await prisma.pago.findFirst({
      where: { pedidoId: r.body.id },
    });
    assert.ok(pago.monto > 1n);
    assert.equal(pago.monto, BigInt(r.body.total));
  });

  test('rechaza efectivo con productos de mas de un local', CON_BASE, async () => {
    const comprador = await crearUsuarioConSesion({ roles: ['comprador'] });
    const vendedor = await crearUsuarioDirecto({
      nombre: 'Vendedor multi-local',
      roles: ['vendedor'],
    });
    const localA = await crearCatalogoParaVendedor({
      vendedorId: vendedor.id,
      precio: 30000n,
    });
    const localB = await crearCatalogoParaVendedor({
      vendedorId: vendedor.id,
      precio: 30000n,
    });

    const r = await comprador.cliente.post(
      '/api/v1/pedidos',
      {
        direccion: {
          texto: 'Calle 1 # 2-3, Bogota',
          latitud: 4.65,
          longitud: -74.05,
        },
        metodo_pago: 'efectivo',
        items: [
          { variante_id: localA.variante.id, cantidad: 1 },
          { variante_id: localB.variante.id, cantidad: 1 },
        ],
      },
      { 'Idempotency-Key': clave() },
    );

    assert.equal(r.status, 422, JSON.stringify(r.body));
    assert.equal(r.body.error.codigo, 'efectivo_un_solo_local');
  });
});

describe('aceptacion de un pedido en efectivo', () => {
  test('descuenta el stock y deja el sub-pedido en preparando', CON_BASE, async () => {
    const { vendedor, subPedido, variante } = await pedidoEfectivo();

    const r = await vendedor.cliente.post(
      `/api/v1/sub-pedidos/${subPedido.id}/aceptar`,
    );

    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.estado, 'preparando');

    const varianteDespues = await prisma.productoVariante.findUnique({
      where: { id: variante.id },
    });
    assert.equal(varianteDespues.stock, 7);
  });

  test('dos aceptaciones simultaneas descuentan stock una sola vez', CON_BASE, async () => {
    const { vendedor, subPedido, variante } = await pedidoEfectivo();
    const actor = { id: vendedor.id, roles: ['vendedor'] };

    const resultados = await Promise.allSettled([
      aceptarSubPedido({ usuario: actor, id: subPedido.id }),
      aceptarSubPedido({ usuario: actor, id: subPedido.id }),
    ]);

    const exitosas = resultados.filter((r) => r.status === 'fulfilled');
    const fallidas = resultados.filter((r) => r.status === 'rejected');

    assert.equal(exitosas.length, 1);
    assert.equal(fallidas.length, 1);
    assert.equal(fallidas[0].reason.codigo, 'transicion_invalida');

    const varianteDespues = await prisma.productoVariante.findUnique({
      where: { id: variante.id },
    });
    assert.equal(varianteDespues.stock, 7);

    const subDespues = await prisma.subPedido.findUnique({
      where: { id: subPedido.id },
    });
    assert.equal(subDespues.estado, 'preparando');
  });

  test('si no hay stock cancela el pedido, rechaza el pago y no descuenta', CON_BASE, async () => {
    const { vendedor, subPedido, pedido, variante } = await pedidoEfectivo();
    await ajustarStock(prisma, variante.id, -8);

    const r = await vendedor.cliente.post(
      `/api/v1/sub-pedidos/${subPedido.id}/aceptar`,
    );

    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.error.codigo, 'stock_insuficiente');

    const varianteDespues = await prisma.productoVariante.findUnique({
      where: { id: variante.id },
    });
    assert.equal(varianteDespues.stock, 2);

    const subDespues = await prisma.subPedido.findUnique({
      where: { id: subPedido.id },
    });
    const pedidoDespues = await prisma.pedido.findUnique({
      where: { id: pedido.id },
      include: { pagos: true },
    });

    assert.equal(subDespues.estado, 'cancelado');
    assert.equal(pedidoDespues.estado, 'cancelado');
    assert.equal(pedidoDespues.pagos.length, 1);
    assert.equal(pedidoDespues.pagos[0].estado, 'rechazado');
  });
});

export { montarCatalogo, cuerpoCheckout, clave, pedidoEfectivo };
