import '../helpers/entorno.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { pendiente, estadoInvariante } from '../helpers/pendiente.js';

export const ESTADO = estadoInvariante({
  aplica: false,
  etapa: 'Etapa 2',
  motivo: 'La tabla pago y el webhook de Wompi llegan en el corte vertical de la Etapa 2.',
});

const cuandoAplique = pendiente(ESTADO.etapa, ESTADO.motivo);

describe('invariante 2 - pago.referencia es UNIQUE y las referencias desconocidas se alertan', () => {
  test('dos pagos con la misma referencia no pueden existir', cuandoAplique, () => {
    // A activar en la Etapa 2:
    //   await prisma.pago.create({ data: { referencia: 'X', ... } });
    //   await assert.rejects(
    //     () => prisma.pago.create({ data: { referencia: 'X', ... } }),
    //     /P2002|unique/i,
    //   );
    assert.ok(true);
  });

  test('un webhook con referencia desconocida se registra y alerta, no se descarta', cuandoAplique, () => {
    // A activar en la Etapa 2, contra la tabla evento_webhook:
    //   enviar un evento con referencia 'no-existe'
    //   esperar estado 200
    //   verificar que hay una fila con resultado = 'referencia_desconocida'
    //   verificar que se genero la alerta al admin
    assert.ok(true);
  });

  test('un webhook repetido no procesa dos veces', cuandoAplique, () => {
    // A activar en la Etapa 2: mandar el mismo evento dos veces y verificar
    // que solo se creo un sub_pedido y una sola fila de ledger.
    assert.ok(true);
  });
});