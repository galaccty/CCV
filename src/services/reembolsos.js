import { prisma } from '../lib/prisma.js';
import { withTransaccion } from '../lib/transaccion.js';
import {
  aBigInt,
  convertirBigIntAJson,
  dividirRedondeando,
  multiplicar,
  porcentajeABasisPuntos,
  restar,
  sumar,
} from '../lib/dinero.js';
import { ErrorApi, errorNoEncontrado } from '../lib/errores.js';
import { logger } from '../lib/logger.js';
import { esquemaCrearReembolso } from '../lib/validacion.js';
import { derivarEstadoPedido } from '../domain/estados.js';
import { obtenerConfiguracionEnTransaccion } from './configuracion.js';
import { recalcularEstadoLocal } from './estadoLocal.js';
import { completarEnTx } from './idempotencia.js';
import { registrarMovimiento } from './ledger.js';

/**
 * REEMBOLSOS POR LINEA (Etapa 4c-2a)
 * ==================================
 * El backend calcula todo monto con `detalle_producto.precio_unitario`; el
 * cliente solo elige lineas y cantidades. El envio se incluye unicamente si el
 * sub-pedido no tiene fecha de entrega.
 *
 * Un reembolso nace `pendiente`. Mientras lo esta, bloquea la liberacion del
 * saldo. Si el saldo ya estaba liberado, la creacion congela lo que alcance de
 * `saldo_por_pagar`; si el saldo no alcanza, el resto quedara como deuda al
 * completarse.
 *
 * Completar es idempotente a nivel de estado: un UPDATE condicionado a
 * `pendiente` decide quien gana. El ganador escribe los asientos del ledger en
 * la misma transaccion. Fallar descongela y alerta, sin tocar el pago.
 *
 * Si el saldo aun no fue liberado, se registran el reembolso y la reversa de
 * comision de plataforma; el asiento local, la comision del vendedor y el
 * redondeo quedan diferidos a la liberacion (Etapa 4d).
 */

const INCLUIR_REEMBOLSO = {
  lineas: {
    orderBy: [{ id: 'asc' }],
  },
  pago: {
    select: {
      id: true,
      monto: true,
      montoReembolsado: true,
      estado: true,
    },
  },
  subPedido: {
    include: {
      detalles: true,
      pedido: {
        select: {
          id: true,
          estado: true,
          metodoPago: true,
          configSnapshot: true,
        },
      },
    },
  },
};

export function serializarReembolso(reembolso) {
  return {
    id: reembolso.id,
    pago_id: reembolso.pagoId,
    sub_pedido_id: reembolso.subPedidoId,
    disputa_id: reembolso.disputaId,
    tipo: reembolso.tipo,
    monto: reembolso.monto,
    monto_envio: reembolso.montoEnvio,
    incluye_envio: reembolso.incluyeEnvio,
    desde_congelado: reembolso.desdeCongelado,
    estado: reembolso.estado,
    motivo: reembolso.motivo,
    fecha: reembolso.fecha,
    fecha_limite: reembolso.fechaLimite,
    registrado_por: reembolso.registradoPor,
    completado_en: reembolso.completadoEn,
    actualizado_en: reembolso.actualizadoEn,
    lineas: (reembolso.lineas ?? []).map((linea) => ({
      id: linea.id,
      reembolso_id: linea.reembolsoId,
      detalle_id: linea.detalleId,
      cantidad: linea.cantidad,
      monto: linea.monto,
    })),
  };
}

function errorLinea(mensaje, codigo = 'linea_reembolso_invalida') {
  return new ErrorApi(codigo, mensaje, 422);
}

function bloquearSubPedido(tx, subPedidoId) {
  return tx.$queryRaw`
    SELECT "id"
      FROM "sub_pedido"
     WHERE "id" = ${subPedidoId}
     FOR UPDATE
  `;
}

async function cargarSubPedido(tx, subPedidoId) {
  const filas = await bloquearSubPedido(tx, subPedidoId);
  if (filas.length === 0) throw errorNoEncontrado('Sub-pedido no encontrado.');

  const sub = await tx.subPedido.findUnique({
    where: { id: subPedidoId },
    include: {
      detalles: true,
      pedido: {
        select: {
          id: true,
          estado: true,
          metodoPago: true,
          configSnapshot: true,
        },
      },
      local: { select: { id: true } },
    },
  });

  if (!sub) throw errorNoEncontrado('Sub-pedido no encontrado.');
  return sub;
}

