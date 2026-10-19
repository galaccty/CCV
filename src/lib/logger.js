import pino from 'pino';
import { config } from '../config/entorno.js';

// Logs estructurados: una linea por evento.
// En produccion sale JSON puro (es lo que un servidor de logs sabe leer).
// En desarrollo se usa pino-pretty para que sea legible en la terminal.
const opciones = {
  level: process.env.LOG_LEVEL ?? 'info',
  base: { servicio: 'ccv-backend' },
  timestamp: pino.stdTimeFunctions.isoTime,
  // Nunca dejar pasar contrasenas ni tokens a los logs.
  redact: {
    paths: [
      'password',
      'contrasena',
      'password_hash',
      'passwordHash',
      'token',
      'token_hash',
      'tokenHash',
      'req.headers.cookie',
      'req.headers.authorization',
    ],
    censor: '[oculto]',
  },
};

const destino = config.esProduccion
  ? pino.destination({ dest: 1 })
  : pino.transport({
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'HH:MM:ss',
        ignore: 'pid,hostname',
      },
    });

export const logger = pino(opciones, destino);

export default logger;