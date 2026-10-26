/**
 * DEFINICIONES DE LA CONFIGURACION EDITABLE
 * =========================================
 * Este modulo no importa Prisma ni Express: solo describe que claves existen,
 * de que tipo son y en que rango se pueden mover. Lo usan el servicio de
 * administracion y los esquemas de validacion de la API.
 *
 * `congelada` significa que el valor se copia al snapshot de cada pedido
 * nuevo. Cambiarlo no reescribe pedidos ya creados ni recalcula comisiones
 * historicas. `en vivo` significa que la proxima lectura usa el valor nuevo.
 */

export const DEFINICIONES_CONFIGURACION = Object.freeze({
  porcentaje_comision: Object.freeze({
    tipo: 'numero',
    minimo: 0,
    maximo: 100,
    congelada: true,
    descripcion:
      'Comision de la plataforma sobre el valor de los productos. Nunca sobre el envio.',
  }),
  comision_minima: Object.freeze({
    tipo: 'entero',
    minimo: 0,
    maximo: null,
    congelada: true,
    descripcion:
      'Comision minima por sub_pedido para que los pedidos chicos no dejen margen negativo.',
  }),
  pedido_minimo: Object.freeze({
    tipo: 'entero',
    minimo: 0,
    maximo: null,
    congelada: true,
    descripcion: 'Subtotal minimo de productos por local, sin envio.',
  }),
  tarifa_base_envio: Object.freeze({
    tipo: 'entero',
    minimo: 0,
    maximo: null,
    congelada: true,
    descripcion: 'Base del costo de envio por sub_pedido.',
  }),
  tarifa_por_km: Object.freeze({
    tipo: 'entero',
    minimo: 0,
    maximo: null,
    congelada: true,
    descripcion: 'Costo por kilometro de distancia en linea recta.',
  }),
  dias_retencion: Object.freeze({
    tipo: 'entero',
    minimo: 3,
    maximo: 365,
    congelada: true,
    descripcion:
      'Dias de retencion del saldo del vendedor despues de entregar. Minimo 3.',
  }),
  limite_deuda: Object.freeze({
    tipo: 'entero',
    minimo: 0,
    maximo: null,
    congelada: false,
    descripcion:
      'Deuda maxima antes de que un local pase a en_plazo. Se lee en vivo.',
  }),
  plazo_dias: Object.freeze({
    tipo: 'entero',
    minimo: 1,
    maximo: 365,
    congelada: false,
    descripcion:
      'Dias que tiene un local en_plazo para pagar. Se lee en vivo.',
  }),
  dias_auto_entrega: Object.freeze({
    tipo: 'entero',
    minimo: 1,
    maximo: 365,
    congelada: false,
    descripcion:
      'Dias en enviado sin confirmacion antes de que el sistema entregue.',
  }),
  minutos_expiracion_pago: Object.freeze({
    tipo: 'entero',
    minimo: 1,
    maximo: 10080,
    congelada: false,
    descripcion: 'Minutos que un pago digital puede quedar pendiente.',
  }),
  horas_aceptacion: Object.freeze({
    tipo: 'entero',
    minimo: 1,
    maximo: 8760,
    congelada: false,
    descripcion:
      'Horas que un vendedor tiene para aceptar un pedido en efectivo.',
  }),
  dias_reembolso_efectivo: Object.freeze({
    tipo: 'entero',
    minimo: 1,
    maximo: 365,
    congelada: false,
    descripcion:
      'Dias que el vendedor tiene para reembolsar en efectivo antes de incumplir.',
  }),
  intentos_maximos_reembolso: Object.freeze({
    tipo: 'entero',
    minimo: 1,
    maximo: 100,
    congelada: false,
    descripcion: 'Intentos antes de marcar un reembolso como fallido.',
  }),
  monto_minimo_liquidacion: Object.freeze({
    tipo: 'entero',
    minimo: 0,
    maximo: null,
    congelada: false,
    descripcion:
      'Monto minimo de una liquidacion; 0 permite lotes de cualquier tamano.',
  }),
});

export const CLAVES_CONFIGURACION = Object.freeze(
  Object.keys(DEFINICIONES_CONFIGURACION),
);

export const CLAVES_CONGELADAS = Object.freeze(
  CLAVES_CONFIGURACION.filter(
    (clave) => DEFINICIONES_CONFIGURACION[clave].congelada,
  ),
);

export const CLAVES_EN_VIVO = Object.freeze(
  CLAVES_CONFIGURACION.filter(
    (clave) => !DEFINICIONES_CONFIGURACION[clave].congelada,
  ),
);

export const CLAVES_QUE_RECALCULAN_LOCALES = Object.freeze([
  'limite_deuda',
  'plazo_dias',
]);

export function esCongelada(clave) {
  return Boolean(DEFINICIONES_CONFIGURACION[clave]?.congelada);
}

/**
 * Devuelve un mensaje de error, o null si el valor es valido.
 * No coerciona: un entero enviado como texto se rechaza para que el contrato
 * sea explicito y no dependa de la generosidad de JavaScript.
 */
export function validarValorConfiguracion(clave, valor) {
  const definicion = DEFINICIONES_CONFIGURACION[clave];
  if (!definicion) {
    return `La clave ${clave} no esta permitida.`;
  }

  if (definicion.tipo === 'entero') {
    if (typeof valor !== 'number' || !Number.isInteger(valor)) {
      return `La clave ${clave} debe ser un entero.`;
    }
  } else if (definicion.tipo === 'numero') {
    if (typeof valor !== 'number' || !Number.isFinite(valor)) {
      return `La clave ${clave} debe ser un numero.`;
    }
  } else if (definicion.tipo === 'booleano') {
    if (typeof valor !== 'boolean') {
      return `La clave ${clave} debe ser booleano.`;
    }
  } else if (definicion.tipo === 'texto') {
    if (typeof valor !== 'string') {
      return `La clave ${clave} debe ser texto.`;
    }
  }

  if (typeof valor === 'number') {
    if (definicion.minimo !== null && valor < definicion.minimo) {
      return `La clave ${clave} debe ser mayor o igual a ${definicion.minimo}.`;
    }
    if (definicion.maximo !== null && valor > definicion.maximo) {
      return `La clave ${clave} debe ser menor o igual a ${definicion.maximo}.`;
    }
  }

  return null;
}

/** Convierte el valor JSON al texto que vive en la tabla `configuracion`. */
export function serializarValorConfiguracion(valor) {
  if (typeof valor === 'boolean') return valor ? 'true' : 'false';
  return String(valor);
}
