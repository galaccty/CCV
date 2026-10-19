import '../helpers/entorno.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { pendiente, estadoInvariante } from '../helpers/pendiente.js';

/**
 * INVARIANTE 9 - el estado de un local por deuda solo lo cambia recalcular_estado_local.
 *
 * PENDIENTE. Este invariante todavia no aplica porque La tabla local y la maquina de estados por deuda llegan en la Etapa 4.
 *
 * El archivo queda en el repositorio con su motivo y su etapa para que el
 * invariante no desaparezca en silencio. Cuando llegue la etapa, se cambia
 * `pendiente` por nada y se escriben los tres casos de abajo.
 */

export const ESTADO = estadoInvariante({
  aplica: false,
  etapa: 'Etapa 4',
  motivo: 'La tabla local y la maquina de estados por deuda llegan en la Etapa 4.',
});

const cuandoAplique = pendiente(ESTADO.etapa, ESTADO.motivo);

describe('invariante 9 - el estado de un local por deuda solo lo cambia recalcular_estado_local', () => {
  test('recalcular_estado_local cubre todas las ramas', cuandoAplique, () => {
    // A activar en la Etapa 4
    //   probar: deuda cero, deuda bajo el limite, deuda sobre el limite, reembolso efectivo incumplido, local bloqueado, local suspendido, local pendiente_aprobacion
    assert.ok(true);
  });

  test('volver a activo limpia la fecha limite', cuandoAplique, () => {
    // A activar en la Etapa 4
    //   un local en_plazo que salda su deuda queda activo con fecha_limite_pago nula
    assert.ok(true);
  });

  test('un local suspendido o pendiente de aprobacion no lo toca el recalculo', cuandoAplique, () => {
    // A activar en la Etapa 4
    //   verificar que el early return los deja igual
    assert.ok(true);
  });

  test('el job diario bloquea al que vencio el plazo', cuandoAplique, () => {
    // A activar en la Etapa 4
    //   fecha_limite_pago en el pasado y saldo_deuda > 0 lleva a bloqueado
    assert.ok(true);
  });
});
