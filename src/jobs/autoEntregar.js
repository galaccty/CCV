import { prisma } from '../lib/prisma.js';
import { withTransaccion } from '../lib/transaccion.js';
import { logger } from '../lib/logger.js';
import {
  cargarConfiguracion,
  obtenerEntero,
} from '../services/configuracion.js';
import { registrarMovimiento } from '../services/ledger.js';
import { recalcularEstadoLocal } from '../services/estadoLocal.js';
import { sincronizarEstadoPedido } from '../services/subPedidos.js';
import { abrirAlerta } from '../services/alertas.js';

/**
 * JOB: AUTO-ENTREGA (Etapa 4f-2)
 * =============================
 * Un sub-pedido `enviado` que lleva `dias_auto_entrega` sin confirmacion del
 * comprador pasa a `entregado` con `entrega_confirmada_por = sistema`.
 *
 * En efectivo, igual que la entrega manual, este es el momento en que se
 * registran la venta y la comision como deuda del local. El UPDATE condicionado
 * de `sub_pedido` es el candado de idempotencia: solo una ejecucion puede
 * cambiar `enviado -> entregado`, por lo que jamas se escribe dos veces la
 * comision. Si algo falla dentro de la transaccion, rollback completo y se
 * deja una alerta para que el proximo intento sea visible.
 *
 * No libera saldo: de eso se encarga el job de retencion. Tampoco entrega un
 * sub-pedido con una disputa abierta.
 */

const TAMANO_LOTE = 500;

async function entregarUno({ subPedidoId, limite, ahora }) {
  return withTransaccion(async (tx) => {
    const filas = await tx.$queryRaw`
      SELECT "id"
        FROM "sub_pedido"
       WHERE "id" = ${subPedidoId}
       FOR UPDATE
    `;

    if (filas.length === 0) return null;

    const sub = await tx.subPedido.findUnique({
      where: { id: subPedidoId },
      include: { pedido: true },
    });

    if (!sub || sub.estado !== 'enviado') return null;

    const disputaAbierta = await tx.disputa.count({
      where: { subPedidoId, estado: 'abierta' },
    });
    if (disputaAbierta > 0) return null;

    const envio = await tx.historialEstadoSubPedido.findFirst({
      where: { subPedidoId, estadoNuevo: 'enviado' },
      orderBy: [{ fecha: 'desc' }, { id: 'desc' }],
      select: { fecha: true },
    });

    if (!envio) {
      throw new Error('El sub-pedido enviado no tiene historial de envio.');
    }

    // La consulta de candidatos usa `some` para no traer toda la tabla. Se
    // revalida con el ultimo envio: si el sub-pedido volvio a `enviado` por
    // una disputa resuelta, el plazo se cuenta desde ese envio mas reciente.
    if (envio.fecha.getTime() > limite.getTime()) return null;

    const cambiados = await tx.subPedido.updateMany({
      where: { id: subPedidoId, estado: 'enviado' },
      data: {
        estado: 'entregado',
        fechaEntrega: ahora,
        entregaConfirmadaPor: 'sistema',
      },
    });

    if (cambiados.count === 0) return null;

    await tx.historialEstadoSubPedido.create({
      data: {
        subPedidoId,
        estadoAnterior: 'enviado',
        estadoNuevo: 'entregado',
        cambiadoPor: null,
      },
    });

    if (sub.pedido.metodoPago === 'efectivo') {
      const pago = await tx.pago.findFirst({
        where: { pedidoId: sub.pedidoId, metodoPago: 'efectivo' },
      });

      if (!pago) {
        throw new Error('El pedido en efectivo no tiene su pago pendiente.');
      }

      const pagoAprobado = await tx.pago.updateMany({
        where: { id: pago.id, estado: 'pendiente' },
        data: { estado: 'aprobado' },
      });

      if (pagoAprobado.count === 0) {
        // Un pedido en efectivo puede tener varios sub-pedidos. El primero
        // que se entrega deja el pago `aprobado`; los demas siguen su propio
        // camino y registran su comision. Cualquier otro estado es un error.
        const pagoActual = await tx.pago.findUnique({
          where: { id: pago.id },
          select: { estado: true },
        });
        if (pagoActual?.estado !== 'aprobado') {
          throw new Error('El pago del pedido en efectivo ya no esta pendiente.');
        }
      }

      if (sub.subtotalProductos > 0n) {
        await registrarMovimiento({
          tipo: 'venta',
          monto: sub.subtotalProductos,
          localId: sub.localId,
          subPedidoId: sub.id,
          pagoId: pago.id,
        });
      }

      if (sub.comision > 0n) {
        await registrarMovimiento({
          tipo: 'comision',
          monto: sub.comision,
          localId: sub.localId,
          subPedidoId: sub.id,
          pagoId: pago.id,
        });
      }

      await recalcularEstadoLocal(sub.localId, tx, { ahora });
    }

    await sincronizarEstadoPedido(tx, sub.pedidoId);

    return {
      subPedidoId: sub.id,
      pedidoId: sub.pedidoId,
      localId: sub.localId,
      metodoPago: sub.pedido.metodoPago,
    };
  });
}

export async function autoEntregar({
  ahora = new Date(),
  subPedidoIds = null,
} = {}) {
  await cargarConfiguracion({ forzar: true });
  const dias = Math.max(1, obtenerEntero('dias_auto_entrega', 7));
  const limite = new Date(ahora.getTime() - dias * 24 * 60 * 60 * 1000);

  if (Array.isArray(subPedidoIds) && subPedidoIds.length === 0) {
    return { revisados: 0, entregados: 0, errores: 0 };
  }

  const candidatos = await prisma.subPedido.findMany({
    where: {
      estado: 'enviado',
      ...(subPedidoIds ? { id: { in: subPedidoIds } } : {}),
      historial: {
        some: { estadoNuevo: 'enviado', fecha: { lte: limite } },
      },
    },
    select: { id: true },
    orderBy: { id: 'asc' },
    take: TAMANO_LOTE,
  });

  let entregados = 0;
  let errores = 0;

  for (const candidato of candidatos) {
    try {
      const resultado = await entregarUno({
        subPedidoId: candidato.id,
        limite,
        ahora,
      });
      if (resultado) entregados += 1;
    } catch (err) {
      errores += 1;
      logger.error(
        { err, subPedidoId: candidato.id },
        'no se pudo auto-entregar un sub-pedido',
      );

      try {
        await abrirAlerta({
          clave: `auto_entrega_error:sub_pedido:${candidato.id}`,
          tipo: 'auto_entrega_error',
          severidad: 'alta',
          titulo: 'Fallo la auto-entrega de un sub-pedido',
          detalle: {
            sub_pedido_id: candidato.id,
            error: err.message,
          },
          subPedidoId: candidato.id,
        });
      } catch (errAlerta) {
        logger.error(
          { err: errAlerta, subPedidoId: candidato.id },
          'tampoco se pudo registrar la alerta de auto-entrega',
        );
      }
    }
  }

  return {
    revisados: candidatos.length,
    entregados,
    errores,
  };
}
