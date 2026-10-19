import { config } from '../config/entorno.js';
import { errorNoAutenticado, errorSinPermiso } from '../lib/errores.js';
import { usuarioDesdeToken } from '../services/auth.js';

export const NOMBRE_COOKIE_SESION = 'ccv_sesion';
export const NOMBRE_COOKIE_CSRF = 'ccv_csrf';

export function ponerCookieSesion(res, token) {
  res.cookie(NOMBRE_COOKIE_SESION, token, {
    httpOnly: true,
    secure: config.SESSION_COOKIE_SECURE,
    sameSite: 'lax',
    maxAge: config.sessionMaxAgeMs,
    path: '/',
  });
}

export function quitarCookieSesion(res) {
  res.clearCookie(NOMBRE_COOKIE_SESION, {
    httpOnly: true,
    secure: config.SESSION_COOKIE_SECURE,
    sameSite: 'lax',
    path: '/',
  });
}

/**
 * Lee el usuario desde la cookie y lo deja en req.usuario.
 * Nunca falla: si no hay sesion valida, req.usuario queda en null y es
 * cada ruta la que decide si necesita sesion.
 */
export async function cargarSesion(req, _res, next) {
  const token = req.cookies?.[NOMBRE_COOKIE_SESION];
  req.usuario = token ? await usuarioDesdeToken(token) : null;
  next();
}

/** Exige sesion iniciada. */
export function requiereSesion(req, _res, next) {
  if (!req.usuario) return next(errorNoAutenticado());
  next();
}

/**
 * Exige uno de los roles indicados.
 * Con roles ['admin'] solo un administrador pasa.
 * Con roles ['comprador','vendedor'] pasa cualquiera de los dos.
 */
export function requiereRol(...roles) {
  return (req, _res, next) => {
    if (!req.usuario) return next(errorNoAutenticado());
    const tiene = req.usuario.roles.some((r) => roles.includes(r));
    if (!tiene) {
      return next(
        errorSinPermiso(
          `Esta accion requiere uno de estos roles: ${roles.join(', ')}.`,
        ),
      );
    }
    next();
  };
}