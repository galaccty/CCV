import '../helpers/entorno.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { pendiente, estadoInvariante } from '../helpers/pendiente.js';

/**
 * INVARIANTE 6 - entregado y el dinero movido son hechos distintos.
 *
 * PENDIENTE. Este invariante todavia no aplica porque El job de liberacion de saldo y las disputas llegan en la Etapa 4.
 *
 * El archivo queda en el repositorio con su motivo y su etapa para que el
 * invariante no desaparezca en silencio. Cuando llegue la etapa, se cambia
 * `pendiente` por nada y se escriben los tres casos de abajo.
 */

export const ESTADO = estadoInvariante({
  aplica: false,
  etapa: 'Etapa 4',
  motivo: 'El job de liberacion de saldo y las disputas llegan en la Etapa 4.',
});

const cuandoAplique = pendiente(ESTADO.etapa, ESTADO.motivo);

describe('invariante 6 - entregado y el dinero movido son hechos distintos', () => {
  test('no se libera saldo antes de dias_retencion', cuandoAplique, () => {
    // A activar en la Etapa 4
    //   marcar entregado con retencion de 5 dias y verificar que a los 4 dias saldo_liberado_en sigue nulo
    assert.ok(true);
  });

  test('no se libera saldo con una disputa abierta', cuandoAplique, () => {
    // A activar en la Etapa 4
    //   abrir una disputa y verificar que el saldo sigue retenido
    assert.ok(true);
  });

  test('no se liquida saldo con un reembolso pendiente', cuandoAplique, () => {
    // A activar en la Etapa 4
    //   dejar un reembolso en estado pendiente y verificar que el lote no lo incluye
    assert.ok(true);
  });

  test('el job corre en la fecha correcta', cuandoAplique, () => {
    // A activar en la Etapa 4
    //   con fecha_entrega + dias_retencion llegada, verificar que el job libera y llena saldo_liberado_en
    assert.ok(true);
  });
});
