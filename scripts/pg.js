/**
 * CONTROL DE LA BASE DE DATOS LOCAL
 * =================================
 *
 * Esta copia de PostgreSQL no quedo instalada como servicio de Windows
 * (hacia falta ser administrador), asi que hay que arrancarla y pararla a
 * mano. Este script lo hace mas comodo:
 *
 *   npm run db:iniciar
 *   npm run db:parar
 *   npm run db:estado
 *   npm run db:reiniciar
 *
 * Las rutas salen de PGBIN y PGDATA, que estan en tu .env.
 * Si moviste PostgreSQL, cambialas ahi.
 */

import 'dotenv/config';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const PGBIN = (process.env.PGBIN ?? '').replace(/\\/g, '/').replace(/\/$/, '');
const PGDATA = (process.env.PGDATA ?? '').replace(/\\/g, '/');

if (!PGBIN || !PGDATA) {
  console.error('\nFaltan PGBIN o PGDATA en tu .env.\n');
  console.error('Ejemplo:\n');
  console.error('  PGBIN="C:/ruta/a/pgsql/bin"\n');
  console.error('  PGDATA="C:/ruta/a/pgdata"\n');
  process.exit(1);
}

const ejecutable = path.join(PGBIN, process.platform === 'win32' ? 'pg_ctl.exe' : 'pg_ctl');
const logServidor = path.join(PGDATA, 'server.log');

/**
 * Corre pg_ctl y espera.
 *
 * Solo para comandos que terminan solos (parar, estado).
 */
function correr(args) {
  return spawnSync(ejecutable, args, { encoding: 'utf8', stdio: 'pipe' });
}

/**
 * Arranca PostgreSQL desacoplado.
 *
 * En Windows el proceso de postgres queda adoptado por el sistema y mantiene
 * un descriptor de salida abierto. Si lo esperamos de la forma normal, este
 * script se queda colgado para siempre aunque la base ya haya levantado.
 * Por eso lo lanzamos con detached: nos desvinculamos y verificamos aparte
 * con `pg_ctl status`, que ese si termina solo.
 */
function arrancarDesacoplado(args, comprobar, esperaMs = 3000) {
  const hijo = spawn(ejecutable, args, { stdio: 'ignore', detached: true });
  hijo.unref();

  setTimeout(() => {
    const r = spawnSync(ejecutable, comprobar, { encoding: 'utf8' });
    const salio = r.stdout?.trim() || r.stderr?.trim() || 'sin informacion';
    console.log(salio);
    process.exit(r.status === 0 ? 0 : 1);
  }, esperaMs);
}

const ACCIONES = {
  iniciar() {
    console.log('\nArrancando PostgreSQL...\n');
    arrancarDesacoplado(
      ['-D', PGDATA, '-l', logServidor, '-w', 'start'],
      ['-D', PGDATA, 'status'],
    );
  },

  parar() {
    console.log('\nParando PostgreSQL...\n');
    const r = correr(['-D', PGDATA, '-w', 'stop']);
    if (r.status !== 0) {
      console.error(r.stderr || r.stdout);
      process.exit(1);
    }
    console.log(r.stdout.trim());
  },

  reiniciar() {
    ACCIONES.parar();
    ACCIONES.iniciar();
  },

  estado() {
    const r = correr(['-D', PGDATA, 'status']);
    console.log(r.stdout?.trim() || r.stderr?.trim() || 'sin informacion');
    process.exit(r.status === 0 ? 0 : 1);
  },
};

const accion = process.argv[2];

if (!accion || !ACCIONES[accion]) {
  console.log('\nUso: node scripts/pg.js <iniciar|parar|reiniciar|estado>\n');
  console.log('Atajos:');
  console.log('  npm run db:iniciar');
  console.log('  npm run db:parar');
  console.log('  npm run db:estado\n');
  process.exit(1);
}

if (!fs.existsSync(ejecutable)) {
  console.error(`\nNo se encontro pg_ctl en ${ejecutable}`);
  console.error('Revisa PGBIN en tu .env.\n');
  process.exit(1);
}

ACCIONES[accion]();