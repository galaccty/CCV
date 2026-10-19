import { config } from './config/entorno.js';
import { logger } from './lib/logger.js';
import { prisma } from './lib/prisma.js';
import { registrarProveedor } from './mail/index.js';
import { proveedorConsola, proveedorNulo } from './mail/consola.js';
import { cargarConfiguracion } from './services/configuracion.js';
import { crearApp } from './app.js';

/**
 * Arranque del servidor.
 * Aqui se conecta todo lo que es global: proveedor de correo, configuracion,
 * cliente de base de datos y, por ultimo, el servidor HTTP.
 */

// 1. Proveedor de correo.
//    Etapa 1: el de prueba, que escribe el mensaje en la terminal.
//    Cuando elijas proveedor, se agrega el archivo y se cambia MAIL_DRIVER.
const proveedorPorDefecto = config.MAIL_DRIVER === 'ninguno' ? proveedorNulo : proveedorConsola;
registrarProveedor(proveedorPorDefecto);
logger.info({ proveedor: config.MAIL_DRIVER }, 'proveedor de correo activo');

// 2. Configuracion desde la tabla.
try {
  await cargarConfiguracion({ forzar: true });
} catch (err) {
  logger.error({ err }, 'no se pudo leer la tabla configuracion');
  logger.error(
    'Revisa que las migraciones esten aplicadas: npx prisma migrate deploy',
  );
}

// 3. Comprobacion de la base de datos.
try {
  await prisma.$queryRaw`SELECT 1`;
  logger.info('base de datos conectada');
} catch (err) {
  logger.error({ err }, 'no se pudo conectar con la base de datos');
}

// 4. Servidor HTTP.
const app = crearApp();

const servidor = app.listen(config.PORT, () => {
  logger.info(
    {
      puerto: config.PORT,
      entorno: config.NODE_ENV,
      origenes: config.origenesPermitidos,
    },
    'servidor escuchando',
  );
});

async function apagar(senal) {
  logger.info({ senal }, 'apagando el servidor');
  servidor.close(async () => {
    await prisma.$disconnect();
    logger.info('servidor apagado limpiamente');
    process.exit(0);
  });
  // Si no se apaga en 10 segundos, se fuerza la salida.
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGINT', () => apagar('SIGINT'));
process.on('SIGTERM', () => apagar('SIGTERM'));

process.on('unhandledRejection', (motivo) => {
  logger.error({ err: motivo }, 'promesa rechazada sin manejar');
});

process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'excepcion sin capturar');
  apagar('uncaughtException');
});