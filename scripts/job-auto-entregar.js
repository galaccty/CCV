import { prisma } from '../src/lib/prisma.js';
import { logger } from '../src/lib/logger.js';
import { CLAVES_JOBS, ejecutarJob } from '../src/jobs/ejecutarJob.js';
import { autoEntregar } from '../src/jobs/autoEntregar.js';

/**
 * Script operativo del job. Se programa desde cron externo:
 *   npm run job:auto-entregar
 */
try {
  const resultado = await ejecutarJob({
    nombre: 'auto_entrega',
    clave: CLAVES_JOBS.auto_entrega,
    ejecutar: () => autoEntregar(),
  });

  logger.info({ resultado }, 'resultado del job auto_entrega');
  console.log(JSON.stringify(resultado));
} catch (err) {
  logger.error({ err }, 'fallo el job auto_entrega');
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
