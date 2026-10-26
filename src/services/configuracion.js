import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';

export {
  CLAVES_CONGELADAS,
  CLAVES_EN_VIVO,
  CLAVES_CONFIGURACION,
  esCongelada,
} from '../domain/configuracion.js';

/**
 * Lector de la tabla `configuracion`.
 *
 * La tabla es clave-valor con un `tipo` que dice como interpretar el texto.
 * Este modulo es el UNICO lugar donde se leen esos valores, para que una
 * clave mal cargada se note en un solo archivo y no en toda la aplicacion.
 */

const cache = new Map();
let cacheCargada = false;

export function interpretarValorConfiguracion(valor, tipo) {
  switch (tipo) {
    case 'entero':
      return Number.parseInt(valor, 10);
    case 'numero':
      return Number.parseFloat(valor);
    case 'booleano':
      return valor === 'true';
    case 'texto':
      return valor;
    default:
      return valor;
  }
}

/** Carga (o recarga) toda la configuracion en memoria. */
export async function cargarConfiguracion({ forzar = false } = {}) {
  if (cacheCargada && !forzar) return cache;

  const filas = await prisma.configuracion.findMany();
  cache.clear();
  for (const fila of filas) {
    cache.set(fila.clave, fila);
  }
  cacheCargada = true;
  logger.debug({ claves: cache.size }, 'configuracion cargada');
  return cache;
}

export function limpiarCacheConfiguracion() {
  cache.clear();
  cacheCargada = false;
}

/** Devuelve el valor tipado, o `porDefecto` si la clave no existe. */
export function obtener(clave, porDefecto = undefined) {
  const fila = cache.get(clave);
  if (!fila) return porDefecto;
  const valor = interpretarValorConfiguracion(fila.valor, fila.tipo);
  return valor === null || Number.isNaN(valor) ? porDefecto : valor;
}

/**
 * Lee claves directamente dentro de una transaccion.
 *
 * `recalcular_estado_local` necesita los valores EN VIVO y en la misma
 * transaccion que bloquea el local. No usa la cache porque el admin puede
 * haber cambiado `limite_deuda` o `plazo_dias` hace un instante.
 */
export async function obtenerConfiguracionEnTransaccion(tx, claves) {
  const filas = await tx.configuracion.findMany({
    where: { clave: { in: claves } },
    select: { clave: true, valor: true, tipo: true },
  });

  const valores = {};
  for (const fila of filas) {
    valores[fila.clave] = interpretarValorConfiguracion(fila.valor, fila.tipo);
  }
  return valores;
}

export function obtenerEntero(clave, porDefecto = 0) {
  const v = obtener(clave, porDefecto);
  return typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : porDefecto;
}

export function obtenerNumero(clave, porDefecto = 0) {
  const v = obtener(clave, porDefecto);
  return typeof v === 'number' && Number.isFinite(v) ? v : porDefecto;
}

export function obtenerTexto(clave, porDefecto = '') {
  const v = obtener(clave, porDefecto);
  return typeof v === 'string' ? v : porDefecto;
}

// La distincion congelada/en vivo vive en `src/domain/configuracion.js` para
// que la validacion de la API y el servicio de administracion compartan una
// sola lista. Se reexporta arriba para no romper imports existentes.
