import { prisma } from '../src/lib/prisma.js';
import { logger } from '../src/lib/logger.js';
import { CLAVES_JOBS, ejecutarJob } from '../src/jobs/ejecutarJob.js';
import { bloquearLocalesVencidos } from '../src/jobs/bloquearLocalesVencidos.js';

/**
 * Script operativo del job. Se programa desde cron externo:
 *   npm run job:bloquear-locales-vencidos
 */
try {
  const resultado = await ejecutarJob({
    nombre: 'bloqueo_deuda',
    clave: CLAVES_JOBS.bloquear_locales_vencidos,
    ejecutar: () => bloquearLocalesVencidos(),
  });

  logger.info({ resultado }, 'resultado del job bloqueo_deuda');
  console.log(JSON.stringify(resultado));
} catch (err) {
  logger.error({ err }, 'fallo el job bloqueo_deuda');
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
