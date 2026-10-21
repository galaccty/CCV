import '../helpers/entorno.js';
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  ejecutarChequeos,
  ARCHIVOS_PERMITIDOS,
} from '../../checks/invariantes-estaticos.js';
import { opcionesConBase, prisma, cerrarConexion } from '../helpers/base.js';
import { crearCatalogo } from '../helpers/datos.js';
import { withTransaccion } from '../../src/lib/transaccion.js';
import {
  descontarStock,
  ErrorStockInsuficiente,
} from '../../src/services/stock.js';

/**
 * INVARIANTE 7 - El stock se descuenta de forma atomica y solo por su modulo.
 *
 * Se activa de verdad en la Etapa 2, cuando la confirmacion del pago descuenta
 * stock. La prueba de concurrencia lanza diez descuentos simultaneos contra un
 * stock de cinco: exactamente cinco deben ganar y el stock final debe ser cero.
 * Nunca se lee el stock y se resta en JavaScript.
 */

const CON_BASE = await opcionesConBase();

after(async () => {
  await cerrarConexion();
});

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

  test('diez descuentos simultaneos sobre stock 5 dejan exactamente cinco', CON_BASE, async () => {
    const { variante } = await crearCatalogo({
      precio: 10000n,
      stockInicial: 5,
    });

    const intentos = Array.from({ length: 10 }, () =>
      withTransaccion((tx) => descontarStock(tx, variante.id, 1))
        .then(() => true)
        .catch((err) => {
          assert.ok(
            err instanceof ErrorStockInsuficiente,
            `error inesperado: ${err.message}`,
          );
          return false;
        }),
    );

    const resultados = await Promise.all(intentos);
    const exitosos = resultados.filter(Boolean).length;

    assert.equal(exitosos, 5);
    assert.equal(resultados.length - exitosos, 5);

    const varianteDb = await prisma.productoVariante.findUnique({
      where: { id: variante.id },
    });
    assert.equal(varianteDb.stock, 0);
  });

  test('una variante inactiva no se puede descontar aunque tenga stock', CON_BASE, async () => {
    const { variante } = await crearCatalogo({
      precio: 10000n,
      stockInicial: 5,
      activoVariante: false,
    });

    await assert.rejects(
      () => withTransaccion((tx) => descontarStock(tx, variante.id, 1)),
      ErrorStockInsuficiente,
    );

    const varianteDb = await prisma.productoVariante.findUnique({
      where: { id: variante.id },
    });
    assert.equal(varianteDb.stock, 5);
  });

  test('la base rechaza un stock negativo', CON_BASE, async () => {
    const { variante } = await crearCatalogo({
      precio: 10000n,
      stockInicial: 5,
    });

    await assert.rejects(
      () =>
        prisma.$executeRawUnsafe(
          'UPDATE "producto_variante" SET "stock" = -1 WHERE "id" = $1',
          variante.id,
        ),
      /producto_variante_stock_no_negativo/i,
    );

    const varianteDb = await prisma.productoVariante.findUnique({
      where: { id: variante.id },
    });
    assert.equal(varianteDb.stock, 5);
  });
});
