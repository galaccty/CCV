import { prisma } from '../lib/prisma.js';
import { withTransaccion } from '../lib/transaccion.js';
import { logger } from '../lib/logger.js';
import {
  cargarConfiguracion,
  obtenerEntero,
} from '../services/configuracion.js';
import { abrirAlerta } from '../services/alertas.js';

/**
 * JOB: EXPIRAR PAGOS DIGITALES (Etapa 4f-2)
 * =========================================
 * Un pago digital que sigue `pendiente` despues de
 * `minutos_expiracion_pago` deja de ser cobrable. El pago pasa a `expirado`
 * y el pedido a `cancelado`; los sub-pedidos que aun no habian sido aceptados
 * tambien quedan cancelados.
 *
 * En digital el stock se descuenta al aprobar el pago, no al crear el pedido,
 * asi que la expiracion no devuelve stock. Si Wompi aprueba tarde, el webhook
 * ve el pedido cancelado y usa el camino de reembolso manual.
 *
 * El pago se bloquea con `FOR UPDATE SKIP LOCKED` y la transicion se condiciona
 * a `estado = 'pendiente'`: una aprobacion simultanea gana o pierde completa,
 * nunca queda un pago expirado con pedido en proceso.
 */

const TAMANO_LOTE = 500;
const METODOS_DIGITALES = ['tarjeta', 'pse', 'nequi'];

async function expirarUno({ pagoId, cutoff, minutos, ahora }) {
  return withTransaccion(async (tx) => {
    const filas = await tx.$queryRaw`
      SELECT "id"
        FROM "pago"
       WHERE "id" = ${pagoId}
         AND "estado" = 'pendiente'
         AND "fecha_creacion" <= ${cutoff}
       FOR UPDATE SKIP LOCKED
    `;

    if (filas.length === 0) return null;

    const pago = await tx.pago.findUnique({
      where: { id: pagoId },
      include: {
        pedido: { select: { id: true, estado: true } },
      },
    });

    if (
      !pago ||
      pago.estado !== 'pendiente' ||
      pago.tipoPago !== 'pedido' ||
      pago.metodoPago === 'efectivo' ||
      pago.metodoPago === 'manual' ||
      !pago.pedido ||
      pago.pedido.estado !== 'pendiente_pago'
    ) {
      return null;
    }

    const cambioPago = await tx.pago.updateMany({
      where: {
        id: pago.id,
        estado: 'pendiente',
        fechaCreacion: { lte: cutoff },
      },
      data: { estado: 'expirado' },
    });

    if (cambioPago.count === 0) return null;

    const cambioPedido = await tx.pedido.updateMany({
      where: { id: pago.pedidoId, estado: 'pendiente_pago' },
      data: { estado: 'cancelado' },
    });

    if (cambioPedido.count === 0) {
      throw new Error('El pedido dejo de estar pendiente de pago.');
    }

    const subPedidos = await tx.subPedido.findMany({
      where: { pedidoId: pago.pedidoId, estado: 'por_aceptar' },
      select: { id: true },
    });

    for (const sub of subPedidos) {
      const cambiado = await tx.subPedido.updateMany({
        where: { id: sub.id, estado: 'por_aceptar' },
        data: { estado: 'cancelado' },
      });

      if (cambiado.count > 0) {
        await tx.historialEstadoSubPedido.create({
          data: {
            subPedidoId: sub.id,
            estadoAnterior: 'por_aceptar',
            estadoNuevo: 'cancelado',
            cambiadoPor: null,
          },
        });
      }
    }

    await tx.auditoriaAdmin.create({
      data: {
        origen: 'sistema',
        adminId: null,
        accion: 'expirar_pago',
        objeto: 'pago',
        objetoId: String(pago.id),
        detalle: {
          pedido_id: pago.pedidoId,
          metodo_pago: pago.metodoPago,
          minutos_expiracion: minutos,
          fecha_corte: cutoff.toISOString(),
          fecha_expiracion: ahora.toISOString(),
        },
      },
    });

    return {
      pagoId: pago.id,
      pedidoId: pago.pedidoId,
      subPedidosCancelados: subPedidos.length,
    };
  });
}

export async function expirarPagos({
  ahora = new Date(),
  pagoIds = null,
} = {}) {
  await cargarConfiguracion({ forzar: true });
  const minutos = Math.max(1, obtenerEntero('minutos_expiracion_pago', 30));
  const cutoff = new Date(ahora.getTime() - minutos * 60 * 1000);

  if (Array.isArray(pagoIds) && pagoIds.length === 0) {
    return { revisados: 0, expirados: 0, errores: 0 };
  }

  const candidatos = await prisma.pago.findMany({
    where: {
      ...(pagoIds ? { id: { in: pagoIds } } : {}),
      tipoPago: 'pedido',
      metodoPago: { in: METODOS_DIGITALES },
      estado: 'pendiente',
      fechaCreacion: { lte: cutoff },
      pedido: { is: { estado: 'pendiente_pago' } },
    },
    select: { id: true },
    orderBy: { id: 'asc' },
    take: TAMANO_LOTE,
  });

  let expirados = 0;
  let errores = 0;

  for (const candidato of candidatos) {
    try {
      if (
        await expirarUno({
          pagoId: candidato.id,
          cutoff,
          minutos,
          ahora,
        })
      ) {
        expirados += 1;
      }
    } catch (err) {
      errores += 1;
      logger.error(
        { err, pagoId: candidato.id },
        'no se pudo expirar un pago digital',
      );

      try {
        await abrirAlerta({
          clave: `expirar_pago_error:pago:${candidato.id}`,
          tipo: 'expirar_pago_error',
          severidad: 'alta',
          titulo: 'Fallo la expiracion de un pago',
          detalle: { pago_id: candidato.id, error: err.message },
          pagoId: candidato.id,
        });
      } catch (errAlerta) {
        logger.error(
          { err: errAlerta, pagoId: candidato.id },
          'tampoco se pudo registrar la alerta de expiracion',
        );
      }
    }
  }

  return {
    revisados: candidatos.length,
    expirados,
    errores,
  };
}
