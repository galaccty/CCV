import './helpers/entorno.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { crearLimitador } from '../src/middlewares/rateLimit.js';

/**
 * Pruebas del limitador de peticiones.
 *
 * En el resto de las pruebas los limitadores vienen desactivados, porque una
 * sola corrida crea muchas cuentas y los frenaria. Aqui se prueban aparte,
 * con instancias propias, limites chicos y sin el salto de entorno de prueba.
 *
 * Objetivo de seguridad: frenar ataques de fuerza bruta contra el login
 * (seccion 7 de la especificacion).
 */

// El limitador va con app.use para que cubra todas las rutas, como en la app real.
function appConLimitador(opciones) {
  const app = express();
  app.use(opciones);
  app.get('/protegido', (_req, res) => res.json({ ok: true }));
  app.post('/protegido', (_req, res) => res.json({ ok: true }));
  return app;
}

function limitadorDePrueba(extra = {}) {
  return crearLimitador({
    nombre: 'prueba',
    ventanaMs: 60_000,
    limite: 3,
    mensaje: 'Demasiadas.',
    omitirEnPruebas: false,
    ...extra,
  });
}

describe('limitador de peticiones', () => {
  test('deja pasar las peticiones que estan dentro del limite', async () => {
    const app = appConLimitador(limitadorDePrueba());

    for (let i = 1; i <= 3; i += 1) {
      const r = await request(app).get('/protegido');
      assert.equal(r.status, 200, `la peticion ${i} deberia pasar`);
    }
  });

  test('bloquea con 429 en cuanto se pasa el limite', async () => {
    const app = appConLimitador(limitadorDePrueba());

    for (let i = 1; i <= 3; i += 1) await request(app).get('/protegido');

    const r = await request(app).get('/protegido');
    assert.equal(r.status, 429);
    assert.equal(r.body.error.codigo, 'demasiadas_peticiones');
    assert.equal(r.body.error.mensaje, 'Demasiadas.');
  });

  test('con contarExitos, los aciertos no agotan el limite', async () => {
    const app = appConLimitador(limitadorDePrueba({ limite: 2, contarExitos: true }));

    // Si los aciertos contaran, a partir de la tercera esto seria 429.
    for (let i = 1; i <= 6; i += 1) {
      const r = await request(app).get('/protegido');
      assert.equal(r.status, 200, `el acierto ${i} no deberia consumir el limite`);
    }
  });

  test('con contarExitos, los fallos si agotan el limite', async () => {
    const app = appConLimitador(
      limitadorDePrueba({ limite: 2, contarExitos: true, mensaje: 'Demasiadas.' }),
    );

    // Un endpoint que siempre falla: asi los fallos se acumulan.
    const appFallido = express();
    appFallido.use(limitadorDePrueba({ limite: 2, contarExitos: true }));
    appFallido.get('/protegido', (_req, res) => res.status(500).json({ ok: false }));

    let bloqueado = false;
    let peticion = 0;
    while (!bloqueado && peticion < 6) {
      peticion += 1;
      const r = await request(appFallido).get('/protegido');
      if (r.status === 429) bloqueado = true;
    }

    assert.ok(bloqueado, 'los fallos si tienen que consumir el limite');
    assert.ok(peticion <= 3, `deberia bastar con 3 intentos, tardo ${peticion}`);
    void app;
  });

  test('la respuesta de bloqueo no filtra detalles internos', async () => {
    const app = appConLimitador(limitadorDePrueba({ limite: 1 }));

    await request(app).get('/protegido').expect(200);
    const r = await request(app).get('/protegido');

    assert.equal(r.status, 429);
    assert.deepEqual(Object.keys(r.body), ['error'], 'la respuesta solo debe traer "error"');
    const cuerpo = JSON.stringify(r.body);
    assert.equal(/stack|node_modules|\s+at\s/.test(cuerpo), false);
  });

  test('los limitadores de la aplicacion existen y son middleware', async () => {
    const {
      limiteGeneral,
      limiteIntentos,
      limiteRegistro,
      limiteReenvioVerificacion,
    } = await import('../src/middlewares/rateLimit.js');
    for (const l of [
      limiteGeneral,
      limiteIntentos,
      limiteRegistro,
      limiteReenvioVerificacion,
    ]) {
      assert.equal(typeof l, 'function', 'cada limitador debe ser un middleware');
    }
  });
});