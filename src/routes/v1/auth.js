import { Router } from 'express';
import * as auth from '../../services/auth.js';
import { ponerCookieSesion, quitarCookieSesion, requiereSesion } from '../../middlewares/sesion.js';
import { limiteIntentos, limiteRegistro } from '../../middlewares/rateLimit.js';
import {
  esquemaRegistro,
  esquemaLogin,
  esquemaSolicitarReset,
  esquemaRestablecer,
  esquemaVerificarEmail,
} from '../../lib/validacion.js';
import { logger } from '../../lib/logger.js';

/**
 * Rutas de autenticacion - Etapa 1.
 * Todas devuelven JSON en snake_case y usan el formato de error unico.
 */
const router = Router();

/**
 * POST /api/v1/auth/registro
 * Crea una cuenta de comprador o vendedor.
 * No hay registro publico de administradores: el primero se crea con
 * scripts/crear-admin.js y los demas se crean desde el panel (Etapa 4).
 */
router.post(
  '/registro',
  limiteRegistro,
  async (req, res) => {
    const datos = esquemaRegistro.parse(req.body);
    const usuario = await auth.registrarUsuario({
      nombre: datos.nombre,
      email: datos.email,
      contrasena: datos.contrasena,
      roles: datos.roles ?? ['comprador'],
    });

    res.status(201).json({
      mensaje: 'Cuenta creada. Revisa tu correo para verificarlo.',
      usuario: {
        id: usuario.id,
        nombre: usuario.nombre,
        email: usuario.email,
        email_verificado: usuario.emailVerificado,
        roles: usuario.roles.map((r) => r.rol),
      },
    });
  },
);

/**
 * POST /api/v1/auth/login
 * Deja la cookie httpOnly de sesion.
 */
router.post('/login', limiteIntentos, async (req, res) => {
  const datos = esquemaLogin.parse(req.body);
  const { token, usuario } = await auth.iniciarSesion(datos);
  ponerCookieSesion(res, token);

  logger.info({ usuarioId: usuario.id }, 'inicio de sesion');

  res.json({
    mensaje: 'Sesion iniciada.',
    usuario: {
      id: usuario.id,
      nombre: usuario.nombre,
      email: usuario.email,
      roles: usuario.roles,
    },
  });
});

/**
 * POST /api/v1/auth/logout
 * Borra la cookie del navegador.
 */
router.post('/logout', (req, res) => {
  quitarCookieSesion(res);
  logger.info({ usuarioId: req.usuario?.id }, 'cierre de sesion');
  res.json({ mensaje: 'Sesion cerrada.' });
});

/**
 * GET /api/v1/auth/yo
 * Dice quien es la persona que esta conectada. Sirve para que el frontend
 * sepa si tiene que mostrar el panel de vendedor o el menu de comprador.
 */
router.get('/yo', requiereSesion, (req, res) => {
  res.json({
    usuario: {
      id: req.usuario.id,
      nombre: req.usuario.nombre,
      email: req.usuario.email,
      email_verificado: req.usuario.emailVerificado,
      roles: req.usuario.roles,
    },
  });
});

/**
 * POST /api/v1/auth/verificar-email
 * El frontend pega el token que viene en el enlace del correo.
 */
router.post('/verificar-email', async (req, res) => {
  const datos = esquemaVerificarEmail.parse(req.body);
  const resultado = await auth.verificarEmail(datos.token);
  res.json({ mensaje: 'Correo verificado.', ...resultado });
});

/**
 * POST /api/v1/auth/solicitar-restablecimiento
 * Siempre responde lo mismo, exista o no la cuenta.
 */
router.post('/solicitar-restablecimiento', limiteIntentos, async (req, res) => {
  const datos = esquemaSolicitarReset.parse(req.body);
  const resultado = await auth.solicitarRestablecimiento({ email: datos.email });
  res.json({
    mensaje:
      'Si ese correo tiene una cuenta, te enviamos un enlace para restablecer la contrasena.',
    ...resultado,
  });
});

/**
 * POST /api/v1/auth/restablecer-contrasena
 */
router.post('/restablecer-contrasena', limiteIntentos, async (req, res) => {
  const datos = esquemaRestablecer.parse(req.body);
  const resultado = await auth.restablecerContrasena({
    token: datos.token,
    contrasena: datos.contrasena,
  });
  res.json({ mensaje: 'Contrasena restablecida.', ...resultado });
});

export default router;