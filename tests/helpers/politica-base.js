/**
 * Politica de las pruebas cuando no hay base de datos.
 *
 * Vive aparte y sin imports a proposito: asi se puede probar sin crear un
 * cliente de Prisma ni conectarse a nada. `tests/helpers/base.js` la usa para
 * decidir si la prueba se salta o falla.
 */

export function mensajeSinBase(baseDePruebas) {
  return (
    'No hay conexion con la base de datos de pruebas.\n' +
    `  base: ${baseDePruebas}\n` +
    '  Levantala con: npm run db:iniciar\n' +
    '  Si solo quieres correr las pruebas que no necesitan base, usa:\n' +
    '    PERMITIR_SALTAR_BD=1 npm test\n' +
    '  En CI esta variable se ignora: alla las pruebas nunca se saltan.'
  );
}

/**
 * Decide si, SIN base de datos, se permite saltar las pruebas.
 *
 * La variable es un permiso explicito y NUNCA aplica en CI, aunque alguien
 * la configure por error en el entorno del runner.
 */
export function puedeSaltarSinBase(entorno = process.env) {
  return entorno.PERMITIR_SALTAR_BD === '1' && !entorno.CI;
}
