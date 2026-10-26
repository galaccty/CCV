/**
 * GUARDIANES ESTATICOS DE LOS INVARIANTES
 * ========================================
 * Estos chequeos corren en cada push y hacen fallar el build si alguien
 * rompe un invariante por la via que los tests no alcanzan a ver.
 *
 *   Invariante 1:  nada escribe los saldos de `cuenta_local` por fuera del
 *                  servicio del ledger. Incluye SQL escrito a mano.
 *   Invariante 7:  nada escribe `producto_variante.stock` por fuera del
 *                  modulo de stock.
 *   Invariante 4a: nadie importa el cliente de Wompi por fuera del modulo
 *                  `wompi`.
 *
 * Se ejecutan juntos desde CI:
 *   node checks/invariantes-estaticos.js
 *
 * Salen con codigo 1 si algo falla, que es lo que bloquea el merge.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Carpetas que se revisan.
 *
 * OJO: prisma/migrations queda FUERA a proposito. Esas migraciones hacen
 * `CREATE TABLE cuenta_local (saldo_deuda ...)` y eso es DDL, no una
 * escritura de saldo en tiempo de ejecucion.
 */
const CARPETAS_REVISADAS = ['src', 'scripts', 'tests'];

/** Extensiones de codigo que nos interesan. */
const EXTENSIONES = new Set(['.js', '.mjs', '.cjs', '.ts', '.mts']);

/**
 * Archivos autorizados a romper cada invariante.
 * Vacio en la Etapa 1 a proposito: todavia no hay ledger ni modulo de stock,
 * asi que cualquier escritura seria una violacion.
 */
export const ARCHIVOS_PERMITIDOS = {
  1: ['src/services/ledger.js'],
  7: ['src/services/stock.js'],
  // El servicio de pagos es el UNICO que puede importar el cliente de Wompi.
  // El cliente sigue exigiendo, en tiempo de ejecucion, que la llamada ocurra
  // fuera de una transaccion. El webhook usa los metodos que pagos.js
  // reexporta, no importa lib/wompi.js directamente.
  4: ['src/lib/wompi.js', 'src/services/pagos.js'],
};

/**
 * Las pruebas de invariantes SI pueden romperlas a proposito: su trabajo es
 * intentar violarlas. Por eso los archivos que se llaman invariante_01_* o
 * invariante_07_* estan autorizados.
 */
function autorizadoComoPruebaDeInvariante(invariante, rutaRelativa) {
  return rutaRelativa.includes(`invariante_0${invariante}_`);
}

/**
 * Archivos que necesitan escribir `cuenta_local` a mano para comprobar que
 * Postgres rechaza la operacion (CHECK de saldos y trigger de borrado). No son
 * codigo de produccion: su unico fin es intentar violar la restriccion. Se
 * excluyen solo del chequeo del invariante 1; el resto de sus lineas sigue
 * pasando por los demas chequeos.
 */
const PRUEBAS_QUE_VIOLAN_CUENTA_LOCAL = new Set([
  'tests/integridad.test.js',
  'tests/invariantes/invariante_11_nada_financiero_se_borra.test.js',
  // Simula una diferencia de conciliacion saltando triggers. El job debe
  // detectarla y alertar, nunca corregirla.
  'tests/etapa4/conciliacion.integridad.test.js',
]);

// ---------------------------------------------------------------------------
// Reglas de deteccion
// ---------------------------------------------------------------------------

const COLUMNAS_SALDO = [
  'saldo_deuda',
  'saldo_por_pagar',
  'saldo_congelado',
  // Nombres del cliente Prisma. La regla tambien tiene que ver una asignacion
  // directa como `cuenta.saldoPorPagar = ...`, no solo el SQL a mano.
  'saldoDeuda',
  'saldoPorPagar',
  'saldoCongelado',
];

/** SQL escrito a mano: UPDATE cuenta_local ... SET saldo_deuda = ... */
const REGLA_SQL_SALDO = new RegExp(
  String.raw`UPDATE\s+"?cuenta_local"?[\s\S]{0,120}?\bSET\b[\s\S]{0,300}?\b(saldo_deuda|saldo_por_pagar|saldo_congelado)\b\s*=`,
  'i',
);

/** ORM: prisma.cuentaLocal.update / upsert / delete... */
const REGLA_ORM_SALDO = new RegExp(
  String.raw`\b(cuentaLocal|cuenta_local)\s*\.\s*(update|updateMany|upsert|create|createMany|delete|deleteMany)\b`,
  'i',
);

/** Asignacion directa a una columna de saldo. */
const REGLA_ASIGNACION_SALDO = new RegExp(
  `(${COLUMNAS_SALDO.join('|')})\\s*(=|:=)\\s*[^=]`,
  'i',
);

const REGLA_SQL_STOCK = new RegExp(
  String.raw`(UPDATE|INSERT)\s+"?producto_variante"?`,
  'i',
);

const REGLA_ORM_STOCK = new RegExp(
  String.raw`\b(productoVariante|producto_variante)\s*\.\s*(update|updateMany|upsert|create|createMany)\b`,
  'i',
);

