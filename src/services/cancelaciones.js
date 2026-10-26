import { prisma } from '../lib/prisma.js';
import { withTransaccion } from '../lib/transaccion.js';
import { convertirBigIntAJson } from '../lib/dinero.js';
import {
  ErrorApi,
  errorNoEncontrado,
  errorSinPermiso,
  errorValidacion,
} from '../lib/errores.js';
import { envolverLista } from '../lib/validacion.js';
import { devolverStock } from './stock.js';
import { crearEnTx, serializarReembolso } from './reembolsos.js';
import { completarEnTx } from './idempotencia.js';
import {
  serializarSubPedido,
  sincronizarEstadoPedido,
} from './subPedidos.js';

/**
 * CANCELACIONES (Etapa 4f-1)
 * ==========================
 * Reglas:
 *   - comprador: solo `por_aceptar`; en `preparando` debe aceptar el vendedor.
 *   - vendedor: `por_aceptar` y `preparando`.
 *   - `enviado` o posterior: no se cancela, se abre una disputa.
 *
 * El stock se devuelve solo si ya se habia descontado: efectivo aceptado o
 * pago digital aprobado. El reembolso digital se crea pendiente por el flujo
 * 4c-2a, con todas las lineas y el envio incluido (no hubo entrega).
 *
 * La fila del sub-pedido se bloquea antes de decidir. El UPDATE condicionado
 * por el estado anterior es la ultima barrera: dos cancelaciones simultaneas
 * solo pueden producir un reembolso y una devolucion de stock.
 */

const ACCION_AUDITORIA = 'cancelar_sub_pedido';
const ESTADOS_PAGO_REEMBOLSABLES = new Set([
  'aprobado',
  'reembolsado_parcial',
]);
const ESTADOS_PAGO_DIGITAL_CON_STOCK = new Set([
  'aprobado',
  'reembolsado_parcial',
  'reembolsado',
]);

function bloquearSubPedido(tx, id) {
  return tx.$queryRaw`
    SELECT "id"
      FROM "sub_pedido"
     WHERE "id" = ${id}
     FOR UPDATE
  `;
}

function tipoActor(sub, usuario) {
  if (usuario.roles?.includes('admin')) return 'admin';
  if (sub.local.usuarioId === usuario.id) return 'vendedor';
  if (sub.pedido.usuarioId === usuario.id) return 'comprador';
  throw errorSinPermiso('No tienes permiso para cancelar este sub-pedido.');
}

function validarEstadoCancelable(estado, actor) {
  if (estado === 'por_aceptar') return;

  if (estado === 'preparando') {
    if (actor === 'comprador') {
      throw new ErrorApi(
        'cancelacion_requiere_vendedor',
        'El vendedor ya acepto el pedido. La cancelacion en "preparando" solo la puede ejecutar el vendedor.',
        409,
      );
    }
    return;
  }

  if (estado === 'enviado') {
    throw new ErrorApi(
      'transicion_invalida',
      'Un sub-pedido enviado no se puede cancelar. Abre una disputa.',
      409,
    );
  }

  throw new ErrorApi(
    'cancelacion_no_permitida',
    `No se puede cancelar un sub-pedido en estado "${estado}".`,
    409,
  );
}

async function devolverStockDeDetalles({ tx, sub, usuarioId }) {
  const devoluciones = [];

  for (const detalle of sub.detalles) {
    await tx.devolucionStock.create({
      data: {
        subPedidoId: sub.id,
        detalleId: detalle.id,
        cantidad: detalle.cantidad,
        origen: 'cancelacion',
        registradoPor: usuarioId,
      },
    });

    await devolverStock(tx, detalle.varianteId, detalle.cantidad);

    devoluciones.push({
      detalle_id: detalle.id,
      variante_id: detalle.varianteId,
      cantidad: detalle.cantidad,
      origen: 'cancelacion',
    });
  }

  return devoluciones;
}

function lineasCompletas(sub) {
  return sub.detalles.map((detalle) => ({
    detalle_id: detalle.id,
    cantidad: detalle.cantidad,
  }));
}

function traducirErrorCancelacion(err) {
  if (err?.code === 'P2002') {
    return new ErrorApi(
      'stock_ya_devuelto',
      'El stock de una linea de este sub-pedido ya fue devuelto antes.',
      409,
    );
  }
  return err;
}

