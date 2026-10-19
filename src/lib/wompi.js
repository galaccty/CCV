import { exigirFueraDeTransaccion } from './transaccion.js';

/**
 * Cliente de Wompi.
 *
 * En la Etapa 1 todavia no hay pagos: este modulo existe desde ahora para
 * que el invariante 4 quede protegido desde el primer dia, antes de que
 * exista codigo que pueda romperlo.
 *
 * Dos capas de proteccion:
 *  1. La regla de lint que prohibe importar este archivo fuera del modulo
 *     `wompi`. Asi nadie lo copia a otro lado para saltarse el guardián.
 *  2. El guardián de `src/lib/transaccion.js`, que revisa cada llamada.
 *
 * En la Etapa 2 se implementan los metodos reales de aqui.
 */

const NO_IMPLEMENTADO =
  'El cliente de Wompi se implementa en la Etapa 2 (integracion con sandbox).';

/** Crea una transaccion de pago en Wompi. */
export async function crearTransaccion(_datos) {
  exigirFueraDeTransaccion('wompi.crearTransaccion');
  throw new Error(NO_IMPLEMENTADO);
}

/** Consulta el estado de una transaccion por su referencia. */
export async function consultarTransaccion(_referencia) {
  exigirFueraDeTransaccion('wompi.consultarTransaccion');
  throw new Error(NO_IMPLEMENTADO);
}

/** Solicita un reembolso. */
export async function solicitarReembolso(_datos) {
  exigirFueraDeTransaccion('wompi.solicitarReembolso');
  throw new Error(NO_IMPLEMENTADO);
}

/** Verifica la firma o el secreto de los eventos entrantes. */
export async function verificarFirmaEvento(_cuerpo, _firma) {
  exigirFueraDeTransaccion('wompi.verificarFirmaEvento');
  throw new Error(NO_IMPLEMENTADO);
}