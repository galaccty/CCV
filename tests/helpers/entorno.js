/**
 * Entorno de pruebas (sin base de datos).
 *
 * OJO CON EL ORDEN: el primer import tiene que ser './variables.js'.
 * En JavaScript los imports se evaluan en el orden en que estan escritos, asi
 * que ese archivo (que no importa nada del proyecto) deja las variables de
 * entorno puestas ANTES de que se cargue la configuracion.
 *
 * Este archivo NO importa Prisma a proposito. Node ejecuta los archivos de
 * prueba en paralelo, y cada cliente de Prisma abre su propio pool de
 * conexiones: si los 16 archivos de prueba crearan uno, se terminarian
 * agotando las del servidor y los que SI necesitan la base fallarian al
 * conectarse. Los que necesitan base usan './base.js'.
 *
 * Lo que si vive aca es el proveedor de correo de prueba, que guarda los
 * mensajes para poder leer el enlace de verificacion sin depender de la
 * terminal.
 */

import { BASE_DE_PRUEBAS } from './variables.js';
import { registrarProveedor } from '../../src/mail/index.js';

export { BASE_DE_PRUEBAS };

/** Correos enviados durante la prueba. */
export const correosEnviados = [];

export const proveedorDePrueba = {
  nombre: 'prueba',
  async enviar(correo) {
    correosEnviados.push(correo);
  },
};

registrarProveedor(proveedorDePrueba);

export function limpiarCorreos() {
  correosEnviados.length = 0;
}

/** Ultimo correo enviado cuyo asunto contiene el texto dado. */
export function ultimoCorreo(asuntoIncluye) {
  return [...correosEnviados].reverse().find((c) => c.asunto.includes(asuntoIncluye));
}

/** Extrae un parametro de la URL de un enlace que viene dentro de un correo. */
export function tokenDeCorreo(correo, parametro = 'token') {
  const coincidencia = correo.texto.match(new RegExp(`${parametro}=([A-Za-z0-9_-]+)`));
  return coincidencia?.[1] ?? null;
}

let contador = 0;

/** Correo unico por prueba, para que una ejecucion no pise la anterior. */
export function correoUnico(prefijo = 'prueba') {
  contador += 1;
  return `${prefijo}.${Date.now()}.${contador}@ejemplo.com`;
}

export const CONTRASENA_VALIDA = 'PruebaSegura123';