import pino from 'pino';
import { config } from '../config/entorno.js';

// Logs estructurados: una linea por evento.
// En produccion sale JSON puro (es lo que un servidor de logs sabe leer).
// En desarrollo se usa pino-pretty para que sea legible en la terminal.
export const RUTAS_REDACTADAS = [
  'password',
  'contrasena',
  'password_hash',
  'passwordHash',
  'token',
  'token_hash',
  'tokenHash',
  'req.headers.cookie',
  'req.headers.authorization',
  // Datos bancarios: nunca en logs, ni en claro ni cifrados.
  'numero_cuenta',
  'documento_titular',
  'numeroCuentaCifrado',
  'documentoTitularCifrado',
  'req.body.numero_cuenta',
  'req.body.documento_titular',
  '*.numero_cuenta',
  '*.documento_titular',
  '*.numero_cuenta_cifrado',
  '*.documento_titular_cifrado',
  '*.numeroCuentaCifrado',
  '*.documentoTitularCifrado',
  // La clave nunca debe terminar en un log, aunque alguien registre la config.
  'CUENTA_BANCARIA_ENCRYPTION_KEY',
  '*.CUENTA_BANCARIA_ENCRYPTION_KEY',
];

const opciones = {
  level: process.env.LOG_LEVEL ?? 'info',
  base: { servicio: 'ccv-backend' },
  timestamp: pino.stdTimeFunctions.isoTime,
  // Nunca dejar pasar contrasenas ni tokens a los logs.
  redact: {
    paths: RUTAS_REDACTADAS,
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