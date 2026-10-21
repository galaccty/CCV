import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { ErrorApi } from '../lib/errores.js';
import { withTransaccion } from '../lib/transaccion.js';
import { centavosDePesos } from '../lib/dinero.js';
import { descontarStock, ErrorStockInsuficiente } from './stock.js';
import { registrarMovimiento } from './ledger.js';
import * as pagos from './pagos.js';

/**
 * WEBHOOK DE WOMPI (secciones 4.1.3 y 4.1.4)
 * ==========================================
 * Reglas que se cumplen aqui:
 *
 *   1. TODO evento se guarda en `evento_webhook`, incluso si la firma es
 *      invalida o la referencia es desconocida (invariante 2).
 *   2. La firma se verifica con el secreto de eventos.
 *   3. NUNCA se confia en el cuerpo: antes de aprobar se consulta la
 *      transaccion a Wompi (fuera de cualquier transaccion de base de datos).
 *   4. Se responde 200 solo despues de procesar. Los fallos transitorios
 *      responden 5xx para que Wompi reintente.
 *   5. La confirmacion del pago tiene DOS transacciones separadas:
 *        A) aprobar + descontar stock + ledger + estado del pedido
 *        B) si A falla por stock, reembolsar y cancelar
 *      La llamada a Wompi ocurre antes de A, jamas dentro.
 */

const ESTADOS_QUE_RECHAZAN = new Set(['DECLINED', 'VOIDED', 'ERROR']);

class ErrorConfirmacionNoPosible extends Error {
  constructor(motivo) {
    super(`No se puede confirmar el pedido: ${motivo}`);
    this.name = 'ErrorConfirmacionNoPosible';
    this.motivo = motivo;
  }
}

async function cerrarEvento(id, resultado) {
  await prisma.eventoWebhook.update({
    where: { id },
    data: { procesado: true, resultado },
  });
}

function alertaReferenciaDesconocida({ eventoId, referencia, transaccionId }) {
  logger.error(
    {
      alerta: 'pago_referencia_desconocida',
      eventoId,
      referencia,
      transaccionId,
    },
    'ALERTA: llego un webhook con una referencia que no existe en pagos',
  );
}

/**
 * Procesa un evento ya parseado. Devuelve el cuerpo que se responde a Wompi.
 * Lanza ErrorApi 401 para firma invalida y 503 para fallos transitorios.
 */
