/**
 * Marca una prueba como PENDIENTE de forma explicita.
 *
 * Un invariante que todavia no aplica NO se borra ni se salta en silencio:
 * queda el archivo, queda el motivo y queda la etapa en la que se activa.
 * Asi nadie puede borrar un invariante "porque todavia no aplica" y que
 * nadie lo note hasta que el dinero se mueva mal en produccion.
 *
 * @param {string} etapa  En que etapa se activa. Ej: 'Etapa 2'.
 * @param {string} motivo Por que no aplica todavia.
 * @returns {{ skip: string }}
 */
export function pendiente(etapa, motivo) {
  return { skip: `PENDIENTE ${etapa}: ${motivo}` };
}

/** Estado de un invariante, para el resumen de tests/invariantes/indice.test.js */
export function estadoInvariante({ aplica, etapa, motivo }) {
  return { aplica, etapa, motivo };
}