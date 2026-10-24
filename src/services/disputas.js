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
  esquemaProductoRecibido,
  esquemaResolverDisputa,
} from '../lib/validacion.js';
import { derivarEstadoPedido } from '../domain/estados.js';
import { serializarSubPedido } from './subPedidos.js';
import { completarEnTx } from './idempotencia.js';
import { registrarMovimiento } from './ledger.js';
import { crearEnTx, serializarReembolso } from './reembolsos.js';
import { devolverStock } from './stock.js';

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
  reembolso: {
    include: {
      lineas: {
        orderBy: [{ id: 'asc' }],
      },
    },
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
    reembolso: disputa.reembolso
      ? serializarReembolso(disputa.reembolso)
      : null,
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
    const destino = `${err?.meta?.target ?? ''} ${err?.message ?? ''}`;

    if (
      destino.includes('devolucion_stock') ||
      destino.includes('sub_pedido_id_detalle_id')
    ) {
      return new ErrorApi(
        'devolucion_duplicada',
        'La linea ya tiene registrada una devolucion de stock.',
        409,
      );
    }

    if (destino.includes('reembolso') || destino.includes('disputa_id')) {
      return new ErrorApi(
        'reembolso_duplicado',
        'La disputa ya tiene un reembolso asociado.',
        409,
      );
    }

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

  if (mensaje.includes('detalle_no_pertenece')) {
    return new ErrorApi(
      'linea_no_pertenece',
      'La linea no pertenece al sub-pedido.',
      422,
    );
  }

  if (mensaje.includes('cantidad_excede_linea')) {
    return new ErrorApi(
      'cantidad_excede_linea',
      'La cantidad devuelta supera las unidades compradas en la linea.',
      422,
    );
  }

  if (mensaje.includes('devolucion_stock_inmutable')) {
    return new ErrorApi(
      'devolucion_inmutable',
      'Una devolucion de stock registrada no se puede modificar ni borrar.',
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

async function bloquearSubPedido(tx, subPedidoId) {
  const filas = await tx.$queryRaw`
    SELECT "id"
      FROM "sub_pedido"
     WHERE "id" = ${subPedidoId}
     FOR UPDATE
  `;

  if (filas.length === 0) {
    throw errorNoEncontrado('Sub-pedido no encontrado.');
  }
}

async function montoCongeladoPendiente(tx, disputaId) {
  const [congelado, descongelado] = await Promise.all([
    tx.ledger.aggregate({
      where: { disputaId, tipo: 'congelacion' },
      _sum: { monto: true },
    }),
    tx.ledger.aggregate({
      where: { disputaId, tipo: 'descongelacion' },
      _sum: { monto: true },
    }),
  ]);

  return (
    (congelado._sum.monto ?? 0n) - (descongelado._sum.monto ?? 0n)
  );
}

async function descongelarDisputa(tx, disputa, sub) {
  const monto = await montoCongeladoPendiente(tx, disputa.id);
  if (monto <= 0n) return 0n;

  // El indice unico parcial deja una sola descongelacion por disputa. Si ya
  // existe, no se vuelve a asentar.
  const existente = await tx.ledger.findFirst({
    where: { disputaId: disputa.id, tipo: 'descongelacion' },
    select: { id: true },
  });
  if (existente) return 0n;

  await registrarMovimiento({
    tipo: 'descongelacion',
    monto,
    localId: sub.localId,
    subPedidoId: sub.id,
    disputaId: disputa.id,
  });

  return monto;
}

async function restaurarSubPedido({ tx, disputa, sub, adminId }) {
  const cambiados = await tx.subPedido.updateMany({
    where: { id: sub.id, estado: 'en_disputa' },
    data: { estado: disputa.estadoSubPedidoAnterior },
  });

  if (cambiados.count === 0) {
    throw new ErrorApi(
      'sub_pedido_no_en_disputa',
      'El sub-pedido ya no esta en disputa.',
      409,
    );
  }

  await tx.historialEstadoSubPedido.create({
    data: {
      subPedidoId: sub.id,
      estadoAnterior: 'en_disputa',
      estadoNuevo: disputa.estadoSubPedidoAnterior,
      cambiadoPor: adminId,
    },
  });
}

async function cancelarSubPedidoSinEntrega({ tx, sub, adminId }) {
  const cambiados = await tx.subPedido.updateMany({
    where: { id: sub.id, estado: 'en_disputa' },
    data: { estado: 'cancelado' },
  });

  if (cambiados.count === 0) {
    throw new ErrorApi(
      'sub_pedido_no_en_disputa',
      'El sub-pedido ya no esta en disputa.',
      409,
    );
  }

  await tx.historialEstadoSubPedido.create({
    data: {
      subPedidoId: sub.id,
      estadoAnterior: 'en_disputa',
      estadoNuevo: 'cancelado',
      cambiadoPor: adminId,
    },
  });
}

async function devolverStockDeDetalles({
  tx,
  sub,
  detalles,
  origen,
  adminId,
}) {
  for (const detalle of detalles) {
    await tx.devolucionStock.create({
      data: {
        subPedidoId: sub.id,
        detalleId: detalle.id,
        cantidad: detalle.cantidad,
        origen,
        registradoPor: adminId,
      },
    });

    await devolverStock(tx, detalle.varianteId, detalle.cantidad);
  }
}

function serializarDevolucionStock(devolucion) {
  return {
    id: devolucion.id,
    detalle_id: devolucion.detalleId,
    variante_id: devolucion.detalle?.varianteId ?? null,
    cantidad: devolucion.cantidad,
    origen: devolucion.origen,
    registrado_en: devolucion.creadoEn,
  };
}

async function cargarDevoluciones(tx, subPedidoId) {
  return tx.devolucionStock.findMany({
    where: { subPedidoId },
    include: {
      detalle: {
        select: { varianteId: true },
      },
    },
    orderBy: [{ id: 'asc' }],
  });
}

function respuestaProductoRecibido(subPedidoId, devoluciones) {
  return convertirBigIntAJson({
    sub_pedido_id: subPedidoId,
    productos: devoluciones.map(serializarDevolucionStock),
  });
}

/**
 * Resuelve una disputa abierta. Bloquea primero el sub-pedido y despues la
 * disputa, en el mismo orden que usa la apertura, para que dos resoluciones
 * concurrentes se serialicen y solo una gane.
 */
export async function resolverDisputa({
  disputaId,
  admin = null,
  datos,
  idempotenciaId = null,
  ahora = new Date(),
}) {
  const entrada = esquemaResolverDisputa.parse(datos);
  const resolucion = entrada.resolucion ?? entrada.motivo;

  try {
    return await withTransaccion(async (tx) => {
      const inicial = await tx.disputa.findUnique({
        where: { id: disputaId },
        select: { subPedidoId: true },
      });

      if (!inicial) throw errorNoEncontrado('Disputa no encontrada.');

      await bloquearSubPedido(tx, inicial.subPedidoId);

      const filas = await tx.$queryRaw`
        SELECT "id"
          FROM "disputa"
         WHERE "id" = ${disputaId}
         FOR UPDATE
      `;

      if (filas.length === 0) {
        throw errorNoEncontrado('Disputa no encontrada.');
      }

      const disputa = await tx.disputa.findUnique({
        where: { id: disputaId },
        include: INCLUIR_DISPUTA,
      });

      if (!disputa) throw errorNoEncontrado('Disputa no encontrada.');

      if (disputa.estado !== 'abierta') {
        throw new ErrorApi(
          'disputa_cerrada',
          'La disputa ya esta resuelta y no se puede volver a resolver.',
          409,
        );
      }

      const sub = disputa.subPedido;

      if (!sub || sub.estado !== 'en_disputa') {
        throw new ErrorApi(
          'sub_pedido_no_en_disputa',
          'El sub-pedido ya no esta en disputa.',
          409,
        );
      }

      let estadoSubPedido = 'en_disputa';
      let montoCongelado = undefined;
      let reembolso = null;

      if (entrada.favor === 'vendedor') {
        await restaurarSubPedido({
          tx,
          disputa,
          sub,
          adminId: admin?.id ?? null,
        });

        const descongelado = await descongelarDisputa(tx, disputa, sub);
        if (descongelado > 0n) montoCongelado = 0n;
        estadoSubPedido = disputa.estadoSubPedidoAnterior;
      } else {
        // Un sub-pedido entregado puede llegar sin `fecha_entrega` en datos
        // antiguos o de prueba. El estado anterior que guardo la apertura es
        // la senal mas estable de si hubo entrega.
        const sinEntrega =
          !sub.fechaEntrega && disputa.estadoSubPedidoAnterior !== 'entregado';
        let lineas;

        if (sinEntrega) {
          // Sin entrega se reembolsa todo, sin importar el subconjunto que
          // haya pedido el admin en el cuerpo.
          lineas = sub.detalles.map((detalle) => ({
            detalle_id: detalle.id,
            cantidad: detalle.cantidad,
          }));
        } else {
          if (!entrada.lineas?.length) {
            throw new ErrorApi(
              'lineas_requeridas',
              'Para reembolsar un sub-pedido entregado hay que aprobar al menos una linea.',
              422,
            );
          }
          if (entrada.incluye_envio) {
            throw new ErrorApi(
              'envio_no_reembolsable',
              'El envio no se reembolsa si el sub-pedido ya fue entregado.',
              422,
            );
          }
          lineas = entrada.lineas;
        }

        reembolso = await crearEnTx({
          tx,
          subPedidoId: sub.id,
          entrada: {
            motivo: `Resolucion de disputa #${disputa.id}`,
            lineas,
            incluye_envio: sinEntrega || entrada.incluye_envio,
          },
          disputaId: disputa.id,
          registradoPor: admin?.id ?? null,
          ahora,
        });

        if (sinEntrega) {
          await cancelarSubPedidoSinEntrega({
            tx,
            sub,
            adminId: admin?.id ?? null,
          });

          await devolverStockDeDetalles({
            tx,
            sub,
            detalles: sub.detalles,
            origen: 'disputa_sin_entrega',
            adminId: admin?.id ?? null,
          });

          estadoSubPedido = 'cancelado';
        } else {
          const congelado = await tx.ledger.aggregate({
            where: { reembolsoId: reembolso.id, tipo: 'congelacion' },
            _sum: { monto: true },
          });
          const monto = congelado._sum.monto ?? 0n;
          if (monto > 0n) montoCongelado = monto;
        }
      }

      const actualizada = await tx.disputa.updateMany({
        where: { id: disputa.id, estado: 'abierta' },
        data: {
          estado:
            entrada.favor === 'vendedor'
              ? 'resuelta_vendedor'
              : 'resuelta_comprador',
          fechaResolucion: ahora,
          resueltoPor: admin?.id ?? null,
          resolucion,
          ...(montoCongelado !== undefined ? { montoCongelado } : {}),
        },
      });

      if (actualizada.count === 0) {
        throw new ErrorApi(
          'disputa_cerrada',
          'Otro proceso ya resolvio esta disputa.',
          409,
        );
      }

      await sincronizarEstadoPedido(tx, sub.pedidoId);

      await tx.auditoriaAdmin.create({
        data: {
          origen: admin ? 'admin' : 'sistema',
          adminId: admin?.id ?? null,
          accion: 'resolver_disputa',
          objeto: 'disputa',
          objetoId: String(disputa.id),
          detalle: {
            favor: entrada.favor,
            sub_pedido_id: sub.id,
            estado_sub_pedido: estadoSubPedido,
            reembolso_id: reembolso?.id ?? null,
            monto: reembolso ? reembolso.monto.toString() : '0',
          },
        },
      });

      const final = await tx.disputa.findUnique({
        where: { id: disputa.id },
        include: INCLUIR_DISPUTA,
      });

      const respuesta = convertirBigIntAJson(serializarDisputa(final));
      await completarEnTx(tx, idempotenciaId, 200, respuesta);
      return respuesta;
    });
  } catch (err) {
    throw traducirErrorDisputa(err);
  }
}

/**
 * Confirma que el admin recibio el producto de una disputa resuelta a favor
 * del comprador. Devuelve stock una sola vez por linea; el UNIQUE de
 * `devolucion_stock` es la ultima barrera contra dos confirmaciones.
 */
export async function registrarProductoRecibido({
  subPedidoId,
  admin = null,
  datos = {},
  idempotenciaId = null,
}) {
  const entrada = esquemaProductoRecibido.parse(datos);

  try {
    return await withTransaccion(async (tx) => {
      await bloquearSubPedido(tx, subPedidoId);

      const sub = await tx.subPedido.findUnique({
        where: { id: subPedidoId },
        include: {
          detalles: true,
          disputa: {
            include: {
              reembolso: {
                include: {
                  lineas: true,
                },
              },
            },
          },
        },
      });

      if (!sub) throw errorNoEncontrado('Sub-pedido no encontrado.');

      const disputa = sub.disputa;
      if (!disputa || disputa.estado !== 'resuelta_comprador') {
        throw new ErrorApi(
          'disputa_no_comprador',
          'El producto solo se puede devolver en una disputa resuelta a favor del comprador.',
          409,
        );
      }

      const existentes = await cargarDevoluciones(tx, sub.id);

      const sinEntrega =
        !sub.fechaEntrega && disputa.estadoSubPedidoAnterior !== 'entregado';

      if (sinEntrega) {
        if (existentes.length === 0) {
          throw new ErrorApi(
            'producto_sin_entrega',
            'La disputa sin entrega ya devolvio el stock al resolverla.',
            409,
          );
        }

        const respuesta = respuestaProductoRecibido(sub.id, existentes);
        await completarEnTx(tx, idempotenciaId, 200, respuesta);
        return respuesta;
      }

      const reembolso = disputa.reembolso;
      if (!reembolso) {
        throw new ErrorApi(
          'reembolso_no_encontrado',
          'La disputa no tiene un reembolso asociado.',
          409,
        );
      }

      const lineasReembolso = new Map(
        reembolso.lineas.map((linea) => [linea.detalleId, linea]),
      );
      const detalles = new Map(sub.detalles.map((detalle) => [detalle.id, detalle]));
      const yaDevueltas = new Map(
        existentes.map((devolucion) => [devolucion.detalleId, devolucion]),
      );

      const solicitadas = entrada.lineas?.length
        ? entrada.lineas
        : reembolso.lineas.map((linea) => ({
            detalle_id: linea.detalleId,
            cantidad: linea.cantidad,
          }));

      const nuevos = [];

      for (const item of solicitadas) {
        const linea = lineasReembolso.get(item.detalle_id);
        if (!linea) {
          throw new ErrorApi(
            'linea_no_reembolsada',
            `La linea ${item.detalle_id} no forma parte del reembolso aprobado.`,
            422,
            { detalle_id: item.detalle_id },
          );
        }

        const cantidad = item.cantidad ?? linea.cantidad;
        if (cantidad !== linea.cantidad) {
          throw new ErrorApi(
            'cantidad_no_coincide',
            `La linea ${item.detalle_id} debe devolverse completa (${linea.cantidad} unidades) una sola vez.`,
            422,
            {
              detalle_id: item.detalle_id,
              cantidad: linea.cantidad,
            },
          );
        }

        const existente = yaDevueltas.get(item.detalle_id);
        if (existente) {
          if (existente.cantidad !== cantidad) {
            throw new ErrorApi(
              'linea_ya_devuelta',
              `La linea ${item.detalle_id} ya fue devuelta con otra cantidad.`,
              409,
              { detalle_id: item.detalle_id },
            );
          }
          continue;
        }

        const detalle = detalles.get(item.detalle_id);
        if (!detalle) {
          throw new ErrorApi(
            'linea_no_pertenece',
            `La linea ${item.detalle_id} no pertenece al sub-pedido.`,
            422,
            { detalle_id: item.detalle_id },
          );
        }

        const creada = await tx.devolucionStock.create({
          data: {
            subPedidoId: sub.id,
            detalleId: detalle.id,
            cantidad,
            origen: 'producto_recibido',
            registradoPor: admin?.id ?? null,
          },
          include: {
            detalle: {
              select: { varianteId: true },
            },
          },
        });

        await devolverStock(tx, detalle.varianteId, cantidad);
        nuevos.push(creada);
      }

      if (nuevos.length > 0) {
        await tx.auditoriaAdmin.create({
          data: {
            origen: admin ? 'admin' : 'sistema',
            adminId: admin?.id ?? null,
            accion: 'producto_recibido',
            objeto: 'sub_pedido',
            objetoId: String(sub.id),
            detalle: {
              disputa_id: disputa.id,
              reembolso_id: reembolso.id,
              lineas: nuevos.map((devolucion) => ({
                detalle_id: devolucion.detalleId,
                cantidad: devolucion.cantidad,
              })),
            },
          },
        });
      }

      const devoluciones = await cargarDevoluciones(tx, sub.id);
      const respuesta = respuestaProductoRecibido(sub.id, devoluciones);
      await completarEnTx(tx, idempotenciaId, 200, respuesta);
      return respuesta;
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
