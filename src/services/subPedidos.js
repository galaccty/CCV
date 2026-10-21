import { prisma } from '../lib/prisma.js';
import { withTransaccion } from '../lib/transaccion.js';
import { convertirBigIntAJson } from '../lib/dinero.js';
import {
  ErrorApi,
  errorNoEncontrado,
  errorSinPermiso,
} from '../lib/errores.js';
import { derivarEstadoPedido, exigirTransicion } from '../domain/estados.js';

/**
 * SUB-PEDIDOS: LECTURA DEL VENDEDOR Y MAQUINA DE ESTADOS
 * =====================================================
 * Reglas de la Etapa 2:
 *   - aceptar: solo el vendedor dueno del local. pendiente -> preparando.
 *   - enviar:  solo el vendedor. preparando -> enviado. Exige evidencia.
 *   - entregar: comprador o vendedor. enviado -> entregado.
 *
 * Marcar entregado NO libera dinero: `saldo_liberado_en` queda nulo hasta el
 * job de retencion de la Etapa 4.
 *
 * Cada cambio se hace con un UPDATE condicionado por el estado anterior. Si
 * dos peticiones intentan la misma transicion, solo una actualiza la fila; la
 * otra recibe 409. El historial se escribe en la misma transaccion.
 */

export function serializarSubPedido(sub) {
  return {
    id: sub.id,
    pedido_id: sub.pedidoId,
    local_id: sub.localId,
    nombre_local: sub.nombreLocal,
    subtotal_productos: sub.subtotalProductos,
    costo_envio: sub.costoEnvio,
    comision: sub.comision,
    total: sub.total,
    estado: sub.estado,
    evidencia_envio: sub.evidenciaEnvio,
    entrega_confirmada_por: sub.entregaConfirmadaPor,
    fecha_entrega: sub.fechaEntrega,
    saldo_liberado_en: sub.saldoLiberadoEn,
    detalles: (sub.detalles ?? []).map((detalle) => ({
      id: detalle.id,
      variante_id: detalle.varianteId,
      nombre_producto: detalle.nombreProducto,
      atributos_elegidos: detalle.atributosElegidos,
      cantidad: detalle.cantidad,
      precio_unitario: detalle.precioUnitario,
    })),
  };
}

const INCLUIR_DETALLES = { detalles: true };

function esAdmin(usuario) {
  return usuario.roles.includes('admin');
}

function esVendedorDelLocal(sub, usuario) {
  return sub.local.usuarioId === usuario.id;
}

function esCompradorDelPedido(sub, usuario) {
  return sub.pedido.usuarioId === usuario.id;
}

async function cargarSubPedido(id) {
  const sub = await prisma.subPedido.findUnique({
    where: { id },
    include: {
      local: true,
      pedido: true,
      detalles: true,
    },
  });

  if (!sub) throw errorNoEncontrado('Sub-pedido no encontrado.');
  return sub;
}

export async function listarSubPedidosVendedor({
  usuario,
  estado,
  pagina,
  porPagina,
}) {
  const where = {
    local: { usuarioId: usuario.id },
    ...(estado ? { estado } : {}),
  };

  const total = await prisma.subPedido.count({ where });
  const datos = await prisma.subPedido.findMany({
    where,
    include: INCLUIR_DETALLES,
    orderBy: { creadoEn: 'desc' },
    skip: (pagina - 1) * porPagina,
    take: porPagina,
  });

  return convertirBigIntAJson({
    datos: datos.map(serializarSubPedido),
    paginacion: {
      pagina,
      por_pagina: porPagina,
      total,
      paginas: Math.ceil(total / porPagina),
    },
  });
}

async function cambiarEstado({
  usuario,
  id,
  hacia,
  soloVendedor,
  datosExtra = {},
  entregaPor = null,
}) {
  const sub = await cargarSubPedido(id);

  const vendedor = esVendedorDelLocal(sub, usuario);
  const comprador = esCompradorDelPedido(sub, usuario);
  const admin = esAdmin(usuario);

  if (soloVendedor) {
    if (!vendedor && !admin) throw errorSinPermiso();
  } else if (!vendedor && !comprador && !admin) {
    throw errorSinPermiso();
  }

  exigirTransicion(sub.estado, hacia);

  return withTransaccion(async (tx) => {
    const actualizados = await tx.subPedido.updateMany({
      where: { id: sub.id, estado: sub.estado },
      data: {
        estado: hacia,
        ...datosExtra,
        ...(entregaPor ? { entregaConfirmadaPor: entregaPor } : {}),
      },
    });

    if (actualizados.count === 0) {
      throw new ErrorApi(
        'transicion_invalida',
        'El sub-pedido cambio de estado mientras se procesaba la solicitud.',
        409,
      );
    }

    await tx.historialEstadoSubPedido.create({
      data: {
        subPedidoId: sub.id,
        estadoAnterior: sub.estado,
        estadoNuevo: hacia,
        cambiadoPor: usuario.id,
      },
    });

    const pedido = await tx.pedido.findUnique({
      where: { id: sub.pedidoId },
      select: { estado: true },
    });

    const estados = await tx.subPedido.findMany({
      where: { pedidoId: sub.pedidoId },
      select: { estado: true },
    });

    const estadoDerivado = derivarEstadoPedido({
      estadoActual: pedido.estado,
      estadosSubPedidos: estados.map((fila) => fila.estado),
    });

    if (estadoDerivado !== pedido.estado) {
      await tx.pedido.update({
        where: { id: sub.pedidoId },
        data: { estado: estadoDerivado },
      });
    }

    const actualizado = await tx.subPedido.findUnique({
      where: { id: sub.id },
      include: INCLUIR_DETALLES,
    });

    return convertirBigIntAJson(serializarSubPedido(actualizado));
  });
}

export function aceptarSubPedido({ usuario, id }) {
  return cambiarEstado({
    usuario,
    id,
    hacia: 'preparando',
    soloVendedor: true,
  });
}

export function enviarSubPedido({ usuario, id, evidenciaEnvio }) {
  return cambiarEstado({
    usuario,
    id,
    hacia: 'enviado',
    soloVendedor: true,
    datosExtra: { evidenciaEnvio },
  });
}

export function entregarSubPedido({ usuario, id }) {
  // Se calcula quien confirma. Si el usuario es comprador y vendedor a la vez,
  // se registra comprador; el admin queda como sistema.
  return (async () => {
    const sub = await cargarSubPedido(id);
    const por = esCompradorDelPedido(sub, usuario)
      ? 'comprador'
      : esVendedorDelLocal(sub, usuario)
        ? 'vendedor'
        : 'sistema';

    return cambiarEstado({
      usuario,
      id,
      hacia: 'entregado',
      soloVendedor: false,
      datosExtra: { fechaEntrega: new Date() },
      entregaPor: por,
    });
  })();
}
