import '../helpers/entorno.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { pendiente, estadoInvariante } from '../helpers/pendiente.js';

/**
 * INVARIANTE 5 - los snapshots de sub_pedido nunca se modifican.
 *
 * PENDIENTE. Este invariante todavia no aplica porque La tabla sub_pedido y los reembolsos llegan en la Etapa 2.
 *
 * El archivo queda en el repositorio con su motivo y su etapa para que el
 * invariante no desaparezca en silencio. Cuando llegue la etapa, se cambia
 * `pendiente` por nada y se escriben los tres casos de abajo.
 */

export const ESTADO = estadoInvariante({
  aplica: false,
  etapa: 'Etapa 2',
  motivo: 'La tabla sub_pedido y los reembolsos llegan en la Etapa 2.',
});

const cuandoAplique = pendiente(ESTADO.etapa, ESTADO.motivo);

describe('invariante 5 - los snapshots de sub_pedido nunca se modifican', () => {
  test('cambiar el precio del producto no altera el pedido', cuandoAplique, () => {
    // A activar en la Etapa 2
    //   crear un pedido, cambiar el precio del producto y comparar el precio_unitario congelado
    assert.ok(true);
  });

  test('un reembolso no altera subtotal_productos, comision ni total', cuandoAplique, () => {
    // A activar en la Etapa 2
    //   reembolsar una linea y verificar que los snapshots siguen iguales
    assert.ok(true);
  });

  test('el neto siempre se deriva', cuandoAplique, () => {
    // A activar en la Etapa 2
    //   verificar que el neto se calcula, no se lee de una columna mutada
    assert.ok(true);
  });
});
