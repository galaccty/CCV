import { prisma } from '../src/lib/prisma.js';
import { logger } from '../src/lib/logger.js';
import { CLAVES_JOBS, ejecutarJob } from '../src/jobs/ejecutarJob.js';
import { verificarIntegridad } from '../src/jobs/integridad.js';

/**
 * Script operativo del job. Se programa desde cron externo:
 *   npm run job:integridad
 */
try {
  const resultado = await ejecutarJob({
    nombre: 'verificacion_integridad',
    clave: CLAVES_JOBS.integridad,
    ejecutar: () => verificarIntegridad(),
  });

  logger.info({ resultado }, 'resultado del job verificacion_integridad');
  console.log(JSON.stringify(resultado));
} catch (err) {
  logger.error({ err }, 'fallo el job verificacion_integridad');
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
