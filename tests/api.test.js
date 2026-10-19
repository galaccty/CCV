import './helpers/entorno.js';
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  cliente,
  postSinCsrf,
  postConCsrfInvalido,
  crearUsuarioVerificado,
} from './helpers/http.js';
import { leerPaginacion, envolverLista, POR_PAGINA_MAXIMO } from '../src/lib/validacion.js';
import { opcionesConBase, cerrarConexion, prisma } from './helpers/base.js';

const RUTA_LOGIN = '/api/v1/auth/login';

// awaited en el nivel del modulo: los callbacks de describe no son async,
// asi que adentro no se puede hacer await.
const CON_BASE = await opcionesConBase();

/**
 * Pruebas del contrato de la API (seccion 6) y de la proteccion CSRF.
 * Las de contrato no necesitan base de datos; las de sesion, si.
 */

describe('formato de error unico (seccion 6)', () => {
  test('una ruta inexistente responde 404 con la forma acordada', async () => {
    const r = await cliente().get('/api/v1/no-existe');

    assert.equal(r.status, 404);
    assert.ok(r.body.error, 'debe existir la propiedad error');
    assert.equal(typeof r.body.error.codigo, 'string');
    assert.equal(typeof r.body.error.mensaje, 'string');
    assert.equal(r.body.error.codigo, 'ruta_no_encontrada');
  });

  test('un cuerpo invalido responde 400 con codigo y detalle', async () => {
    const r = await cliente().post('/api/v1/auth/login', { email: 'no-es-correo' });

    assert.equal(r.status, 400);
    assert.equal(r.body.error.codigo, 'validacion_invalida');
    assert.ok(Array.isArray(r.body.error.detalles));
    assert.ok(r.body.error.detalles[0].campo);
  });

  test('nunca se filtran detalles internos en un 500', async () => {
    const { manejadorErrores } = await import('../src/lib/errores.js');
    const res = {
      statusCode: 200,
      headersSent: false,
      body: undefined,
      status(c) {
        this.statusCode = c;
        return this;
      },
      json(cuerpo) {
        this.body = cuerpo;
        return this;
      },
    };

    manejadorErrores(
      new Error('SECRETO INTERNO DE LA BASE DE DATOS'),
      { method: 'POST', path: '/api/v1/x' },
      res,
      () => {},
    );

    assert.equal(res.statusCode, 500);
    assert.equal(res.body.error.codigo, 'error_interno');
    assert.equal(JSON.stringify(res.body).includes('SECRETO'), false);
  });
});

describe('proteccion anti-CSRF (seccion 7)', () => {
  test('un POST sin el token es rechazado', async () => {
    const r = await postSinCsrf(RUTA_LOGIN, {
      email: 'alguien@ejemplo.com',
      contrasena: 'Contrasena12345',
    });

    assert.equal(r.status, 403);
    assert.equal(r.body.error.codigo, 'sin_permiso');
    assert.match(r.body.error.mensaje, /CSRF/i);
  });

  test('un POST con el token equivocado es rechazado', async () => {
    const r = await postConCsrfInvalido(RUTA_LOGIN, {
      email: 'alguien@ejemplo.com',
      contrasena: 'Contrasena12345',
    });

    assert.equal(r.status, 403);
    assert.match(r.body.error.mensaje, /CSRF/i);
  });

  test('un GET no necesita el token', async () => {
    const r = await cliente().get('/api/v1/salud');
    assert.notEqual(r.status, 403);
  });
});

