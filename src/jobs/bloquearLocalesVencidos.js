import { prisma } from '../lib/prisma.js';
import { withTransaccion } from '../lib/transaccion.js';
import { logger } from '../lib/logger.js';
import { recalcularEstadoLocal } from '../services/estadoLocal.js';

/**
 * JOB: BLOQUEO DIARIO DE LOCALES VENCIDOS (Etapa 4f-2)
 * ====================================================
 * Un local con deuda vencida pasa a `bloqueado`. Antes de decidir, el job
 * SIEMPRE llama a `recalcularEstadoLocal()`: si el local acaba de pagar y su
 * deuda ya esta dentro del limite, el recalculo lo deja `activo` y limpia la
 * fecha; el job no lo bloquea.
 *
 * El estado administrativo (`suspendido`, `pendiente_aprobacion`) no se toca.
 * El cambio a `bloqueado` se hace con UPDATE condicionado y con el GUC que
 * exige el trigger `ccv_estado_local_solo_sistema`.
 */

function diaUtc(ahora) {
  return new Date(
    Date.UTC(ahora.getUTCFullYear(), ahora.getUTCMonth(), ahora.getUTCDate()),
  );
}

async function revisarLocal({ localId, hoy, ahora }) {
  return withTransaccion(async (tx) => {
    const recalculo = await recalcularEstadoLocal(localId, tx, { ahora });

    const cuenta = await tx.cuentaLocal.findUnique({ where: { localId } });
    if (!cuenta) return null;

    if (
      !['activo', 'en_plazo'].includes(recalculo.estado) ||
      !cuenta.fechaLimitePago ||
      cuenta.fechaLimitePago.getTime() >= hoy.getTime()
    ) {
      return null;
    }

    await tx.$queryRaw`
      SELECT set_config('ccv.estado_local_sistema', '1', true)
    `;

    const cambiados = await tx.local.updateMany({
      where: {
        id: localId,
        estado: recalculo.estado,
      },
      data: { estado: 'bloqueado' },
    });

    if (cambiados.count === 0) return null;

    await tx.auditoriaAdmin.create({
      data: {
        origen: 'sistema',
        adminId: null,
        accion: 'bloquear_local_por_deuda',
        objeto: 'local',
        objetoId: String(localId),
        detalle: {
          estado_anterior: recalculo.estado,
          estado_nuevo: 'bloqueado',
          saldo_deuda: cuenta.saldoDeuda.toString(),
          fecha_limite_pago: cuenta.fechaLimitePago.toISOString(),
          motivo_recalculo: recalculo.motivo,
          fecha_ejecucion: ahora.toISOString(),
        },
      },
    });

    return {
      localId,
      estadoAnterior: recalculo.estado,
      saldoDeuda: cuenta.saldoDeuda.toString(),
    };
  });
}

export async function bloquearLocalesVencidos({
  ahora = new Date(),
  localIds = null,
} = {}) {
  const hoy = diaUtc(ahora);

  if (Array.isArray(localIds) && localIds.length === 0) {
    return { revisados: 0, bloqueados: 0, errores: 0 };
  }

  const candidatos = await prisma.local.findMany({
    where: {
      ...(localIds ? { id: { in: localIds } } : {}),
      estado: { in: ['activo', 'en_plazo'] },
      cuenta: {
        is: { fechaLimitePago: { lt: hoy } },
      },
    },
    select: { id: true },
    orderBy: { id: 'asc' },
  });

  let bloqueados = 0;
  let errores = 0;

  for (const local of candidatos) {
    try {
      if (await revisarLocal({ localId: local.id, hoy, ahora })) {
        bloqueados += 1;
      }
    } catch (err) {
      errores += 1;
      logger.error(
        { err, localId: local.id },
        'no se pudo evaluar el bloqueo diario de un local',
      );
    }
  }

  return {
    revisados: candidatos.length,
    bloqueados,
    errores,
  };
}
