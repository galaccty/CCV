/**
 * MODULO DE DINERO
 * ================
 * La base y Prisma guardan el dinero como BIGINT. JavaScript lo representa
 * con `bigint`.
 *
 * Reglas de la casa:
 *   - Toda cuenta de dinero se hace con `bigint`, nunca con `number`.
 *   - Un `number` solo entra en el borde (un dato de configuracion, una
 *     cantidad) y se convierte con `aBigInt()`.
 *   - Para responder JSON se convierte en UN solo lugar (el middleware
 *     `jsonBigInt`) y se lanza error si el valor no cabe en un entero seguro
 *     de JavaScript.
 *
 * No hay centavos: todos los montos son pesos enteros.
 */

export class ErrorDinero extends Error {
  constructor(mensaje) {
    super(mensaje);
    this.name = 'ErrorDinero';
    this.codigo = 'monto_invalido';
  }
}

const MAX_SEGURO = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SEGURO = BigInt(Number.MIN_SAFE_INTEGER);

/**
 * Convierte a bigint sin perder precision.
 * Acepta bigint, number entero seguro o string de digitos.
 */
export function aBigInt(valor, campo = 'monto') {
  if (typeof valor === 'bigint') return valor;

  if (typeof valor === 'number') {
    if (!Number.isSafeInteger(valor)) {
      throw new ErrorDinero(
        `${campo} debe ser un entero seguro de JavaScript; llego ${valor}.`,
      );
    }
    return BigInt(valor);
  }

  if (typeof valor === 'string') {
    const limpio = valor.trim();
    if (/^-?\d+$/.test(limpio)) return BigInt(limpio);
  }

  throw new ErrorDinero(`${campo} debe ser un monto entero en pesos.`);
}

/**
 * Punto unico de salida hacia JSON.
 * Si el monto no cabe en Number.MAX_SAFE_INTEGER, se lanza un error en vez de
 * devolver un numero redondeado en silencio.
 */
export function aNumeroSeguro(valor, campo = 'monto') {
  const grande = aBigInt(valor, campo);

  if (grande > MAX_SEGURO || grande < MIN_SEGURO) {
    throw new ErrorDinero(
      `${campo} (${grande}) supera Number.MAX_SAFE_INTEGER; no se puede ` +
        'devolver como numero JSON sin perder precision.',
    );
  }

  return Number(grande);
}

export function sumar(...valores) {
  return valores.reduce((total, valor) => total + aBigInt(valor), 0n);
}

export function restar(minuendo, sustraendo) {
  return aBigInt(minuendo) - aBigInt(sustraendo);
}

export function multiplicar(factorA, factorB) {
  return aBigInt(factorA) * aBigInt(factorB);
}

/**
 * Division entera con redondeo al mas cercano (mitad hacia arriba).
 * Los montos son no negativos, pero se soportan negativos por completitud.
 */
export function dividirRedondeando(dividendo, divisor) {
  const a = aBigInt(dividendo);
  const b = aBigInt(divisor);

  if (b === 0n) throw new ErrorDinero('No se puede dividir por cero.');

  const negativo = a < 0n !== b < 0n;
  const absA = a < 0n ? -a : a;
  const absB = b < 0n ? -b : b;
  const cociente = (absA + absB / 2n) / absB;

  return negativo ? -cociente : cociente;
}

/**
 * Un porcentaje como 5 o 5.25 se guarda como basis points enteros
 * (500 o 525). Asi el calculo no usa punto flotante.
 */
export function porcentajeABasisPuntos(porcentaje) {
  const numero =
    typeof porcentaje === 'string' ? Number.parseFloat(porcentaje) : porcentaje;

  if (!Number.isFinite(numero) || numero < 0 || numero > 100) {
    throw new ErrorDinero(`Porcentaje invalido: ${porcentaje}`);
  }

  return BigInt(Math.round(numero * 100));
}

/** Aplica basis points (10000 = 100%) con redondeo al peso. */
export function aplicarPorcentaje(monto, basisPuntos) {
  return dividirRedondeando(multiplicar(monto, basisPuntos), 10000n);
}

/** Wompi trabaja en centavos; el resto del sistema en pesos. */
export function centavosDePesos(pesos) {
  return multiplicar(pesos, 100n);
}

/**
 * Convierte recursivamente bigint a number para JSON.
 * Es el unico conversor: las rutas no deberian hacer `Number(monto)` a mano.
 */
export function convertirBigIntAJson(valor, ruta = '$') {
  if (typeof valor === 'bigint') {
    return aNumeroSeguro(valor, ruta);
  }

  if (Array.isArray(valor)) {
    return valor.map((item, indice) =>
      convertirBigIntAJson(item, `${ruta}[${indice}]`),
    );
  }

  if (valor !== null && typeof valor === 'object') {
    if (valor instanceof Date || Buffer.isBuffer(valor)) return valor;

    const salida = {};
    for (const [clave, contenido] of Object.entries(valor)) {
      salida[clave] = convertirBigIntAJson(contenido, `${ruta}.${clave}`);
    }
    return salida;
  }

  return valor;
}
