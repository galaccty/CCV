import crypto from 'node:crypto';
import { prisma } from '../lib/prisma.js';
import { withTransaccion } from '../lib/transaccion.js';
import { convertirBigIntAJson } from '../lib/dinero.js';
import { ErrorApi, errorNoEncontrado } from '../lib/errores.js';
import { completarEnTx } from './idempotencia.js';
import * as wompi from '../lib/wompi.js';

/**
 * PAGOS
 * =====
 * Este es el UNICO archivo de `src` que importa `lib/wompi.js`. El guardian
 * estatico del invariante 4 lo permite solo aqui, y el cliente de Wompi sigue
 * exigiendo en tiempo de ejecucion que cada llamada ocurra fuera de una
 * transaccion.
 *
 * Crear un pago NO llama a Wompi: arma los datos firmados del Web Checkout y
 * los devuelve al frontend. La confirmacion llega por webhook y se procesa en
 * `services/webhooks.js`, que usa los metodos reexportados de aqui.
 */

export const verificarFirmaEvento = wompi.verificarFirmaEvento;
export const consultarTransaccion = wompi.consultarTransaccion;
export const esProveedorFalso = wompi.esProveedorFalso;

// Utilidades del proveedor falso para las pruebas. Se reexportan desde aqui
// para que ningun archivo fuera de este modulo importe `lib/wompi.js`
// directamente (invariante 4). En modo real no hacen nada util, pero no
// exponen llaves ni datos de produccion.
export const registrarTransaccionFalsa = wompi.registrarTransaccionFalsa;
export const limpiarWompiFalso = wompi.limpiarWompiFalso;
export const auditoriaWompiFalsa = wompi.auditoriaWompiFalsa;

export function serializarPago(pago) {
  return {
    id: pago.id,
    tipo_pago: pago.tipoPago,
    pedido_id: pago.pedidoId,
    referencia: pago.referencia,
    id_transaccion_wompi: pago.idTransaccionWompi,
    metodo_pago: pago.metodoPago,
    monto: pago.monto,
    monto_reembolsado: pago.montoReembolsado,
    estado: pago.estado,
    fecha_creacion: pago.fechaCreacion,
    fecha_actualizacion: pago.fechaActualizacion,
  };
}

const METODOS_DIGITALES = new Set(['tarjeta', 'pse', 'nequi']);

/**
 * Crea el pago pendiente y devuelve los datos firmados del checkout.
 * El monto sale SIEMPRE de pedido.total, nunca del cuerpo de la peticion.
 */
export async function crearPago({ usuario, pedidoId, idempotenciaId }) {
  const pedido = await prisma.pedido.findFirst({
    where: { id: pedidoId, usuarioId: usuario.id },
  });

  if (!pedido) throw errorNoEncontrado('Pedido no encontrado.');

  if (pedido.estado !== 'pendiente_pago') {
    throw new ErrorApi(
      'pedido_no_pagable',
      'El pedido ya no esta pendiente de pago.',
      422,
    );
  }

  if (!METODOS_DIGITALES.has(pedido.metodoPago)) {
    throw new ErrorApi(
      'metodo_pago_no_soportado',
      'En esta etapa solo se aceptan pagos digitales (tarjeta, pse, nequi).',
      422,
    );
  }

  const existente = await prisma.pago.findUnique({ where: { pedidoId } });
  if (existente) {
    throw new ErrorApi(
      'pedido_ya_tiene_pago',
      'El pedido ya tiene un pago asociado.',
      409,
    );
  }

  // Referencia unica generada por el backend con bytes aleatorios.
  const referencia = `CCV-${crypto.randomBytes(16).toString('hex')}`;

  // Se calcula FUERA de la transaccion. No es una llamada HTTP, pero asi el
  // invariante 4 se cumple sin excepciones.
  const checkout = await wompi.crearCheckout({
    referencia,
    montoPesos: pedido.total,
    moneda: 'COP',
  });

  try {
    return await withTransaccion(async (tx) => {
      const pago = await tx.pago.create({
        data: {
          tipoPago: 'pedido',
          pedidoId: pedido.id,
          referencia,
          metodoPago: pedido.metodoPago,
          monto: pedido.total,
          estado: 'pendiente',
        },
      });

      const respuesta = convertirBigIntAJson({
        pago: serializarPago(pago),
        checkout: {
          llave_publica: checkout.llavePublica,
          referencia: checkout.referencia,
          monto_en_centavos: checkout.montoEnCentavos,
          moneda: checkout.moneda,
          firma_integridad: checkout.firmaIntegridad,
          url_checkout: checkout.urlCheckout,
        },
      });

      await completarEnTx(tx, idempotenciaId, 201, respuesta);
      return respuesta;
    });
  } catch (err) {
    if (err?.code === 'P2002') {
      const otro = await prisma.pago.findUnique({ where: { pedidoId } });
      if (otro) {
        throw new ErrorApi(
          'pedido_ya_tiene_pago',
          'El pedido ya tiene un pago asociado.',
          409,
        );
      }
    }
    throw err;
  }
}
