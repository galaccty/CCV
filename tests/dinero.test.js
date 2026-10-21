import './helpers/entorno.js';
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  aBigInt,
  aNumeroSeguro,
  aplicarPorcentaje,
  centavosDePesos,
  convertirBigIntAJson,
  porcentajeABasisPuntos,
  sumar,
} from '../src/lib/dinero.js';
import { opcionesConBase, prisma, cerrarConexion } from './helpers/base.js';
import {
  crearCatalogo,
  crearPedidoDePrueba,
  crearPagoDePrueba,
  crearMovimientoDePrueba,
} from './helpers/datos.js';

/**
 * DINERO EN BIGINT
 * ================
 * INTEGER llega a 2.147.483.647. Estos casos usan montos por encima de ese
 * limite para comprobar que la base, Prisma y las sumas no se desbordan.
 *
 * El JSON de la API devuelve numeros, pero el conversor se niega a devolver
 * algo que no quepa en Number.MAX_SAFE_INTEGER.
 */

const CON_BASE = await opcionesConBase();

after(async () => {
  await cerrarConexion();
});

describe('utilidades de dinero', () => {
  test('convierte numeros seguros y bigint sin perder precision', () => {
    assert.equal(aBigInt(10), 10n);
    assert.equal(aBigInt(10n), 10n);
    assert.equal(aBigInt('10'), 10n);
    assert.throws(() => aBigInt(1.5), /entero/i);
    assert.throws(() => aBigInt(Number.MAX_SAFE_INTEGER + 1), /seguro/i);
  });

  test('devuelve JSON como numero solo si es seguro', () => {
    assert.equal(aNumeroSeguro(2_147_483_648n), 2_147_483_648);
    assert.equal(aNumeroSeguro(3_000_000_000n), 3_000_000_000);
    assert.throws(
      () => aNumeroSeguro(BigInt(Number.MAX_SAFE_INTEGER) + 1n),
      /MAX_SAFE_INTEGER/,
    );
  });

  test('convierte bigint anidados para JSON', () => {
    const salida = convertirBigIntAJson({
      total: 3_000_000_000n,
      lineas: [{ precio: 2_000_000_000n }],
      fecha: new Date('2026-01-01T00:00:00.000Z'),
    });

    assert.equal(salida.total, 3_000_000_000);
    assert.equal(salida.lineas[0].precio, 2_000_000_000);
    assert.equal(salida.fecha instanceof Date, true);
  });

  test('suma, porcentaje y centavos se hacen con bigint', () => {
    assert.equal(sumar(2_000_000_000n, 2_000_000_000n), 4_000_000_000n);
    assert.equal(porcentajeABasisPuntos(5), 500n);
    assert.equal(porcentajeABasisPuntos('5.25'), 525n);
    assert.equal(aplicarPorcentaje(10_000n, 500n), 500n);
    assert.equal(centavosDePesos(30_000n), 3_000_000n);
  });
});

describe('bigint contra PostgreSQL', () => {
  test('un monto mayor que INTEGER se guarda y se lee bien', CON_BASE, async () => {
    const precio = 3_000_000_000n;
    const { local, variante } = await crearCatalogo({ precio });
    const { pedido, subPedido, detalle } = await crearPedidoDePrueba({
      local,
      variante,
      precioUnitario: precio,
      cantidad: 1,
    });
    const pago = await crearPagoDePrueba({ pedido, monto: precio });

    assert.equal(variante.precio, precio);
    assert.equal(pedido.total, precio);
    assert.equal(subPedido.total, precio);
    assert.equal(detalle.precioUnitario, precio);
    assert.equal(pago.monto, precio);
    assert.ok(pedido.total > 2_147_483_647n);

    const leido = await prisma.pedido.findUnique({ where: { id: pedido.id } });
    assert.equal(leido.total, precio);
  });

  test('una suma del ledger mayor que INTEGER no desborda', CON_BASE, async () => {
    const { local } = await crearCatalogo();
    await crearMovimientoDePrueba({ localId: local.id, monto: 2_000_000_000n });
    await crearMovimientoDePrueba({ localId: local.id, monto: 2_000_000_000n });

    const filas = await prisma.$queryRaw`
      SELECT SUM(monto)::bigint AS suma
        FROM ledger
       WHERE local_id = ${local.id}
    `;

    assert.equal(filas[0].suma, 4_000_000_000n);
    assert.ok(filas[0].suma > 2_147_483_647n);
  });
});