export async function procesarEvento({ cuerpo, checksum }) {
  const transaccionEvento = cuerpo?.data?.transaction ?? {};
  const referencia = transaccionEvento.reference
    ? String(transaccionEvento.reference)
    : null;
  const transaccionId = transaccionEvento.id
    ? String(transaccionEvento.id)
    : null;

  // Se guarda ANTES de verificar la firma: un evento con firma invalida
  // tambien es evidencia y debe quedar registrado.
  const evento = await prisma.eventoWebhook.create({
    data: {
      referencia: referencia ? referencia.slice(0, 255) : null,
      payload: cuerpo,
      procesado: false,
    },
  });

  const firmaValida = await pagos.verificarFirmaEvento(cuerpo, checksum);

  if (!firmaValida) {
    await cerrarEvento(evento.id, 'firma_invalida');
    throw new ErrorApi(
      'firma_invalida',
      'La firma del evento de Wompi no es valida.',
      401,
    );
  }

  if (!referencia || !transaccionId) {
    await cerrarEvento(evento.id, 'ignorado');
    return { recibido: true, resultado: 'ignorado' };
  }

  const pago = await prisma.pago.findUnique({
    where: { referencia },
    include: { pedido: true },
  });

  if (!pago) {
    await cerrarEvento(evento.id, 'referencia_desconocida');
    alertaReferenciaDesconocida({
      eventoId: evento.id,
      referencia,
      transaccionId,
    });
    return { recibido: true, resultado: 'referencia_desconocida' };
  }

  // Nunca se confia en el estado que trae el cuerpo: se consulta a Wompi.
  const transaccion = await pagos.consultarTransaccion(transaccionId);

  if (!transaccion) {
    // Puede ser una carrera de Wompi. Es transitorio: que reintente.
    logger.warn(
      { eventoId: evento.id, referencia, transaccionId },
      'Wompi no devolvio la transaccion del evento; se pide reintento',
    );
    throw new ErrorApi(
      'wompi_no_confirma',
      'Wompi todavia no devuelve la transaccion; reintentar.',
      503,
    );
  }

  const montoEsperado = centavosDePesos(pago.monto);

  if (
    transaccion.id !== transaccionId ||
    transaccion.reference !== pago.referencia ||
    transaccion.currency !== 'COP' ||
    transaccion.amountInCents !== montoEsperado
  ) {
    await cerrarEvento(evento.id, 'ignorado');
    logger.error(
      {
        alerta: 'evento_no_coincide_con_el_pago',
        eventoId: evento.id,
        referencia: pago.referencia,
        transaccionId,
        montoEsperado: String(montoEsperado),
        montoRecibido: String(transaccion.amountInCents),
      },
      'ALERTA: el evento no coincide con el pago; no se aprueba',
    );
    return { recibido: true, resultado: 'ignorado' };
  }

  if (transaccion.status !== 'APPROVED') {
    if (transaccion.status === 'PENDING') {
      await withTransaccion(async (tx) => {
        await tx.pago.updateMany({
          where: { id: pago.id, estado: 'pendiente' },
          data: { idTransaccionWompi: transaccion.id },
        });
      });
      await cerrarEvento(evento.id, 'ignorado');
      return { recibido: true, resultado: 'ignorado' };
    }

    if (ESTADOS_QUE_RECHAZAN.has(transaccion.status)) {
      await withTransaccion(async (tx) => {
        await tx.pago.updateMany({
          where: { id: pago.id, estado: 'pendiente' },
          data: { estado: 'rechazado', idTransaccionWompi: transaccion.id },
        });
      });
      await cerrarEvento(evento.id, 'ignorado');
      return { recibido: true, resultado: 'ignorado' };
    }

    await cerrarEvento(evento.id, 'ignorado');
    return { recibido: true, resultado: 'ignorado' };
  }

  if (!pago.pedidoId) {
    await cerrarEvento(evento.id, 'ignorado');
    logger.error(
      { alerta: 'pago_sin_pedido', pagoId: pago.id },
      'ALERTA: pago aprobado sin pedido asociado',
    );
    return { recibido: true, resultado: 'ignorado' };
  }

  let reembolso = false;

  try {
    const resultado = await withTransaccion(async (tx) => {
      const pagoActual = await tx.pago.findUnique({ where: { id: pago.id } });

      if (!pagoActual) {
        throw new ErrorApi('pago_no_encontrado', 'El pago no existe.', 404);
      }

      if (
        pagoActual.estado === 'aprobado' ||
        pagoActual.estado === 'reembolsado' ||
        pagoActual.estado === 'reembolsado_parcial'
      ) {
        return { yaProcesado: true };
      }

      const pedidoActual = await tx.pedido.findUnique({
        where: { id: pago.pedidoId },
      });

      if (!pedidoActual) {
        throw new ErrorApi('pedido_no_encontrado', 'El pedido no existe.', 404);
      }

      if (pedidoActual.estado === 'expirado') {
        throw new ErrorConfirmacionNoPosible('pedido_expirado');
      }

      const actualizados = await tx.pago.updateMany({
        where: {
          id: pago.id,
          estado: { in: ['pendiente', 'rechazado'] },
        },
        data: {
          estado: 'aprobado',
          idTransaccionWompi: transaccion.id,
        },
      });

      if (actualizados.count === 0) {
        // Otra peticion gano la carrera y ya lo proceso.
        return { yaProcesado: true };
      }

      const subPedidos = await tx.subPedido.findMany({
        where: { pedidoId: pago.pedidoId },
        include: { detalles: true, local: true },
      });

      if (subPedidos.length === 0) {
        throw new ErrorConfirmacionNoPosible('pedido_sin_sub_pedidos');
      }

      // Primero se valida todo y se descuenta stock. Si una sola linea falla,
      // el UPDATE atomico devuelve 0 y toda la transaccion A se revierte.
      for (const sub of subPedidos) {
        if (sub.local.estado !== 'activo') {
          throw new ErrorConfirmacionNoPosible('local_inactivo');
        }
        for (const detalle of sub.detalles) {
          await descontarStock(tx, detalle.varianteId, detalle.cantidad);
        }
      }

      // Ledger en la MISMA transaccion que el stock y el pago.
      for (const sub of subPedidos) {
        if (sub.subtotalProductos > 0n) {
          await registrarMovimiento({
            tipo: 'venta',
            monto: sub.subtotalProductos,
            localId: sub.localId,
            subPedidoId: sub.id,
          });
        }
        if (sub.comision > 0n) {
          await registrarMovimiento({
            tipo: 'comision',
            monto: sub.comision,
            subPedidoId: sub.id,
          });
        }
      }

      await registrarMovimiento({
        tipo: 'pago_recibido',
        monto: pagoActual.monto,
        pagoId: pago.id,
      });

      if (pedidoActual.estado === 'pendiente_pago') {
        await tx.pedido.update({
          where: { id: pedidoActual.id },
          data: { estado: 'en_proceso' },
        });
      }

      return { yaProcesado: false };
    });

    if (resultado.yaProcesado) {
      await cerrarEvento(evento.id, 'ok');
      return { recibido: true, resultado: 'ok' };
    }
  } catch (err) {
    if (
      err instanceof ErrorStockInsuficiente ||
      err instanceof ErrorConfirmacionNoPosible
    ) {
      logger.error(
        {
          alerta: 'confirmacion_revertida',
          pagoId: pago.id,
          pedidoId: pago.pedidoId,
          motivo: err.message,
        },
        'ALERTA: el pago se aprobo en Wompi pero no se pudo confirmar; se reembolsa',
      );

      try {
        const resultadoReembolso = await crearReembolsoTotal({
          pago,
          transaccionId: transaccion.id,
          motivo:
            err instanceof ErrorStockInsuficiente
              ? 'stock_insuficiente_al_confirmar_pago'
              : err.motivo,
        });
        reembolso = resultadoReembolso.reembolsado;
      } catch (errReembolso) {
        logger.error(
          { err: errReembolso, pagoId: pago.id },
          'no se pudo registrar el reembolso; se pide reintento',
        );
        throw new ErrorApi(
          'fallo_reembolso',
          'No se pudo registrar el reembolso; reintentar.',
          503,
        );
      }
    } else {
      throw err;
    }
  }

  await cerrarEvento(evento.id, 'ok');
  return { recibido: true, resultado: 'ok', reembolso };
}

