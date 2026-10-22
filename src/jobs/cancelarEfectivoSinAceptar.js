import { prisma } from '../lib/prisma.js';
import { withTransaccion } from '../lib/transaccion.js';
import { cargarConfiguracion, obtenerEntero } from '../services/configuracion.js';
import { derivarEstadoPedido } from '../domain/estados.js';

/**
 * JOB: CANCELAR EFECTIVO SIN ACEPTAR (Etapa 4b)
 * =============================================
 * Cancela los sub-pedidos en efectivo que llevan mas de `horas_aceptacion`
 * esperando al vendedor. No toca stock: en efectivo el stock nunca se
 * desconto al crear el pedido, solo al aceptar. El pago pendiente queda
 * `rechazado` y el pedido se deriva a `cancelado`.
 *
 * Cada cancelacion usa un UPDATE condicionado por `estado = 'por_aceptar'`,
 * asi que dos ejecuciones (o una aceptacion simultanea) no pisan el resultado
 * de la otra. El candado advisory lo pone `ejecutarJob` en el script.
 */

async function cancelarSubPedidoVencido(subPedido) {
  return withTransaccion(async (tx) => {
    const cambiados = await tx.subPedido.updateMany({
      where: { id: subPedido.id, estado: 'por_aceptar' },
      data: { estado: 'cancelado' },
    });

    if (cambiados.count === 0) return false;

    await tx.historialEstadoSubPedido.create({
      data: {
        subPedidoId: subPedido.id,
        estadoAnterior: 'por_aceptar',
        estadoNuevo: 'cancelado',
        cambiadoPor: null,
      },
    });

    const pedido = await tx.pedido.findUnique({
      where: { id: subPedido.pedidoId },
      select: { estado: true },
    });
    const estados = await tx.subPedido.findMany({
      where: { pedidoId: subPedido.pedidoId },
      select: { estado: true },
    });
    const estadoDerivado = derivarEstadoPedido({
      estadoActual: pedido.estado,
      estadosSubPedidos: estados.map((fila) => fila.estado),
    });

    if (estadoDerivado !== pedido.estado) {
      await tx.pedido.update({
        where: { id: subPedido.pedidoId },
        data: { estado: estadoDerivado },
      });
    }

    await tx.pago.updateMany({
      where: {
        pedidoId: subPedido.pedidoId,
        metodoPago: 'efectivo',
        estado: 'pendiente',
      },
      data: { estado: 'rechazado' },
    });

    return true;
  });
}

export async function cancelarEfectivoSinAceptar({ ahora = new Date() } = {}) {
  // El job es un proceso corto: se lee la configuracion viva, no una cache
  // de un servidor que lleva horas encendido.
  await cargarConfiguracion({ forzar: true });
  const horas = Math.max(0, obtenerEntero('horas_aceptacion', 48));
  const limite = new Date(ahora.getTime() - horas * 60 * 60 * 1000);

  const vencidos = await prisma.subPedido.findMany({
    where: {
      estado: 'por_aceptar',
      creadoEn: { lt: limite },
      pedido: { metodoPago: 'efectivo' },
    },
    select: { id: true, pedidoId: true },
    orderBy: { id: 'asc' },
  });

  let cancelados = 0;
  for (const subPedido of vencidos) {
    if (await cancelarSubPedidoVencido(subPedido)) cancelados += 1;
  }

  return { revisados: vencidos.length, cancelados };
}
