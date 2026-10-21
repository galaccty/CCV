import './helpers/entorno.js';
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { opcionesConBase, prisma, cerrarConexion } from './helpers/base.js';
import { cliente, crearUsuarioConSesion } from './helpers/http.js';
import { crearCatalogo } from './helpers/datos.js';

/**
 * CARRITO MULTI-LOCAL - ETAPA 3
 * =============================
 * El carrito guarda una fila por variante. La cantidad de PUT es absoluta.
 * No reserva stock y el checkout vuelve a validar todo.
 */

const CON_BASE = await opcionesConBase();

after(async () => {
  await cerrarConexion();
});

describe('carrito', () => {
  test('exige sesion', CON_BASE, async () => {
    const { variante } = await crearCatalogo();
    const r = await cliente().put(`/api/v1/carrito/items/${variante.id}`, {
      cantidad: 1,
    });
    assert.equal(r.status, 401);
  });

  test('agrega, reemplaza y elimina items de varios locales', CON_BASE, async () => {
    const comprador = await crearUsuarioConSesion();
    const uno = await crearCatalogo({ precio: 10000n, stockInicial: 10 });
    const dos = await crearCatalogo({ precio: 20000n, stockInicial: 10 });

    const primero = await comprador.cliente.put(
      `/api/v1/carrito/items/${uno.variante.id}`,
      { cantidad: 2 },
    );
    assert.equal(primero.status, 200, JSON.stringify(primero.body));
    assert.equal(primero.body.items.length, 1);
    assert.equal(primero.body.items[0].cantidad, 2);
    assert.equal(primero.body.items[0].precio_unitario, 10000);
    assert.equal(primero.body.items[0].subtotal, 20000);
    assert.equal(primero.body.total_productos, 20000);
    assert.equal(primero.body.items[0].disponible, true);

    const segundo = await comprador.cliente.put(
      `/api/v1/carrito/items/${dos.variante.id}`,
      { cantidad: 1 },
    );
    assert.equal(segundo.status, 200);
    assert.equal(segundo.body.items.length, 2);
    assert.equal(segundo.body.total_productos, 40000);

    // La cantidad es absoluta, no incremental.
    const reemplazo = await comprador.cliente.put(
      `/api/v1/carrito/items/${uno.variante.id}`,
      { cantidad: 4 },
    );
    assert.equal(reemplazo.status, 200);
    const itemUno = reemplazo.body.items.find(
      (item) => item.variante_id === uno.variante.id,
    );
    assert.equal(itemUno.cantidad, 4);
    assert.equal(reemplazo.body.total_productos, 60000);

    const consulta = await comprador.cliente.get('/api/v1/carrito');
    assert.equal(consulta.status, 200);
    assert.equal(consulta.body.items.length, 2);

    const borrarUno = await comprador.cliente.delete(
      `/api/v1/carrito/items/${uno.variante.id}`,
    );
    assert.equal(borrarUno.status, 204);

    const queda = await comprador.cliente.get('/api/v1/carrito');
    assert.equal(queda.body.items.length, 1);
    assert.equal(queda.body.items[0].variante_id, dos.variante.id);

    const vaciar = await comprador.cliente.delete('/api/v1/carrito');
    assert.equal(vaciar.status, 204);

    const vacio = await comprador.cliente.get('/api/v1/carrito');
    assert.deepEqual(vacio.body.items, []);
    assert.equal(vacio.body.total_productos, 0);
  });

  test('marca como no disponible un item sin stock suficiente', CON_BASE, async () => {
    const comprador = await crearUsuarioConSesion();
    const { variante } = await crearCatalogo({
      precio: 10000n,
      stockInicial: 1,
    });

    const r = await comprador.cliente.put(
      `/api/v1/carrito/items/${variante.id}`,
      { cantidad: 2 },
    );
    assert.equal(r.status, 200);
    assert.equal(r.body.items[0].disponible, false);
  });

  test('rechaza variantes inactivas, locales que no venden y variantes inexistentes', CON_BASE, async () => {
    const comprador = await crearUsuarioConSesion();
    const inactiva = await crearCatalogo({ activoVariante: false });
    const bloqueado = await crearCatalogo({ estadoLocal: 'bloqueado' });

    const porInactiva = await comprador.cliente.put(
      `/api/v1/carrito/items/${inactiva.variante.id}`,
      { cantidad: 1 },
    );
    assert.equal(porInactiva.status, 422);
    assert.equal(porInactiva.body.error.codigo, 'variante_no_disponible');

    const porLocal = await comprador.cliente.put(
      `/api/v1/carrito/items/${bloqueado.variante.id}`,
      { cantidad: 1 },
    );
    assert.equal(porLocal.status, 422);
    assert.equal(porLocal.body.error.codigo, 'variante_no_disponible');

    const inexistente = await comprador.cliente.put(
      '/api/v1/carrito/items/99999999',
      { cantidad: 1 },
    );
    assert.equal(inexistente.status, 404);
  });

  test('rechaza cantidades invalidas', CON_BASE, async () => {
    const comprador = await crearUsuarioConSesion();
    const { variante } = await crearCatalogo();

    for (const cantidad of [0, -1, 1000]) {
      const r = await comprador.cliente.put(
        `/api/v1/carrito/items/${variante.id}`,
        { cantidad },
      );
      assert.equal(r.status, 400, String(cantidad));
      assert.equal(r.body.error.codigo, 'validacion_invalida');
    }
  });

  test('la base rechaza cantidades fuera del rango', CON_BASE, async () => {
    const comprador = await crearUsuarioConSesion();
    const { variante } = await crearCatalogo();
    const carrito = await prisma.carrito.create({
      data: { usuarioId: comprador.id },
    });

    await assert.rejects(
      () =>
        prisma.carritoItem.create({
          data: { carritoId: carrito.id, varianteId: variante.id, cantidad: 0 },
        }),
      /carrito_item_cantidad_valida/i,
    );
  });
});
