import crypto from 'node:crypto';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import {
  generarToken,
  hashearToken,
  compararTokens,
  hashearContrasena,
  verificarContrasena,
  cumplePoliticaContrasena,
} from '../lib/crypto.js';
import {
  errorCredenciales,
  errorValidacion,
  errorConflicto,
  errorNoEncontrado,
} from '../lib/errores.js';
import { config } from '../config/entorno.js';
import * as correo from '../mail/index.js';

const EXPIRACION_VERIFICACION_HORAS = 24;
const EXPIRACION_RESET_HORAS = 2;

const ROLES_VALIDOS = ['comprador', 'vendedor', 'admin'];

// ---------------------------------------------------------------------------
// Cookie de sesion
// ---------------------------------------------------------------------------
// Decision de diseno: la cookie es un valor firmado (HMAC) que lleva el id
// del usuario y su expiracion. NO hay tabla de sesiones.
//
// Por que: la Etapa 1 define cinco tablas y "sesion" no es una de ellas.
// Asi el rol y el estado `activo` se leen SIEMPRE de la base en cada
// peticion, que es justo lo que pide la seccion 7 ("token de vida corta o
// version de token que se invalide al cambiar el rol"): degradar o desactivar
// un usuario surte efecto de inmediato, sin esperar a que expire nada.
//
// Limitacion a tener en cuenta: cerrar sesion borra la cookie del navegador,
// pero el token sigue siendo valido hasta que expira. Si necesitas revocar
// un token robado de inmediato, hay que agregar una tabla `sesion` (es una
// migracion nueva, no se toca ninguna aplicada).
// ---------------------------------------------------------------------------

const PREFIJO_TOKEN = 'v1';

function firmar(datos) {
  const cuerpo = Buffer.from(JSON.stringify(datos)).toString('base64url');
  const firma = crypto
    .createHmac('sha256', config.SESSION_SECRET)
    .update(cuerpo)
    .digest('base64url');
  return `${PREFIJO_TOKEN}.${cuerpo}.${firma}`;
}

