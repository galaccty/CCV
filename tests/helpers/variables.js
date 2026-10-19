/**
 * VARIABLES DE ENTORNO PARA LAS PRUEBAS
 * =====================================
 * Este archivo no importa NADA del proyecto a proposito.
 *
 * En JavaScript con modulos ES, todos los imports se evaluan ANTES de las
 * sentencias del archivo. Por eso si estas asignaciones vivieran en un archivo
 * que tambien importa la configuracion, llegado el momento de correrlas la
 * configuracion ya se habia leido con los valores viejos.
 *
 * La solucion es que este archivo solo use createRequire (que no es un import):
 * se evalua primero, carga el .env, pone las variables, y recien despues se
 * carga el resto del proyecto.
 */

import { createRequire } from 'node:module';

/**
 * Este archivo se evalua antes que cualquier otro modulo del proyecto, asi
 * que todavia nadie ha cargado el .env. Se carga aca, en el cuerpo del
 * modulo: createRequire NO es un import, asi que no se adelanta.
 */
const require = createRequire(import.meta.url);
require('dotenv').config({ quiet: true });

/** Cambia el nombre de la base para que las pruebas no toquen la de desarrollo. */
function urlDePruebas(url) {
  if (!url) return url;
  try {
    const u = new URL(url);
    const base = u.pathname.replace(/^\//, '').replace(/_test$/, '');
    u.pathname = `/${base}_test`;
    return u.toString();
  } catch {
    return url;
  }
}

export const BASE_DE_PRUEBAS = urlDePruebas(process.env.DATABASE_URL);

process.env.DATABASE_URL = BASE_DE_PRUEBAS;

process.env.NODE_ENV = 'test';

// Clave fija para que los tokens firmados sean reproducibles entre pruebas.
process.env.SESSION_SECRET = 'secreto-de-pruebas-0123456789abcdef';
process.env.SESSION_COOKIE_SECURE = 'false';

// El proveedor de consola escribe en pantalla y arruinaria la salida de las
// pruebas. El de prueba guarda los mensajes para poder leerlos.
process.env.MAIL_DRIVER = 'ninguno';

// Sin base de datos, los errores de Prisma llenarian la salida de ruido.
process.env.LOG_LEVEL = 'silent';