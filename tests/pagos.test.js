import './helpers/entorno.js';
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { opcionesConBase, prisma, cerrarConexion } from './helpers/base.js';
import { crearUsuarioConSesion } from './helpers/http.js';
import { crearCatalogo } from './helpers/datos.js';
import { auditoriaWompiFalsa } from '../src/services/pagos.js';

/**
 * PAGOS - ETAPA 2
 * ===============
 * Crear un pago no llama a Wompi: devuelve los datos firmados del Web
 * Checkout. La referencia la genera el backend y el monto sale del pedido.
 */

const CON_BASE = await opcionesConBase();

after(async () => {
  await cerrarConexion();
});

function claveUnica(prefijo = 'pago') {
  return `${prefijo}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function cuerpoCheckout(varianteId, cantidad = 3) {
  return {
    direccion: {
      texto: 'Calle 1 # 2-3, Bogota',
      latitud: 4.65,
      longitud: -74.05,
    },
    metodo_pago: 'tarjeta',
    items: [{ variante_id: varianteId, cantidad }],
  };
}

async function crearPedidoPagable({ comprador, variante, cantidad = 3 }) {
  const r = await comprador.cliente.post(
    '/api/v1/pedidos',
    cuerpoCheckout(variante.id, cantidad),
    { 'Idempotency-Key': claveUnica('checkout') },
  );

  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
}

describe('POST /api/v1/pedidos/{id}/pagos', () => {
  test('crea el pago pendiente y devuelve el checkout firmado', CON_BASE, async () => {
    const comprador = await crearUsuarioConSesion();
    const { variante } = await crearCatalogo({ precio: 10000n });
    const pedido = await crearPedidoPagable({ comprador, variante });

    const r = await comprador.cliente.post(
      `/api/v1/pedidos/${pedido.id}/pagos`,
      undefined,
      { 'Idempotency-Key': claveUnica() },
    );

    assert.equal(r.status, 201, JSON.stringify(r.body));

    const { pago, checkout } = r.body;
    assert.equal(pago.pedido_id, pedido.id);
    assert.equal(pago.monto, 32000);
    assert.equal(pago.monto_reembolsado, 0);
    assert.equal(pago.estado, 'pendiente');
    assert.equal(pago.metodo_pago, 'tarjeta');
    assert.match(pago.referencia, /^CCV-[0-9a-f]{32}$/);

    assert.equal(checkout.llave_publica, 'pub_test_falsa');
    assert.equal(checkout.referencia, pago.referencia);
    assert.equal(checkout.monto_en_centavos, 3_200_000);
    assert.equal(checkout.moneda, 'COP');
    assert.match(checkout.firma_integridad, /^[0-9a-f]{64}$/);
    assert.equal(checkout.url_checkout, null, 'el proveedor falso no inventa URL');

    const guardado = await prisma.pago.findUnique({
      where: { id: pago.id },
    });
    assert.equal(guardado.monto, 32000n);
    assert.equal(guardado.estado, 'pendiente');
    assert.equal(guardado.referencia, pago.referencia);
    assert.equal(guardado.idTransaccionWompi, null);

    // El checkout no es una llamada a Wompi: no queda ninguna consulta.
    assert.equal(auditoriaWompiFalsa.length, 0);
  });

  test('repetir la misma clave devuelve el mismo pago', CON_BASE, async () => {
    const comprador = await crearUsuarioConSesion();
    const { variante } = await crearCatalogo({ precio: 10000n });
    const pedido = await crearPedidoPagable({ comprador, variante });
    const clave = claveUnica('repetido');

    const primera = await comprador.cliente.post(
      `/api/v1/pedidos/${pedido.id}/pagos`,
      undefined,
      { 'Idempotency-Key': clave },
    );
    const segunda = await comprador.cliente.post(
      `/api/v1/pedidos/${pedido.id}/pagos`,
      undefined,
      { 'Idempotency-Key': clave },
    );

    assert.equal(primera.status, 201, JSON.stringify(primera.body));
    assert.equal(segunda.status, 201, JSON.stringify(segunda.body));
    assert.equal(segunda.body.pago.id, primera.body.pago.id);

    const pagos = await prisma.pago.count({ where: { pedidoId: pedido.id } });
    assert.equal(pagos, 1);
  });

  test('una clave nueva sobre el mismo pedido da 409', CON_BASE, async () => {
    const comprador = await crearUsuarioConSesion();
    const { variante } = await crearCatalogo({ precio: 10000n });
    const pedido = await crearPedidoPagable({ comprador, variante });

    const primera = await comprador.cliente.post(
      `/api/v1/pedidos/${pedido.id}/pagos`,
      undefined,
      { 'Idempotency-Key': claveUnica() },
    );
    assert.equal(primera.status, 201);

    const segunda = await comprador.cliente.post(
      `/api/v1/pedidos/${pedido.id}/pagos`,
      undefined,
      { 'Idempotency-Key': claveUnica() },
    );

    assert.equal(segunda.status, 409);
    assert.equal(segunda.body.error.codigo, 'pedido_ya_tiene_pago');
  });

  test('exige Idempotency-Key', CON_BASE, async () => {
    const comprador = await crearUsuarioConSesion();
    const { variante } = await crearCatalogo({ precio: 10000n });
    const pedido = await crearPedidoPagable({ comprador, variante });

    const r = await comprador.cliente.post(
      `/api/v1/pedidos/${pedido.id}/pagos`,
      undefined,
    );

    assert.equal(r.status, 400);
    assert.equal(r.body.error.codigo, 'validacion_invalida');
  });

  test('no permite pagar el pedido de otro usuario', CON_BASE, async () => {
    const comprador = await crearUsuarioConSesion();
    const otro = await crearUsuarioConSesion();
    const { variante } = await crearCatalogo({ precio: 10000n });
    const pedido = await crearPedidoPagable({ comprador, variante });

    const r = await otro.cliente.post(
      `/api/v1/pedidos/${pedido.id}/pagos`,
      undefined,
      { 'Idempotency-Key': claveUnica() },
    );

    assert.equal(r.status, 404);
  });

  test('no permite pagar un pedido que ya no esta pendiente', CON_BASE, async () => {
    const comprador = await crearUsuarioConSesion();
    const { variante } = await crearCatalogo({ precio: 10000n });
    const pedido = await crearPedidoPagable({ comprador, variante });

    await prisma.pedido.update({
      where: { id: pedido.id },
      data: { estado: 'en_proceso' },
    });

    const r = await comprador.cliente.post(
      `/api/v1/pedidos/${pedido.id}/pagos`,
      undefined,
      { 'Idempotency-Key': claveUnica() },
    );

    assert.equal(r.status, 422);
    assert.equal(r.body.error.codigo, 'pedido_no_pagable');
  });
});
