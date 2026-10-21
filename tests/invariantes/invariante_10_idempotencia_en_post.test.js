import '../helpers/entorno.js';
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { estadoInvariante } from '../helpers/pendiente.js';
import { opcionesConBase, prisma, cerrarConexion } from '../helpers/base.js';
import { crearUsuarioConSesion } from '../helpers/http.js';
import { crearCatalogo } from '../helpers/datos.js';

/**
 * INVARIANTE 10 - todo POST que crea pedido o pago exige Idempotency-Key.
 *
 *   - Sin cabecera: 400 y no se crea nada.
 *   - Misma clave: se devuelve la respuesta guardada, no se ejecuta de nuevo.
 *   - Primera peticion en vuelo: 409 solicitud_en_proceso.
 *   - La clave es unica por usuario y ruta: dos usuarios o dos rutas no chocan.
 */

export const ESTADO = estadoInvariante({
  aplica: true,
  etapa: 'Etapa 2',
  motivo: 'Los POST de pedido y pago y la tabla idempotencia ya existen.',
});

const CON_BASE = await opcionesConBase();

after(async () => {
  await cerrarConexion();
});

function claveUnica(prefijo = 'idem') {
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

describe('invariante 10 - Idempotency-Key en los POST que crean pedido o pago', () => {
  test('sin la cabecera responde 400', CON_BASE, async () => {
    const comprador = await crearUsuarioConSesion();
    const { variante } = await crearCatalogo({ precio: 10000n });

    const r = await comprador.cliente.post(
      '/api/v1/pedidos',
      cuerpoCheckout(variante.id),
    );

    assert.equal(r.status, 400);
    assert.equal(r.body.error.codigo, 'validacion_invalida');

    const pedidos = await prisma.pedido.count({
      where: { usuarioId: comprador.id },
    });
    assert.equal(pedidos, 0);
  });

  test('dos veces con la misma clave crea un solo pedido', CON_BASE, async () => {
    const comprador = await crearUsuarioConSesion();
    const { variante } = await crearCatalogo({ precio: 10000n });
    const clave = claveUnica();
    const cuerpo = cuerpoCheckout(variante.id);

    const primera = await comprador.cliente.post('/api/v1/pedidos', cuerpo, {
      'Idempotency-Key': clave,
    });
    const segunda = await comprador.cliente.post('/api/v1/pedidos', cuerpo, {
      'Idempotency-Key': clave,
    });

    assert.equal(primera.status, 201);
    assert.equal(segunda.status, 201);
    assert.equal(segunda.body.id, primera.body.id);

    const pedidos = await prisma.pedido.count({
      where: { usuarioId: comprador.id },
    });
    assert.equal(pedidos, 1);

    const fila = await prisma.idempotencia.findFirst({
      where: { usuarioId: comprador.id, clave },
    });
    assert.equal(fila.estado, 'completada');
    assert.equal(fila.codigoHttp, 201);
    assert.equal(fila.respuestaJson.id, primera.body.id);
  });

  test('con la primera peticion en vuelo responde 409', CON_BASE, async () => {
    const comprador = await crearUsuarioConSesion();
    const { variante } = await crearCatalogo({ precio: 10000n });
    const clave = claveUnica('en-vuelo');

    await prisma.idempotencia.create({
      data: {
        clave,
        usuarioId: comprador.id,
        ruta: 'POST /api/v1/pedidos',
        estado: 'en_proceso',
        expira: new Date(Date.now() + 60 * 60 * 1000),
      },
    });

    const r = await comprador.cliente.post(
      '/api/v1/pedidos',
      cuerpoCheckout(variante.id),
      { 'Idempotency-Key': clave },
    );

    assert.equal(r.status, 409);
    assert.equal(r.body.error.codigo, 'solicitud_en_proceso');

    const pedidos = await prisma.pedido.count({
      where: { usuarioId: comprador.id },
    });
    assert.equal(pedidos, 0);
  });

  test('un error 4xx se guarda como completado y se repite igual', CON_BASE, async () => {
    const comprador = await crearUsuarioConSesion();
    const { variante } = await crearCatalogo({ precio: 10000n });
    const clave = claveUnica('error-4xx');
    const cuerpoInvalido = { ...cuerpoCheckout(variante.id), items: [] };

    const primera = await comprador.cliente.post(
      '/api/v1/pedidos',
      cuerpoInvalido,
      { 'Idempotency-Key': clave },
    );
    const segunda = await comprador.cliente.post(
      '/api/v1/pedidos',
      cuerpoInvalido,
      { 'Idempotency-Key': clave },
    );

    assert.equal(primera.status, 400);
    assert.equal(segunda.status, 400);
    assert.deepEqual(segunda.body, primera.body);

    const fila = await prisma.idempotencia.findFirst({
      where: { usuarioId: comprador.id, clave },
    });
    assert.equal(fila.estado, 'completada');
    assert.equal(fila.codigoHttp, 400);
    assert.equal(fila.respuestaJson.error.codigo, 'validacion_invalida');

    const pedidos = await prisma.pedido.count({
      where: { usuarioId: comprador.id },
    });
    assert.equal(pedidos, 0);
  });

  test('la clave es unica por usuario y ruta', CON_BASE, async () => {
    const uno = await crearUsuarioConSesion();
    const dos = await crearUsuarioConSesion();
    const { variante } = await crearCatalogo({ precio: 10000n });
    const clave = claveUnica('compartida');

    const primero = await uno.cliente.post(
      '/api/v1/pedidos',
      cuerpoCheckout(variante.id),
      { 'Idempotency-Key': clave },
    );
    const segundo = await dos.cliente.post(
      '/api/v1/pedidos',
      cuerpoCheckout(variante.id),
      { 'Idempotency-Key': clave },
    );

    assert.equal(primero.status, 201);
    assert.equal(segundo.status, 201);
    assert.notEqual(primero.body.id, segundo.body.id);

    // La MISMA clave en otra ruta (crear el pago) no puede chocar con la del
    // checkout: la unicidad es (usuario, ruta, clave).
    const pago = await uno.cliente.post(
      `/api/v1/pedidos/${primero.body.id}/pagos`,
      undefined,
      { 'Idempotency-Key': clave },
    );

    assert.equal(pago.status, 201, JSON.stringify(pago.body));
    assert.equal(pago.body.pago.pedido_id, primero.body.id);
  });
});
