import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { config } from '../config/entorno.js';

/**
 * CIFRADO DE DATOS BANCARIOS
 * ==========================
 * El numero de cuenta y el documento del titular se cifran en la aplicacion
 * con AES-256-GCM antes de llegar a Postgres. La clave vive solo en la
 * variable de entorno `CUENTA_BANCARIA_ENCRYPTION_KEY` (32 bytes en base64).
 *
 * Formato guardado:
 *
 *   v1.<version_clave>.<iv base64url>.<tag base64url>.<ciphertext base64url>
 *
 * `v1` identifica el formato y `version_clave` la version de la llave. Hoy
 * solo existe una llave y se descifra con la version configurada; la rotacion
 * futura usara ese identificador para elegir la llave anterior.
 *
 * El AAD ata cada valor a su campo. Un numero de cuenta copiado al campo del
 * documento no se puede descifrar. La funcion de descifrado nunca incluye el
 * valor ni la clave en el mensaje de error.
 */

const PREFIJO = 'v1';
const ALGORITMO = 'aes-256-gcm';
const LARGO_IV = 12;
const LARGO_TAG = 16;

export function versionClaveBancariaActual() {
  return config.CUENTA_BANCARIA_KEY_VERSION;
}

let claveCache = null;

function clave() {
  if (claveCache) return claveCache;

  const bytes = Buffer.from(config.CUENTA_BANCARIA_ENCRYPTION_KEY, 'base64');
  if (bytes.length !== 32) {
    throw new Error(
      'CUENTA_BANCARIA_ENCRYPTION_KEY debe ser base64 de exactamente 32 bytes.',
    );
  }

  claveCache = bytes;
  return claveCache;
}

function aad(campo) {
  if (!campo) throw new Error('El cifrado bancario necesita un campo.');
  return Buffer.from(`ccv:cuenta-bancaria:${campo}`, 'utf8');
}

export function cifrarDatoBancario(valor, campo) {
  if (typeof valor !== 'string' || valor.length === 0) {
    throw new Error('El dato bancario a cifrar debe ser texto no vacio.');
  }

  const iv = randomBytes(LARGO_IV);
  const cipher = createCipheriv(ALGORITMO, clave(), iv, {
    authTagLength: LARGO_TAG,
  });
  cipher.setAAD(aad(campo));

  const cifrado = Buffer.concat([
    cipher.update(valor, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return [
    PREFIJO,
    versionClaveBancariaActual(),
    iv.toString('base64url'),
    tag.toString('base64url'),
    cifrado.toString('base64url'),
  ].join('.');
}

export function descifrarDatoBancario(valor, campo) {
  if (typeof valor !== 'string') {
    throw new Error('El dato bancario cifrado no es texto.');
  }

  const partes = valor.split('.');
  if (partes.length !== 5 || partes[0] !== PREFIJO) {
    throw new Error('El dato bancario cifrado tiene un formato invalido.');
  }

  if (partes[1] !== versionClaveBancariaActual()) {
    throw new Error(
      'El dato bancario usa una version de clave no soportada por esta configuracion.',
    );
  }

  const iv = Buffer.from(partes[2], 'base64url');
  const tag = Buffer.from(partes[3], 'base64url');
  const cifrado = Buffer.from(partes[4], 'base64url');

  if (iv.length !== LARGO_IV || tag.length !== LARGO_TAG) {
    throw new Error('El dato bancario cifrado tiene un formato invalido.');
  }

  try {
    const decipher = createDecipheriv(ALGORITMO, clave(), iv, {
      authTagLength: LARGO_TAG,
    });
    decipher.setAAD(aad(campo));
    decipher.setAuthTag(tag);

    return Buffer.concat([
      decipher.update(cifrado),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new Error(
      'No se pudo descifrar el dato bancario: la clave o el contenido no coinciden.',
    );
  }
}

/** Muestra solo los ultimos cuatro caracteres; nunca el valor completo. */
export function enmascararDatoBancario(valor) {
  if (typeof valor !== 'string' || valor.length === 0) return null;
  const limpio = valor.trim();
  if (limpio.length === 0) return null;
  if (limpio.length <= 4) return '****';
  return `****${limpio.slice(-4)}`;
}

export function cuentaBancariaCompleta(local) {
  return Boolean(
    local?.banco &&
      local?.tipoCuentaBancaria &&
      local?.numeroCuentaCifrado &&
      local?.titularCuenta &&
      local?.documentoTitularCifrado,
  );
}
