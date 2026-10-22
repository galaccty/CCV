import { prisma } from '../lib/prisma.js';
import { withTransaccion } from '../lib/transaccion.js';
import {
  convertirBigIntAJson,
  multiplicar,
  sumar,
} from '../lib/dinero.js';
import {
  ErrorApi,
  errorNoEncontrado,
} from '../lib/errores.js';
import {
  envolverLista,
  esquemaAbrirDisputa,
  esquemaAgregarEvidencia,
} from '../lib/validacion.js';
import { derivarEstadoPedido } from '../domain/estados.js';
import { serializarSubPedido } from './subPedidos.js';

/**
 * DISPUTAS Y EVIDENCIA (Etapa 4c-1)
 * =================================
 * Esta mitad registra la apertura y la evidencia. No congela saldo, no
 * resuelve y no escribe en el ledger: esos pasos son 4c-2.
 *
 * La apertura bloquea el sub-pedido con `FOR UPDATE`, valida que el comprador
 * sea el dueno y calcula `monto_reclamado` con los precios congelados de
 * `detalle_producto`. El cliente manda lineas y cantidades, nunca montos.
 *
 * El trigger de la base hace la ultima parte: pasa el sub-pedido a
 * `en_disputa` en la misma transaccion y guarda el estado anterior.
 */

const INCLUIR_DISPUTA = {
  subPedido: {
    include: {
      detalles: true,
      pedido: {
        select: {
          id: true,
          usuarioId: true,
          metodoPago: true,
        },
      },
      local: {
        select: {
          id: true,
          usuarioId: true,
          nombre: true,
        },
      },
    },
  },
  evidencias: {
    orderBy: [{ creadoEn: 'asc' }, { id: 'asc' }],
  },
};

export function serializarEvidencia(evidencia) {
  return {
    id: evidencia.id,
    disputa_id: evidencia.disputaId,
    usuario_id: evidencia.usuarioId,
    lado: evidencia.lado,
    tipo: evidencia.tipo,
    contenido: evidencia.contenido,
    creado_en: evidencia.creadoEn,
  };
}

export function serializarDisputa(disputa) {
  return {
    id: disputa.id,
    sub_pedido_id: disputa.subPedidoId,
    pedido_id: disputa.subPedido?.pedidoId ?? null,
    local_id: disputa.subPedido?.localId ?? null,
    usuario_id: disputa.usuarioId,
    tipo: disputa.tipo,
    motivo: disputa.motivo,
    estado: disputa.estado,
    monto_reclamado: disputa.montoReclamado,
    monto_congelado: disputa.montoCongelado,
    fecha_apertura: disputa.fechaApertura,
    fecha_resolucion: disputa.fechaResolucion,
    resuelto_por: disputa.resueltoPor,
    resolucion: disputa.resolucion,
    estado_sub_pedido_anterior: disputa.estadoSubPedidoAnterior,
    sub_pedido: disputa.subPedido
      ? serializarSubPedido(disputa.subPedido)
      : undefined,
    evidencias: (disputa.evidencias ?? []).map(serializarEvidencia),
  };
}

function esAdmin(usuario) {
  return usuario.roles?.includes('admin') ?? false;
}

function esComprador(disputa, usuario) {
  return disputa.subPedido.pedido.usuarioId === usuario.id;
}

function esVendedor(disputa, usuario) {
  return disputa.subPedido.local.usuarioId === usuario.id;
}

function exigirAcceso(disputa, usuario) {
  if (esAdmin(usuario) || esComprador(disputa, usuario) || esVendedor(disputa, usuario)) {
    return;
  }

  // 404 y no 403: no se revela que la disputa existe a quien no participa.
  throw errorNoEncontrado('Disputa no encontrada.');
}

async function cargarDisputa(id, tx = prisma) {
  const disputa = await tx.disputa.findUnique({
    where: { id },
    include: INCLUIR_DISPUTA,
  });

  if (!disputa) throw errorNoEncontrado('Disputa no encontrada.');
  return disputa;
}

async function sincronizarEstadoPedido(tx, pedidoId) {
  const pedido = await tx.pedido.findUnique({
    where: { id: pedidoId },
    select: { estado: true },
  });

  if (!pedido) return;

  const estados = await tx.subPedido.findMany({
    where: { pedidoId },
    select: { estado: true },
  });

  const estadoDerivado = derivarEstadoPedido({
    estadoActual: pedido.estado,
    estadosSubPedidos: estados.map((fila) => fila.estado),
  });

  if (estadoDerivado !== pedido.estado) {
    await tx.pedido.update({
      where: { id: pedidoId },
      data: { estado: estadoDerivado },
    });
  }
}

