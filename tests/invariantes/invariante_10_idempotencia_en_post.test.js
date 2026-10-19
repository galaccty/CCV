import '../helpers/entorno.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { pendiente, estadoInvariante } from '../helpers/pendiente.js';

/**
 * INVARIANTE 10 - todo POST que crea pedido o pago exige Idempotency-Key.
 *
 * PENDIENTE. Este invariante todavia no aplica porque Los POST que crean pedido y pago llegan en la Etapa 2. La tabla idempotencia se crea en esa misma etapa.
 *
 * El archivo queda en el repositorio con su motivo y su etapa para que el
 * invariante no desaparezca en silencio. Cuando llegue la etapa, se cambia
 * `pendiente` por nada y se escriben los tres casos de abajo.
 */

export const ESTADO = estadoInvariante({
  aplica: false,
  etapa: 'Etapa 2',
  motivo: 'Los POST que crean pedido y pago llegan en la Etapa 2. La tabla idempotencia se crea en esa misma etapa.',
});

const cuandoAplique = pendiente(ESTADO.etapa, ESTADO.motivo);

describe('invariante 10 - todo POST que crea pedido o pago exige Idempotency-Key', () => {
  test('sin la cabecera responde 400', cuandoAplique, () => {
    // A activar en la Etapa 2
    //   llamar al checkout sin Idempotency-Key
    assert.ok(true);
  });

  test('dos veces con la misma clave crea un solo pedido', cuandoAplique, () => {
    // A activar en la Etapa 2
    //   repetir la peticion y verificar que el segundo devuelve la respuesta guardada
    assert.ok(true);
  });

  test('con la primera peticion en vuelo responde 409', cuandoAplique, () => {
    // A activar en la Etapa 2
    //   verificar el codigo solicitud_en_proceso
    assert.ok(true);
  });

  test('la clave es unica por usuario y ruta', cuandoAplique, () => {
    // A activar en la Etapa 2
    //   intentar reutilizar la misma clave en otra ruta o con otro usuario
    assert.ok(true);
  });
});