/**
 * Transaccion B: reembolso total automatico cuando la transaccion A fallo.
 * Un reembolso por sub_pedido; la suma completa el monto del pago.
 */
async function crearReembolsoTotal({ pago, transaccionId, motivo }) {
  // La Etapa 2 solo ejecuta reembolsos con el proveedor falso. El endpoint
  // real de reembolsos de Wompi no esta verificado en la documentacion
  // oficial. En modo real se prefiere fallar y alertar antes que marcar un
  // reembolso como completado sin haber devuelto el dinero.
  if (!pagos.esProveedorFalso()) {
    throw new Error(
      'El reembolso automatico real no esta implementado: falta verificar el ' +
        'endpoint de reembolsos de Wompi. El evento queda sin procesar y se alerta.',
    );
  }

  return withTransaccion(async (tx) => {
    const pagoActual = await tx.pago.findUnique({ where: { id: pago.id } });

    if (!pagoActual) {
      throw new ErrorApi('pago_no_encontrado', 'El pago no existe.', 404);
    }

    // Reclamo atomico: solo una transaccion puede pasar el pago de `pendiente`
    // a `reembolsado`. Si otra peticion alcanzo a aprobarlo, o si ya estaba
    // reembolsado, esta transaccion no toca nada. Asi dos webhooks simultaneos
    // no pueden aprobar Y reembolsar el mismo pago a la vez.
    const reclamo = await tx.pago.updateMany({
      where: { id: pago.id, estado: 'pendiente' },
      data: { estado: 'reembolsado', idTransaccionWompi: transaccionId },
    });

    if (reclamo.count === 0) {
      return { reembolsado: false };
    }

    const subPedidos = await tx.subPedido.findMany({
      where: { pedidoId: pagoActual.pedidoId },
      include: { detalles: true },
    });

    if (subPedidos.length === 0) {
      throw new Error('No hay sub_pedidos para reembolsar.');
    }

    const existentes = await tx.reembolso.findMany({
      where: { pagoId: pago.id },
    });

    for (const sub of subPedidos) {
      if (existentes.some((r) => r.subPedidoId === sub.id)) continue;

      const reembolso = await tx.reembolso.create({
        data: {
          pagoId: pago.id,
          subPedidoId: sub.id,
          tipo: 'digital',
          monto: sub.total,
          estado: 'completado',
          motivo,
        },
      });

      await registrarMovimiento({
        tipo: 'reembolso',
        monto: sub.total,
        pagoId: pago.id,
        reembolsoId: reembolso.id,
      });

      await tx.historialEstadoSubPedido.create({
        data: {
          subPedidoId: sub.id,
          estadoAnterior: sub.estado,
          estadoNuevo: 'reembolsado',
        },
      });

      await tx.subPedido.update({
        where: { id: sub.id },
        data: { estado: 'reembolsado' },
      });
    }

    const suma = await tx.reembolso.aggregate({
      where: { pagoId: pago.id, estado: 'completado' },
      _sum: { monto: true },
    });

    const totalReembolsado = suma._sum.monto ?? 0n;

    await tx.pago.update({
      where: { id: pago.id },
      data: {
        estado:
          totalReembolsado >= pagoActual.monto
            ? 'reembolsado'
            : 'reembolsado_parcial',
        montoReembolsado: totalReembolsado,
        idTransaccionWompi: transaccionId,
      },
    });

    const pedidoActual = await tx.pedido.findUnique({
      where: { id: pagoActual.pedidoId },
    });

    // `expirado` es terminal y solo lo escribe el job de expiracion.
    if (pedidoActual && pedidoActual.estado !== 'expirado') {
      await tx.pedido.update({
        where: { id: pedidoActual.id },
        data: { estado: 'reembolsado' },
      });
    }

    return { reembolsado: true };
  });
}
