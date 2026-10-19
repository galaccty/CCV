import '../helpers/entorno.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ejecutarChequeos, ARCHIVOS_PERMITIDOS } from '../../checks/invariantes-estaticos.js';

/**
 * INVARIANTE 7 - El stock se descuenta de forma atomica y solo por su modulo.
 *
 * Activo desde la Etapa 1 mediante el guardian estatico. La tabla
 * `producto_variante` llega en la Etapa 3, asi que hoy lo que se comprueba es
 * que no exista ninguna escritura de stock escondida en el codigo.
 *
 * En la Etapa 3 este archivo crece con la prueba de concurrencia: diez
 * checkouts simultaneos sobre stock = 5 deben dejar exactamente cinco
 * compras successfules.
 */

describe('invariante 7 - el stock solo se descuenta por el modulo de stock', () => {
  test('no hay escrituras a producto_variante.stock por fuera del modulo', () => {
    const violaciones = ejecutarChequeos().filter((v) => v.invariante === 7);
    const detalle = violaciones
      .map((v) => `${v.archivo}:${v.linea} (${v.como})`)
      .join('\n');

    assert.equal(
      violaciones.length,
      0,
      `INVARIANTE 7 roto: hay escrituras de stock fuera del modulo:\n${detalle}`,
    );
  });

  test('la lista blanca del invariante 7 permite solo al modulo de stock', () => {
    assert.deepEqual(ARCHIVOS_PERMITIDOS[7], ['src/services/stock.js']);
  });
});