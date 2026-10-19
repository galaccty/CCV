import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';

/**
 * Lector de la tabla `configuracion`.
 *
 * La tabla es clave-valor con un `tipo` que dice como interpretar el texto.
 * Este modulo es el UNICO lugar donde se leen esos valores, para que una
 * clave mal cargada se note en un solo archivo y no en toda la aplicacion.
 */

const cache = new Map();
let cacheCargada = false;

function interpretar(valor, tipo) {
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
  const valor = interpretar(fila.valor, fila.tipo);
  return valor === null || Number.isNaN(valor) ? porDefecto : valor;
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

/**
 * Valor congelado vs valor en vivo (seccion 4.2).
 * Esta funcion existe para que la distincion quede visible en el codigo:
 * cuando llegue la Etapa 2, el checkout usara leerSnapshotPedido() y los
 * jobs usaran leerEnVivo().
 */
export const CLAVES_CONGELADAS = [
  'porcentaje_comision',
  'comision_minima',
  'pedido_minimo',
  'tarifa_base_envio',
  'tarifa_por_km',
  'dias_retencion',
];

export const CLAVES_EN_VIVO = [
  'limite_deuda',
  'plazo_dias',
  'dias_auto_entrega',
  'minutos_expiracion_pago',
  'horas_aceptacion',
];

export function esCongelada(clave) {
  return CLAVES_CONGELADAS.includes(clave);
}