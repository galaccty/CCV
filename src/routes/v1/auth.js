import { Router } from 'express';
import * as auth from '../../services/auth.js';
import { ponerCookieSesion, quitarCookieSesion, requiereSesion } from '../../middlewares/sesion.js';
import {
  limiteIntentos,
  limiteRegistro,
  limiteReenvioVerificacion,
} from '../../middlewares/rateLimit.js';
import {
  esquemaRegistro,
  esquemaLogin,
  esquemaSolicitarReset,
  esquemaRestablecer,
  esquemaVerificarEmail,
  esquemaActualizarPerfil,
  esquemaCambiarContrasena,
  esquemaReenviarVerificacion,
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
      usuario: auth.serializarUsuario(usuario),
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
    usuario,
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
  res.json({ usuario: auth.serializarUsuario(req.usuario) });
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

/**
 * PATCH /api/v1/auth/perfil
 * Edita el nombre y/o el telefono de la cuenta conectada. El correo no se
 * cambia por aca.
 */
router.patch('/perfil', requiereSesion, async (req, res) => {
  const datos = esquemaActualizarPerfil.parse(req.body);
  const usuario = await auth.actualizarPerfil({
    usuarioId: req.usuario.id,
    ...datos,
  });

  res.json({ mensaje: 'Perfil actualizado.', usuario });
});

/**
 * POST /api/v1/auth/cambiar-contrasena
 * Pide la contrasena actual. Se reutiliza el limitador de intentos para que
 * una sesion robada no pueda probar contrasenas en bucle.
 */
router.post(
  '/cambiar-contrasena',
  requiereSesion,
  limiteIntentos,
  async (req, res) => {
    const datos = esquemaCambiarContrasena.parse(req.body);
    const resultado = await auth.cambiarContrasena({
      usuarioId: req.usuario.id,
      contrasenaActual: datos.contrasena_actual,
      contrasenaNueva: datos.contrasena_nueva,
    });

    res.json({ mensaje: 'Contrasena cambiada.', ...resultado });
  },
);

/**
 * POST /api/v1/auth/reenviar-verificacion
 * Es publica a proposito: una cuenta sin verificar no puede iniciar sesion,
 * asi que no tendria sesion para pedir el reenvio.
 */
router.post(
  '/reenviar-verificacion',
  limiteReenvioVerificacion,
  async (req, res) => {
    const datos = esquemaReenviarVerificacion.parse(req.body);
    const resultado = await auth.reenviarVerificacion({ email: datos.email });

    res.json({
      mensaje:
        'Si ese correo tiene una cuenta sin verificar, te enviamos un enlace nuevo.',
      ...resultado,
    });
  },
);

export default router;