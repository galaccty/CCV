import '../helpers/entorno.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { pendiente, estadoInvariante } from '../helpers/pendiente.js';

/**
 * INVARIANTE 12 - todo monto que aparece en pantalla se calcula en el backend.
 *
 * PENDIENTE. Este invariante todavia no aplica porque La primera tabla con montos es producto_variante, que llega en la Etapa 3.
 *
 * El archivo queda en el repositorio con su motivo y su etapa para que el
 * invariante no desaparezca en silencio. Cuando llegue la etapa, se cambia
 * `pendiente` por nada y se escriben los tres casos de abajo.
 */

export const ESTADO = estadoInvariante({
  aplica: false,
  etapa: 'Etapa 3',
  motivo: 'La primera tabla con montos es producto_variante, que llega en la Etapa 3.',
});

const cuandoAplique = pendiente(ESTADO.etapa, ESTADO.motivo);

describe('invariante 12 - todo monto que aparece en pantalla se calcula en el backend', () => {
  test('el backend ignora el precio que manda el frontend', cuandoAplique, () => {
    // A activar en la Etapa 3
    //   mandar un producto con precio 1 y verificar que el pedido usa el precio de la base
    assert.ok(true);
  });

  test('el total del pedido es siempre la suma de sus sub_pedidos', cuandoAplique, () => {
    // A activar en la Etapa 3
    //   comparar contra la suma real en la base
    assert.ok(true);
  });

  test('la API nunca expone un monto calculable por el cliente', cuandoAplique, () => {
    // A activar en la Etapa 3
    //   revisar que las respuestas de locales y productos no traigan total, subtotal ni total_carrito
    assert.ok(true);
  });
});