export async function cancelarSubPedido({
  usuario,
  id,
  motivo,
  idempotenciaId = null,
}) {
  try {
    return await withTransaccion(async (tx) => {
      const bloqueadas = await bloquearSubPedido(tx, id);
      if (bloqueadas.length === 0) {
        throw errorNoEncontrado('Sub-pedido no encontrado.');
      }

      const sub = await tx.subPedido.findUnique({
        where: { id },
        include: {
          local: true,
          pedido: true,
          detalles: true,
        },
      });

      if (!sub) throw errorNoEncontrado('Sub-pedido no encontrado.');

      const actor = tipoActor(sub, usuario);
      validarEstadoCancelable(sub.estado, actor);

      const estadoAnterior = sub.estado;
      const efectivo = sub.pedido.metodoPago === 'efectivo';
      const efectivoAceptado = efectivo && estadoAnterior === 'preparando';

      const pago = await tx.pago.findUnique({
        where: { pedidoId: sub.pedidoId },
      });

      const digitalConStock =
        !efectivo &&
        Boolean(pago) &&
        ESTADOS_PAGO_DIGITAL_CON_STOCK.has(pago.estado);
      const stockDescontado = efectivoAceptado || digitalConStock;

      // Transicion condicionada: aunque el lock ya serializa, el WHERE evita
      // que un cambio de estado inesperado se pise.
      const cambiados = await tx.subPedido.updateMany({
        where: { id: sub.id, estado: estadoAnterior },
        data: { estado: 'cancelado' },
      });

      if (cambiados.count === 0) {
        throw new ErrorApi(
          'transicion_invalida',
          'El sub-pedido cambio de estado mientras se procesaba la cancelacion.',
          409,
        );
      }

      await tx.historialEstadoSubPedido.create({
        data: {
          subPedidoId: sub.id,
          estadoAnterior,
          estadoNuevo: 'cancelado',
          cambiadoPor: usuario.id,
        },
      });

      const devolucionesStock = stockDescontado
        ? await devolverStockDeDetalles({
            tx,
            sub,
            usuarioId: usuario.id,
          })
        : [];

      let reembolso = null;
      const debeReembolsar =
        !efectivo &&
        Boolean(pago) &&
        ESTADOS_PAGO_REEMBOLSABLES.has(pago.estado);

      if (debeReembolsar) {
        reembolso = await crearEnTx({
          tx,
          subPedidoId: sub.id,
          entrada: {
            motivo,
            lineas: lineasCompletas(sub),
            incluye_envio: true,
          },
          registradoPor: usuario.id,
        });
      }

      await sincronizarEstadoPedido(tx, sub.pedidoId);

      // Solo se rechaza el pago pendiente cuando ya no queda ningun sub-pedido
      // activo en el pedido. En un pedido con varios locales, cancelar uno no
      // debe impedir el cobro de los demas.
      const pedidoActualizado = await tx.pedido.findUnique({
        where: { id: sub.pedidoId },
        select: { estado: true },
      });
      if (pedidoActualizado?.estado === 'cancelado') {
        await tx.pago.updateMany({
          where: { pedidoId: sub.pedidoId, estado: 'pendiente' },
          data: { estado: 'rechazado' },
        });
      }

      const actualizado = await tx.subPedido.findUnique({
        where: { id: sub.id },
        include: { detalles: true },
      });

      const auditoria = await tx.auditoriaAdmin.create({
        data: {
          origen: actor === 'admin' ? 'admin' : 'sistema',
          adminId: usuario.id,
          accion: ACCION_AUDITORIA,
          objeto: 'sub_pedido',
          objetoId: String(sub.id),
          detalle: {
            sub_pedido_id: sub.id,
            pedido_id: sub.pedidoId,
            local_id: sub.localId,
            local_nombre: sub.nombreLocal,
            actor_id: usuario.id,
            actor_tipo: actor,
            motivo,
            estado_anterior: estadoAnterior,
            metodo_pago: sub.pedido.metodoPago,
            efectivo_aceptado: efectivoAceptado,
            reembolso_id: reembolso?.id ?? null,
            monto_reembolso: reembolso ? reembolso.monto.toString() : '0',
            stock_devuelto: devolucionesStock.length > 0,
            devoluciones_stock: devolucionesStock,
          },
        },
      });

      const respuesta = convertirBigIntAJson({
        ...serializarSubPedido(actualizado),
        reembolso: reembolso ? serializarReembolso(reembolso) : null,
        devoluciones_stock: devolucionesStock,
        auditoria_id: auditoria.id,
      });

      await completarEnTx(tx, idempotenciaId, 200, respuesta);
      return respuesta;
    });
  } catch (err) {
    throw traducirErrorCancelacion(err);
  }
}

