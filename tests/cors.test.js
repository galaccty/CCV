import './helpers/entorno.js';
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { opcionesConBase, cerrarConexion } from './helpers/base.js';
import { app, crearUsuarioVerificado } from './helpers/http.js';
import { config } from '../src/config/entorno.js';

/**
 * CORS CON CREDENCIALES - ETAPA 3B
 * ================================
 * El frontend corre en otro puerto/origen. Se verifica el preflight, que solo
 * el origen configurado reciba credenciales y que la cookie de sesion + CSRF
 * funcionen en ese flujo.
 */

const CON_BASE = await opcionesConBase();
const ORIGEN = config.origenesPermitidos[0];
const ORIGEN_AJENO = 'http://sitio-ajeno.example';

after(async () => {
  await cerrarConexion();
});

describe('CORS con credenciales', () => {
  test('responde el preflight del origen configurado con credenciales y CSRF', async () => {
    const r = await request(app)
      .options('/api/v1/direcciones')
      .set('Origin', ORIGEN)
      .set('Access-Control-Request-Method', 'POST')
      .set(
        'Access-Control-Request-Headers',
        'content-type,x-csrf-token,idempotency-key',
      );

    assert.equal(r.status, 204);
    assert.equal(r.headers['access-control-allow-origin'], ORIGEN);
    assert.equal(r.headers['access-control-allow-credentials'], 'true');
    assert.match(r.headers['access-control-allow-headers'], /X-CSRF-Token/i);
    assert.match(r.headers['access-control-allow-headers'], /Idempotency-Key/i);
    assert.match(r.headers['access-control-allow-methods'], /PATCH/);
    assert.equal(r.headers.vary, 'Origin');
  });

  test('no da credenciales a un origen ajeno', async () => {
    const preflight = await request(app)
      .options('/api/v1/direcciones')
      .set('Origin', ORIGEN_AJENO)
      .set('Access-Control-Request-Method', 'POST');

    assert.equal(preflight.status, 403);
    assert.equal(preflight.headers['access-control-allow-origin'], undefined);
    assert.equal(
      preflight.headers['access-control-allow-credentials'],
      undefined,
    );

    const simple = await request(app)
      .get('/api/v1/csrf')
      .set('Origin', ORIGEN_AJENO);
    assert.equal(simple.status, 200);
    assert.equal(simple.headers['access-control-allow-origin'], undefined);
  });

  test('la cookie de sesion y el CSRF funcionan desde el origen configurado', CON_BASE, async () => {
    const usuario = await crearUsuarioVerificado();
    const agente = request.agent(app);

    const csrf = await agente.get('/api/v1/csrf').set('Origin', ORIGEN);
    assert.equal(csrf.status, 200);
    assert.equal(csrf.headers['access-control-allow-origin'], ORIGEN);
    assert.equal(csrf.headers['access-control-allow-credentials'], 'true');
    assert.match(csrf.headers['set-cookie'].join(';'), /ccv_csrf=/);
    assert.match(csrf.headers['set-cookie'].join(';'), /SameSite=Lax/i);

    const login = await agente
      .post('/api/v1/auth/login')
      .set('Origin', ORIGEN)
      .set('X-CSRF-Token', csrf.body.token)
      .send({ email: usuario.email, contrasena: usuario.contrasena });

    assert.equal(login.status, 200, JSON.stringify(login.body));
    assert.equal(login.headers['access-control-allow-origin'], ORIGEN);
    assert.equal(login.headers['access-control-allow-credentials'], 'true');
    const cookies = login.headers['set-cookie'].join(';');
    assert.match(cookies, /ccv_sesion=/);
    assert.match(cookies, /HttpOnly/i);
    assert.match(cookies, /SameSite=Lax/i);

    const yo = await agente.get('/api/v1/auth/yo').set('Origin', ORIGEN);
    assert.equal(yo.status, 200);
    assert.equal(yo.body.usuario.id, usuario.id);
  });
});
