import '../../tests/helpers/entorno.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ejecutarChequeos, ARCHIVOS_PERMITIDOS } from '../../checks/invariantes-estaticos.js';

/**
 * INVARIANTE 1 - El ledger es la fuente de verdad.
 *
 * Activo desde la Etapa 1 mediante el guardian estatico: ninguna escritura a
 * las columnas de saldo puede aparecer por fuera del servicio del ledger.
 *
 * El servicio del ledger todavia no existe (llega en la Etapa 4), asi que hoy
 * lo que se comprueba es que no haya ninguna escritura de saldos escondida en
 * el codigo. Cuando el ledger aparezca, este mismo test empieza a exigir que
 * las escrituras SOLO pasen por el.
 */

describe('invariante 1 - el ledger es la fuente de verdad', () => {
  test('no hay escrituras a cuenta_local por fuera del servicio del ledger', () => {
    const violaciones = ejecutarChequeos().filter((v) => v.invariante === 1);
    const detalle = violaciones
      .map((v) => `${v.archivo}:${v.linea} (${v.como})`)
      .join('\n');

    assert.equal(
      violaciones.length,
      0,
      `INVARIANTE 1 roto: hay escrituras de saldos fuera del ledger:\n${detalle}`,
    );
  });

  test('la lista blanca del invariante 1 permite solo al servicio del ledger', () => {
    assert.deepEqual(
      ARCHIVOS_PERMITIDOS[1],
      ['src/services/ledger.js'],
      'La lista blanca del invariante 1 debe permitir unicamente al servicio del ledger.',
    );
  });
});