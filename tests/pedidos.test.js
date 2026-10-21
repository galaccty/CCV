import './helpers/entorno.js';
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { opcionesConBase, prisma, cerrarConexion } from './helpers/base.js';
import { cliente, crearUsuarioConSesion } from './helpers/http.js';
import { crearCatalogo } from './helpers/datos.js';

/**
 * CHECKOUT - ETAPA 2
 * ==================
 * El backend calcula todo. El cliente solo manda variante_id y cantidad.
 * El stock se verifica, pero no se descuenta hasta que el pago se confirme.
 */

const CON_BASE = await opcionesConBase();

after(async () => {
  await cerrarConexion();
});

function claveUnica(prefijo = 'pedido') {
  return `${prefijo}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function cuerpoCheckout(varianteId, cantidad = 3, extra = {}) {
  return {
    direccion: {
      texto: 'Calle 1 # 2-3, Bogota',
      latitud: 4.65,
      longitud: -74.05,
    },
    metodo_pago: 'tarjeta',
    items: [{ variante_id: varianteId, cantidad }],
    ...extra,
  };
}

describe('POST /api/v1/pedidos', () => {
  test('exige sesion', CON_BASE, async () => {
    const { variante } = await crearCatalogo();

    const r = await cliente().post('/api/v1/pedidos', cuerpoCheckout(variante.id), {
      'Idempotency-Key': claveUnica(),
    });

    assert.equal(r.status, 401);
    assert.equal(r.body.error.codigo, 'no_autenticado');
  });

  test('exige la cabecera Idempotency-Key', CON_BASE, async () => {
    const comprador = await crearUsuarioConSesion();
    const { variante } = await crearCatalogo();

    const r = await comprador.cliente.post(
      '/api/v1/pedidos',
      cuerpoCheckout(variante.id),
    );

    assert.equal(r.status, 400);
    assert.equal(r.body.error.codigo, 'validacion_invalida');
  });

  test('calcula subtotal, comision, envio y total en el backend', CON_BASE, async () => {
    const comprador = await crearUsuarioConSesion();
    const { variante, local } = await crearCatalogo({ precio: 10000n, stockInicial: 10 });

    const r = await comprador.cliente.post(
      '/api/v1/pedidos',
      cuerpoCheckout(variante.id, 3),
      { 'Idempotency-Key': claveUnica() },
    );

    assert.equal(r.status, 201, JSON.stringify(r.body));

    const pedido = r.body;
    assert.equal(pedido.estado, 'pendiente_pago');
    assert.equal(pedido.total, 32000);
    assert.equal(pedido.sub_pedidos.length, 1);

    const sub = pedido.sub_pedidos[0];
    assert.equal(sub.local_id, local.id);
    assert.equal(sub.subtotal_productos, 30000);
    assert.equal(sub.comision, 2000);
    assert.equal(sub.costo_envio, 2000);
    assert.equal(sub.total, 32000);
    assert.equal(sub.estado, 'pendiente');
    assert.equal(sub.detalles.length, 1);
    assert.equal(sub.detalles[0].precio_unitario, 10000);
    assert.equal(sub.detalles[0].cantidad, 3);
    assert.equal(sub.detalles[0].nombre_producto.length > 0, true);

    assert.equal(pedido.config_snapshot.porcentaje_comision, 5);
    assert.equal(pedido.config_snapshot.comision_minima, 2000);
    assert.equal(pedido.config_snapshot.pedido_minimo, 30000);
    assert.equal(pedido.config_snapshot.tarifa_base_envio, 2000);
    assert.equal(pedido.config_snapshot.tarifa_por_km, 800);
    assert.equal(pedido.config_snapshot.dias_retencion, 5);

    const guardado = await prisma.pedido.findUnique({
      where: { id: pedido.id },
      include: { subPedidos: { include: { detalles: true } } },
    });
    assert.equal(guardado.total, 32000n);
    assert.equal(guardado.subPedidos[0].subtotalProductos, 30000n);
    assert.equal(guardado.subPedidos[0].comision, 2000n);
    assert.equal(guardado.subPedidos[0].detalles[0].precioUnitario, 10000n);

    // El checkout NO descuenta stock.
    const varianteGuardada = await prisma.productoVariante.findUnique({
      where: { id: variante.id },
    });
    assert.equal(varianteGuardada.stock, 10);
  });

  test('ignora cualquier monto que mande el cliente', CON_BASE, async () => {
    const comprador = await crearUsuarioConSesion();
    const { variante } = await crearCatalogo({ precio: 10000n });

    const r = await comprador.cliente.post(
      '/api/v1/pedidos',
      cuerpoCheckout(variante.id, 3, {
        total: 1,
        subtotal: 1,
        comision: 0,
        items: [
          {
            variante_id: variante.id,
            cantidad: 3,
            precio_unitario: 1,
            subtotal: 1,
          },
        ],
      }),
      { 'Idempotency-Key': claveUnica() },
    );

    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.total, 32000);
    assert.equal(r.body.sub_pedidos[0].subtotal_productos, 30000);
    assert.equal(r.body.sub_pedidos[0].comision, 2000);
    assert.equal(r.body.sub_pedidos[0].detalles[0].precio_unitario, 10000);
  });

  test('rechaza stock insuficiente sin descontar nada', CON_BASE, async () => {
    const comprador = await crearUsuarioConSesion();
    const { variante } = await crearCatalogo({ precio: 10000n, stockInicial: 2 });

    const r = await comprador.cliente.post(
      '/api/v1/pedidos',
      cuerpoCheckout(variante.id, 3),
      { 'Idempotency-Key': claveUnica() },
    );

    assert.equal(r.status, 422);
    assert.equal(r.body.error.codigo, 'stock_insuficiente');
    assert.equal(r.body.error.detalles[0].disponible, 2);
    assert.equal(r.body.error.detalles[0].pedido, 3);

    const guardada = await prisma.productoVariante.findUnique({
      where: { id: variante.id },
    });
    assert.equal(guardada.stock, 2);

    const pedidos = await prisma.pedido.count({
      where: { usuarioId: comprador.id },
    });
    assert.equal(pedidos, 0);
  });

  test('rechaza un pedido por debajo del minimo', CON_BASE, async () => {
    const comprador = await crearUsuarioConSesion();
    const { variante } = await crearCatalogo({ precio: 10000n });

    const r = await comprador.cliente.post(
      '/api/v1/pedidos',
      cuerpoCheckout(variante.id, 1),
      { 'Idempotency-Key': claveUnica() },
    );

    assert.equal(r.status, 422);
    assert.equal(r.body.error.codigo, 'pedido_minimo_no_alcanzado');
    assert.equal(r.body.error.detalles.minimo, 30000);
    assert.equal(r.body.error.detalles.subtotal, 10000);
  });

  test('rechaza productos de locales distintos en esta etapa', CON_BASE, async () => {
    const comprador = await crearUsuarioConSesion();
    const uno = await crearCatalogo({ precio: 20000n });
    const dos = await crearCatalogo({ precio: 20000n });

    const r = await comprador.cliente.post(
      '/api/v1/pedidos',
      {
        ...cuerpoCheckout(uno.variante.id, 2),
        items: [
          { variante_id: uno.variante.id, cantidad: 2 },
          { variante_id: dos.variante.id, cantidad: 2 },
        ],
      },
      { 'Idempotency-Key': claveUnica() },
    );

    assert.equal(r.status, 422);
    assert.equal(r.body.error.codigo, 'varios_locales_no_soportado');
  });

  test('rechaza una variante inactiva', CON_BASE, async () => {
    const comprador = await crearUsuarioConSesion();
    const { variante } = await crearCatalogo({
      precio: 10000n,
      activoVariante: false,
    });

    const r = await comprador.cliente.post(
      '/api/v1/pedidos',
      cuerpoCheckout(variante.id, 3),
      { 'Idempotency-Key': claveUnica() },
    );

    assert.equal(r.status, 422);
    assert.equal(r.body.error.codigo, 'variante_no_disponible');
  });

  test('repetir la misma clave devuelve el mismo pedido y no crea otro', CON_BASE, async () => {
    const comprador = await crearUsuarioConSesion();
    const { variante } = await crearCatalogo({ precio: 10000n });
    const clave = claveUnica('repetida');
    const cuerpo = cuerpoCheckout(variante.id, 3);

    const primera = await comprador.cliente.post('/api/v1/pedidos', cuerpo, {
      'Idempotency-Key': clave,
    });
    const segunda = await comprador.cliente.post('/api/v1/pedidos', cuerpo, {
      'Idempotency-Key': clave,
    });

    assert.equal(primera.status, 201, JSON.stringify(primera.body));
    assert.equal(segunda.status, 201, JSON.stringify(segunda.body));
    assert.equal(segunda.body.id, primera.body.id);

    const total = await prisma.pedido.count({
      where: { usuarioId: comprador.id },
    });
    assert.equal(total, 1);
  });

  test('la misma clave de dos usuarios distintos crea dos pedidos', CON_BASE, async () => {
    const uno = await crearUsuarioConSesion();
    const dos = await crearUsuarioConSesion();
    const catalogo = await crearCatalogo({ precio: 10000n });
    const clave = claveUnica('misma-clave');

    const a = await uno.cliente.post(
      '/api/v1/pedidos',
      cuerpoCheckout(catalogo.variante.id, 3),
      { 'Idempotency-Key': clave },
    );
    const b = await dos.cliente.post(
      '/api/v1/pedidos',
      cuerpoCheckout(catalogo.variante.id, 3),
      { 'Idempotency-Key': clave },
    );

    assert.equal(a.status, 201);
    assert.equal(b.status, 201);
    assert.notEqual(a.body.id, b.body.id);
  });
});

describe('GET /api/v1/pedidos', () => {
  test('lista solo los pedidos del usuario y pagina', CON_BASE, async () => {
    const comprador = await crearUsuarioConSesion();
    const otro = await crearUsuarioConSesion();
    const { variante } = await crearCatalogo({ precio: 10000n });

    const creado = await comprador.cliente.post(
      '/api/v1/pedidos',
      cuerpoCheckout(variante.id, 3),
      { 'Idempotency-Key': claveUnica() },
    );
    assert.equal(creado.status, 201);

    const lista = await comprador.cliente.get('/api/v1/pedidos?pagina=1&por_pagina=5');
    assert.equal(lista.status, 200);
    assert.equal(lista.body.paginacion.pagina, 1);
    assert.equal(lista.body.paginacion.por_pagina, 5);
    assert.equal(lista.body.paginacion.total, 1);
    assert.equal(lista.body.datos[0].id, creado.body.id);

    const listaOtro = await otro.cliente.get('/api/v1/pedidos');
    assert.equal(listaOtro.status, 200);
    assert.equal(listaOtro.body.paginacion.total, 0);
  });

  test('el detalle solo lo ve su dueno', CON_BASE, async () => {
    const comprador = await crearUsuarioConSesion();
    const otro = await crearUsuarioConSesion();
    const { variante } = await crearCatalogo({ precio: 10000n });

    const creado = await comprador.cliente.post(
      '/api/v1/pedidos',
      cuerpoCheckout(variante.id, 3),
      { 'Idempotency-Key': claveUnica() },
    );

    const propio = await comprador.cliente.get(`/api/v1/pedidos/${creado.body.id}`);
    assert.equal(propio.status, 200);
    assert.equal(propio.body.id, creado.body.id);

    const ajeno = await otro.cliente.get(`/api/v1/pedidos/${creado.body.id}`);
    assert.equal(ajeno.status, 404);
  });
});
