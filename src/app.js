import express from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { logger } from './lib/logger.js';
import { manejadorErrores, manejadorNoEncontrado } from './lib/errores.js';
import { cargarSesion } from './middlewares/sesion.js';
import { proteccionCsrf } from './middlewares/csrf.js';
import { limiteGeneral } from './middlewares/rateLimit.js';
import { jsonBigInt } from './middlewares/jsonBigInt.js';
import rutas from './routes/index.js';

/**
 * Construye la aplicacion Express sin arrancarla.
 * Asi las pruebas pueden importar `app` y probarlo con supertest
 * sin abrir ningun puerto.
 */
export function crearApp() {
  const app = express();

  // Detras de un proxy (Railway, Vercel) para que req.ip sea la direccion
  // real del visitante y el rate limit no bloque a todo el mundo junto.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(
    helmet({
      // La API devuelve JSON, no HTML: la CSP no aplica igual.
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );

  app.use(express.json({ limit: '100kb' }));
  app.use(express.urlencoded({ extended: false }));
  app.use(cookieParser());

  // Todo monto sale como numero JSON desde un solo lugar. Si un bigint no
  // cabe en Number.MAX_SAFE_INTEGER, el middleware responde 500.
  app.use(jsonBigInt);

  // Registro de peticiones. Se registra al terminar, cuando ya se sabe el codigo.
  app.use((req, res, next) => {
    const inicio = Date.now();
    res.on('finish', () => {
      const duracion = Date.now() - inicio;
      const nivel = res.statusCode >= 500 ? 'error' : 'debug';
      logger[nivel](
        {
          metodo: req.method,
          ruta: req.originalUrl,
          estado: res.statusCode,
          duracion_ms: duracion,
          ip: req.ip,
          usuario_id: req.usuario?.id,
        },
        'peticion',
      );
    });
    next();
  });

  // La sesion se lee antes de las rutas para que req.usuario este disponible.
  app.use(cargarSesion);

  // El token anti-CSRF va tambien antes de las rutas, para que la cookie
  // exista desde la primera peticion que haga el frontend.
  // La lista de rutas exentas se llena cuando exista el webhook de Wompi.
  app.use(proteccionCsrf({ exentas: [] }));

  app.use('/api', limiteGeneral, rutas);

  app.use(manejadorNoEncontrado);
  app.use(manejadorErrores);

  return app;
}

export default crearApp;