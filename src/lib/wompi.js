import crypto from 'node:crypto';
import { config } from '../config/entorno.js';
import { exigirFueraDeTransaccion, hayTransaccionAbierta } from './transaccion.js';
import { aBigInt, centavosDePesos } from './dinero.js';

/**
 * CLIENTE DE WOMPI
 * ================
 * Dos implementaciones detras de la misma interfaz:
 *
 *   - `falso` (por defecto): no hace ninguna llamada HTTP. Genera firmas
 *     reales con secretos de prueba y guarda las transacciones en memoria.
 *     Sirve para construir y probar todo el corte vertical sin llaves.
 *   - `real`: llama a la API de Wompi. Solo se activa cuando existen las
 *     cuatro llaves en .env y WOMPI_PROVEEDOR="real".
 *
 * El invariante 4 se respeta en TODAS las funciones publicas: lo primero que
 * hacen es `exigirFueraDeTransaccion`. Asi ninguna llamada externa puede
 * quedar dentro de una transaccion de base de datos.
 *
 * Datos verificados en docs.wompi.co:
 *   - Web Checkout: public-key, currency, amount-in-cents, reference,
 *     signature:integrity, redirect-url.
 *   - Firma de integridad: SHA256(referencia + monto_en_centavos + moneda +
 *     secreto_de_integridad).
 *   - Firma de eventos: SHA256(valores de signature.properties en orden +
 *     timestamp + secreto_de_eventos).
 *   - Consulta: GET /v1/transactions/{id} con la llave privada.
 *
 * Pendiente y NO inventado: el endpoint de reembolsos no se pudo verificar en
 * la documentacion oficial. En la Etapa 2 el reembolso se registra en la base;
 * la ejecucion real contra Wompi se activa cuando se confirme ese endpoint.
 */

export class ErrorWompiTransitorio extends Error {
  constructor(mensaje, causa = undefined) {
    super(mensaje);
    this.name = 'ErrorWompiTransitorio';
    this.transitorio = true;
    this.causa = causa;
  }
}

const ES_REAL = config.WOMPI_PROVEEDOR === 'real';

if (ES_REAL) {
  const faltan = [
    ['WOMPI_PUB_KEY', config.WOMPI_PUB_KEY],
    ['WOMPI_PRV_KEY', config.WOMPI_PRV_KEY],
    ['WOMPI_EVENTS_KEY', config.WOMPI_EVENTS_KEY],
    ['WOMPI_INTEGRITY_KEY', config.WOMPI_INTEGRITY_KEY],
  ]
    .filter(([, valor]) => !valor)
    .map(([nombre]) => nombre);

  if (faltan.length > 0) {
    throw new Error(
      `WOMPI_PROVEEDOR="real" requiere estas variables en .env: ${faltan.join(', ')}`,
    );
  }
}

const LLAVE_PUBLICA = config.WOMPI_PUB_KEY || 'pub_test_falsa';
const SECRETO_INTEGRIDAD =
  config.WOMPI_INTEGRITY_KEY || 'test_integrity_falsa';
const SECRETO_EVENTOS = config.WOMPI_EVENTS_KEY || 'test_events_falsa';
const MONEDA = 'COP';

const fake = {
  transacciones: new Map(),
  reembolsos: new Map(),
  consultas: [],
};

export function esProveedorFalso() {
  return !ES_REAL;
}

/** Solo para pruebas: registra una transaccion en el Wompi falso. */
export function registrarTransaccionFalsa({
  id,
  reference,
  status = 'APPROVED',
  amountInCents,
  currency = MONEDA,
}) {
  if (!id || !reference) {
    throw new Error('La transaccion falsa necesita id y reference.');
  }

  const montoCentavos = aBigInt(amountInCents, 'amount_in_cents');
  fake.transacciones.set(String(id), {
    id: String(id),
    reference: String(reference),
    status,
    amountInCents: montoCentavos,
    currency,
  });
}

/** Solo para pruebas: limpia el estado en memoria del proveedor falso. */
export function limpiarWompiFalso() {
  fake.transacciones.clear();
  fake.reembolsos.clear();
  fake.consultas.length = 0;
}

/** Solo para pruebas: historial de consultas y si ocurrieron en transaccion. */
export const auditoriaWompiFalsa = fake.consultas;

function sha256Hex(texto) {
  return crypto.createHash('sha256').update(texto, 'utf8').digest('hex');
}

function valorPorRuta(objeto, ruta) {
  return ruta
    .split('.')
    .reduce((actual, parte) => (actual == null ? undefined : actual[parte]), objeto);
}

function compararSeguro(a, b) {
  const bufferA = Buffer.from(String(a));
  const bufferB = Buffer.from(String(b));
  return (
    bufferA.length === bufferB.length && crypto.timingSafeEqual(bufferA, bufferB)
  );
}

/**
 * Crea los datos firmados del Web Checkout. NO llama a Wompi: solo calcula la
 * firma de integridad.
 */