function verificar(token) {
  if (!token || typeof token !== 'string') return null;
  const partes = token.split('.');
  if (partes.length !== 3) return null;
  const [prefijo, cuerpo, firma] = partes;
  if (prefijo !== PREFIJO_TOKEN) return null;

  const esperada = crypto
    .createHmac('sha256', config.SESSION_SECRET)
    .update(cuerpo)
    .digest('base64url');

  const a = Buffer.from(firma);
  const b = Buffer.from(esperada);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  try {
    const datos = JSON.parse(Buffer.from(cuerpo, 'base64url').toString('utf8'));
    if (typeof datos.exp !== 'number' || datos.exp < Date.now()) return null;
    return datos;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Correos
// ---------------------------------------------------------------------------

function urlBasePublica() {
  return (process.env.PUBLIC_WEB_URL ?? 'http://localhost:5173').replace(/\/$/, '');
}

async function enviarCorreo({ para, asunto, texto, html, idReferencia }) {
  try {
    await correo.enviar({
      para,
      asunto,
      texto,
      html,
      idReferencia,
      from: config.MAIL_FROM,
    });
  } catch (err) {
    // Un correo que no sale no puede tumbar el registro del usuario.
    logger.error({ err, para, asunto }, 'no se pudo enviar el correo');
  }
}

/**
 * Forma publica de una cuenta. Nunca incluye el hash de la contrasena.
 * `roles` puede venir como filas de Prisma ({ rol }) o como strings.
 */
export function serializarUsuario(usuario) {
  return {
    id: usuario.id,
    nombre: usuario.nombre,
    email: usuario.email,
    email_verificado: usuario.emailVerificado,
    telefono: usuario.telefono ?? null,
    roles: (usuario.roles ?? []).map((r) => (typeof r === 'string' ? r : r.rol)),
  };
}

async function crearToken(usuarioId, tipo, horasValidez) {
  const token = generarToken();

  const nuevo = await prisma.tokenVerificacion.create({
    data: {
      usuarioId,
      tipo,
      tokenHash: hashearToken(token),
      expira: new Date(Date.now() + horasValidez * 3600 * 1000),
    },
  });

  // Inutiliza los tokens viejos del mismo tipo y usuario.
  // OJO: hay que EXCLUIR el recien creado, o este mismo queda marcado como
  // usado y ningun enlace de verificacion serviria.
  await prisma.tokenVerificacion.updateMany({
    where: { usuarioId, tipo, usado: false, id: { not: nuevo.id } },
    data: { usado: true },
  });

  return token;
}

async function consumirToken(token, tipo) {
  if (!token) throw errorValidacion('Falta el token.');
  const tokenHash = hashearToken(token);

  const fila = await prisma.tokenVerificacion.findUnique({
    where: { tokenHash },
    include: { usuario: true },
  });

  if (!fila || fila.tipo !== tipo || fila.usado || fila.expira < new Date()) {
    throw errorValidacion('El enlace no es valido o ya expiro. Pide uno nuevo.');
  }
  return fila;
}

async function enviarCorreoVerificacion(usuario) {
  const token = await crearToken(
    usuario.id,
    'verificar_email',
    EXPIRACION_VERIFICACION_HORAS,
  );
  const enlace = `${urlBasePublica()}/verificar-email?token=${encodeURIComponent(token)}`;

  await enviarCorreo({
    para: usuario.email,
    asunto: 'Verifica tu correo electronico',
    idReferencia: `verificar_email:${usuario.id}`,
    texto:
      `Hola ${usuario.nombre}.\n\n` +
      `Confirma tu correo con este enlace:\n${enlace}\n\n` +
      `El enlace vence en ${EXPIRACION_VERIFICACION_HORAS} horas.\n` +
      `Si tu no creaste esta cuenta, ignora este mensaje.`,
    html: `
      <p>Hola ${usuario.nombre},</p>
      <p>Confirma tu correo con este enlace:</p>
      <p><a href="${enlace}">Verificar mi correo</a></p>
      <p>El enlace vence en ${EXPIRACION_VERIFICACION_HORAS} horas.</p>
      <p>Si tu no creaste esta cuenta, ignora este mensaje.</p>
    `,
  });
}

// ---------------------------------------------------------------------------
// Registro
// ---------------------------------------------------------------------------

export async function registrarUsuario({
  nombre,
  email,
  contrasena,
  roles = ['comprador'],
}) {
  const correoNormalizado = String(email).trim().toLowerCase();

  if (!nombre || String(nombre).trim().length < 2) {
    throw errorValidacion('El nombre es obligatorio.', { campo: 'nombre' });
  }
  if (!/^\S+@\S+\.\S+$/.test(correoNormalizado)) {
    throw errorValidacion('El correo no tiene un formato valido.', { campo: 'email' });
  }

  const problemasContrasena = cumplePoliticaContrasena(contrasena ?? '');
  if (problemasContrasena.length > 0) {
    throw errorValidacion('La contrasena es muy debil.', {
      campo: 'contrasena',
      requisitos: problemasContrasena,
    });
  }

  const rolesLimpios = [...new Set(roles)].filter((r) => ROLES_VALIDOS.includes(r));
  if (rolesLimpios.length === 0) rolesLimpios.push('comprador');

  const existente = await prisma.usuario.findUnique({
    where: { email: correoNormalizado },
  });
  if (existente) {
    throw errorConflicto('Ya existe una cuenta con ese correo.', { campo: 'email' });
  }

  const usuario = await prisma.usuario.create({
    data: {
      nombre: String(nombre).trim(),
      email: correoNormalizado,
      passwordHash: await hashearContrasena(contrasena),
      emailVerificado: false,
      aceptoTerminos: true,
      fechaAceptacion: new Date(),
      roles: { create: rolesLimpios.map((rol) => ({ rol })) },
    },
    select: {
      id: true,
      nombre: true,
      email: true,
      telefono: true,
      emailVerificado: true,
      roles: true,
    },
  });

  await enviarCorreoVerificacion(usuario);

  logger.info({ usuarioId: usuario.id, roles: rolesLimpios }, 'usuario registrado');
  return usuario;
}

// ---------------------------------------------------------------------------
// Inicio y fin de sesion
// ---------------------------------------------------------------------------

export function crearTokenSesion(usuarioId) {
  const ahora = Date.now();
  return firmar({
    u: usuarioId,
    iat: ahora,
    exp: ahora + config.sessionMaxAgeMs,
  });
}

export async function iniciarSesion({ email, contrasena }) {
  const correoNormalizado = String(email ?? '').trim().toLowerCase();
  const usuario = await prisma.usuario.findUnique({
    where: { email: correoNormalizado },
    include: { roles: true },
  });

  const ok = await verificarContrasena(contrasena ?? '', usuario?.passwordHash ?? null);

  // Mismo mensaje y mismo tiempo de respuesta exista o no el usuario,
  // para no revelar que correos estan registrados.
  if (!usuario || !ok) {
    logger.warn({ email: correoNormalizado }, 'intento de inicio de sesion fallido');
    throw errorCredenciales();
  }
  if (!usuario.activo) {
    throw errorCredenciales('Esta cuenta esta desactivada.');
  }
  if (!usuario.emailVerificado) {
    throw errorCredenciales('Debes verificar tu correo antes de iniciar sesion.');
  }

  return {
    token: crearTokenSesion(usuario.id),
    usuario: serializarUsuario(usuario),
  };
}

/** Lee el usuario desde el token de la cookie. Devuelve null si no sirve. */
export async function usuarioDesdeToken(token) {
  const datos = verificar(token);
  if (!datos) return null;

  const usuario = await prisma.usuario.findUnique({
    where: { id: datos.u },
    include: { roles: true },
  });
  if (!usuario || !usuario.activo) return null;

  return {
    id: usuario.id,
    nombre: usuario.nombre,
    email: usuario.email,
    telefono: usuario.telefono,
    emailVerificado: usuario.emailVerificado,
    roles: usuario.roles.map((r) => r.rol),
  };
}

// ---------------------------------------------------------------------------
// Verificacion de correo
// ---------------------------------------------------------------------------

export async function verificarEmail(token) {
  const fila = await consumirToken(token, 'verificar_email');

  await prisma.$transaction([
    prisma.tokenVerificacion.update({
      where: { id: fila.id },
      data: { usado: true },
    }),
    prisma.usuario.update({
      where: { id: fila.usuarioId },
      data: { emailVerificado: true },
    }),
  ]);

  logger.info({ usuarioId: fila.usuarioId }, 'correo verificado');
  return { email: fila.usuario.email, verificado: true };
}

// ---------------------------------------------------------------------------
// Restablecimiento de contrasena
// ---------------------------------------------------------------------------

export async function solicitarRestablecimiento({ email }) {
  const correoNormalizado = String(email ?? '').trim().toLowerCase();
  const usuario = await prisma.usuario.findUnique({ where: { email: correoNormalizado } });

  // Respuesta identica exista o no la cuenta: no revelamos correos.
  if (!usuario || !usuario.activo) {
    logger.warn({ email: correoNormalizado }, 'restablecimiento pedido para correo no registrado');
    return { enviado: true };
  }

  const token = await crearToken(usuario.id, 'reset_password', EXPIRACION_RESET_HORAS);
  const enlace = `${urlBasePublica()}/restablecer-contrasena?token=${encodeURIComponent(token)}`;

  await enviarCorreo({
    para: usuario.email,
    asunto: 'Restablece tu contrasena',
    idReferencia: `reset_password:${usuario.id}`,
    texto:
      `Hola ${usuario.nombre}.\n\n` +
      `Restablece tu contrasena con este enlace:\n${enlace}\n\n` +
      `El enlace vence en ${EXPIRACION_RESET_HORAS} horas.\n` +
      `Si tu no lo pediste, ignora este mensaje: tu contrasena sigue igual.`,
    html: `
      <p>Hola ${usuario.nombre},</p>
      <p>Restablece tu contrasena con este enlace:</p>
      <p><a href="${enlace}">Cambiar mi contrasena</a></p>
      <p>El enlace vence en ${EXPIRACION_RESET_HORAS} horas.</p>
      <p>Si tu no lo pediste, ignora este mensaje: tu contrasena sigue igual.</p>
    `,
  });

  return { enviado: true };
}

export async function restablecerContrasena({ token, contrasena }) {
  const problemas = cumplePoliticaContrasena(contrasena ?? '');
  if (problemas.length > 0) {
    throw errorValidacion('La contrasena es muy debil.', {
      campo: 'contrasena',
      requisitos: problemas,
    });
  }

  const fila = await consumirToken(token, 'reset_password');

  await prisma.$transaction([
    prisma.tokenVerificacion.update({
      where: { id: fila.id },
      data: { usado: true },
    }),
    prisma.usuario.update({
      where: { id: fila.usuarioId },
      data: { passwordHash: await hashearContrasena(contrasena) },
    }),
  ]);

  logger.info({ usuarioId: fila.usuarioId }, 'contrasena restablecida');
  return { restablecida: true };
}

// ---------------------------------------------------------------------------
// Cuenta del comprador
// ---------------------------------------------------------------------------

export async function actualizarPerfil({ usuarioId, nombre, telefono }) {
  const actualizado = await prisma.usuario.update({
    where: { id: usuarioId },
    data: {
      ...(nombre !== undefined ? { nombre } : {}),
      ...(telefono !== undefined ? { telefono } : {}),
    },
    select: {
      id: true,
      nombre: true,
      email: true,
      telefono: true,
      emailVerificado: true,
      roles: true,
    },
  });

  logger.info({ usuarioId }, 'perfil actualizado');
  return serializarUsuario(actualizado);
}

export async function cambiarContrasena({
  usuarioId,
  contrasenaActual,
  contrasenaNueva,
}) {
  const problemas = cumplePoliticaContrasena(contrasenaNueva ?? '');
  if (problemas.length > 0) {
    throw errorValidacion('La contrasena es muy debil.', {
      campo: 'contrasena_nueva',
      requisitos: problemas,
    });
  }

  const usuario = await prisma.usuario.findUnique({ where: { id: usuarioId } });
  const actualCorrecta = await verificarContrasena(
    contrasenaActual ?? '',
    usuario?.passwordHash ?? null,
  );

  if (!usuario || !usuario.activo || !actualCorrecta) {
    logger.warn({ usuarioId }, 'cambio de contrasena rechazado');
    throw errorCredenciales('La contrasena actual no es correcta.');
  }

  const passwordHash = await hashearContrasena(contrasenaNueva);

  await prisma.$transaction([
    prisma.usuario.update({
      where: { id: usuarioId },
      data: { passwordHash },
    }),
    // Un enlace de restablecimiento pendiente deja de servir: el usuario ya
    // demostro que conoce la contrasena actual.
    prisma.tokenVerificacion.updateMany({
      where: { usuarioId, tipo: 'reset_password', usado: false },
      data: { usado: true },
    }),
  ]);

  logger.info({ usuarioId }, 'contrasena cambiada');
  return { actualizada: true };
}

export async function reenviarVerificacion({ email }) {
  const correoNormalizado = String(email ?? '').trim().toLowerCase();
  const usuario = await prisma.usuario.findUnique({
    where: { email: correoNormalizado },
  });

  // Respuesta identica exista o no la cuenta y este o no verificada.
  if (!usuario || !usuario.activo || usuario.emailVerificado) {
    logger.warn(
      { email: correoNormalizado },
      'reenvio de verificacion pedido para una cuenta que no lo necesita',
    );
    return { enviado: true };
  }

  await enviarCorreoVerificacion(usuario);
  logger.info({ usuarioId: usuario.id }, 'verificacion de correo reenviada');
  return { enviado: true };
}

// ---------------------------------------------------------------------------
// Utilidades expuestas para los middlewares y pruebas
// ---------------------------------------------------------------------------

export { verificar as verificarTokenSesion, compararTokens, errorNoEncontrado };