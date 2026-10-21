/**
 * LIMPIEZA DE LA BASE DE PRUEBAS
 * ==============================
 * Se ejecuta sola antes y despues de `npm test` (scripts `pretest` y `posttest`).
 *
 * Por que existe: las pruebas crean usuarios, pedidos y movimientos de ledger.
 * Si la base no se limpia, cada corrida deja cientos de filas y en pocas
 * semanas la base de pruebas tarda mas y cuesta distinguir que dejo la ultima
 * corrida. En vez de acordarse de borrar en cada archivo (facil de olvidar y
 * fragil si una prueba falla a mitad de camino), la base se recrea al empezar:
 * se vacian las tablas y se reinician los identificadores.
 *
 * SEGURIDAD: este script NUNCA toca la base de desarrollo. Importa
 * `tests/helpers/variables.js`, que es el mismo archivo que usan las pruebas
 * para derivar `ccv` -> `ccv_test`, y ademas verifica que el nombre termine
 * en `_test`. Si algo no cuadra, se niega a borrar y sale con error.
 */

// Tiene que ser el primer import: deja DATABASE_URL apuntando a *_test
// antes de que se cree cualquier cliente de Prisma.
import '../tests/helpers/variables.js';

import { PrismaClient } from '../generated/prisma/index.js';

const url = new URL(process.env.DATABASE_URL);
const nombreBase = decodeURIComponent(url.pathname.replace(/^\//, ''));

if (!nombreBase.endsWith('_test')) {
  console.error(
    `\nABORTADO: la base "${nombreBase}" no termina en "_test".\n` +
      'Este script solo puede vaciar la base de pruebas. Revisa DATABASE_URL.\n',
  );
  process.exit(1);
}

const prisma = new PrismaClient();

const TABLAS_PROTEGIDAS = new Set(['_prisma_migrations']);

try {
  const filas = await prisma.$queryRaw`
    SELECT tablename
    FROM pg_tables
    WHERE schemaname = 'public'
  `;

  const tablas = filas
    .map((f) => f.tablename)
    .filter((t) => !TABLAS_PROTEGIDAS.has(t));

  if (tablas.length === 0) {
    console.log(`[pruebas] ${nombreBase}: no hay tablas que limpiar.`);
  } else {
    // Los nombres vienen del catalogo de Postgres, no de entrada del usuario.
    // Igual se entrecomillan para no depender de como se llamen.
    const lista = tablas.map((t) => `"${t.replace(/"/g, '""')}"`).join(', ');
    await prisma.$executeRawUnsafe(
      `TRUNCATE TABLE ${lista} RESTART IDENTITY CASCADE`,
    );
    console.log(
      `[pruebas] ${nombreBase}: ${tablas.length} tablas vaciadas, identificadores reiniciados.`,
    );
  }
} catch (err) {
  const detalle =
    (err.message || '').trim().split('\n').filter(Boolean)[0] ??
    err.code ??
    'sin detalle';

  if (process.env.PERMITIR_SALTAR_BD === '1' && !process.env.CI) {
    console.log(
      `[pruebas] base no disponible y PERMITIR_SALTAR_BD=1: se omite la limpieza.\n` +
        `          (${detalle})`,
    );
  } else {
    console.error(
      `\nNo se pudo limpiar la base de pruebas "${nombreBase}".\n` +
        '  Levantala con: npm run db:iniciar\n' +
        '  Detalle: ' +
        detalle +
        '\n',
    );
    process.exitCode = 1;
  }
} finally {
  await prisma.$disconnect();
}
