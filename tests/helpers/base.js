/**
 * Acceso a la base de datos en las pruebas.
 *
 * Va aparte de './entorno.js' a proposito: node --test corre los archivos de
 * prueba en paralelo, y este es el UNICO lugar donde se crea un cliente de
 * Prisma. Los archivos que no necesitan base (los doce invariantes y los
 * limites) no lo importan, y asi no abren pools de conexiones que no usan.
 *
 * Solo lo importan auth.test.js y api.test.js.
 */

import './entorno.js';
import { prisma } from '../../src/lib/prisma.js';
import { BASE_DE_PRUEBAS } from './entorno.js';
import { mensajeSinBase, puedeSaltarSinBase } from './politica-base.js';

export { BASE_DE_PRUEBAS, prisma, puedeSaltarSinBase };

let conexionVerificada = null;

/** Mensaje unico para que el fallo diga exactamente que hacer. */
export const MENSAJE_SIN_BASE = mensajeSinBase(BASE_DE_PRUEBAS);

/** true si hay una base de datos a la que conectarse. */
export async function baseDeDatosDisponible() {
  if (conexionVerificada !== null) return conexionVerificada;
  try {
    await prisma.$queryRaw`SELECT 1`;
    conexionVerificada = true;
  } catch {
    conexionVerificada = false;
  }
  return conexionVerificada;
}

/**
 * Opciones para `test(...)`.
 *
 * Si la base responde: {} y la prueba corre.
 * Si no responde: por defecto LANZA, para que la prueba falle con un mensaje
 * claro. Antes se saltaba sola y la suite quedaba en verde sin haber probado
 * lo que importa. Solo se salta con PERMITIR_SALTAR_BD=1 y fuera de CI.
 */
export async function opcionesConBase() {
  const hay = await baseDeDatosDisponible();
  if (hay) return {};

  if (puedeSaltarSinBase()) {
    return { skip: `sin base de datos (PERMITIR_SALTAR_BD=1): ${BASE_DE_PRUEBAS}` };
  }

  throw new Error(MENSAJE_SIN_BASE);
}

/** Marca el correo como verificado sin pasar por el enlace. */
export async function marcarEmailVerificado(email) {
  await prisma.usuario.updateMany({ where: { email }, data: { emailVerificado: true } });
}

export async function cerrarConexion() {
  await prisma.$disconnect();
}