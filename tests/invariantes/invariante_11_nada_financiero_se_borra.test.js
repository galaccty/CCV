import '../helpers/entorno.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { estadoInvariante, pendiente } from '../helpers/pendiente.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * INVARIANTE 11 - Nada financiero se borra.
 *
 * MEDIO ACTIVO en la Etapa 1. El invariante completo habla de `ledger`,
 * `cuenta_local` y `producto` (Etapas 3 y 4), pero la tabla `auditoria_admin`
 * YA existe y tiene la misma naturaleza: solo se le agregan filas.
 *
 * Asi que hoy el invariante ya protege algo real, y cuando lleguen las tablas
 * financieras solo hay que ampliar este archivo.
 */

export const ESTADO = estadoInvariante({
  aplica: 'parcial',
  etapa: 'Etapa 4',
  motivo:
    'La tabla auditoria_admin ya existe y se verifica. Las tablas financieras (ledger, cuenta_local, producto) llegan en las Etapas 3 y 4.',
});

const pendienteFinanciero = pendiente(
  'Etapa 4',
  'las tablas ledger, cuenta_local y producto todavia no existen',
);

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

describe('invariante 11 - nada financiero se borra', () => {
  test('no hay borrados sobre auditoria_admin en el codigo', () => {
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
          if (REGLA_BORRADO_AUDITORIA.test(linea)) {
            violaciones.push(`${relativa}:${indice + 1}`);
          }
        });
      }
    }

    assert.equal(
      violaciones.length,
      0,
      `INVARIANTE 11 roto: se borra la auditoria en:\n${violaciones.join('\n')}`,
    );
  });

  test('prisma/migrations queda fuera del chequeo porque es DDL de esquema', () => {
    // Las migraciones crean tablas con CREATE TABLE; no borran informacion
    // en tiempo de ejecucion, asi que no cuentan como violacion.
    assert.ok(fs.existsSync(path.join(RAIZ, 'prisma', 'migrations')));
  });

  test('no hay borrados sobre las tablas financieras', pendienteFinanciero, () => {
    // A activar en las Etapas 3 y 4: ledger, cuenta_local y producto solo
    // admiten un DELETE manual de un administrador, nunca automatico.
    assert.ok(true);
  });

  test('los productos se desactivan, no se borran', pendienteFinanciero, () => {
    // A activar en la Etapa 3: verificar que desactivar un producto deja
    // activo = false y que sus filas siguen existiendo.
    assert.ok(true);
  });

  test('evento_webhook, vistas y pedidos expirados tienen retencion definida', pendienteFinanciero, () => {
    // A activar en las Etapas 3 a 6: verificar que los jobs de limpieza
    // respetan la retencion de 90 dias.
    assert.ok(true);
  });
});