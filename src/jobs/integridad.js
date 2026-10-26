import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { abrirAlerta } from '../services/alertas.js';

/**
 * JOB: INTEGRIDAD FINANCIERA (Etapa 4f-2)
 * =======================================
 * Busca inconsistencias que no son un simple saldo distinto:
 *
 *   1. `pago.monto_reembolsado` distinto de la suma de reembolsos completados.
 *   2. `pedido.total` distinto de la suma de sus sub-pedidos.
 *   3. Cualquier saldo negativo en `cuenta_local`.
 *   4. Sub-pedido `en_disputa` sin una disputa abierta.
 *   5. Pedido `en_proceso` sin actividad durante una semana.
 *
 * El job es de SOLO LECTURA. Nunca corrige ni completa datos: escribe alertas
 * para que el admin investigue. Cada alerta tiene clave estable y se reabre si
 * la causa vuelve despues de haber sido resuelta.
 */

const HORAS_PEDIDO_ESTANCADO = 7 * 24;

async function alertar(datos) {
  try {
    await abrirAlerta(datos);
    return true;
  } catch (err) {
    logger.error(
      { err, clave: datos.clave },
      'no se pudo registrar una alerta de integridad',
    );
    return false;
  }
}

function filtrarPorIds(filas, ids, campo = 'id') {
  if (!ids) return filas;
  const permitidos = new Set(ids);
  return filas.filter((fila) => permitidos.has(fila[campo]));
}

