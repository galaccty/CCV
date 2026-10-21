/**
 * RECREACION DE LA BASE DE PRUEBAS
 * ================================
 * Se ejecuta sola antes de `npm test` (script `pretest`).
 *
 * Por que se recrea y no se vacia con TRUNCATE: desde la Etapa 2 hay triggers
 * que prohiben borrar pedidos, pagos, reembolsos, sub_pedidos, detalles y
 * ledger. TRUNCATE no dispara esos triggers, asi que usarlo para "limpiar"
 * escondería que la proteccion funciona. Aca se tira la base completa y se
 * vuelve a crear desde cero; las pruebas corren contra un esquema limpio y los
 * triggers quedan activos todo el tiempo.
 *
 * SEGURIDAD: este script NUNCA toca la base de desarrollo. Importa
 * `tests/helpers/variables.js` (el mismo archivo que usan las pruebas para
 * derivar `ccv` -> `ccv_test`) y ademas exige que el nombre termine en `_test`.
 * Si algo no cuadra, se niega a borrar.
 *
 * Si no hay permisos para DROP DATABASE (por ejemplo en un Postgres administrado
 * donde el usuario no puede crear bases), cae a un plan B equivalente: borra y
 * recrea el esquema `public` de la base de pruebas. Las migraciones se vuelven a
 * aplicar en los dos caminos.
 */

// Tiene que ser el primer import: deja DATABASE_URL apuntando a *_test
// antes de que se cree cualquier cliente de Prisma.
import '../tests/helpers/variables.js';

import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '../generated/prisma/index.js';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const urlPruebas = new URL(process.env.DATABASE_URL);
const nombreBase = decodeURIComponent(urlPruebas.pathname.replace(/^\//, ''));

if (!nombreBase.endsWith('_test')) {
  console.error(
    `\nABORTADO: la base "${nombreBase}" no termina en "_test".\n` +
      'Este script solo puede recrear la base de pruebas. Revisa DATABASE_URL.\n',
  );
  process.exit(1);
}

const nombreSeguro = nombreBase.replace(/"/g, '""');
const urlMantenimiento = new URL(urlPruebas);
urlMantenimiento.pathname = '/postgres';

function detalleDe(err) {
  return (
    (err.message || '').trim().split('\n').filter(Boolean)[0] ?? err.code ?? 'sin detalle'
  );
}

async function recrearBase() {
  const admin = new PrismaClient({
    datasources: { db: { url: urlMantenimiento.toString() } },
  });

  try {
    await admin.$executeRawUnsafe(
      `DROP DATABASE IF EXISTS "${nombreSeguro}" WITH (FORCE)`,
    );
    await admin.$executeRawUnsafe(`CREATE DATABASE "${nombreSeguro}"`);
    console.log(`[pruebas] ${nombreBase}: base recreada desde cero.`);
    return true;
  } catch (err) {
    console.warn(
      `[pruebas] no se pudo recrear la base completa (${detalleDe(err)}).`,
    );
    console.warn('[pruebas] plan B: recrear el esquema public de la base de pruebas.');

    try {
      const prueba = new PrismaClient({
        datasources: { db: { url: urlPruebas.toString() } },
      });
      await prueba.$executeRawUnsafe('DROP SCHEMA IF EXISTS public CASCADE');
      await prueba.$executeRawUnsafe('CREATE SCHEMA public');
      await prueba.$disconnect();
      console.log(`[pruebas] ${nombreBase}: esquema public recreado.`);
      return true;
    } catch (err2) {
      throw new Error(
        `no se pudo recrear "${nombreBase}" ni por base ni por esquema: ${detalleDe(err2)}`,
      );
    }
  } finally {
    await admin.$disconnect();
  }
}

function aplicarMigraciones() {
  const prismaCli = path.join(RAIZ, 'node_modules', 'prisma', 'build', 'index.js');
  execFileSync(process.execPath, [prismaCli, 'migrate', 'deploy'], {
    cwd: RAIZ,
    env: { ...process.env, DATABASE_URL: urlPruebas.toString() },
    stdio: 'inherit',
  });
}

try {
  await recrearBase();
  aplicarMigraciones();
  console.log(`[pruebas] ${nombreBase}: migraciones aplicadas, lista para correr.`);
} catch (err) {
  if (process.env.PERMITIR_SALTAR_BD === '1' && !process.env.CI) {
    console.log(
      `[pruebas] base no disponible y PERMITIR_SALTAR_BD=1: se omite la recreacion.\n` +
        `          (${detalleDe(err)})`,
    );
  } else {
    console.error(
      `\nNo se pudo preparar la base de pruebas "${nombreBase}".\n` +
        '  Levantala con: npm run db:iniciar\n' +
        '  Detalle: ' +
        detalleDe(err) +
        '\n',
    );
    process.exitCode = 1;
  }
}