async function cantidadesReembolsadas(tx, detalleIds) {
  if (detalleIds.length === 0) return new Map();

  const filas = await tx.reembolsoLinea.groupBy({
    by: ['detalleId'],
    where: {
      detalleId: { in: detalleIds },
      reembolso: { estado: { in: ['pendiente', 'completado'] } },
    },
    _sum: { cantidad: true },
  });

  return new Map(
    filas.map((fila) => [fila.detalleId, fila._sum.cantidad ?? 0]),
  );
}

async function bloquearCuenta(tx, localId) {
  // No se crea ni modifica la cuenta aqui: el invariante 1 reserva esas
  // escrituras para el servicio del ledger. Si el saldo fue liberado, la
  // cuenta ya existe.
  const filas = await tx.$queryRaw`
    SELECT "saldo_por_pagar" AS "saldoPorPagar",
           "saldo_congelado" AS "saldoCongelado",
           "saldo_deuda" AS "saldoDeuda"
      FROM "cuenta_local"
     WHERE "local_id" = ${localId}
     FOR UPDATE
  `;

  if (filas.length === 0) {
    throw new Error(`No existe la cuenta del local ${localId}.`);
  }

  return {
    saldoPorPagar: aBigInt(filas[0].saldoPorPagar, 'saldo_por_pagar'),
    saldoCongelado: aBigInt(filas[0].saldoCongelado, 'saldo_congelado'),
    saldoDeuda: aBigInt(filas[0].saldoDeuda, 'saldo_deuda'),
  };
}

async function montoCongeladoDelReembolso(tx, reembolsoId) {
  const filas = await tx.$queryRaw`
    SELECT COALESCE(
             SUM(
               CASE
                 WHEN "tipo" = 'congelacion' THEN "monto"
                 WHEN "tipo" = 'descongelacion' THEN -"monto"
                 ELSE 0
               END
             ),
             0
           )::bigint AS "total"
      FROM "ledger"
     WHERE "reembolso_id" = ${reembolsoId}
       AND "tipo" IN ('congelacion', 'descongelacion')
  `;

  return aBigInt(filas[0]?.total ?? 0, 'monto_congelado');
}

async function calcularComisionObjetivo(tx, sub) {
  const config = sub.pedido?.configSnapshot ?? {};
  const porcentaje = config.porcentaje_comision ?? 0;
  const comisionMinima = aBigInt(config.comision_minima ?? 0, 'comision_minima');

  const lineas = await tx.reembolsoLinea.aggregate({
    where: {
      reembolso: {
        subPedidoId: sub.id,
        estado: 'completado',
      },
    },
    _sum: { monto: true },
  });

  const reembolsadoProductos = lineas._sum.monto ?? 0n;
  const restante = restar(sub.subtotalProductos, reembolsadoProductos);
  const subtotalRestante = restante > 0n ? restante : 0n;

  const [reversasLocal, reversasPlataforma] = await Promise.all([
    tx.ledger.aggregate({
      where: {
        subPedidoId: sub.id,
        localId: sub.localId,
        tipo: 'reversa_comision',
      },
      _sum: { monto: true },
    }),
    tx.ledger.aggregate({
      where: {
        subPedidoId: sub.id,
        localId: null,
        tipo: 'reversa_comision',
      },
      _sum: { monto: true },
    }),
  ]);

  const comisionNetaLocal = restar(
    sub.comision,
    reversasLocal._sum.monto ?? 0n,
  );
  const comisionNetaPlataforma = restar(
    sub.comision,
    reversasPlataforma._sum.monto ?? 0n,
  );

  let comisionObjetivo = 0n;
  if (subtotalRestante > 0n) {
    const basisPuntos = BigInt(porcentajeABasisPuntos(porcentaje));
    const proporcional = dividirRedondeando(
      multiplicar(subtotalRestante, basisPuntos),
      10000n,
    );
    comisionObjetivo =
      proporcional > comisionMinima ? proporcional : comisionMinima;
  }

  const diferenciaLocal = restar(comisionNetaLocal, comisionObjetivo);
  const diferenciaPlataforma = restar(
    comisionNetaPlataforma,
    comisionObjetivo,
  );

  return {
    comisionObjetivo,
    comisionNetaActual: comisionNetaLocal,
    reversa: diferenciaLocal > 0n ? diferenciaLocal : 0n,
    reversaPlataforma:
      diferenciaPlataforma > 0n ? diferenciaPlataforma : 0n,
    ajuste: diferenciaLocal < 0n ? -diferenciaLocal : 0n,
    reembolsadoProductos,
    subtotalRestante,
  };
}