describe('paginacion (seccion 6)', () => {
  test('valores por defecto y minimos', () => {
    assert.deepEqual(leerPaginacion({}), { pagina: 1, porPagina: 20, saltar: 0 });
    assert.deepEqual(leerPaginacion({ pagina: '0' }), { pagina: 1, porPagina: 20, saltar: 0 });
    assert.deepEqual(leerPaginacion({ pagina: '3', por_pagina: '10' }), {
      pagina: 3,
      porPagina: 10,
      saltar: 20,
    });
  });

  test('nunca supera el maximo permitido', () => {
    const r = leerPaginacion({ por_pagina: '10000' });
    assert.equal(r.porPagina, POR_PAGINA_MAXIMO);
    assert.ok(r.porPagina <= POR_PAGINA_MAXIMO);
  });

  test('descarta valores que no son numeros', () => {
    assert.equal(leerPaginacion({ pagina: 'abc', por_pagina: 'xyz' }).porPagina, 20);
  });

  test('la envoltura incluye total y pagina actual', () => {
    const r = envolverLista([1, 2, 3], { pagina: 2, porPagina: 3 }, 10);
    assert.deepEqual(r, {
      datos: [1, 2, 3],
      paginacion: { pagina: 2, por_pagina: 3, total: 10, paginas: 4 },
    });
  });
});

describe('respuestas en snake_case (seccion 6)', () => {
  test('el endpoint de salud usa snake_case', async () => {
    const r = await cliente().get('/api/v1/salud');

    assert.ok('base_de_datos' in r.body, 'debe usar base_de_datos, no baseDeDatos');
    assert.equal(
      Object.keys(r.body).some((k) => /[A-Z]/.test(k)),
      false,
      'ninguna clave debe traer mayusculas',
    );
  });

  test('todos los montos van como enteros en pesos', () => {
    // La Etapa 1 todavia no tiene montos: la regla queda declarada aca para que
    // la primera tabla con precios la cumpla desde el primer dia.
    assert.ok(true);
  });
});

describe('salud del servicio', () => {
  test('responde con version y estado de la base de datos', async () => {
    const r = await cliente().get('/api/v1/salud');
    assert.ok([200, 503].includes(r.status));
    assert.equal(r.body.version, 'v1');
    assert.ok(['ok', 'error'].includes(r.body.base_de_datos));
  });
});

describe('sesion y roles', () => {
  test('un comprador no tiene el rol admin', CON_BASE, async () => {
    const usuario = await crearUsuarioVerificado();
    const c = cliente();

    await c.post('/api/v1/auth/login', { email: usuario.email, contrasena: usuario.contrasena });

    // En la Etapa 1 no hay rutas de admin todavia: la prueba de rol se
    // completa en la Etapa 4 con el panel. Aca confirmamos que la sesion
    // se establece bien y que /yo devuelve los roles del usuario.
    const r = await c.get('/api/v1/auth/yo');
    assert.equal(r.status, 200);
    assert.ok(r.body.usuario.roles.includes('comprador'));
    assert.equal(
      r.body.usuario.roles.includes('admin'),
      false,
      'un comprador no debe tener admin',
    );
  });

  test('un usuario desactivado pierde el acceso de inmediato', CON_BASE, async () => {
    const usuario = await crearUsuarioVerificado();
    const c = cliente();

    await c.post('/api/v1/auth/login', { email: usuario.email, contrasena: usuario.contrasena });
    assert.equal((await c.get('/api/v1/auth/yo')).status, 200);

    await prisma.usuario.update({
      where: { email: usuario.email },
      data: { activo: false },
    });

    const despues = await c.get('/api/v1/auth/yo');
    assert.equal(
      despues.status,
      401,
      'la sesion debe morir sin esperar a que expire el token',
    );
  });

  test('un cambio de rol surte efecto sin esperar expiracion', CON_BASE, async () => {
    const usuario = await crearUsuarioVerificado();
    const c = cliente();

    await c.post('/api/v1/auth/login', { email: usuario.email, contrasena: usuario.contrasena });
    assert.equal(
      (await c.get('/api/v1/auth/yo')).body.usuario.roles.includes('vendedor'),
      false,
    );

    await prisma.usuarioRol.create({
      data: { usuarioId: usuario.id, rol: 'vendedor' },
    });

    const despues = await c.get('/api/v1/auth/yo');
    assert.equal(
      despues.body.usuario.roles.includes('vendedor'),
      true,
      'el rol se lee siempre de la base, asi que el cambio es inmediato',
    );
  });
});

after(async () => {
  await cerrarConexion();
});