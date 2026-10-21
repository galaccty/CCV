import '../helpers/entorno.js';
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { estadoInvariante } from '../helpers/pendiente.js';
import { opcionesConBase, prisma, cerrarConexion } from '../helpers/base.js';
import { crearUsuarioConSesion } from '../helpers/http.js';
import { crearCatalogo } from '../helpers/datos.js';

/**
 * INVARIANTE 12 - todo monto que aparece en pantalla se calcula en el backend.
 *
 * El cuerpo del checkout solo aporta variante_id y cantidad. Cualquier precio,
 * subtotal, comision o total que mande el cliente se ignora. Los valores que
 * se guardan y se devuelven salen de la base y de la configuracion del servidor.
 */

export const ESTADO = estadoInvariante({
  aplica: true,
  etapa: 'Etapa 2',
  motivo: 'El checkout ya calcula precios, comision, envio y total en el backend.',
});

const CON_BASE = await opcionesConBase();

after(async () => {
  await cerrarConexion();
});

function claveUnica(prefijo = 'montos') {
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

describe('invariante 12 - los montos se calculan en el backend', () => {
  test('el backend ignora el precio que manda el frontend', CON_BASE, async () => {
    const comprador = await crearUsuarioConSesion();
    const { variante } = await crearCatalogo({ precio: 10000n });

    const r = await comprador.cliente.post(
      '/api/v1/pedidos',
      cuerpoCheckout(variante.id, 3, {
        total: 1,
        subtotal: 1,
        comision: 999999,
        items: [
          {
            variante_id: variante.id,
            cantidad: 3,
            precio_unitario: 1,
            precio: 1,
            subtotal: 3,
          },
        ],
      }),
      { 'Idempotency-Key': claveUnica() },
    );

    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.total, 32000);
    assert.equal(r.body.sub_pedidos[0].subtotal_productos, 30000);
    assert.equal(r.body.sub_pedidos[0].comision, 2000);
    assert.equal(r.body.sub_pedidos[0].costo_envio, 2000);
    assert.equal(r.body.sub_pedidos[0].detalles[0].precio_unitario, 10000);
  });

  test('el total guardado es la suma de los totales de los sub_pedidos', CON_BASE, async () => {
    const comprador = await crearUsuarioConSesion();
    const { variante } = await crearCatalogo({ precio: 10000n });

    const r = await comprador.cliente.post(
      '/api/v1/pedidos',
      cuerpoCheckout(variante.id, 3),
      { 'Idempotency-Key': claveUnica() },
    );

    assert.equal(r.status, 201);

    const pedidoDb = await prisma.pedido.findUnique({
      where: { id: r.body.id },
      include: { subPedidos: { include: { detalles: true } } },
    });

    const suma = pedidoDb.subPedidos.reduce(
      (acumulado, sub) => acumulado + sub.total,
      0n,
    );

    assert.equal(pedidoDb.total, 32000n);
    assert.equal(pedidoDb.total, suma);

    const sub = pedidoDb.subPedidos[0];
    assert.equal(
      sub.total,
      sub.subtotalProductos + sub.costoEnvio,
    );
    assert.equal(
      sub.detalles[0].precioUnitario * BigInt(sub.detalles[0].cantidad),
      sub.subtotalProductos,
    );

    // Lo que se devuelve por la API es exactamente lo guardado.
    assert.equal(r.body.total, Number(pedidoDb.total));
    assert.equal(
      r.body.sub_pedidos[0].total,
      Number(pedidoDb.subPedidos[0].total),
    );
  });

  test('dos variantes con precios distintos se cobran a precio de base', CON_BASE, async () => {
    const comprador = await crearUsuarioConSesion();
    const { variante: barata } = await crearCatalogo({ precio: 10000n });
    const { variante: cara } = await crearCatalogo({ precio: 25000n });

    // Dos locales distintos no se permiten en esta etapa, asi que se usa una
    // sola linea para comprobar que el precio no viene del cliente.
    const r = await comprador.cliente.post(
      '/api/v1/pedidos',
      cuerpoCheckout(cara.id, 2, {
        items: [
          { variante_id: cara.id, cantidad: 2, precio_unitario: 1 },
        ],
      }),
      { 'Idempotency-Key': claveUnica() },
    );

    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.sub_pedidos[0].detalles[0].precio_unitario, 25000);
    assert.equal(r.body.sub_pedidos[0].subtotal_productos, 50000);

    // La otra variante conserva su propio precio en la base.
    const barataDb = await prisma.productoVariante.findUnique({
      where: { id: barata.id },
    });
    assert.equal(barataDb.precio, 10000n);
  });
});