async function aplicarRevisionComision(
  tx,
  sub,
  reembolso,
  { actualizarLocal, actualizarPlataforma },
) {
  const calculo = await calcularComisionObjetivo(tx, sub);

  // La plataforma solo reconoce ingreso por comision en pagos digitales. Su
  // reversa es independiente de que el saldo del vendedor ya se haya liberado:
  // reduce el ingreso neto en la misma fecha del reembolso.
  if (actualizarPlataforma && calculo.reversaPlataforma > 0n) {
    await registrarMovimiento({
      tipo: 'reversa_comision',
      monto: calculo.reversaPlataforma,
      subPedidoId: sub.id,
      reembolsoId: reembolso.id,
      pagoId: reembolso.pagoId,
    });
  }

  // En efectivo la comision vive como deuda del vendedor. En digital, el
  // reverso local se difiere hasta la liberacion si el saldo aun no salio.
  if (actualizarLocal && calculo.reversa > 0n) {
    await registrarMovimiento({
      tipo: 'reversa_comision',
      monto: calculo.reversa,
      localId: sub.localId,
      subPedidoId: sub.id,
      reembolsoId: reembolso.id,
    });
  }

  // Si una reversa anterior dejo la comision neta por debajo del objetivo, la
  // diferencia exacta se corrige con ajuste de redondeo.
  if (actualizarLocal && calculo.ajuste > 0n) {
    const enEfectivo = reembolso.tipo === 'efectivo';
    await registrarMovimiento({
      tipo: 'ajuste_redondeo',
      monto: calculo.ajuste,
      localId: sub.localId,
      subPedidoId: sub.id,
      reembolsoId: reembolso.id,
      direccion: 'debito',
      cuentaAjuste: enEfectivo ? 'saldoDeuda' : 'saldoPorPagar',
    });
  }

  return calculo;
}

function lineasConPrecio(sub, lineas) {
  const porId = new Map(sub.detalles.map((detalle) => [detalle.id, detalle]));

  return lineas.map((linea) => {
    const detalle = porId.get(linea.detalle_id);
    if (!detalle) {
      throw errorLinea(
        `La linea ${linea.detalle_id} no pertenece al sub-pedido.`,
        'linea_no_pertenece',
      );
    }

    const cantidad = linea.cantidad;
    return {
      detalle,
      cantidad,
      monto: multiplicar(detalle.precioUnitario, cantidad),
    };
  });
}