export async function verificarIntegridad({
  ahora = new Date(),
  localIds = null,
  pedidoIds = null,
  pagoIds = null,
} = {}) {
  const resultado = {
    pagos_revisados: 0,
    pedidos_revisados: 0,
    diferencias: 0,
    alertas: 0,
  };

  // 1. Pago.reembolsado vs reembolsos completados.
  const pagos =
    await prisma.$queryRawUnsafe(`SELECT p."id",
         p."monto_reembolsado",
         p."estado",
         COALESCE(SUM(r."monto") FILTER (WHERE r."estado" = 'completado'), 0)::bigint
           AS "reembolsado_completado"
    FROM "pago" p
    LEFT JOIN "reembolso" r ON r."pago_id" = p."id"
   GROUP BY p."id", p."monto_reembolsado", p."estado"
  HAVING p."monto_reembolsado" <>
         COALESCE(SUM(r."monto") FILTER (WHERE r."estado" = 'completado'), 0)
   ORDER BY p."id"`);

  for (const pago of filtrarPorIds(pagos, pagoIds)) {
    resultado.pagos_revisados += 1;
    resultado.diferencias += 1;
    if (
      await alertar({
        clave: `integridad:pago_reembolsado:${pago.id}`,
        tipo: 'integridad_pago_reembolsado',
        severidad: 'alta',
        titulo: 'El monto reembolsado de un pago no cuadra',
        detalle: {
          pago_id: pago.id,
          estado_pago: pago.estado,
          monto_reembolsado: pago.monto_reembolsado.toString(),
          suma_reembolsos_completados:
            pago.reembolsado_completado.toString(),
          detectado_en: ahora.toISOString(),
        },
        pagoId: pago.id,
      })
    ) {
      resultado.alertas += 1;
    }
  }

  // 2. Total del pedido vs suma de sub-pedidos.
  const pedidos =
    await prisma.$queryRawUnsafe(`SELECT p."id",
         p."total",
         p."estado",
         COALESCE(SUM(s."total"), 0)::bigint AS "total_sub_pedidos"
    FROM "pedido" p
    LEFT JOIN "sub_pedido" s ON s."pedido_id" = p."id"
   GROUP BY p."id", p."total", p."estado"
  HAVING p."total" <> COALESCE(SUM(s."total"), 0)
   ORDER BY p."id"`);

  for (const pedido of filtrarPorIds(pedidos, pedidoIds)) {
    resultado.pedidos_revisados += 1;
    resultado.diferencias += 1;
    if (
      await alertar({
        clave: `integridad:pedido_total:${pedido.id}`,
        tipo: 'integridad_total_pedido',
        severidad: 'alta',
        titulo: 'El total de un pedido no coincide con sus sub-pedidos',
        detalle: {
          pedido_id: pedido.id,
          estado_pedido: pedido.estado,
          total_pedido: pedido.total.toString(),
          suma_sub_pedidos: pedido.total_sub_pedidos.toString(),
          detectado_en: ahora.toISOString(),
        },
        pedidoId: pedido.id,
      })
    ) {
      resultado.alertas += 1;
    }
  }

  // 3. Saldos negativos.
  const cuentas = await prisma.cuentaLocal.findMany({
    where: {
      ...(localIds ? { localId: { in: localIds } } : {}),
      OR: [
        { saldoDeuda: { lt: 0n } },
        { saldoPorPagar: { lt: 0n } },
        { saldoCongelado: { lt: 0n } },
      ],
    },
    orderBy: { localId: 'asc' },
  });

  for (const cuenta of cuentas) {
    resultado.diferencias += 1;
    if (
      await alertar({
        clave: `integridad:saldo_negativo:${cuenta.localId}`,
        tipo: 'integridad_saldo_negativo',
        severidad: 'alta',
        titulo: 'Un local tiene un saldo negativo',
        detalle: {
          local_id: cuenta.localId,
          saldo_deuda: cuenta.saldoDeuda.toString(),
          saldo_por_pagar: cuenta.saldoPorPagar.toString(),
          saldo_congelado: cuenta.saldoCongelado.toString(),
          detectado_en: ahora.toISOString(),
        },
        localId: cuenta.localId,
      })
    ) {
      resultado.alertas += 1;
    }
  }

  // 4. en_disputa sin disputa abierta.
  const subPedidos = await prisma.subPedido.findMany({
    where: {
      estado: 'en_disputa',
      ...(localIds ? { localId: { in: localIds } } : {}),
    },
    select: {
      id: true,
      localId: true,
      pedidoId: true,
      disputa: { select: { id: true, estado: true } },
    },
    orderBy: { id: 'asc' },
  });

  for (const sub of subPedidos) {
    if (sub.disputa?.estado === 'abierta') continue;

    resultado.diferencias += 1;
    if (
      await alertar({
        clave: `integridad:disputa_abierta:${sub.id}`,
        tipo: 'integridad_disputa_abierta',
        severidad: 'alta',
        titulo: 'Sub-pedido en disputa sin disputa abierta',
        detalle: {
          sub_pedido_id: sub.id,
          pedido_id: sub.pedidoId,
          local_id: sub.localId,
          disputa_id: sub.disputa?.id ?? null,
          estado_disputa: sub.disputa?.estado ?? null,
          detectado_en: ahora.toISOString(),
        },
        localId: sub.localId,
        pedidoId: sub.pedidoId,
        subPedidoId: sub.id,
      })
    ) {
      resultado.alertas += 1;
    }
  }

  // 5. Pedidos en_proceso sin actividad durante una semana.
  const corte = new Date(
    ahora.getTime() - HORAS_PEDIDO_ESTANCADO * 60 * 60 * 1000,
  );
  const estancados = await prisma.$queryRaw`
    SELECT p."id",
           p."creado_en",
           p."actualizado_en",
           GREATEST(
             p."actualizado_en",
             COALESCE(MAX(s."actualizado_en"), p."actualizado_en")
           ) AS "ultima_actividad"
      FROM "pedido" p
      LEFT JOIN "sub_pedido" s ON s."pedido_id" = p."id"
     WHERE p."estado" = 'en_proceso'
     GROUP BY p."id"
    HAVING GREATEST(
             p."actualizado_en",
             COALESCE(MAX(s."actualizado_en"), p."actualizado_en")
           ) <= ${corte}
     ORDER BY p."id"
  `;

  for (const pedido of filtrarPorIds(estancados, pedidoIds)) {
    resultado.diferencias += 1;
    if (
      await alertar({
        clave: `integridad:pedido_estancado:${pedido.id}`,
        tipo: 'integridad_pedido_estancado',
        severidad: 'media',
        titulo: 'Pedido en proceso sin actividad',
        detalle: {
          pedido_id: pedido.id,
          creado_en: pedido.creado_en.toISOString(),
          ultima_actividad: pedido.ultima_actividad.toISOString(),
          horas_sin_actividad: HORAS_PEDIDO_ESTANCADO,
          detectado_en: ahora.toISOString(),
        },
        pedidoId: pedido.id,
      })
    ) {
      resultado.alertas += 1;
    }
  }

  return resultado;
}
