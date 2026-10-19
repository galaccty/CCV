import crypto from 'node:crypto';
import { config } from '../config/entorno.js';
import { errorSinPermiso } from '../lib/errores.js';
import { NOMBRE_COOKIE_CSRF } from './sesion.js';

const METODOS_SIN_PROTECCION = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF con double submit.
 *
 * El servidor pone una cookie `ccv_csrf` que el JavaScript del navegador SI
 * puede leer, y exige que cada peticion que modifica datos mande el mismo
 * valor en la cabecera `X-CSRF-Token`. Un sitio ajeno no puede leer la cookie
 * de tu dominio, asi que no puede completar la peticion.
 *
 * La cookie de sesion es httpOnly: nadie puede leerla, y por eso el atacante
 * no tendria con copiarla aunque quisiera.
 *
 * Rutas exentas: las que entran desde fuera y se protegen de otra forma.
 * El webhook de Wompi entra en la Etapa 2: llega sin cookie y se valida
 * verificando la firma del proveedor, no con CSRF.
 *
 * @param {{ exentas?: string[] }} opciones
 */
export function proteccionCsrf({ exentas = [] } = {}) {
  const esExenta = (url) => exentas.some((p) => url === p || url.startsWith(p));

  return function middlewareCsrf(req, res, next) {
    let tokenCookie = req.cookies?.[NOMBRE_COOKIE_CSRF];

    // Si no hay cookie todavia, se crea una. Asi el frontend siempre tiene
    // un valor que leer antes de hacer su primera peticion que modifica datos.
    if (!tokenCookie) {
      tokenCookie = crypto.randomBytes(24).toString('base64url');
      res.cookie(NOMBRE_COOKIE_CSRF, tokenCookie, {
        httpOnly: false, // el frontend lo lee para poder mandarlo de vuelta
        secure: config.SESSION_COOKIE_SECURE,
        sameSite: 'lax',
        maxAge: config.sessionMaxAgeMs,
        path: '/',
      });
    }

    // Se deja disponible en la peticion para que las rutas puedan devolverlo
    // (por ejemplo GET /api/v1/csrf). Si no, recien en la peticion siguiente
    // el token existiria en req.cookies.
    req.csrfToken = tokenCookie;

    if (METODOS_SIN_PROTECCION.has(req.method) || esExenta(req.originalUrl)) {
      return next();
    }

    const tokenCabecera = req.get('x-csrf-token');

    if (!tokenCabecera) {
      return next(
        errorSinPermiso('Falta el token anti-CSRF (cabecera X-CSRF-Token).'),
      );
    }

    const a = Buffer.from(String(tokenCabecera));
    const b = Buffer.from(String(tokenCookie));
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return next(errorSinPermiso('El token anti-CSRF no es valido.'));
    }

    return next();
  };
}