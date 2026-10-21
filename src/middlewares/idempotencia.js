import {
  describirError,
  errorNoAutenticado,
  errorValidacion,
} from '../lib/errores.js';
import { logger } from '../lib/logger.js';
import { completar, liberar, reservar } from '../services/idempotencia.js';

/**
 * Exige `Idempotency-Key` en los POST que crean pedidos o pagos.
 * Se monta DESPUES de `requiereSesion`, porque la clave se guarda por usuario.
 */
export function idempotenciaRequerida(req, res, next) {
  (async () => {
    if (!req.usuario) throw errorNoAutenticado();

    const clave = req.get('idempotency-key')?.trim();

    if (!clave || clave.length < 8 || clave.length > 255) {
      throw errorValidacion(
        'Falta la cabecera Idempotency-Key o no tiene entre 8 y 255 caracteres.',
        [{ campo: 'Idempotency-Key', problema: 'obligatoria, 8 a 255 caracteres' }],
      );
    }

    const ruta = `${req.method} ${req.originalUrl.split('?')[0]}`;
    const { repetida, fila } = await reservar({
      usuarioId: req.usuario.id,
      ruta,
      clave,
    });

    if (repetida) {
      // La respuesta original se guardo como JSON. No se vuelve a ejecutar
      // ninguna logica de negocio.
      return res.status(fila.codigoHttp ?? 200).json(fila.respuestaJson);
    }

    res.locals.idempotenciaId = fila.id;
    res.locals.idempotenciaRuta = ruta;
    return next();
  })().catch(next);
}

/**
 * Cierra la reserva de idempotencia cuando la ruta lanza un error.
 *
 * - 5xx: se borra la reserva para que el cliente pueda reintentar.
 * - 4xx: se guarda la MISMA respuesta de error como completada. Asi un
 *   reintento con la misma clave no vuelve a ejecutar la logica de negocio.
 *
 * Se monta como middleware de errores, despues de las rutas y antes del
 * manejador global. Si no hay reserva (por ejemplo, la clave estaba en vuelo o
 * el error ocurrio antes de reservar), simplemente pasa el error.
 */
export function finalizarIdempotencia(err, _req, res, next) {
  const id = res.locals.idempotenciaId;
  if (!id) return next(err);

  const { estado, cuerpo } = describirError(err);
  const cierre = estado >= 500 ? liberar(id) : completar(id, estado, cuerpo);

  Promise.resolve(cierre)
    .catch((errCierre) => {
      logger.error(
        { err: errCierre, idempotenciaId: id },
        'no se pudo cerrar la reserva de idempotencia',
      );
    })
    .finally(() => next(err));
}
