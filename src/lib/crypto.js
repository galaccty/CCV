import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';

const LONGITUD_TOKEN = 32;
const RONDAS_BCRYPT = 12;

/**
 * Tokens de sesion.
 *
 * El token es un valor aleatorio que viaja en la cookie httpOnly.
 * En la base solo se guarda su hash (sha256), igual que las contrasenas:
 * si alguien lee la tabla de sesiones no puede suplantar a nadie.
 */
export function generarToken(bytes = LONGITUD_TOKEN) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function hashearToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/** Compara dos hashes de token en tiempo constante. */
export function compararTokens(hashA, hashB) {
  const a = Buffer.from(hashA ?? '', 'utf8');
  const b = Buffer.from(hashB ?? '', 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** Contrasenas. bcrypt nunca guarda el texto plano. */
export async function hashearContrasena(contrasena) {
  return bcrypt.hash(contrasena, RONDAS_BCRYPT);
}

export async function verificarContrasena(contrasena, hash) {
  if (!hash) return false;
  return bcrypt.compare(contrasena, hash);
}

/**
 * Politica minima de contrasena para esta primera version.
 * El abogado y tu pueden endurecerla despues.
 */
export function cumplePoliticaContrasena(contrasena) {
  const problemas = [];
  if (contrasena.length < 10) problemas.push('debe tener al menos 10 caracteres');
  if (!/[a-z]/.test(contrasena)) problemas.push('debe tener una minuscula');
  if (!/[A-Z]/.test(contrasena)) problemas.push('debe tener una mayuscula');
  if (!/[0-9]/.test(contrasena)) problemas.push('debe tener un numero');
  return problemas;
}