import '../helpers/entorno.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { pendiente, estadoInvariante } from '../helpers/pendiente.js';

/**
 * INVARIANTE 3 - el webhook responde 200 solo despues de procesar.
 *
 * PENDIENTE. Este invariante todavia no aplica porque La ruta /api/v1/pagos/webhook llega en la Etapa 2.
 *
 * El archivo queda en el repositorio con su motivo y su etapa para que el
 * invariante no desaparezca en silencio. Cuando llegue la etapa, se cambia
 * `pendiente` por nada y se escriben los tres casos de abajo.
 */

export const ESTADO = estadoInvariante({
  aplica: false,
  etapa: 'Etapa 2',
  motivo: 'La ruta /api/v1/pagos/webhook llega en la Etapa 2.',
});

const cuandoAplique = pendiente(ESTADO.etapa, ESTADO.motivo);

describe('invariante 3 - el webhook responde 200 solo despues de procesar', () => {
  test('responde 200 despues de procesar el evento', cuandoAplique, () => {
    // A activar en la Etapa 2
    //   enviar un evento valido y verificar que el 200 llega DESPUES de que el sub_pedido quedo creado
    assert.ok(true);
  });

  test('responde 5xx ante un fallo transitorio para que Wompi reintente', cuandoAplique, () => {
    // A activar en la Etapa 2
    //   hacer fallar la base de datos a proposito y verificar que la respuesta es 5xx, no 200
    assert.ok(true);
  });

  test('responde 401 ante una firma invalida', cuandoAplique, () => {
    // A activar en la Etapa 2
    //   mandar el evento con la firma alterada y verificar 401 y fila en evento_webhook con resultado = firma_invalida
    assert.ok(true);
  });
});
