import { logger } from './logger.js';

/**
 * Error de la API. Todo lo que sale de las rutas debe usar esta clase,
 * para que la respuesta tenga siempre la misma forma (seccion 6):
 *
 *   { "error": { "codigo": "...", "mensaje": "..." } }
 *
 * El frontend decide que hacer mirando el `codigo`, nunca el `mensaje`.
 */
export class ErrorApi extends Error {
  constructor(codigo, mensaje, estado = 500, detalles = undefined) {
    super(mensaje);
    this.name = 'ErrorApi';
    this.codigo = codigo;
    this.estado = estado;
    this.detalles = detalles;
  }
}

export const errorValidacion = (mensaje, detalles) =>
  new ErrorApi('validacion_invalida', mensaje, 400, detalles);

export const errorCredenciales = (mensaje = 'Correo o contrasena incorrectos.') =>
  new ErrorApi('credenciales_invalidas', mensaje, 401);

export const errorNoAutenticado = (mensaje = 'Necesitas iniciar sesion.') =>
  new ErrorApi('no_autenticado', mensaje, 401);

export const errorSinPermiso = (mensaje = 'No tienes permiso para esto.') =>
  new ErrorApi('sin_permiso', mensaje, 403);

export const errorNoEncontrado = (mensaje = 'No se encontro lo que buscas.') =>
  new ErrorApi('no_encontrado', mensaje, 404);

export const errorConflicto = (mensaje, detalles) =>
  new ErrorApi('conflicto', mensaje, 409, detalles);

export const errorDemasiadasPeticiones = (mensaje = 'Demasiados intentos. Espera un momento.') =>
  new ErrorApi('demasiadas_peticiones', mensaje, 429);

/** Se usa en pruebas y en el guardián del invariante 4. */
export const errorLlamadaProhibidaEnTransaccion = () =>
  new ErrorApi(
    'llamada_prohibida_en_transaccion',
    'INVARIANTE 4: no se puede llamar a un servicio externo dentro de una transaccion de base de datos.',
    500,
  );

/** Ruta que no existe. */
export function manejadorNoEncontrado(req, res) {
  res.status(404).json({
    error: {
      codigo: 'ruta_no_encontrada',
      mensaje: `La ruta ${req.method} ${req.path} no existe.`,
    },
  });
}

const CODIGOS_PRISMA = {
  P2002: ['recurso_duplicado', 409, 'Ya existe un registro con esos datos.'],
  P2003: ['referencia_invalida', 409, 'El registro hace referencia a algo que no existe.'],
  P2025: ['no_encontrado', 404, 'No se encontro el registro.'],
};

/**
 * Traduce cualquier error a la respuesta JSON de la seccion 6.
 * Lo usan el manejador global y el middleware de idempotencia (que necesita
 * guardar la MISMA respuesta que recibira el cliente cuando el error es 4xx).
 */
export function describirError(err) {
  if (err instanceof ErrorApi) {
    return {
      estado: err.estado,
      cuerpo: {
        error: {
          codigo: err.codigo,
          mensaje: err.message,
          ...(err.detalles ? { detalles: err.detalles } : {}),
        },
      },
    };
  }

  if (err?.name === 'ZodError') {
    return {
      estado: 400,
      cuerpo: {
        error: {
          codigo: 'validacion_invalida',
          mensaje: 'Los datos enviados no son validos.',
          detalles: err.issues.map((i) => ({
            campo: i.path.join('.'),
            problema: i.message,
          })),
        },
      },
    };
  }

  const prisma = err?.code ? CODIGOS_PRISMA[err.code] : undefined;
  if (prisma) {
    const [codigo, estado, mensaje] = prisma;
    return { estado, cuerpo: { error: { codigo, mensaje } } };
  }

  return {
    estado: 500,
    cuerpo: {
      error: {
        codigo: 'error_interno',
        mensaje: 'Ocurrio un error inesperado. Intenta de nuevo.',
      },
    },
  };
}

/**
 * Manejador global de errores.
 * - Si el error es nuestro (ErrorApi), responde con su codigo.
 * - Si es un error de validacion de Zod, responde 400 con el detalle.
 * - Si es un error de Prisma, lo traduce sin filtrar datos internos.
 * - Cualquier otra cosa es 500 y se registra completa en el log.
 */
export function manejadorErrores(err, req, res, _next) {
  if (res.headersSent) return;

  if (err instanceof ErrorApi) {
    if (err.estado >= 500) {
      logger.error({ err, codigo: err.codigo }, 'error de la api');
    } else {
      logger.warn({ codigo: err.codigo, mensaje: err.message }, 'error controlado');
    }
  } else if (err?.name !== 'ZodError' && !(err?.code && CODIGOS_PRISMA[err.code])) {
    // Cualquier otra cosa: 500 sin filtrar detalles internos.
    logger.error({ err, ruta: `${req.method} ${req.path}` }, 'error no controlado');
  }

  const { estado, cuerpo } = describirError(err);
  return res.status(estado).json(cuerpo);
}