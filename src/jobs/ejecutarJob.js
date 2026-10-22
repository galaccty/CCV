import pg from 'pg';
import { config } from '../config/entorno.js';
import { logger } from '../lib/logger.js';

const { Client } = pg;

/**
 * EJECUTOR DE JOBS CON CANDADO ADVISORY
 * =====================================
 * Cada job corre como un script independiente (`npm run job:<nombre>`). Si el
 * programador externo lanza dos instancias al mismo tiempo, solo una debe
 * trabajar. El candado es de PostgreSQL y vive en la sesion de una conexion
 * dedicada: se libera al terminar o, si el proceso muere, al cerrarse la
 * conexion.
 *
 * El cierre va en un `finally` para que no quede una conexion colgada aunque
 * el job lance. No se usa el pool de Prisma: el candado tiene que quedar en
 * una conexion conocida y cerrarse explicitamente.
 */

/** Claves fijas por job. No reutilizar: dos jobs distintos no deben excluirse. */
export const CLAVES_JOBS = Object.freeze({
  liberar_saldos: 41001,
  bloquear_locales_vencidos: 41002,
  cancelar_efectivo_sin_aceptar: 41003,
  expirar_pagos: 41004,
  conciliar: 41005,
  integridad: 41006,
});

/**
 * Corre un job bajo `pg_try_advisory_lock`.
 *
 * @param {object} opciones
 * @param {string} opciones.nombre nombre para los logs
 * @param {number} opciones.clave entero de 32 bits, unico por job
 * @param {() => Promise<any>} opciones.ejecutar trabajo real
 * @returns {Promise<{ejecutado: boolean, resultado?: any, motivo?: string}>}
 */
export async function ejecutarJob({ nombre, clave, ejecutar }) {
  if (typeof nombre !== 'string' || nombre.length === 0) {
    throw new Error('ejecutarJob necesita un nombre.');
  }
  if (
    !Number.isInteger(clave) ||
    clave < 0 ||
    clave > 2_147_483_647
  ) {
    throw new Error('La clave del job debe ser un entero de 32 bits no negativo.');
  }
  if (typeof ejecutar !== 'function') {
    throw new Error('ejecutarJob necesita una funcion ejecutar.');
  }

  const cliente = new Client({ connectionString: config.DATABASE_URL });
  await cliente.connect();

  let tomado = false;

  try {
    const resultadoLock = await cliente.query(
      'SELECT pg_try_advisory_lock($1::bigint) AS tomado',
      [clave],
    );
    tomado = resultadoLock.rows[0]?.tomado === true;

    if (!tomado) {
      logger.info({ job: nombre }, 'job omitido: otra instancia lo esta ejecutando');
      return { ejecutado: false, motivo: 'ocupado' };
    }

    logger.info({ job: nombre }, 'job iniciado');
    const resultado = await ejecutar();
    logger.info({ job: nombre }, 'job terminado');

    return { ejecutado: true, resultado };
  } finally {
    if (tomado) {
      try {
        await cliente.query('SELECT pg_advisory_unlock($1::bigint)', [clave]);
      } catch (err) {
        logger.warn({ err, job: nombre }, 'no se pudo liberar el candado del job');
      }
    }
    await cliente.end();
  }
}
