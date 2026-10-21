import './helpers/entorno.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { puedeSaltarSinBase, mensajeSinBase } from './helpers/politica-base.js';

/**
 * Pruebas de la politica de la suite, no del negocio.
 *
 * Lo que se protege: que una base apagada NO deje la suite en verde por
 * accidente. Es un fallo que ya nos paso y que cuesta caro, porque las
 * pruebas que mas importan (dinero, stock, pedidos) son justo las que
 * necesitan base.
 */

describe('pruebas sin base de datos', () => {
  test('por defecto NO se permite saltar', () => {
    assert.equal(puedeSaltarSinBase({}), false);
    assert.equal(puedeSaltarSinBase({ PERMITIR_SALTAR_BD: '0' }), false);
    assert.equal(puedeSaltarSinBase({ PERMITIR_SALTAR_BD: 'true' }), false);
  });

  test('con PERMITIR_SALTAR_BD=1 si se permite', () => {
    assert.equal(puedeSaltarSinBase({ PERMITIR_SALTAR_BD: '1' }), true);
  });

  test('en CI se ignora el permiso aunque este puesto', () => {
    assert.equal(
      puedeSaltarSinBase({ PERMITIR_SALTAR_BD: '1', CI: 'true' }),
      false,
      'en CI las pruebas nunca se saltan: si no hay base, el job debe fallar',
    );
  });

  test('el mensaje dice como levantar la base', () => {
    const mensaje = mensajeSinBase('postgresql://localhost/ccv_test');
    assert.match(mensaje, /npm run db:iniciar/);
    assert.match(mensaje, /PERMITIR_SALTAR_BD=1/);
    assert.match(mensaje, /ccv_test/);
  });
});
