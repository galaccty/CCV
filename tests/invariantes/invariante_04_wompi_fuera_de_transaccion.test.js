import '../helpers/entorno.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  contextoTransaccion,
  transaccionActual,
  hayTransaccionAbierta,
  exigirFueraDeTransaccion,
} from '../../src/lib/transaccion.js';
import * as wompi from '../../src/lib/wompi.js';
import { ARCHIVOS_PERMITIDOS } from '../../checks/invariantes-estaticos.js';

/**
 * INVARIANTE 4 - Nunca se llama a Wompi dentro de una transaccion.
 *
 * Tiene tres capas (seccion 10):
 *   (a) guardian estatico: el cliente de Wompi solo se importa en su modulo
 *   (b) guardian en ejecucion: el envoltorio de transacciones marca el
 *       contexto con AsyncLocalStorage y el cliente lo revisa al llamarse
 *   (c) estas pruebas, que verifican (b) sin mockear nada
 *
 * Esta activo desde la Etapa 1 para que la proteccion exista antes de que
 * haya codigo de pagos capaz de romperla.
 */

describe('invariante 4 - Wompi nunca se llama dentro de una transaccion', () => {
  test('fuera de una transaccion no hay contexto abierto', () => {
    assert.equal(hayTransaccionAbierta(), false);
    assert.equal(transaccionActual(), null);
  });

  test('exigirFueraDeTransaccion no hace nada fuera de una transaccion', () => {
    assert.doesNotThrow(() => exigirFueraDeTransaccion('prueba'));
  });

  test('el contexto se propaga a traves de las promesas', async () => {
    await contextoTransaccion.run({ abierto: true }, async () => {
      assert.equal(hayTransaccionAbierta(), true);
      await new Promise((r) => setTimeout(r, 1));
      // El punto clave: sigue viendo la transaccion despues de un await,
      // que es donde un guardia mal hecho dejaria de funcionar.
      assert.equal(hayTransaccionAbierta(), true);
    });

    assert.equal(hayTransaccionAbierta(), false, 'al terminar debe quedar limpio');
  });

  test('dentro de una transaccion exigirFueraDeTransaccion lanza', () => {
    contextoTransaccion.run({ abierto: true }, () => {
      assert.throws(() => exigirFueraDeTransaccion('wompi'), /INVARIANTE 4/);
    });
  });

  test('dentro de una transaccion el cliente de Wompi se niega a llamar', async () => {
    await contextoTransaccion.run({ abierto: true }, async () => {
      await assert.rejects(() => wompi.crearTransaccion({}), /INVARIANTE 4/);
      await assert.rejects(() => wompi.consultarTransaccion('ref'), /INVARIANTE 4/);
      await assert.rejects(() => wompi.solicitarReembolso({}), /INVARIANTE 4/);
      await assert.rejects(() => wompi.verificarFirmaEvento({}, 'x'), /INVARIANTE 4/);
    });
  });

  test('el error menciona el invariante para que sea facil de rastrear', async () => {
    await contextoTransaccion.run({ abierto: true }, async () => {
      await assert.rejects(
        () => wompi.crearTransaccion({}),
        (err) => {
          assert.match(err.message, /INVARIANTE 4/);
          assert.match(err.message, /dentro de una transacción de base de datos/);
          assert.match(err.message, /DESPUÉS del commit/);
          return true;
        },
      );
    });
  });

  test('fuera de una transaccion el guardia NO molesta', async () => {
    // Fuera de una transaccion debe llegar al "no implementado" de la Etapa 2,
    // no al error del invariante: asi se distingue una cosa de la otra.
    await assert.rejects(
      () => wompi.crearTransaccion({}),
      (err) => !/INVARIANTE 4/.test(err.message) && /Etapa 2/.test(err.message),
    );
  });

  test('capa (a): el cliente de Wompi solo se importa en su modulo', () => {
    assert.deepEqual(ARCHIVOS_PERMITIDOS[4], ['src/lib/wompi.js']);
  });
});