const REGLA_ASIGNACION_STOCK = new RegExp(
  String.raw`\bstock\s*(:=|=)\s*[^=]`,
  'i',
);

const REGLA_IMPORT_WOMPI = new RegExp(
  String.raw`(from|require\()\s*['"][^'"]*lib/wompi(\.js)?['"]`,
);

// ---------------------------------------------------------------------------
// Recorrido de archivos
// ---------------------------------------------------------------------------

function* recorrer(directorio) {
  for (const entrada of fs.readdirSync(directorio, { withFileTypes: true })) {
    const completa = path.join(directorio, entrada.name);
    if (entrada.isDirectory()) {
      if (entrada.name === 'node_modules' || entrada.name === 'generated') continue;
      yield* recorrer(completa);
    } else if (EXTENSIONES.has(path.extname(entrada.name))) {
      yield completa;
    }
  }
}

function lineasDe(archivo) {
  return fs.readFileSync(archivo, 'utf8').split(/\r?\n/);
}

/** Ignora las lineas que son solo comentario. */
function esComentario(linea) {
  const t = linea.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('#');
}

// ---------------------------------------------------------------------------
// Chequeos
// ---------------------------------------------------------------------------

const listaBlanca = (invariante, relativa) =>
  ARCHIVOS_PERMITIDOS[invariante].includes(relativa) ||
  autorizadoComoPruebaDeInvariante(invariante, relativa);

function revisarInvariante({ invariante, nombre, reglas, exclusiones }) {
  const violaciones = [];

  for (const carpeta of CARPETAS_REVISADAS) {
    const absoluta = path.join(RAIZ, carpeta);
    if (!fs.existsSync(absoluta)) continue;

    for (const archivo of recorrer(absoluta)) {
      const relativa = path.relative(RAIZ, archivo).replace(/\\/g, '/');
      if (exclusiones(relativa)) continue;
      if (listaBlanca(invariante, relativa)) continue;

      lineasDe(archivo).forEach((linea, indice) => {
        if (esComentario(linea)) return;
        for (const { patron, como } of reglas) {
          if (patron.test(linea)) {
            violaciones.push({
              invariante,
              nombre,
              archivo: relativa,
              linea: indice + 1,
              como,
              texto: linea.trim().slice(0, 100),
            });
            break;
          }
        }
      });
    }
  }

  return violaciones;
}

/**
 * El invariante 7 no prohíbe tocar el precio o el estado de una variante:
 * prohíbe escribir su STOCK por fuera del módulo. Por eso la detección mira
 * una ventana de líneas alrededor de la escritura y exige que aparezca la
 * columna `stock`. Las creaciones de variantes se marcan siempre, porque el
 * stock inicial también debe pasar por el módulo.
 *
 * Se exporta el analizador puro para que las pruebas puedan demostrar que el
 * guardián realmente falla ante una escritura simulada, sin crear archivos
 * temporales dentro del repositorio.
 */
export function analizarInvariante7(contenido, rutaRelativa = 'archivo-simulado.js') {
  if (listaBlanca(7, rutaRelativa)) return [];

  const lineas = Array.isArray(contenido)
    ? contenido
    : String(contenido).split(/\r?\n/);
  const violaciones = [];
  const NOMBRE = 'El stock solo lo escribe el modulo de stock';

  for (let indice = 0; indice < lineas.length; indice += 1) {
    const linea = lineas[indice];
    if (esComentario(linea)) continue;

    const ventana = lineas.slice(indice, indice + 30).join('\n');
    const ventanaSql = lineas.slice(indice, indice + 6).join('\n');
    const escrituraOrm = linea.match(REGLA_ORM_STOCK);
    const escrituraSql = linea.match(REGLA_SQL_STOCK);
    const asignacionDirecta = REGLA_ASIGNACION_STOCK.test(linea);

    if (escrituraOrm) {
      const metodo = escrituraOrm[2].toLowerCase();
      const creaVariante = ['create', 'createmany', 'upsert'].includes(metodo);
      const escribeStock = /\bstock\s*:/.test(ventana);

      if (creaVariante || escribeStock) {
        violaciones.push({
          invariante: 7,
          nombre: NOMBRE,
          archivo: rutaRelativa,
          linea: indice + 1,
          como: 'escritura por el ORM sobre producto_variante',
          texto: linea.trim().slice(0, 100),
        });
        continue;
      }
    }

    if (escrituraSql && /\bstock\b/i.test(ventanaSql)) {
      violaciones.push({
        invariante: 7,
        nombre: NOMBRE,
        archivo: rutaRelativa,
        linea: indice + 1,
        como: 'escritura SQL sobre producto_variante.stock',
        texto: linea.trim().slice(0, 100),
      });
      continue;
    }

    if (asignacionDirecta) {
      violaciones.push({
        invariante: 7,
        nombre: NOMBRE,
        archivo: rutaRelativa,
        linea: indice + 1,
        como: 'asignacion directa a stock',
        texto: linea.trim().slice(0, 100),
      });
    }
  }

  return violaciones;
}

