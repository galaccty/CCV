import { ErrorApi } from '../lib/errores.js';

/**
 * MAQUINA DE ESTADOS DEL SUB-PEDIDO (seccion 4.3)
 * ===============================================
 * Las transiciones validas de la Etapa 2 son:
 *
 *   por_aceptar -> preparando -> enviado -> entregado
 *   por_aceptar -> cancelado
 *   preparando  -> cancelado
 *
 * `entregado -> en_disputa` se deja declarada porque la disputa existe en la
 * especificacion, pero la ruta que la abre llega en la Etapa 4. No hay ninguna
 * transicion automatica a `en_disputa` en esta etapa.
 */

export const TRANSICIONES_SUB_PEDIDO = Object.freeze({
  por_aceptar: ['preparando', 'cancelado'],
  preparando: ['enviado', 'cancelado'],
  enviado: ['entregado'],
  entregado: ['en_disputa'],
  en_disputa: [],
  cancelado: [],
  reembolsado: [],
  reembolsado_parcial: [],
});

export const ESTADOS_TERMINALES = new Set([
  'entregado',
  'cancelado',
  'reembolsado',
  'reembolsado_parcial',
]);

export function puedeTransicionar(desde, hacia) {
  return TRANSICIONES_SUB_PEDIDO[desde]?.includes(hacia) ?? false;
}

export function exigirTransicion(desde, hacia) {
  if (!puedeTransicionar(desde, hacia)) {
    throw new ErrorApi(
      'transicion_invalida',
      `No se puede pasar un sub-pedido de "${desde}" a "${hacia}".`,
      409,
    );
  }
}

/**
 * Deriva pedido.estado a partir de sus sub_pedidos (seccion 4.3).
 * `expirado` y `reembolso_pendiente` son estados explicitos: no se derivan de
 * los sub_pedidos y esta funcion nunca los sobrescribe. El primero lo escribe
 * el job de expiracion; el segundo, la transaccion B cuando el reembolso real
 * queda pendiente de ejecucion manual.
 */
export function derivarEstadoPedido({ estadoActual, estadosSubPedidos }) {
  if (
    estadoActual === 'expirado' ||
    estadoActual === 'reembolso_pendiente'
  ) {
    return estadoActual;
  }

  const estados = estadosSubPedidos ?? [];
  if (estados.length === 0) {
    return estadoActual === 'pendiente_pago' ? 'pendiente_pago' : 'en_proceso';
  }

  if (estados.some((estado) => !ESTADOS_TERMINALES.has(estado))) {
    return 'en_proceso';
  }

  if (estados.every((estado) => estado === 'cancelado')) {
    return 'cancelado';
  }

  if (estados.some((estado) => estado === 'entregado' || estado === 'reembolsado_parcial')) {
    return 'completado';
  }

  return 'reembolsado';
}
