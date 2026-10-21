import { config } from '../config/entorno.js';

const METODOS_PERMITIDOS = 'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS';
const CABECERAS_PERMITIDAS = [
  'Accept',
  'Content-Type',
  'Idempotency-Key',
  'Origin',
  'X-CSRF-Token',
].join(', ');

/**
 * CORS con credenciales para el frontend.
 *
 * No se puede usar `*` cuando se envian cookies. Se refleja exactamente el
 * origen que este en `CORS_ORIGINS` y se agrega
 * `Access-Control-Allow-Credentials: true`. Los preflight (`OPTIONS`) se
 * responden antes del body parser, del rate limit y de la proteccion CSRF.
 */
export function corsCredenciales({ origenes = config.origenesPermitidos } = {}) {
  const permitidos = new Set(origenes.filter((origen) => origen !== '*'));

  return function middlewareCors(req, res, next) {
    const origen = req.get('origin');

    res.vary('Origin');

    if (!origen) return next();

    if (!permitidos.has(origen)) {
      if (req.method === 'OPTIONS') {
        return res.status(403).json({
          error: {
            codigo: 'origen_no_permitido',
            mensaje: 'El origen no esta autorizado para usar la API.',
          },
        });
      }
      return next();
    }

    res.setHeader('Access-Control-Allow-Origin', origen);
    res.setHeader('Access-Control-Allow-Credentials', 'true');

    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', METODOS_PERMITIDOS);
      res.setHeader('Access-Control-Allow-Headers', CABECERAS_PERMITIDAS);
      res.setHeader('Access-Control-Max-Age', '600');
      return res.status(204).end();
    }

    return next();
  };
}
