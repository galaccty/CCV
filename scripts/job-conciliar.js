import { prisma } from '../src/lib/prisma.js';
import { logger } from '../src/lib/logger.js';
import { CLAVES_JOBS, ejecutarJob } from '../src/jobs/ejecutarJob.js';
import { conciliar } from '../src/jobs/conciliar.js';

/**
 * Script operativo del job. Se programa desde cron externo:
 *   npm run job:conciliar
 */
try {
  const resultado = await ejecutarJob({
    nombre: 'conciliacion_nocturna',
    clave: CLAVES_JOBS.conciliar,
    ejecutar: () => conciliar(),
  });

  logger.info({ resultado }, 'resultado del job conciliacion_nocturna');
  console.log(JSON.stringify(resultado));
} catch (err) {
  logger.error({ err }, 'fallo el job conciliacion_nocturna');
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
