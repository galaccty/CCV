import { logger } from '../lib/logger.js';

/**
 * PROVEEDOR DE PRUEBA: escribe el correo en la consola.
 *
 * Es el que usa la Etapa 1 mientras eliges proveedor. El enlace de
 * verificacion y el de restablecimiento aparecen completos en la terminal,
 * asi que puedes probarlos sin configurar nada externo.
 *
 * El enlace llega como texto plano justamente para que puedas hacer clic.
 * Con un proveedor real se envia solo el HTML.
 */

const ANCHO = 78;

function linea(char = '-') {
  return char.repeat(ANCHO);
}

function envolver(texto, sangria = 2) {
  const espacio = ' '.repeat(sangria);
  return texto
    .split('\n')
    .map((l) => espacio + l)
    .join('\n');
}

export const proveedorConsola = {
  nombre: 'consola',

  async enviar(correo) {
    const separador = linea('=');
    logger.info(`Correo simulado -> ${correo.para} (${correo.asunto})`);

    if (process.env.NODE_ENV !== 'test') {
      console.log('\n' + separador);
      console.log(`  CORREO (proveedor de prueba, no se envio a nadie)`);
      console.log(`  Para:    ${correo.para}`);
      console.log(`  De:      ${correo.from ?? '(sin definir)'}`);
      console.log(`  Asunto:  ${correo.asunto}`);
      console.log(linea());
      console.log(envolver(correo.texto ?? '(sin texto plano)'));
      console.log(separador + '\n');
    }
  },
};

/**
 * Proveedor que no hace nada. Util para pruebas automatizadas que
 * necesitan importar la app sin ensuciar la salida.
 */
export const proveedorNulo = {
  nombre: 'ninguno',
  async enviar() {},
};