export async function crearEnTx({
  tx,
  subPedidoId,
  entrada,
  disputaId = null,
  registradoPor = null,
  ahora = new Date(),
}) {
  const sub = await cargarSubPedido(tx, subPedidoId);
  const detalles = lineasConPrecio(sub, entrada.lineas);
  const ids = detalles.map((item) => item.detalle.id);
  const reembolsadas = await cantidadesReembolsadas(tx, ids);

  for (const item of detalles) {
    const consumida = reembolsadas.get(item.detalle.id) ?? 0;
    if (item.cantidad + consumida > item.detalle.cantidad) {
      throw errorLinea(
        `La cantidad de la linea ${item.detalle.id} supera lo que queda por reembolsar.`,
        'cantidad_excede_linea',
      );
    }
  }

  if (
    entrada.incluye_envio &&
    (sub.fechaEntrega || sub.estado === 'entregado')
  ) {
    throw errorLinea(
      'El envio no se reembolsa si el pedido ya fue entregado.',
      'envio_no_reembolsable',
    );
  }

  const montoProductos = detalles.reduce(
    (total, item) => total + item.monto,
    0n,
  );
  const montoEnvio = entrada.incluye_envio
    ? aBigInt(sub.costoEnvio, 'costo_envio')
    : 0n;
  const monto = sumar(montoProductos, montoEnvio);

  if (monto <= 0n) {
    throw errorLinea(
      'El reembolso calculado debe ser mayor que cero.',
      'reembolso_sin_monto',
    );
  }

  const pago = await tx.pago.findUnique({
    where: { pedidoId: sub.pedidoId },
  });

  if (!pago) {
    throw new ErrorApi(
      'pago_no_encontrado',
      'El pedido no tiene un pago asociado.',
      409,
    );
  }

  if (!['aprobado', 'reembolsado_parcial', 'reembolsado'].includes(pago.estado)) {
    throw new ErrorApi(
      'pago_no_reembolsable',
      'El pago no esta aprobado; no se puede reembolsar.',
      409,
    );
  }

  const yaReembolsado = await tx.reembolso.aggregate({
    where: { pagoId: pago.id },
    _sum: { monto: true },
  });

  if (sumar(yaReembolsado._sum.monto ?? 0n, monto) > pago.monto) {
    throw errorLinea(
      `El reembolso supera el monto cobrado del pago (${pago.monto} pesos).`,
      'reembolso_excede_pago',
    );
  }

  if (disputaId) {
    const disputa = await tx.disputa.findUnique({
      where: { id: disputaId },
      select: { subPedidoId: true },
    });

    if (!disputa || disputa.subPedidoId !== sub.id) {
      throw errorLinea(
        'La disputa no pertenece al sub-pedido.',
        'disputa_no_pertenece',
      );
    }
  }

  const tipo = pago.metodoPago === 'efectivo' ? 'efectivo' : 'digital';
  let fechaLimite = null;

  if (tipo === 'efectivo') {
    const config = await obtenerConfiguracionEnTransaccion(tx, [
      'dias_reembolso_efectivo',
    ]);
    const dias = Number(config.dias_reembolso_efectivo ?? 5);
    fechaLimite = new Date(ahora);
    fechaLimite.setUTCDate(
      fechaLimite.getUTCDate() + (Number.isFinite(dias) ? dias : 5),
    );
  }

  const reembolso = await tx.reembolso.create({
    data: {
      pagoId: pago.id,
      subPedidoId: sub.id,
      disputaId,
      tipo,
      monto,
      montoEnvio,
      incluyeEnvio: entrada.incluye_envio,
      estado: 'pendiente',
      motivo: entrada.motivo,
      fechaLimite,
      registradoPor,
    },
  });

  await tx.reembolsoLinea.createMany({
    data: detalles.map((item) => ({
      reembolsoId: reembolso.id,
      detalleId: item.detalle.id,
      cantidad: item.cantidad,
      monto: item.monto,
    })),
  });

  // El saldo liberado pero no pagado se congela mientras el reembolso esta
  // pendiente. Si no alcanza, se congela lo disponible y el resto sera deuda
  // al completar. `desde_congelado` indica que el pago local sale de ahi.
  if (tipo === 'digital' && sub.saldoLiberadoEn) {
    const cuenta = await bloquearCuenta(tx, sub.localId);
    const congelar =
      cuenta.saldoPorPagar < monto ? cuenta.saldoPorPagar : monto;

    if (congelar > 0n) {
      await registrarMovimiento({
        tipo: 'congelacion',
        monto: congelar,
        localId: sub.localId,
        subPedidoId: sub.id,
        reembolsoId: reembolso.id,
        disputaId,
      });

      await tx.reembolso.update({
        where: { id: reembolso.id },
        data: { desdeCongelado: true },
      });
    }
  }

  return tx.reembolso.findUnique({
    where: { id: reembolso.id },
    include: INCLUIR_REEMBOLSO,
  });
}

export async function crearReembolso({
  subPedidoId,
  datos,
  registradoPor = null,
  idempotenciaId = null,
}) {
  const entrada = esquemaCrearReembolso.parse(datos);

  try {
    return await withTransaccion(async (tx) => {
      const reembolso = await crearEnTx({
        tx,
        subPedidoId,
        entrada,
        disputaId: entrada.disputa_id ?? null,
        registradoPor,
      });

      const respuesta = convertirBigIntAJson(
        serializarReembolso(reembolso),
      );
      await completarEnTx(tx, idempotenciaId, 201, respuesta);
      return respuesta;
    });
  } catch (err) {
    throw traducirErrorReembolso(err);
  }
}