const SOLO_FECHA = /^\d{4}-\d{2}-\d{2}$/;

function parseFecha(valor, campo) {
  const normalizado = SOLO_FECHA.test(valor)
    ? `${valor}T00:00:00.000Z`
    : valor;
  const fecha = new Date(normalizado);

  if (Number.isNaN(fecha.getTime())) {
    throw errorValidacion(`El filtro ${campo} no es una fecha valida.`);
  }

  return fecha;
}

function limiteFecha(valor, { fin = false } = {}) {
  if (SOLO_FECHA.test(valor)) {
    return new Date(`${valor}T${fin ? '23:59:59.999' : '00:00:00.000'}Z`);
  }
  return parseFecha(valor, fin ? 'hasta' : 'desde');
}

function rangoFechas(filtros) {
  const desde = filtros.desde ?? filtros.fecha_desde ?? null;
  const hasta = filtros.hasta ?? filtros.fecha_hasta ?? null;
  const fecha = filtros.fecha ?? null;

  if (fecha) {
    return {
      gte: limiteFecha(fecha),
      lte: limiteFecha(fecha, { fin: true }),
    };
  }

  const gte = desde ? limiteFecha(desde) : null;
  const lte = hasta ? limiteFecha(hasta, { fin: true }) : null;

  if (gte && lte && gte > lte) {
    throw errorValidacion(
      'El filtro "desde" no puede ser posterior al filtro "hasta".',
    );
  }

  return { gte, lte };
}

function serializarCancelacionEfectivo(fila) {
  const detalle = fila.detalle ?? {};

  return {
    id: fila.id,
    fecha: fila.fecha,
    sub_pedido_id: detalle.sub_pedido_id ?? null,
    pedido_id: detalle.pedido_id ?? null,
    local_id: detalle.local_id ?? null,
    local_nombre: detalle.local_nombre ?? null,
    actor_id: detalle.actor_id ?? fila.adminId ?? null,
    actor_tipo: detalle.actor_tipo ?? 'sistema',
    motivo: detalle.motivo ?? null,
    estado_anterior: detalle.estado_anterior ?? null,
    efectivo_aceptado: detalle.efectivo_aceptado === true,
    reembolso_id: detalle.reembolso_id ?? null,
    monto_reembolso: Number(detalle.monto_reembolso ?? 0),
  };
}

export async function listarCancelacionesEfectivo({
  localId,
  fecha,
  desde,
  hasta,
  fechaDesde,
  fechaHasta,
  pagina,
  porPagina,
}) {
  const { gte, lte } = rangoFechas({
    fecha,
    desde,
    hasta,
    fecha_desde: fechaDesde,
    fecha_hasta: fechaHasta,
  });

  const where = {
    accion: ACCION_AUDITORIA,
    objeto: 'sub_pedido',
    AND: [
      { detalle: { path: ['efectivo_aceptado'], equals: true } },
      ...(localId
        ? [{ detalle: { path: ['local_id'], equals: localId } }]
        : []),
    ],
    ...(gte || lte
      ? {
          fecha: {
            ...(gte ? { gte } : {}),
            ...(lte ? { lte } : {}),
          },
        }
      : {}),
  };

  const [total, filas] = await Promise.all([
    prisma.auditoriaAdmin.count({ where }),
    prisma.auditoriaAdmin.findMany({
      where,
      orderBy: [{ fecha: 'desc' }, { id: 'desc' }],
      skip: (pagina - 1) * porPagina,
      take: porPagina,
    }),
  ]);

  return envolverLista(
    filas.map(serializarCancelacionEfectivo),
    { pagina, porPagina },
    total,
  );
}
