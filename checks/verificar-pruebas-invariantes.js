/**
 * Verifica que existan los doce archivos de pruebas de invariantes.
 *
 *   node checks/verificar-pruebas-invariantes.js
 *
 * Sale con codigo 1 y lista los que faltan, para que un invariante que se
 * quede sin prueba se note en CI en vez de desaparecer en silencio.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CARPETA = path.join(RAIZ, 'tests', 'invariantes');

export const INVARIANTES = [
  [1, 'ledger_es_fuente_de_verdad'],
  [2, 'referencia_unica'],
  [3, 'webhook_responde_luego_de_procesar'],
  [4, 'wompi_fuera_de_transaccion'],
  [5, 'snapshots_de_sub_pedido'],
  [6, 'liberacion_de_saldo'],
  [7, 'stock_atomico'],
  [8, 'compensacion_de_deuda'],
  [9, 'estado_local_por_deuda'],
  [10, 'idempotencia_en_post'],
  [11, 'nada_financiero_se_borra'],
  [12, 'montos_en_el_backend'],
];

export function verificarPruebas() {
  const faltan = [];

  if (!fs.existsSync(CARPETA)) {
    return { faltan: INVARIANTES.map(([n, d]) => ({ n, archivo: `invariante_${String(n).padStart(2, '0')}_${d}.test.js` })), carpetaAusente: true };
  }

  const existentes = new Set(fs.readdirSync(CARPETA));

  for (const [n, descripcion] of INVARIANTES) {
    const prefijo = `invariante_${String(n).padStart(2, '0')}_`;
    if (![...existentes].some((f) => f.startsWith(prefijo) && f.endsWith('.test.js'))) {
      faltan.push({ n, archivo: `${prefijo}${descripcion}.test.js` });
    }
  }

  return { faltan, carpetaAusente: false };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { faltan, carpetaAusente } = verificarPruebas();

  if (faltan.length === 0) {
    console.log('Pruebas de invariantes: los 12 archivos estan.');
    process.exit(0);
  }

  console.error('\nFaltan pruebas de invariantes:\n');
  for (const f of faltan) console.error(`  invariante ${f.n}: ${f.archivo}`);
  if (carpetaAusente) console.error('\nLa carpeta tests/invariantes no existe.');
  console.error('\nTodo invariante necesita al menos una prueba. Si todavia no aplica,\nla prueba se crea marcada como pendiente con su motivo.\n');
  process.exit(1);
}