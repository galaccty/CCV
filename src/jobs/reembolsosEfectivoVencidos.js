import { prisma } from '../lib/prisma.js';
import { withTransaccion } from '../lib/transaccion.js';
import { logger } from '../lib/logger.js';
import { registrarMovimiento } from '../services/ledger.js';
import { recalcularEstadoLocal } from '../services/estadoLocal.js';

/**
 * JOB: REEMBOLSOS EN EFECTIVO VENCIDOS (Etapa 4c-2b)
 * ==================================================
 * Un reembolso en efectivo lo paga el vendedor directamente. Si llega su
 * `fecha_limite` sin que el admin confirme la devolucion, el reembolso pasa a
 * `incumplido` y el monto se convierte en deuda del local.
 *
 * Cada fila se bloquea con `FOR UPDATE SKIP LOCKED`, la transicion se
 * condiciona a `estado = 'pendiente'` y el indice UNIQUE parcial del ledger
 * impide una segunda `deuda_reembolso` por reembolso. Por eso dos ejecuciones
 * simultaneas, o un reintento, no duplican la deuda.
 *
 * `recalcularEstadoLocal()` corre en la misma transaccion: un local activo con
 * un reembolso incumplido queda en `en_plazo`.
 */

const TAMANO_LOTE = 500;

async function vencerReembolso(reembolsoId, ahora) {
  return withTransaccion(async (tx) => {
    const filas = await tx.$queryRaw`
      SELECT "id"
        FROM "reembolso"
       WHERE "id" = ${reembolsoId}
         AND "tipo" = 'efectivo'
         AND "estado" = 'pendiente'
         AND "fecha_limite" <= ${ahora}
       FOR UPDATE SKIP LOCKED
    `;

    if (filas.length === 0) return null;

    const reembolso = await tx.reembolso.findUnique({
      where: { id: reembolsoId },
      include: {
        subPedido: {
          select: {
            id: true,
            localId: true,
          },
        },
      },
    });

    if (!reembolso) return null;

    const deudaExistente = await tx.ledger.findFirst({
      where: {
        reembolsoId: reembolso.id,
        tipo: 'deuda_reembolso',
      },
      select: { id: true },
    });

    const actualizado = await tx.reembolso.updateMany({
      where: { id: reembolso.id, estado: 'pendiente' },
      data: { estado: 'incumplido' },
    });

    if (actualizado.count === 0) return null;

    if (!deudaExistente) {
      await registrarMovimiento({
        tipo: 'deuda_reembolso',
        monto: reembolso.monto,
        localId: reembolso.subPedido.localId,
        subPedidoId: reembolso.subPedidoId,
        pagoId: reembolso.pagoId,
        reembolsoId: reembolso.id,
        disputaId: reembolso.disputaId,
      });
    }

    await recalcularEstadoLocal(reembolso.subPedido.localId, tx, { ahora });

    await tx.auditoriaAdmin.create({
      data: {
        origen: 'sistema',
        adminId: null,
        accion: 'reembolso_efectivo_vencido',
        objeto: 'reembolso',
        objetoId: String(reembolso.id),
        detalle: {
          sub_pedido_id: reembolso.subPedidoId,
          local_id: reembolso.subPedido.localId,
          monto: reembolso.monto.toString(),
          deuda_ya_existente: Boolean(deudaExistente),
        },
      },
    });

    return {
      reembolsoId: reembolso.id,
      localId: reembolso.subPedido.localId,
      monto: reembolso.monto.toString(),
    };
  });
}

export async function reembolsosEfectivoVencidos({ ahora = new Date() } = {}) {
  const vencidos = await prisma.reembolso.findMany({
    where: {
      tipo: 'efectivo',
      estado: 'pendiente',
      fechaLimite: { lte: ahora },
    },
    select: { id: true },
    orderBy: [{ fechaLimite: 'asc' }, { id: 'asc' }],
    take: TAMANO_LOTE,
  });

  let incumplidos = 0;

  for (const reembolso of vencidos) {
    try {
      if (await vencerReembolso(reembolso.id, ahora)) incumplidos += 1;
    } catch (err) {
      // Un fallo en una fila no debe impedir que el job procese las demas.
      // La transaccion de esa fila ya hizo rollback; el proximo intento la
      // vuelve a tomar.
      logger.error(
        { err, reembolsoId: reembolso.id },
        'no se pudo vencer un reembolso en efectivo',
      );
    }
  }

  return {
    revisados: vencidos.length,
    incumplidos,
  };
}