/**
 * Analiza un contenido simulado del invariante 1. Se exporta para que las
 * pruebas demuestren que el guardian SI detecta las escrituras prohibidas,
 * incluidas las de los tipos nuevos del ledger, y que solo deja pasar al
 * servicio del ledger.
 */
export function analizarInvariante1(contenido, rutaRelativa = 'archivo-simulado.js') {
  if (listaBlanca(1, rutaRelativa)) return [];

  const lineas = Array.isArray(contenido)
    ? contenido
    : String(contenido).split(/\r?\n/);
  const violaciones = [];
  const NOMBRE = 'El ledger es la fuente de verdad';

  for (let indice = 0; indice < lineas.length; indice += 1) {
    const linea = lineas[indice];
    if (esComentario(linea)) continue;

    const ventana = lineas.slice(indice, indice + 8).join('\n');
    const ventanaOrm = lineas.slice(indice, indice + 30).join('\n');
    const escrituraSql = /\bUPDATE\s+"?cuenta_local"?/i.test(linea);
    const escrituraOrm = linea.match(REGLA_ORM_SALDO);
    // Un UPDATE de cuenta_local que solo toca fecha_limite_pago no mueve
    // saldos y esta permitido. La regla exige que aparezca una columna de
    // saldo en el SET.
    const asignacionDirecta =
      !/\bSET\b/i.test(linea) && REGLA_ASIGNACION_SALDO.test(linea);

    if (escrituraSql && REGLA_SQL_SALDO.test(ventana)) {
      violaciones.push({
        invariante: 1,
        nombre: NOMBRE,
        archivo: rutaRelativa,
        linea: indice + 1,
        como: 'UPDATE SQL sobre cuenta_local',
        texto: linea.trim().slice(0, 100),
      });
      continue;
    }

    if (escrituraOrm) {
      const metodo = escrituraOrm[2].toLowerCase();
      const creaOBorra = ['create', 'createmany', 'delete', 'deletemany'].includes(
        metodo,
      );
      const escribeSaldo = COLUMNAS_SALDO.some((campo) =>
        new RegExp(`\\b${campo}\\s*:`).test(ventanaOrm),
      );

      if (creaOBorra || escribeSaldo) {
        violaciones.push({
          invariante: 1,
          nombre: NOMBRE,
          archivo: rutaRelativa,
          linea: indice + 1,
          como: 'escritura por el ORM sobre cuenta_local',
          texto: linea.trim().slice(0, 100),
        });
        continue;
      }
    }

    if (asignacionDirecta) {
      violaciones.push({
        invariante: 1,
        nombre: NOMBRE,
        archivo: rutaRelativa,
        linea: indice + 1,
        como: 'asignacion directa a una columna de saldo',
        texto: linea.trim().slice(0, 100),
      });
    }
  }

  return violaciones;
}

function revisarInvariante1() {
  const violaciones = [];

  for (const carpeta of CARPETAS_REVISADAS) {
    const absoluta = path.join(RAIZ, carpeta);
    if (!fs.existsSync(absoluta)) continue;

    for (const archivo of recorrer(absoluta)) {
      const relativa = path.relative(RAIZ, archivo).replace(/\\/g, '/');
      if (PRUEBAS_QUE_VIOLAN_CUENTA_LOCAL.has(relativa)) continue;
      violaciones.push(...analizarInvariante1(lineasDe(archivo), relativa));
    }
  }

  return violaciones;
}

function revisarInvariante7() {
  const violaciones = [];

  for (const carpeta of CARPETAS_REVISADAS) {
    const absoluta = path.join(RAIZ, carpeta);
    if (!fs.existsSync(absoluta)) continue;

    for (const archivo of recorrer(absoluta)) {
      const relativa = path.relative(RAIZ, archivo).replace(/\\/g, '/');
      violaciones.push(...analizarInvariante7(lineasDe(archivo), relativa));
    }
  }

  return violaciones;
}

export function ejecutarChequeos() {
  const resultados = [
    revisarInvariante1(),

    revisarInvariante7(),

    revisarInvariante({
      invariante: 4,
      nombre: 'El cliente de Wompi solo se importa en su modulo',
      reglas: [{ patron: REGLA_IMPORT_WOMPI, como: 'importacion del cliente de Wompi' }],
      exclusiones: () => false,
    }),
  ];

  return resultados.flat();
}

// Si se ejecuta directo, informa y sale con codigo 1 si hay violaciones.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const violaciones = ejecutarChequeos();

  if (violaciones.length === 0) {
    console.log('Invariantes estaticos: OK (1, 4 y 7 sin violaciones).');
    process.exit(0);
  }

  console.error('\nINVARIANTES ROTOS\n');
  for (const v of violaciones) {
    console.error(`  [invariante ${v.invariante}] ${v.nombre}`);
    console.error(`    archivo: ${v.archivo}:${v.linea}`);
    console.error(`    motivo:  ${v.como}`);
    console.error(`    linea:   ${v.texto}`);
    console.error('');
  }
  console.error(
    'Si necesitas una excepcion, agregala de forma consciente y anota el porque\n' +
      'en el pull request. Un invariante que se rompe a proposito y sin que nadie\n' +
      'lo note deja de proteger nada.\n',
  );
  process.exit(1);
}