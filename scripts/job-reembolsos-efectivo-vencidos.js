import { prisma } from '../src/lib/prisma.js';
import { logger } from '../src/lib/logger.js';
import { CLAVES_JOBS, ejecutarJob } from '../src/jobs/ejecutarJob.js';
import { reembolsosEfectivoVencidos } from '../src/jobs/reembolsosEfectivoVencidos.js';

/**
 * Script operativo del job. Se programa desde cron externo:
 *   npm run job:reembolsos-efectivo-vencidos
 */
try {
  const resultado = await ejecutarJob({
    nombre: 'reembolsos_efectivo_vencidos',
    clave: CLAVES_JOBS.reembolsos_efectivo_vencidos,
    ejecutar: () => reembolsosEfectivoVencidos(),
  });

  logger.info({ resultado }, 'resultado del job reembolsos_efectivo_vencidos');
  console.log(JSON.stringify(resultado));
} catch (err) {
  logger.error({ err }, 'fallo el job reembolsos_efectivo_vencidos');
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
