import '../../tests/helpers/entorno.js';
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  ejecutarChequeos,
  ARCHIVOS_PERMITIDOS,
  analizarInvariante1,
} from '../../checks/invariantes-estaticos.js';
import { opcionesConBase, prisma, cerrarConexion } from '../helpers/base.js';
import { crearCatalogo } from '../helpers/datos.js';
import { withTransaccion } from '../../src/lib/transaccion.js';
import { registrarMovimiento } from '../../src/services/ledger.js';

/**
 * INVARIANTE 1 - El ledger es la fuente de verdad.
 *
 * El guardian estatico cubre las tres formas de romperlo: SQL a mano, el ORM
 * de Prisma y una asignacion directa a una columna de saldo. Tambien se
 * comprueba que `registrarMovimiento()` no funcione fuera de una transaccion
 * y que, si el saldo no alcanza, el movimiento no quede escrito.
 */

const CON_BASE = await opcionesConBase();

after(async () => {
  await cerrarConexion();
});

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

  test('el guardian detecta ORM, SQL y asignaciones directas simuladas', () => {
    const orm = analizarInvariante1(
      "await tx.cuentaLocal.update({ data: { saldoPorPagar: 1n } });",
      'src/services/otro.js',
    );
    assert.equal(orm.length, 1);
    assert.match(orm[0].como, /ORM/i);

    const sql = analizarInvariante1(
      'await tx.$executeRaw`\nUPDATE cuenta_local\n   SET saldo_congelado = saldo_congelado + 1\n`;',
      'src/services/otro.js',
    );
    assert.equal(sql.length, 1);
    assert.match(sql[0].como, /SQL/i);

    const directa = analizarInvariante1(
      'cuenta.saldoDeuda = 10n;',
      'src/services/otro.js',
    );
    assert.equal(directa.length, 1);
    assert.match(directa[0].como, /asignacion directa/i);

    assert.deepEqual(
      analizarInvariante1(
        "await tx.cuentaLocal.update({ data: { saldoPorPagar: { increment: 1n } } });",
        'src/services/ledger.js',
      ),
      [],
      'el servicio del ledger es la unica excepcion',
    );
  });

  test('registrarMovimiento fuera de withTransaccion falla', async () => {
    await assert.rejects(
      () =>
        registrarMovimiento({
          tipo: 'liberacion',
          monto: 1000n,
          localId: 1,
        }),
      /INVARIANTE 1|withTransaccion/i,
    );
  });

  test(
    'si el saldo no alcanza, el movimiento y la cuenta vuelven atras',
    CON_BASE,
    async () => {
      const { local } = await crearCatalogo();

      await assert.rejects(
        () =>
          withTransaccion(async () => {
            await registrarMovimiento({
              tipo: 'congelacion',
              monto: 1000n,
              localId: local.id,
            });
          }),
        /saldos_no_negativos|check|negativ/i,
      );

      const movimientos = await prisma.ledger.count({
        where: { localId: local.id, tipo: 'congelacion' },
      });
      assert.equal(movimientos, 0, 'el movimiento no debe quedar escrito');

      const cuenta = await prisma.cuentaLocal.findUnique({
        where: { localId: local.id },
      });
      assert.equal(cuenta.saldoPorPagar, 0n);
      assert.equal(cuenta.saldoCongelado, 0n);
    },
  );
});