function traducirErrorDisputa(err) {
  if (err instanceof ErrorApi) return err;

  if (err?.code === 'P2002') {
    return new ErrorApi(
      'disputa_duplicada',
      'El sub-pedido ya tiene una disputa.',
      409,
    );
  }

  // Los triggers de PostgreSQL pueden llegar con codigos distintos segun la
  // operacion. El mensaje estable de la funcion es la senal que usamos.
  const mensaje = String(err?.message ?? '');

  if (mensaje.includes('sub_pedido_no_disputable')) {
    return new ErrorApi(
      'sub_pedido_no_disputable',
      'Solo se puede disputar un sub-pedido enviado o entregado.',
      409,
    );
  }

  if (mensaje.includes('sub_pedido_saldo_liberado')) {
    return new ErrorApi(
      'saldo_ya_liberado',
      'El saldo del sub-pedido ya fue liberado y la disputa ya no esta disponible.',
      409,
    );
  }

  if (mensaje.includes('disputa_cerrada')) {
    return new ErrorApi(
      'disputa_cerrada',
      'La disputa ya esta resuelta y no acepta mas evidencia.',
      409,
    );
  }

  if (mensaje.includes('disputa resuelta')) {
    return new ErrorApi(
      'disputa_cerrada',
      'La disputa ya esta resuelta y no se puede modificar.',
      409,
    );
  }

  return err;
}

export async function abrirDisputa({ usuario, subPedidoId, datos }) {
  const entrada = esquemaAbrirDisputa.parse(datos);

  try {
    return await withTransaccion(async (tx) => {
      const sub = await tx.subPedido.findUnique({
        where: { id: subPedidoId },
        include: {
          pedido: {
            select: {
              id: true,
              usuarioId: true,
              metodoPago: true,
            },
          },
          detalles: true,
        },
      });

      if (!sub) throw errorNoEncontrado('Sub-pedido no encontrado.');

      // El comprador solo puede abrir disputas de sus propios pedidos.
      if (sub.pedido.usuarioId !== usuario.id) {
        throw errorNoEncontrado('Sub-pedido no encontrado.');
      }

      // Bloquea la fila antes de calcular: dos aperturas simultaneas se
      // serializan aca y la segunda ve el estado ya cambiado por el trigger.
      const filas = await tx.$queryRaw`
        SELECT "estado"::text AS "estado",
               "saldo_liberado_en" AS "saldoLiberadoEn"
          FROM "sub_pedido"
         WHERE "id" = ${subPedidoId}
         FOR UPDATE
      `;

      if (filas.length === 0) {
        throw errorNoEncontrado('Sub-pedido no encontrado.');
      }

      const actual = filas[0];

      if (actual.saldoLiberadoEn !== null) {
        throw new ErrorApi(
          'saldo_ya_liberado',
          'El saldo del sub-pedido ya fue liberado y la disputa ya no esta disponible.',
          409,
        );
      }

      if (actual.estado === 'en_disputa') {
        throw new ErrorApi(
          'disputa_duplicada',
          'El sub-pedido ya tiene una disputa.',
          409,
        );
      }

      if (actual.estado !== 'enviado' && actual.estado !== 'entregado') {
        throw new ErrorApi(
          'sub_pedido_no_disputable',
          'Solo se puede disputar un sub-pedido enviado o entregado.',
          409,
        );
      }

      const detallesPorId = new Map(
        sub.detalles.map((detalle) => [detalle.id, detalle]),
      );

      let montoReclamado = 0n;

      for (const linea of entrada.lineas) {
        const detalle = detallesPorId.get(linea.detalle_id);

        if (!detalle) {
          throw new ErrorApi(
            'linea_no_pertenece',
            `La linea ${linea.detalle_id} no pertenece al sub-pedido.`,
            422,
            { detalle_id: linea.detalle_id },
          );
        }

        if (linea.cantidad > detalle.cantidad) {
          throw new ErrorApi(
            'cantidad_excede_linea',
            `La linea ${linea.detalle_id} solo tiene ${detalle.cantidad} unidades.`,
            422,
            {
              detalle_id: linea.detalle_id,
              cantidad: detalle.cantidad,
            },
          );
        }

        montoReclamado = sumar(
          montoReclamado,
          multiplicar(detalle.precioUnitario, BigInt(linea.cantidad)),
        );
      }

      const tipo = sub.pedido.metodoPago === 'efectivo' ? 'efectivo' : 'digital';

      const creada = await tx.disputa.create({
        data: {
          subPedidoId: sub.id,
          usuarioId: usuario.id,
          tipo,
          motivo: entrada.motivo,
          montoReclamado,
          montoCongelado: 0n,
          estadoSubPedidoAnterior: actual.estado,
        },
      });

      // El trigger ya paso el sub-pedido a en_disputa. El historial se escribe
      // en la misma transaccion para que la transicion quede auditada.
      await tx.historialEstadoSubPedido.create({
        data: {
          subPedidoId: sub.id,
          estadoAnterior: actual.estado,
          estadoNuevo: 'en_disputa',
          cambiadoPor: usuario.id,
        },
      });

      if (entrada.evidencia_inicial) {
        await tx.disputaEvidencia.create({
          data: {
            disputaId: creada.id,
            usuarioId: usuario.id,
            lado: 'comprador',
            tipo: entrada.evidencia_inicial.tipo,
            contenido: entrada.evidencia_inicial.contenido,
          },
        });
      }

      await sincronizarEstadoPedido(tx, sub.pedidoId);

      const completa = await tx.disputa.findUnique({
        where: { id: creada.id },
        include: INCLUIR_DISPUTA,
      });

      return convertirBigIntAJson(serializarDisputa(completa));
    });
  } catch (err) {
    throw traducirErrorDisputa(err);
  }
}

