import { prisma } from '../src/lib/prisma.js';
import { logger } from '../src/lib/logger.js';
import { CLAVES_JOBS, ejecutarJob } from '../src/jobs/ejecutarJob.js';
import { liberarSaldos } from '../src/jobs/liberarSaldos.js';

/**
 * Script operativo del job. Se programa desde cron externo:
 *   npm run job:liberar-saldos
 */
try {
  const resultado = await ejecutarJob({
    nombre: 'liberar_saldos',
    clave: CLAVES_JOBS.liberar_saldos,
    ejecutar: () => liberarSaldos(),
  });

  logger.info({ resultado }, 'resultado del job liberar_saldos');
  console.log(JSON.stringify(resultado));
} catch (err) {
  logger.error({ err }, 'fallo el job liberar_saldos');
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