async function actualizarEstadoSubPedido(tx, sub, adminId) {
  const lineas = await tx.reembolsoLinea.aggregate({
    where: {
      reembolso: {
        subPedidoId: sub.id,
        estado: 'completado',
      },
    },
    _sum: { monto: true },
  });

  const reembolsado = lineas._sum.monto ?? 0n;

  // Un sub-pedido cancelado (por ejemplo, una disputa sin entrega) sigue
  // cancelado al completarse el reembolso: el reembolso explica el dinero,
  // pero no revive un pedido que nunca se entrego.
  if (sub.estado === 'cancelado') {
    return { reembolsado, estadoNuevo: 'cancelado' };
  }

  const estadoNuevo =
    reembolsado >= sub.subtotalProductos
      ? 'reembolsado'
      : 'reembolsado_parcial';

  if (sub.estado === estadoNuevo) return { reembolsado, estadoNuevo };

  await tx.historialEstadoSubPedido.create({
    data: {
      subPedidoId: sub.id,
      estadoAnterior: sub.estado,
      estadoNuevo,
      cambiadoPor: adminId,
    },
  });

  await tx.subPedido.update({
    where: { id: sub.id },
    data: { estado: estadoNuevo },
  });

  return { reembolsado, estadoNuevo };
}

async function sincronizarEstadoPedido(tx, pedidoId) {
  const pedido = await tx.pedido.findUnique({
    where: { id: pedidoId },
    select: { id: true, estado: true },
  });

  if (!pedido || pedido.estado === 'expirado') return;

  if (pedido.estado === 'reembolso_pendiente') {
    const pendientes = await tx.reembolso.count({
      where: {
        subPedido: { pedidoId },
        estado: 'pendiente',
      },
    });
    if (pendientes > 0) return;
  }

  const subPedidos = await tx.subPedido.findMany({
    where: { pedidoId },
    select: { estado: true },
  });

  const estadoNuevo = derivarEstadoPedido({
    estadoActual:
      pedido.estado === 'reembolso_pendiente' ? 'en_proceso' : pedido.estado,
    estadosSubPedidos: subPedidos.map((sub) => sub.estado),
  });

  if (estadoNuevo !== pedido.estado) {
    await tx.pedido.update({
      where: { id: pedidoId },
      data: { estado: estadoNuevo },
    });
  }
}

async function sincronizarPago(tx, pagoId) {
  const pago = await tx.pago.findUnique({
    where: { id: pagoId },
    select: { id: true, monto: true },
  });

  if (!pago) throw errorNoEncontrado('Pago no encontrado.');

  const completados = await tx.reembolso.aggregate({
    where: { pagoId, estado: 'completado' },
    _sum: { monto: true },
  });

  const total = completados._sum.monto ?? 0n;
  await tx.pago.update({
    where: { id: pagoId },
    data: {
      montoReembolsado: total,
      estado: total >= pago.monto ? 'reembolsado' : 'reembolsado_parcial',
    },
  });

  return total;
}

