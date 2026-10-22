import rateLimit from 'express-rate-limit';
import { logger } from '../lib/logger.js';
import { config } from '../config/entorno.js';

/**
 * Fabrica de limitadores de peticiones.
 *
 * Se exporta separada de los limitadores ya armados porque asi las pruebas
 * pueden crear uno con limites chicos y SIN el salto automatico de entorno
 * de prueba, y comprobar que de verdad frena.
 */
export function crearLimitador({
  nombre,
  ventanaMs,
  limite,
  mensaje,
  contarExitos = false,
  omitirEnPruebas = true,
}) {
  return rateLimit({
    windowMs: ventanaMs,
    limit: limite,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skipSuccessfulRequests: contarExitos,
    ...(omitirEnPruebas ? { skip: () => config.esPrueba } : {}),
    handler: (req, res) => {
      logger.warn(
        { ip: req.ip, ruta: `${req.method} ${req.path}`, limite, nombre },
        'limite de peticiones superado',
      );
      res.status(429).json({
        error: { codigo: 'demasiadas_peticiones', mensaje },
      });
    },
  });
}

/**
 * En pruebas los limites se desactivan.
 *
 * No es una cobertura para probar el limitador: en una sola corrida las
 * pruebas crean mas de cinco cuentas, asi que el limitador de registro (5 por
 * hora, pensado contra bots) las frenaria a todas y cada prueba fallaria
 * por un motivo que no tiene que ver con lo que verifica.
 *
 * El limitador si se prueba, en tests/limites.test.js, con su propia instancia.
 */

// Limite general: frena abuso y picos, no usuarios legitimos. 300 por 15
// minutos esta muy por encima del uso normal de un comprador o un vendedor.
export const limiteGeneral = crearLimitador({
  nombre: 'general',
  ventanaMs: 15 * 60 * 1000,
  limite: 300,
  mensaje: 'Demasiadas peticiones. Intenta de nuevo en unos minutos.',
});

// Limite estricto para iniciar sesion y pedir restablecimiento: aqui si
// estamos combatiendo ataques de fuerza bruta.
export const limiteIntentos = crearLimitador({
  nombre: 'intentos',
  ventanaMs: 15 * 60 * 1000,
  limite: 10,
  mensaje: 'Demasiados intentos. Espera 15 minutos antes de volver a intentar.',
  contarExitos: true,
});

// Limite para crear cuentas, contra los bots que llenarian el registro de
// solicitudes (que despues seria carga de moderacion).
export const limiteRegistro = crearLimitador({
  nombre: 'registro',
  ventanaMs: 60 * 60 * 1000,
  limite: 5,
  mensaje: 'Demasiadas cuentas creadas desde esta conexion.',
});

// Reenvio del correo de verificacion: evita que una misma conexion use la
// ruta para llenar de correos la bandeja de una persona. Cada solicitud
// invalida el enlace anterior, asi que tambien protege la rotacion de tokens.
export const limiteReenvioVerificacion = crearLimitador({
  nombre: 'reenvio-verificacion',
  ventanaMs: 60 * 60 * 1000,
  limite: 3,
  mensaje: 'Demasiadas solicitudes de verificacion. Espera una hora.',
});