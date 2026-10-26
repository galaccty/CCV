import { prisma } from '../src/lib/prisma.js';
import { logger } from '../src/lib/logger.js';
import { ejecutarJobsActivos } from '../src/jobs/index.js';

/**
 * Corre todos los jobs activos en el orden documentado en `docs/jobs.md`.
 * Cada uno toma su propio advisory lock: si el programador externo lanza este
 * comando y, a la vez, un job individual, no se pisan.
 *
 * Un error no detiene la cadena: se informa en el JSON y el proceso termina
 * con codigo 1 para que el cron lo marque como fallido.
 */
try {
  const resultados = await ejecutarJobsActivos();
  const fallidos = resultados.filter((resultado) => resultado.motivo === 'error');

  logger.info({ resultados }, 'resultado de job:todos');
  console.log(JSON.stringify(resultados));

  if (fallidos.length > 0) {
    process.exitCode = 1;
  }
} catch (err) {
  logger.error({ err }, 'fallo inesperado de job:todos');
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
