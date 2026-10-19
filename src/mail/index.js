/**
 * INTERFAZ DE CORREO
 * ==================
 * La especificacion deja el proveedor como decision pendiente.
 * Aqui solo esta el contrato: `enviar` recibe un objeto de correo y
 * devuelve nada. Quien implemente el proveedor real (Resend, Postmark o SES)
 * solo tiene que cumplir esta misma forma.
 *
 * Cambiar de proveedor despues es agregar un archivo y cambiar MAIL_DRIVER
 * en el .env. Ningun otro archivo del proyecto tiene que cambiar.
 */

/**
 * @typedef {object} Correo
 * @property {string} para          Destinatario.
 * @property {string} asunto        Asunto visible.
 * @property {string} html          Cuerpo en HTML.
 * @property {string} texto         Cuerpo en texto plano (para respaldos).
 * @property {string} [idReferencia] Dato libre para trazar el mensaje.
 */

/** @typedef {(correo: Correo) => Promise<void>} ProveedorCorreo */

/** @type {{ nombre: string, enviar: ProveedorCorreo }} */
let proveedorActual = null;

/**
 * Registra el proveedor a usar. Se llama una vez al arrancar.
 * @param {{ nombre: string, enviar: ProveedorCorreo }} proveedor
 */
export function registrarProveedor(proveedor) {
  if (typeof proveedor?.enviar !== 'function') {
    throw new Error('El proveedor de correo debe exponer una funcion enviar(correo).');
  }
  proveedorActual = proveedor;
  return proveedor;
}

export function proveedorEnUso() {
  return proveedorActual?.nombre ?? 'ninguno';
}

/**
 * Envia un correo usando el proveedor registrado.
 * @param {Correo} correo
 */
export async function enviar(correo) {
  if (!proveedorActual) {
    throw new Error(
      'No hay proveedor de correo registrado. Llama registrarProveedor() al arrancar.',
    );
  }
  await proveedorActual.enviar(correo);
}

export function objetoCorreoVacio() {
  return { para: null, asunto: null, html: null, texto: null };
}