export async function completarReembolso({
  reembolsoId,
  admin = null,
  idempotenciaId = null,
  ahora = new Date(),
}) {
  try {
    return await withTransaccion(async (tx) => {
      const filas = await tx.$queryRaw`
        SELECT "id"
          FROM "reembolso"
         WHERE "id" = ${reembolsoId}
         FOR UPDATE
      `;

      if (filas.length === 0) {
        throw errorNoEncontrado('Reembolso no encontrado.');
      }

      const reembolso = await tx.reembolso.findUnique({
        where: { id: reembolsoId },
        include: INCLUIR_REEMBOLSO,
      });

      if (!reembolso) throw errorNoEncontrado('Reembolso no encontrado.');

      if (reembolso.estado !== 'pendiente') {
        throw new ErrorApi(
          'reembolso_no_pendiente',
          'El reembolso ya no esta pendiente.',
          409,
        );
      }

      await bloquearSubPedido(tx, reembolso.subPedidoId);

      const actualizado = await tx.reembolso.updateMany({
        where: { id: reembolsoId, estado: 'pendiente' },
        data: {
          estado: 'completado',
          completadoEn: ahora,
          registradoPor: admin?.id ?? reembolso.registradoPor,
        },
      });

      if (actualizado.count === 0) {
        throw new ErrorApi(
          'reembolso_no_pendiente',
          'Otro proceso ya completo este reembolso.',
          409,
        );
      }

      const sub = await tx.subPedido.findUnique({
        where: { id: reembolso.subPedidoId },
        include: {
          detalles: true,
          pedido: {
            select: {
              id: true,
              estado: true,
              metodoPago: true,
              configSnapshot: true,
            },
          },
        },
      });

      if (!sub) throw errorNoEncontrado('Sub-pedido no encontrado.');

      // El reembolso de plataforma se registra siempre en digital, aunque el
      // saldo del vendedor aun no se haya liberado. En efectivo el vendedor
      // devuelve el dinero directamente y no hay salida de la plataforma.
      if (reembolso.tipo === 'digital') {
        await registrarMovimiento({
          tipo: 'reembolso',
          monto: reembolso.monto,
          pagoId: reembolso.pagoId,
          reembolsoId: reembolso.id,
          subPedidoId: sub.id,
          disputaId: reembolso.disputaId,
        });
      }

      if (reembolso.tipo === 'digital' && sub.saldoLiberadoEn) {
        // Descongelamos primero lo retenido para que la misma bolsa pague el
        // reembolso. Luego la reversa de comision se acredita y se netea
        // contra el monto pendiente: asi no quedan deuda y disponible al
        // mismo tiempo por el mismo hecho.
        const congelado = await montoCongeladoDelReembolso(tx, reembolso.id);
        if (congelado > 0n) {
          await registrarMovimiento({
            tipo: 'descongelacion',
            monto: congelado,
            localId: sub.localId,
            subPedidoId: sub.id,
            reembolsoId: reembolso.id,
            disputaId: reembolso.disputaId,
          });
        }
      }

      const esDigital = reembolso.tipo === 'digital';
      const calculoComision = await aplicarRevisionComision(tx, sub, reembolso, {
        actualizarLocal: !esDigital || Boolean(sub.saldoLiberadoEn),
        actualizarPlataforma: esDigital,
      });

      if (esDigital && sub.saldoLiberadoEn) {
        const cuenta = await bloquearCuenta(tx, sub.localId);
        const montoLocal =
          cuenta.saldoPorPagar < reembolso.monto
            ? cuenta.saldoPorPagar
            : reembolso.monto;

        if (montoLocal > 0n) {
          await registrarMovimiento({
            tipo: 'reembolso',
            monto: montoLocal,
            localId: sub.localId,
            subPedidoId: sub.id,
            reembolsoId: reembolso.id,
            disputaId: reembolso.disputaId,
          });
        }

        const deuda = reembolso.monto - montoLocal;
        if (deuda > 0n) {
          await registrarMovimiento({
            tipo: 'deuda_reembolso',
            monto: deuda,
            localId: sub.localId,
            subPedidoId: sub.id,
            reembolsoId: reembolso.id,
            disputaId: reembolso.disputaId,
          });
          await recalcularEstadoLocal(sub.localId, tx);
        }
      }

      if (
        !esDigital &&
        (calculoComision.reversa > 0n || calculoComision.ajuste > 0n)
      ) {
        await recalcularEstadoLocal(sub.localId, tx);
      }

      const totalPago = await sincronizarPago(tx, reembolso.pagoId);
      const estadoSub = await actualizarEstadoSubPedido(
        tx,
        sub,
        admin?.id ?? null,
      );
      await sincronizarEstadoPedido(tx, sub.pedidoId);

      await tx.auditoriaAdmin.create({
        data: {
          origen: admin ? 'admin' : 'sistema',
          adminId: admin?.id ?? null,
          accion: 'completar_reembolso',
          objeto: 'reembolso',
          objetoId: String(reembolso.id),
          detalle: {
            sub_pedido_id: sub.id,
            pago_id: reembolso.pagoId,
            monto: reembolso.monto.toString(),
            pago_reembolsado: totalPago.toString(),
            sub_pedido_estado: estadoSub.estadoNuevo,
          },
        },
      });

      const final = await tx.reembolso.findUnique({
        where: { id: reembolso.id },
        include: INCLUIR_REEMBOLSO,
      });

      const respuesta = convertirBigIntAJson(serializarReembolso(final));
      await completarEnTx(tx, idempotenciaId, 200, respuesta);
      return respuesta;
    });
  } catch (err) {
    throw traducirErrorReembolso(err);
  }
}