export async function crearCheckout({ referencia, montoPesos, moneda = MONEDA }) {
  exigirFueraDeTransaccion('wompi.crearCheckout');

  if (!referencia || typeof referencia !== 'string') {
    throw new Error('La referencia del checkout es obligatoria.');
  }

  const monto = aBigInt(montoPesos, 'monto');
  if (monto <= 0n) throw new Error('El monto del checkout debe ser positivo.');
  if (moneda !== MONEDA) throw new Error(`Moneda no soportada: ${moneda}`);

  const montoEnCentavos = centavosDePesos(monto);
  const firmaIntegridad = sha256Hex(
    `${referencia}${montoEnCentavos}${moneda}${SECRETO_INTEGRIDAD}`,
  );

  let urlCheckout = null;
  if (ES_REAL) {
    const parametros = new URLSearchParams({
      'public-key': LLAVE_PUBLICA,
      currency: moneda,
      'amount-in-cents': String(montoEnCentavos),
      reference: referencia,
      'signature:integrity': firmaIntegridad,
    });
    if (config.WOMPI_REDIRECT_URL) {
      parametros.set('redirect-url', config.WOMPI_REDIRECT_URL);
    }
    urlCheckout = `${config.WOMPI_CHECKOUT_BASE}?${parametros.toString()}`;
  }

  return {
    llavePublica: LLAVE_PUBLICA,
    referencia,
    montoEnCentavos,
    moneda,
    firmaIntegridad,
    urlCheckout,
  };
}

/**
 * Crea una transaccion por API. En la Etapa 2 no se usa: el checkout se abre
 * con el Web Checkout y Wompi crea la transaccion cuando el comprador paga.
 */
export async function crearTransaccion(_datos) {
  exigirFueraDeTransaccion('wompi.crearTransaccion');
  throw new Error(
    'El checkout de la Etapa 2 usa el Web Checkout; crearTransaccion por API ' +
      'no se usa todavia. (Etapa 2)',
  );
}

/**
 * Consulta una transaccion por id. La usa el webhook antes de aprobar.
 * Devuelve null si Wompi no la conoce.
 */
export async function consultarTransaccion(idTransaccion) {
  exigirFueraDeTransaccion('wompi.consultarTransaccion');

  if (!idTransaccion) throw new Error('Falta el id de la transaccion.');

  if (!ES_REAL) {
    fake.consultas.push({
      id: String(idTransaccion),
      dentroDeTransaccion: hayTransaccionAbierta(),
    });
    return fake.transacciones.get(String(idTransaccion)) ?? null;
  }

  let respuesta;
  try {
    respuesta = await fetch(
      `${config.WOMPI_API_BASE}/transactions/${encodeURIComponent(idTransaccion)}`,
      {
        headers: { Authorization: `Bearer ${config.WOMPI_PRV_KEY}` },
        signal: AbortSignal.timeout(10_000),
      },
    );
  } catch (err) {
    throw new ErrorWompiTransitorio('No se pudo consultar Wompi.', err);
  }

  if (respuesta.status === 404) return null;

  if (!respuesta.ok) {
    if (respuesta.status >= 500) {
      throw new ErrorWompiTransitorio(`Wompi respondio ${respuesta.status}.`);
    }
    throw new Error(`Wompi respondio ${respuesta.status} al consultar la transaccion.`);
  }

  const cuerpo = await respuesta.json();
  const data = cuerpo?.data;
  if (!data?.id) return null;

  return {
    id: String(data.id),
    reference: data.reference,
    status: data.status,
    amountInCents: aBigInt(data.amount_in_cents, 'amount_in_cents'),
    currency: data.currency,
  };
}

/**
 * Verifica la firma de un evento de Wompi.
 * Los valores de `signature.properties` se leen de `data`, en el orden dado;
 * luego se concatena el timestamp y el secreto de eventos.
 */
export async function verificarFirmaEvento(cuerpo, checksumCabecera) {
  exigirFueraDeTransaccion('wompi.verificarFirmaEvento');

  const propiedades = cuerpo?.signature?.properties;
  const timestamp = cuerpo?.timestamp;
  const checksum = checksumCabecera || cuerpo?.signature?.checksum;

  if (!Array.isArray(propiedades) || propiedades.length === 0) return false;
  if (timestamp === undefined || timestamp === null) return false;
  if (!checksum || typeof checksum !== 'string') return false;

  const valores = propiedades.map((propiedad) =>
    valorPorRuta(cuerpo?.data, propiedad),
  );

  if (valores.some((valor) => valor === undefined || valor === null)) {
    return false;
  }

  const cadena = `${valores.map(String).join('')}${timestamp}${SECRETO_EVENTOS}`;
  return compararSeguro(sha256Hex(cadena), checksum.toLowerCase());
}

/**
 * Solicita un reembolso. En modo falso se registra localmente.
 *
 * En modo real NO se usa todavia. La documentacion de Wompi ya describe la API
 * de Reembolsos V2 (`POST /v1/refunds`), pero su implementacion queda detenida
 * hasta confirmar con el negocio el contrato, los estados asincronicos y los
 * metodos de pago cubiertos. Mientras tanto el reembolso se hace manualmente
 * desde el panel de Wompi. No se inventa una URL ni se marca completado.
 */
export async function solicitarReembolso(datos) {
  exigirFueraDeTransaccion('wompi.solicitarReembolso');

  if (!ES_REAL) {
    const id = `fake-refund-${crypto.randomBytes(8).toString('hex')}`;
    fake.reembolsos.set(id, { ...datos, id, estado: 'completado' });
    return { id, estado: 'completado' };
  }

  throw new Error(
    'La API real de reembolsos de Wompi no esta integrada. Los reembolsos se ' +
      'hacen manualmente desde el panel hasta confirmar el contrato de la API.',
  );
}
