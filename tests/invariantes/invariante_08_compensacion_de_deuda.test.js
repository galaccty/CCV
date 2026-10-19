import '../helpers/entorno.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { pendiente, estadoInvariante } from '../helpers/pendiente.js';

/**
 * INVARIANTE 8 - la deuda se compensa solo en liquidacion y solo con saldo liberado.
 *
 * PENDIENTE. Este invariante todavia no aplica porque Las liquidaciones y los saldos llegan en la Etapa 4.
 *
 * El archivo queda en el repositorio con su motivo y su etapa para que el
 * invariante no desaparezca en silencio. Cuando llegue la etapa, se cambia
 * `pendiente` por nada y se escriben los tres casos de abajo.
 */

export const ESTADO = estadoInvariante({
  aplica: false,
  etapa: 'Etapa 4',
  motivo: 'Las liquidaciones y los saldos llegan en la Etapa 4.',
});

const cuandoAplique = pendiente(ESTADO.etapa, ESTADO.motivo);

describe('invariante 8 - la deuda se compensa solo en liquidacion y solo con saldo liberado', () => {
  test('nunca se compensa de forma continua', cuandoAplique, () => {
    // A activar en la Etapa 4
    //   generar una venta en efectivo y verificar que saldo_deuda sube sin tocar saldo_por_pagar
    assert.ok(true);
  });

  test('no se compensa saldo retenido', cuandoAplique, () => {
    // A activar en la Etapa 4
    //   con saldo por liberar, verificar que la liquidacion lo deja intacto
    assert.ok(true);
  });

  test('si no alcanza, compensa lo disponible y el resto sigue como deuda', cuandoAplique, () => {
    // A activar en la Etapa 4
    //   deuda 100, saldo liberado 40: verificar saldo_deuda = 60
    assert.ok(true);
  });

  test('limite_deuda se evalua sobre el saldo neto', cuandoAplique, () => {
    // A activar en la Etapa 4
    //   despues de compensar, verificar que el estado del local se recalculo
    assert.ok(true);
  });
});
