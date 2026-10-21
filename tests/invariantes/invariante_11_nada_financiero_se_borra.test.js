import '../helpers/entorno.js';
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { estadoInvariante, pendiente } from '../helpers/pendiente.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { opcionesConBase, prisma, cerrarConexion } from '../helpers/base.js';
import {
  crearCatalogo,
  crearPedidoDePrueba,
  crearPagoDePrueba,
  crearReembolsoDePrueba,
  crearMovimientoDePrueba,
} from '../helpers/datos.js';

/**
 * INVARIANTE 11 - Nada financiero se borra.
 *
 * En la Etapa 2 se suman las tablas financieras. La proteccion tiene dos
 * capas:
 *   1. Este chequeo estatico: el codigo de src/ y scripts/ no llama a delete
 *      sobre pedidos, pagos, reembolsos, ledger, sub_pedidos ni detalles.
 *   2. Triggers BEFORE DELETE en la base: aunque alguien escriba SQL a mano,
 *      el motor rechaza el borrado. Las pruebas de abajo lo intentan de verdad.
 *
 * No se desactivan los triggers para limpiar: la base de pruebas se recrea
 * entera antes de cada corrida (scripts/recrear-base-pruebas.js).
 */

export const ESTADO = estadoInvariante({
  aplica: 'parcial',
  etapa: 'Etapa 6',
  motivo:
    'pedido, pago, reembolso, sub_pedido, detalle, ledger, cuenta_local y productos ya se protegen. Falta la retencion de datos.',
});

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function* archivosDe(directorio) {
  for (const entrada of fs.readdirSync(directorio, { withFileTypes: true })) {
    const completa = path.join(directorio, entrada.name);
    if (entrada.isDirectory()) {
      if (['node_modules', 'generated', 'migrations'].includes(entrada.name)) continue;
      yield* archivosDe(completa);
    } else if (/\.(js|mjs|cjs|ts)$/.test(entrada.name)) {
      yield completa;
    }
  }
}

const REGLA_BORRADO_AUDITORIA =
  /(auditoriaAdmin|auditoria_admin)\s*\.\s*(delete|deleteMany)\b|DELETE\s+FROM\s+"?auditoria_admin"?/i;

const TABLAS_FINANCIERAS =
  'pedido|pago|reembolso|ledger|sub_pedido|detalle_producto|cuenta_local';

const REGLA_BORRADO_FINANCIERO = new RegExp(
  String.raw`(pedido|pago|reembolso|ledger|subPedido|sub_pedido|detalleProducto|detalle_producto|cuentaLocal|cuenta_local)\s*\.\s*(delete|deleteMany)\b|DELETE\s+FROM\s+"?(${TABLAS_FINANCIERAS})"?`,
  'i',
);

const REGLA_BORRADO_PRODUCTO =
  /\bproducto\s*\.\s*(delete|deleteMany)\b|DELETE\s+FROM\s+"?producto"?/i;

function buscarEnCodigo(regla) {
  const violaciones = [];

  for (const carpeta of ['src', 'scripts']) {
    const absoluta = path.join(RAIZ, carpeta);
    if (!fs.existsSync(absoluta)) continue;

    for (const archivo of archivosDe(absoluta)) {
      const relativa = path.relative(RAIZ, archivo).replace(/\\/g, '/');
      const lineas = fs.readFileSync(archivo, 'utf8').split(/\r?\n/);

      lineas.forEach((linea, indice) => {
        const t = linea.trim();
        if (t.startsWith('//') || t.startsWith('*')) return;
        if (regla.test(linea)) {
          violaciones.push(`${relativa}:${indice + 1}`);
        }
      });
    }
  }

  return violaciones;
}

const CON_BASE = await opcionesConBase();

after(async () => {
  await cerrarConexion();
});

