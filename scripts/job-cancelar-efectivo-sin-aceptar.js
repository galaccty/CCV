import { prisma } from '../src/lib/prisma.js';
import { logger } from '../src/lib/logger.js';
import { CLAVES_JOBS, ejecutarJob } from '../src/jobs/ejecutarJob.js';
import { cancelarEfectivoSinAceptar } from '../src/jobs/cancelarEfectivoSinAceptar.js';

/**
 * Script operativo del job. Se programa desde cron externo:
 *   npm run job:cancelar-efectivo-sin-aceptar
 */
try {
  const resultado = await ejecutarJob({
    nombre: 'cancelar_efectivo_sin_aceptar',
    clave: CLAVES_JOBS.cancelar_efectivo_sin_aceptar,
    ejecutar: () => cancelarEfectivoSinAceptar(),
  });

  logger.info({ resultado }, 'resultado del job cancelar_efectivo_sin_aceptar');
  console.log(JSON.stringify(resultado));
} catch (err) {
  logger.error({ err }, 'fallo el job cancelar_efectivo_sin_aceptar');
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