export async function fallarReembolso({
  reembolsoId,
  admin = null,
  idempotenciaId = null,
}) {
  let alerta = null;

  try {
    const respuesta = await withTransaccion(async (tx) => {
      const filas = await tx.$queryRaw`
        SELECT "id"
          FROM "reembolso"
         WHERE "id" = ${reembolsoId}
         FOR UPDATE
      `;

      if (filas.length === 0) {
        throw errorNoEncontrado('Reembolso no encontrado.');
      }

      const reembolso = await tx.reembolso.findUnique({
        where: { id: reembolsoId },
        include: INCLUIR_REEMBOLSO,
      });

      if (!reembolso) throw errorNoEncontrado('Reembolso no encontrado.');

      if (reembolso.estado !== 'pendiente') {
        throw new ErrorApi(
          'reembolso_no_pendiente',
          'El reembolso ya no esta pendiente.',
          409,
        );
      }

      const actualizado = await tx.reembolso.updateMany({
        where: { id: reembolsoId, estado: 'pendiente' },
        data: {
          estado: 'fallido',
          registradoPor: admin?.id ?? reembolso.registradoPor,
        },
      });

      if (actualizado.count === 0) {
        throw new ErrorApi(
          'reembolso_no_pendiente',
          'Otro proceso ya cambio este reembolso.',
          409,
        );
      }

      const congelado = await montoCongeladoDelReembolso(tx, reembolso.id);
      if (congelado > 0n) {
        await registrarMovimiento({
          tipo: 'descongelacion',
          monto: congelado,
          localId: reembolso.subPedido.localId,
          subPedidoId: reembolso.subPedidoId,
          reembolsoId: reembolso.id,
          disputaId: reembolso.disputaId,
        });

        await tx.reembolso.update({
          where: { id: reembolso.id },
          data: { desdeCongelado: false },
        });
      }

      await tx.auditoriaAdmin.create({
        data: {
          origen: admin ? 'admin' : 'sistema',
          adminId: admin?.id ?? null,
          accion: 'fallar_reembolso',
          objeto: 'reembolso',
          objetoId: String(reembolso.id),
          detalle: {
            sub_pedido_id: reembolso.subPedidoId,
            pago_id: reembolso.pagoId,
            monto: reembolso.monto.toString(),
            descongelado: congelado.toString(),
          },
        },
      });

      alerta = {
        alerta: 'reembolso_fallido',
        reembolsoId: reembolso.id,
        subPedidoId: reembolso.subPedidoId,
        pagoId: reembolso.pagoId,
        monto: reembolso.monto.toString(),
        descongelado: congelado.toString(),
      };

      const final = await tx.reembolso.findUnique({
        where: { id: reembolso.id },
        include: INCLUIR_REEMBOLSO,
      });

      const respuesta = convertirBigIntAJson(serializarReembolso(final));
      await completarEnTx(tx, idempotenciaId, 200, respuesta);
      return respuesta;
    });

    logger.error(
      alerta,
      'ALERTA: reembolso fallido; revisar el caso con el comprador y el vendedor',
    );

    return respuesta;
  } catch (err) {
    throw traducirErrorReembolso(err);
  }
}

function traducirErrorReembolso(err) {
  if (err?.code === 'P2002') {
    const destino = textoP2002(err);
    if (
      destino.includes('reembolso_disputa_id') ||
      destino.includes('disputa_id')
    ) {
      return new ErrorApi(
        'reembolso_duplicado',
        'La disputa ya tiene un reembolso asociado.',
        409,
      );
    }
  }

  const mensaje = `${err?.meta?.message ?? ''} ${err?.message ?? ''}`;

  if (
    /reembolso.*linea|reembolso_linea|cantidad reembolsada|monto_envio|suma de reembolsos|no coincide con el monto|no pertenece al sub_pedido|incluye envio/i.test(
      mensaje,
    )
  ) {
    return new ErrorApi(
      'reembolso_invalido',
      'La base rechazo el reembolso porque no cumple las reglas de montos, lineas o cantidades.',
      422,
    );
  }

  return err;
}

function textoP2002(err) {
  return `${err?.meta?.target ?? ''} ${err?.message ?? ''}`;
}
