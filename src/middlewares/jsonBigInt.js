import { convertirBigIntAJson } from '../lib/dinero.js';
import { logger } from '../lib/logger.js';

/**
 * Punto UNICO de conversion de bigint a JSON.
 *
 * Express usa JSON.stringify, que no sabe serializar bigint. En vez de llenar
 * las rutas de `Number(...)`, se envuelve `res.json` una sola vez. Si un monto
 * no cabe en Number.MAX_SAFE_INTEGER, se responde 500 en vez de devolver un
 * numero redondeado en silencio.
 */
export function jsonBigInt(req, res, next) {
  const jsonOriginal = res.json.bind(res);

  res.json = (cuerpo) => {
    let convertido;

    try {
      convertido = convertirBigIntAJson(cuerpo);
    } catch (err) {
      logger.error(
        { err, ruta: `${req.method} ${req.originalUrl}` },
        'no se pudo convertir un monto a JSON',
      );
      res.status(500);
      return jsonOriginal({
        error: {
          codigo: 'monto_fuera_de_rango',
          mensaje:
            'Un monto del sistema supera el maximo representable en JSON. ' +
            'Se nego a devolver un valor redondeado.',
        },
      });
    }

    return jsonOriginal(convertido);
  };

  next();
}