describe('invariante 11 - nada financiero se borra', () => {
  test('no hay borrados sobre auditoria_admin en el codigo', () => {
    const violaciones = buscarEnCodigo(REGLA_BORRADO_AUDITORIA);
    assert.equal(
      violaciones.length,
      0,
      `INVARIANTE 11 roto: se borra la auditoria en:\n${violaciones.join('\n')}`,
    );
  });

  test('no hay borrados sobre las tablas financieras en el codigo', () => {
    const violaciones = buscarEnCodigo(REGLA_BORRADO_FINANCIERO);
    assert.equal(
      violaciones.length,
      0,
      `INVARIANTE 11 roto: hay borrados financieros en:\n${violaciones.join('\n')}`,
    );
  });

  test('prisma/migrations queda fuera del chequeo porque es DDL de esquema', () => {
    assert.ok(fs.existsSync(path.join(RAIZ, 'prisma', 'migrations')));
  });

  test('borrar un pedido falla en la base', CON_BASE, async () => {
    const { local, variante } = await crearCatalogo();
    const { pedido } = await crearPedidoDePrueba({ local, variante });

    await assert.rejects(
      () => prisma.pedido.delete({ where: { id: pedido.id } }),
      /no se puede borrar|invariante 11|restrict/i,
    );
  });

  test('borrar un pago falla en la base', CON_BASE, async () => {
    const { local, variante } = await crearCatalogo();
    const { pedido } = await crearPedidoDePrueba({ local, variante });
    const pago = await crearPagoDePrueba({ pedido });

    await assert.rejects(
      () => prisma.pago.delete({ where: { id: pago.id } }),
      /no se puede borrar|invariante 11|restrict/i,
    );
  });

  test('borrar un reembolso falla en la base', CON_BASE, async () => {
    const { local, variante } = await crearCatalogo();
    const { pedido, subPedido } = await crearPedidoDePrueba({ local, variante });
    const pago = await crearPagoDePrueba({ pedido });
    const reembolso = await crearReembolsoDePrueba({ pago, subPedido });

    await assert.rejects(
      () => prisma.reembolso.delete({ where: { id: reembolso.id } }),
      /no se puede borrar|invariante 11|restrict/i,
    );
  });

  test('borrar un sub_pedido falla en la base', CON_BASE, async () => {
    const { local, variante } = await crearCatalogo();
    const { subPedido } = await crearPedidoDePrueba({ local, variante });

    await assert.rejects(
      () => prisma.subPedido.delete({ where: { id: subPedido.id } }),
      /no se puede borrar|invariante 11|restrict/i,
    );
  });

  test('borrar una linea de pedido falla en la base', CON_BASE, async () => {
    const { local, variante } = await crearCatalogo();
    const { detalle } = await crearPedidoDePrueba({ local, variante });

    await assert.rejects(
      () => prisma.detalleProducto.delete({ where: { id: detalle.id } }),
      /snapshots|no se modifican|no se borran|restrict/i,
    );
  });

  test('el ledger no se borra ni se modifica', CON_BASE, async () => {
    const { local } = await crearCatalogo();
    const movimiento = await crearMovimientoDePrueba({ localId: local.id, monto: 1000 });

    await assert.rejects(
      () => prisma.ledger.delete({ where: { id: movimiento.id } }),
      /inmutable|no se borra|invariante 11/i,
    );

    await assert.rejects(
      () => prisma.ledger.update({ where: { id: movimiento.id }, data: { monto: 1 } }),
      /inmutable|no se actualiza|invariante 11/i,
    );
  });

  test('borrar la cuenta de un local falla en la base', CON_BASE, async () => {
    const { local } = await crearCatalogo();
    await prisma.cuentaLocal.create({ data: { localId: local.id } });

    await assert.rejects(
      () => prisma.cuentaLocal.delete({ where: { localId: local.id } }),
      /no se puede borrar|invariante 11|restrict/i,
    );

    const sigue = await prisma.cuentaLocal.findUnique({
      where: { localId: local.id },
    });
    assert.ok(sigue, 'la cuenta debe seguir existiendo');
  });

  test('los productos se desactivan, no se borran', CON_BASE, async () => {
    const { producto } = await crearCatalogo();
    const violaciones = buscarEnCodigo(REGLA_BORRADO_PRODUCTO);
    assert.deepEqual(violaciones, []);

    await prisma.producto.update({
      where: { id: producto.id },
      data: { activo: false },
    });

    const sigue = await prisma.producto.findUnique({
      where: { id: producto.id },
    });
    assert.ok(sigue);
    assert.equal(sigue.activo, false);
  });

  test(
    'evento_webhook, vistas y pedidos expirados tienen retencion definida',
    pendiente('Etapa 6', 'los jobs de limpieza con retencion llegan en la Etapa 6'),
    () => {
      assert.ok(true);
    },
  );
});
