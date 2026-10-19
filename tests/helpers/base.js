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

export { BASE_DE_PRUEBAS, prisma };

let conexionVerificada = null;

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
 * Opciones para `test(...)`: se saltea la prueba si no hay base de datos.
 * A diferencia de un `skip` fijo, aqui SI depende del resultado del chequeo.
 */
export async function opcionesConBase() {
  const hay = await baseDeDatosDisponible();
  return hay
    ? {}
    : { skip: `sin base de datos conectada (las pruebas apuntan a ${BASE_DE_PRUEBAS})` };
}

/** Marca el correo como verificado sin pasar por el enlace. */
export async function marcarEmailVerificado(email) {
  await prisma.usuario.updateMany({ where: { email }, data: { emailVerificado: true } });
}

export async function cerrarConexion() {
  await prisma.$disconnect();
}