import { prisma } from '../src/lib/prisma.js';
import { logger } from '../src/lib/logger.js';
import { CLAVES_JOBS, ejecutarJob } from '../src/jobs/ejecutarJob.js';
import { expirarPagos } from '../src/jobs/expirarPagos.js';

/**
 * Script operativo del job. Se programa desde cron externo:
 *   npm run job:expirar-pagos
 */
try {
  const resultado = await ejecutarJob({
    nombre: 'expirar_pagos',
    clave: CLAVES_JOBS.expirar_pagos,
    ejecutar: () => expirarPagos(),
  });

  logger.info({ resultado }, 'resultado del job expirar_pagos');
  console.log(JSON.stringify(resultado));
} catch (err) {
  logger.error({ err }, 'fallo el job expirar_pagos');
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
