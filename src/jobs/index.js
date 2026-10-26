import { CLAVES_JOBS, ejecutarJob } from './ejecutarJob.js';
import { autoEntregar } from './autoEntregar.js';
import { bloquearLocalesVencidos } from './bloquearLocalesVencidos.js';
import { cancelarEfectivoSinAceptar } from './cancelarEfectivoSinAceptar.js';
import { conciliar } from './conciliar.js';
import { expirarPagos } from './expirarPagos.js';
import { verificarIntegridad } from './integridad.js';
import { liberarSaldos } from './liberarSaldos.js';
import { reembolsosEfectivoVencidos } from './reembolsosEfectivoVencidos.js';

/**
 * REGISTRO UNICO DE JOBS
 * ======================
 * El orden de `JOBS_EN_ORDEN` es el que usa `npm run job:todos`. Primero se
 * cierran los estados que dependen del tiempo (auto-entrega, expiracion,
 * cancelaciones y reembolsos vencidos), despues se libera saldo, se bloquean
 * locales morosos y, al final, se auditan las cuentas.
 *
 * Las claves numericas viven SOLO en `ejecutarJob.js` (`CLAVES_JOBS`). Aca se
 * referencian por nombre para que no existan dos listas que se desincronicen.
 *
 * Los jobs de notificaciones, promedios y anuncios siguen pendientes de las
 * etapas 5 y 6; se listan para que `jobsPendientes()` siga siendo util.
 */

const DESCRIPTORES = [
  {
    nombre: 'auto_entrega',
    etapa: 4,
    activa: true,
    comando: 'job:auto-entregar',
    clave: CLAVES_JOBS.auto_entrega,
    ejecutar: autoEntregar,
  },
  {
    nombre: 'expirar_pedidos_digitales',
    etapa: 4,
    activa: true,
    comando: 'job:expirar-pagos',
    clave: CLAVES_JOBS.expirar_pagos,
    ejecutar: expirarPagos,
  },
  {
    nombre: 'cancelar_efectivo_sin_aceptar',
    etapa: 4,
    activa: true,
    comando: 'job:cancelar-efectivo-sin-aceptar',
    clave: CLAVES_JOBS.cancelar_efectivo_sin_aceptar,
    ejecutar: cancelarEfectivoSinAceptar,
  },
  {
    nombre: 'reembolsos_efectivo_vencidos',
    etapa: 4,
    activa: true,
    comando: 'job:reembolsos-efectivo-vencidos',
    clave: CLAVES_JOBS.reembolsos_efectivo_vencidos,
    ejecutar: reembolsosEfectivoVencidos,
  },
  {
    nombre: 'liberacion_saldo',
    etapa: 4,
    activa: true,
    comando: 'job:liberar-saldos',
    clave: CLAVES_JOBS.liberar_saldos,
    ejecutar: liberarSaldos,
  },
  {
    nombre: 'bloqueo_deuda',
    etapa: 4,
    activa: true,
    comando: 'job:bloquear-locales-vencidos',
    clave: CLAVES_JOBS.bloquear_locales_vencidos,
    ejecutar: bloquearLocalesVencidos,
  },
  {
    nombre: 'conciliacion_nocturna',
    etapa: 4,
    activa: true,
    comando: 'job:conciliar',
    clave: CLAVES_JOBS.conciliar,
    ejecutar: conciliar,
  },
  {
    nombre: 'verificacion_integridad',
    etapa: 4,
    activa: true,
    comando: 'job:integridad',
    clave: CLAVES_JOBS.integridad,
    ejecutar: verificarIntegridad,
  },
  {
    nombre: 'notificaciones_por_lotes',
    etapa: 5,
    activa: false,
    clave: null,
    ejecutar: null,
  },
  {
    nombre: 'reconstruir_promedios',
    etapa: 5,
    activa: false,
    clave: null,
    ejecutar: null,
  },
  {
    nombre: 'retirar_anuncios_vencidos',
    etapa: 6,
    activa: false,
    clave: null,
    ejecutar: null,
  },
];

export const JOBS_EN_ORDEN = Object.freeze(
  DESCRIPTORES.filter((job) => job.activa),
);

export const JOBS = Object.fromEntries(
  DESCRIPTORES.map((job) => [job.nombre, job]),
);

export function jobsPendientes() {
  return DESCRIPTORES.filter((job) => !job.activa).map(({ nombre, etapa }) => ({
    nombre,
    etapa,
  }));
}

/**
 * Corre todos los jobs activos en orden, cada uno con su propio advisory lock.
 * `job:todos` usa esta funcion. Un job ocupado se omite sin frenar la cadena y
 * un fallo se registra para seguir con los demas; el script termina con codigo
 * 1 si alguno fallo.
 */
export async function ejecutarJobsActivos({
  ejecutar = ejecutarJob,
  continuarEnError = true,
} = {}) {
  const ejecutados = [];

  for (const job of JOBS_EN_ORDEN) {
    try {
      const resultado = await ejecutar({
        nombre: job.nombre,
        clave: job.clave,
        ejecutar: job.ejecutar,
      });
      ejecutados.push({ nombre: job.nombre, ...resultado });
    } catch (err) {
      ejecutados.push({
        nombre: job.nombre,
        ejecutado: false,
        motivo: 'error',
        error: err.message,
      });

      if (!continuarEnError) throw err;
    }
  }

  return ejecutados;
}
