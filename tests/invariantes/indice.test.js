import '../helpers/entorno.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * INDICE DE INVARIANTES
 * ====================
 * Lista los doce invariantes y en que estado esta cada uno.
 *
 * Este archivo no prueba nada: documenta. Pero sirve para dos cosas:
 *  1. Que la salida de las pruebas muestre que invariantes siguen sin aplicar,
 *     en vez de que desaparezcan callados.
 *  2. Que si alguien BORRA un archivo de invariantes, este test se entera.
 */

const CARPETA = path.dirname(fileURLToPath(import.meta.url));

const ESPERADOS = [
  [1, 'activo', 'guardian estatico: nada escribe saldos fuera del ledger'],
  [2, 'pendiente', 'Etapa 2 - tabla pago y webhook'],
  [3, 'pendiente', 'Etapa 2 - ruta del webhook'],
  [4, 'activo', 'guardian en ejecucion con AsyncLocalStorage'],
  [5, 'activo', 'triggers: los snapshots de sub_pedido y detalle_producto no se modifican'],
  [6, 'pendiente', 'Etapa 4 - job de liberacion de saldo'],
  [7, 'activo', 'guardian estatico: nada escribe stock fuera del modulo'],
  [8, 'pendiente', 'Etapa 4 - liquidaciones'],
  [9, 'pendiente', 'Etapa 4 - maquina de estados del local'],
  [10, 'pendiente', 'Etapa 2 - POST de pedido y pago'],
  [11, 'parcial', 'pedidos, pagos, reembolsos, sub_pedidos, detalles y ledger protegidos; faltan cuenta_local y retencion'],
  [12, 'pendiente', 'Etapa 3 - primeras tablas con montos'],
];

describe('indice de invariantes', () => {
  test('existen los doce archivos de prueba', () => {
    const existentes = fs.readdirSync(CARPETA);
    const faltan = ESPERADOS.filter(([n]) => {
      const prefijo = `invariante_${String(n).padStart(2, '0')}_`;
      return !existentes.some((f) => f.startsWith(prefijo) && f.endsWith('.test.js'));
    });

    assert.equal(
      faltan.length,
      0,
      `Faltan archivos de prueba de estos invariantes: ${faltan.map(([n]) => n).join(', ')}`,
    );
  });

  test('no hay archivos de invariantes de mas', () => {
    const existentes = fs.readdirSync(CARPETA).filter((f) => f.startsWith('invariante_'));
    const numerados = existentes
      .map((f) => Number(f.match(/^invariante_(\d+)_/)[1]))
      .filter(Number.isInteger)
      .sort((a, b) => a - b);

    assert.deepEqual(
      numerados,
      ESPERADOS.map(([n]) => n),
      'Los archivos de invariantes no cuadran con la lista de doce.',
    );
  });

  test('resumen de estado', () => {
    const resumen = ESPERADOS.map(([n, estado, nota]) => `  ${n}: ${estado.padEnd(10)} ${nota}`).join('\n');
    console.log(`\nEstado de los invariantes en la Etapa 1:\n${resumen}\n`);
    assert.equal(ESPERADOS.length, 12);
  });
});