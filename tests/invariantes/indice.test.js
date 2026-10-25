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
  [1, 'activo', 'guardian estatico: solo el servicio del ledger escribe saldos'],
  [2, 'activo', 'referencia UNIQUE y referencias desconocidas registradas y alertadas'],
  [3, 'activo', 'el webhook responde 200 solo despues de procesar; 5xx si es transitorio'],
  [4, 'activo', 'guardian en ejecucion con AsyncLocalStorage'],
  [5, 'activo', 'triggers: los snapshots de sub_pedido y detalle_producto no se modifican'],
  [6, 'activo', 'job 4d: libera tras la retencion y respeta reembolsos pendientes y disputas abiertas'],
  [7, 'activo', 'modulo unico de stock y descuento atomico probado en concurrencia'],
  [8, 'activo', 'compensacion solo al preparar una liquidacion y solo con saldo liberado'],
  [9, 'activo', 'trigger y recalcular_estado_local cubren la maquina de estados del local'],
  [10, 'activo', 'Idempotency-Key obligatoria en los POST de pedido y pago'],
  [11, 'parcial', 'pedidos, pagos, reembolsos, sub_pedidos, detalles, ledger, cuenta_local y liquidaciones protegidos; faltan productos y retencion'],
  [12, 'activo', 'el checkout calcula precios, comision, envio y total en el backend'],
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
    console.log(`\nEstado de los invariantes en la Etapa 2:\n${resumen}\n`);
    assert.equal(ESPERADOS.length, 12);
  });
});