function resolverLado({ disputa, usuario, lado }) {
  if (lado === 'comprador') {
    if (!esComprador(disputa, usuario)) throw errorNoEncontrado('Disputa no encontrada.');
    return 'comprador';
  }

  if (lado === 'vendedor') {
    if (!esVendedor(disputa, usuario)) throw errorNoEncontrado('Disputa no encontrada.');
    return 'vendedor';
  }

  if (lado === 'admin') {
    if (!esAdmin(usuario)) throw errorNoEncontrado('Disputa no encontrada.');
    return 'admin';
  }

  if (esComprador(disputa, usuario)) return 'comprador';
  if (esVendedor(disputa, usuario)) return 'vendedor';
  if (esAdmin(usuario)) return 'admin';

  throw errorNoEncontrado('Disputa no encontrada.');
}

export async function agregarEvidencia({
  usuario,
  disputaId,
  datos,
  lado = null,
}) {
  const entrada = esquemaAgregarEvidencia.parse(datos);

  try {
    return await withTransaccion(async (tx) => {
      const disputa = await cargarDisputa(disputaId, tx);
      const ladoFinal = resolverLado({ disputa, usuario, lado });

      if (disputa.estado !== 'abierta') {
        throw new ErrorApi(
          'disputa_cerrada',
          'La disputa ya esta resuelta y no acepta mas evidencia.',
          409,
        );
      }

      const evidencia = await tx.disputaEvidencia.create({
        data: {
          disputaId: disputa.id,
          usuarioId: usuario.id,
          lado: ladoFinal,
          tipo: entrada.tipo,
          contenido: entrada.contenido,
        },
      });

      return convertirBigIntAJson(serializarEvidencia(evidencia));
    });
  } catch (err) {
    throw traducirErrorDisputa(err);
  }
}

export async function obtenerDisputa({ usuario, id }) {
  const disputa = await cargarDisputa(id);
  exigirAcceso(disputa, usuario);
  return convertirBigIntAJson(serializarDisputa(disputa));
}

function exigirLocalDelVendedor(localId, usuario) {
  return prisma.local.findFirst({
    where: { id: localId, usuarioId: usuario.id },
    select: { id: true },
  });
}

async function listarDisputas({
  where,
  pagina,
  porPagina,
}) {
  const total = await prisma.disputa.count({ where });
  const datos = await prisma.disputa.findMany({
    where,
    include: INCLUIR_DISPUTA,
    orderBy: [{ fechaApertura: 'desc' }, { id: 'desc' }],
    skip: (pagina - 1) * porPagina,
    take: porPagina,
  });

  return convertirBigIntAJson(
    envolverLista(
      datos.map(serializarDisputa),
      { pagina, porPagina },
      total,
    ),
  );
}

export async function listarDisputasComprador({
  usuario,
  estado,
  localId,
  pagina,
  porPagina,
}) {
  return listarDisputas({
    where: {
      subPedido: {
        pedido: { usuarioId: usuario.id },
        ...(localId ? { localId } : {}),
      },
      ...(estado ? { estado } : {}),
    },
    pagina,
    porPagina,
  });
}

export async function listarDisputasVendedor({
  usuario,
  estado,
  localId,
  pagina,
  porPagina,
}) {
  if (localId) {
    const local = await exigirLocalDelVendedor(localId, usuario);
    if (!local) throw errorNoEncontrado('Local no encontrado.');
  }

  return listarDisputas({
    where: {
      subPedido: {
        local: { usuarioId: usuario.id },
        ...(localId ? { localId } : {}),
      },
      ...(estado ? { estado } : {}),
    },
    pagina,
    porPagina,
  });
}

export async function listarDisputasAdmin({
  estado,
  localId,
  pagina,
  porPagina,
}) {
  return listarDisputas({
    where: {
      ...(estado ? { estado } : {}),
      ...(localId ? { subPedido: { localId } } : {}),
    },
    pagina,
    porPagina,
  });
}
