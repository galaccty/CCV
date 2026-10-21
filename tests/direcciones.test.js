import './helpers/entorno.js';
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { opcionesConBase, prisma, cerrarConexion } from './helpers/base.js';
import { cliente, crearUsuarioConSesion } from './helpers/http.js';

/**
 * DIRECCIONES DEL COMPRADOR - ETAPA 3B
 * =====================================
 * Las coordenadas llegan del frontend. El backend valida el rango de Colombia
 * y solo permite operar sobre direcciones propias.
 */

const CON_BASE = await opcionesConBase();

after(async () => {
  await cerrarConexion();
});

const DIRECCION = {
  texto: 'Calle 1 # 2-3, Bogota',
  latitud: 4.65,
  longitud: -74.05,
};

describe('CRUD de direcciones', () => {
  test('exige sesion', CON_BASE, async () => {
    const anonimo = cliente();
    const lista = await anonimo.get('/api/v1/direcciones');
    const crear = await anonimo.post('/api/v1/direcciones', DIRECCION);

    assert.equal(lista.status, 401);
    assert.equal(crear.status, 401);
  });

  test('crea, lista, edita, marca principal y elimina direcciones propias', CON_BASE, async () => {
    const comprador = await crearUsuarioConSesion();

    const primera = await comprador.cliente.post('/api/v1/direcciones', {
      ...DIRECCION,
      texto: 'Casa principal',
    });
    assert.equal(primera.status, 201, JSON.stringify(primera.body));
    assert.equal(primera.body.principal, true);
    assert.equal(primera.body.usuario_id, comprador.id);

    const segunda = await comprador.cliente.post('/api/v1/direcciones', {
      ...DIRECCION,
      texto: 'Oficina',
      latitud: 4.66,
      longitud: -74.06,
    });
    assert.equal(segunda.status, 201);
    assert.equal(segunda.body.principal, false);

    const lista = await comprador.cliente.get('/api/v1/direcciones');
    assert.equal(lista.status, 200);
    assert.deepEqual(
      lista.body.datos.map((d) => d.id),
      [primera.body.id, segunda.body.id],
    );

    const editada = await comprador.cliente.patch(
      `/api/v1/direcciones/${segunda.body.id}`,
      { texto: 'Oficina nueva', latitud: 4.67, longitud: -74.07 },
    );
    assert.equal(editada.status, 200);
    assert.equal(editada.body.texto, 'Oficina nueva');
    assert.equal(editada.body.latitud, 4.67);
    assert.equal(editada.body.longitud, -74.07);

    const principal = await comprador.cliente.patch(
      `/api/v1/direcciones/${segunda.body.id}/principal`,
      {},
    );
    assert.equal(principal.status, 200);
    assert.equal(principal.body.principal, true);

    const principales = await prisma.direccion.count({
      where: { usuarioId: comprador.id, principal: true },
    });
    assert.equal(principales, 1);

    const listaPrincipal = await comprador.cliente.get('/api/v1/direcciones');
    assert.equal(listaPrincipal.body.datos[0].id, segunda.body.id);

    const borrar = await comprador.cliente.delete(
      `/api/v1/direcciones/${segunda.body.id}`,
    );
    assert.equal(borrar.status, 204);

    const queda = await comprador.cliente.get('/api/v1/direcciones');
    assert.deepEqual(
      queda.body.datos.map((d) => d.id),
      [primera.body.id],
    );
    assert.equal(queda.body.datos[0].principal, false);

    // No se promueve otra automáticamente; la nueva tampoco es principal si
    // ya existe otra dirección, aunque ninguna esté marcada.
    const nueva = await comprador.cliente.post('/api/v1/direcciones', DIRECCION);
    assert.equal(nueva.status, 201);
    assert.equal(nueva.body.principal, false);
  });

  test('no permite leer ni modificar direcciones de otro usuario', CON_BASE, async () => {
    const duenio = await crearUsuarioConSesion();
    const otro = await crearUsuarioConSesion();

    const direccion = await duenio.cliente.post('/api/v1/direcciones', DIRECCION);
    assert.equal(direccion.status, 201);

    const listaOtro = await otro.cliente.get('/api/v1/direcciones');
    assert.equal(listaOtro.status, 200);
    assert.deepEqual(listaOtro.body.datos, []);

    const editar = await otro.cliente.patch(
      `/api/v1/direcciones/${direccion.body.id}`,
      { texto: 'Intento ajeno' },
    );
    assert.equal(editar.status, 404);

    const marcar = await otro.cliente.patch(
      `/api/v1/direcciones/${direccion.body.id}/principal`,
      {},
    );
    assert.equal(marcar.status, 404);

    const borrar = await otro.cliente.delete(
      `/api/v1/direcciones/${direccion.body.id}`,
    );
    assert.equal(borrar.status, 404);

    const listaDuenio = await duenio.cliente.get('/api/v1/direcciones');
    assert.equal(listaDuenio.body.datos.length, 1);
    assert.equal(listaDuenio.body.datos[0].texto, DIRECCION.texto);
    assert.equal(listaDuenio.body.datos[0].principal, true);
  });

  test('valida las coordenadas y los campos obligatorios', CON_BASE, async () => {
    const comprador = await crearUsuarioConSesion();

    const fueraDeColombia = await comprador.cliente.post(
      '/api/v1/direcciones',
      { ...DIRECCION, latitud: 20 },
    );
    assert.equal(fueraDeColombia.status, 400);

    const textoCorto = await comprador.cliente.post('/api/v1/direcciones', {
      ...DIRECCION,
      texto: 'x',
    });
    assert.equal(textoCorto.status, 400);

    const valida = await comprador.cliente.post('/api/v1/direcciones', DIRECCION);
    assert.equal(valida.status, 201);

    const actualizacionInvalida = await comprador.cliente.patch(
      `/api/v1/direcciones/${valida.body.id}`,
      { longitud: -100 },
    );
    assert.equal(actualizacionInvalida.status, 400);

    const cuerpoVacio = await comprador.cliente.patch(
      `/api/v1/direcciones/${valida.body.id}`,
      {},
    );
    assert.equal(cuerpoVacio.status, 400);
  });

  test('la base impide dos direcciones principales para el mismo usuario', CON_BASE, async () => {
    const comprador = await crearUsuarioConSesion();
    await prisma.direccion.create({
      data: { usuarioId: comprador.id, ...DIRECCION, principal: true },
    });

    await assert.rejects(
      () =>
        prisma.direccion.create({
          data: {
            usuarioId: comprador.id,
            ...DIRECCION,
            texto: 'Otra principal',
            principal: true,
          },
        }),
      /direccion_principal_por_usuario|unique/i,
    );
  });
});
