import { Prisma } from '../../generated/prisma/index.js';
import { prisma } from '../lib/prisma.js';
import { withTransaccion } from '../lib/transaccion.js';
import { logger } from '../lib/logger.js';
import { aBigInt, restar, sumar } from '../lib/dinero.js';
import { registrarMovimiento } from './ledger.js';
import { calcularComisionObjetivoEnTx } from './reembolsos.js';

/**
 * LIBERACION DE SALDO (Etapa 4d)
 * ==============================
 * El dinero de una venta digital queda retenido hasta que se cumple la
 * ventana de `dias_retencion` del snapshot. Este modulo calcula el monto y
 * ejecuta el job que lo pasa a `cuenta_local.saldo_por_pagar`.
 *
 * Reglas que no se negocian:
 *   - solo se liberan pedidos digitales; en efectivo el vendedor ya cobro;
 *   - un reembolso pendiente o una disputa abierta bloquean la liberacion;
 *   - cada sub-pedido se procesa en su propia transaccion y con
 *     `FOR UPDATE SKIP LOCKED`;
 *   - el asiento `liberacion` es bruto y los reembolsos locales se escriben
 *     como descuentos separados;
 *   - la reversa de comision de la PLATAFORMA ya se registro al completar el
 *     reembolso (`local_id = NULL`). Aqui solo se escribe la reversa LOCAL que
 *     le corresponde al vendedor. Nunca se repite la de plataforma.
 *   - si el neto es cero, se marca `saldo_liberado_en` sin escribir asientos.
 */

const TAMANO_LOTE = 500;

/**
 * Estados que pueden tener una liberacion pendiente.
 *
 * `reembolsado` se incluye para cerrar los sub-pedidos que se reembolsaron por
 * completo antes de que venciera la retencion. Normalmente su neto es cero y
 * solo se marca la ventana como cerrada; si el envio no fue reembolsado, el
 * vendedor conserva ese envio y se escribe el asiento que corresponda.
 */
const ESTADOS_ELEGIBLES = ['entregado', 'reembolsado_parcial', 'reembolsado'];

/**
 * Monto que se acredita al vendedor cuando vence la retencion.
 *
 * Formula aprobada: subtotal_productos + costo_envio - comision. El envio se
 * acredita al vendedor porque el asume el flete; la comision solo se calcula
 * sobre los productos. Si el neto da cero no se escribe asiento.
 */
export function calcularMontoLiberacion({ subtotalProductos, costoEnvio, comision }) {
  const bruto = sumar(
    aBigInt(subtotalProductos, 'subtotal_productos'),
    aBigInt(costoEnvio, 'costo_envio'),
  );
  return restar(bruto, aBigInt(comision, 'comision'));
}

function normalizarFecha(ahora) {
  const fecha = ahora instanceof Date ? ahora : new Date(ahora);
  if (Number.isNaN(fecha.getTime())) {
    throw new Error('La fecha de liberacion no es valida.');
  }
  return fecha;
}

function filtroSubPedidoIds(subPedidoIds) {
  if (subPedidoIds === null || subPedidoIds === undefined) {
    return Prisma.empty;
  }
  if (!Array.isArray(subPedidoIds)) {
    throw new Error('subPedidoIds debe ser un arreglo o null.');
  }
  if (subPedidoIds.length === 0) {
    // Un filtro vacio no debe convertirse en "todos".
    return Prisma.sql`AND FALSE`;
  }

  const ids = subPedidoIds.filter(
    (id) => Number.isInteger(id) && id > 0,
  );
  if (ids.length === 0) return Prisma.sql`AND FALSE`;

  return Prisma.sql`AND s."id" IN (${Prisma.join(ids)})`;
}

function filtroLimite(limite) {
  if (limite === null || limite === undefined) return Prisma.empty;
  if (!Number.isInteger(limite) || limite < 0) {
    throw new Error('El limite del lote debe ser un entero no negativo.');
  }
  return Prisma.sql`LIMIT ${limite}`;
}

/**
 * Consulta base de elegibilidad. Tambien se usa, con `bloquear: true`, para
 * revalidar una fila dentro de la transaccion que la va a escribir.
 *
 * La retencion se calcula en SQL con `fecha_entrega + make_interval(...)`.
 * Se evita castear configuraciones invalidas: si el snapshot no trae un
 * entero de dias, el valor seguro es cero y la fila no se acelera.
 */
async function consultarCandidatos({
  tx = prisma,
  ahora = new Date(),
  limite = null,
  subPedidoIds = null,
  bloquear = false,
}) {
  const fecha = normalizarFecha(ahora);
  const filtroIds = filtroSubPedidoIds(subPedidoIds);
  const filtroCantidad = filtroLimite(limite);
  const bloqueo = bloquear
    ? Prisma.sql`FOR UPDATE OF s SKIP LOCKED`
    : Prisma.empty;

  const filas = await tx.$queryRaw(Prisma.sql`
    SELECT s."id"
      FROM "sub_pedido" s
      JOIN "pedido" p ON p."id" = s."pedido_id"
     WHERE s."estado"::text IN (${Prisma.join(ESTADOS_ELEGIBLES)})
       AND s."saldo_liberado_en" IS NULL
       AND s."fecha_entrega" IS NOT NULL
       AND p."metodo_pago"::text <> 'efectivo'
       AND s."fecha_entrega" + make_interval(
             days => CASE
               WHEN (p."config_snapshot"->>'dias_retencion') ~ '^[0-9]+$'
                 THEN (p."config_snapshot"->>'dias_retencion')::int
               ELSE 0
             END
           ) <= ${fecha}
       AND NOT EXISTS (
             SELECT 1
               FROM "reembolso" r
              WHERE r."sub_pedido_id" = s."id"
                AND r."estado" = 'pendiente'
           )
       AND NOT EXISTS (
             SELECT 1
               FROM "disputa" d
              WHERE d."sub_pedido_id" = s."id"
                AND d."estado" = 'abierta'
           )
       ${filtroIds}
     ORDER BY s."fecha_entrega" ASC, s."id" ASC
     ${filtroCantidad}
     ${bloqueo}
  `);

  return filas.map((fila) => fila.id);
}

/**
 * Devuelve los IDs que pueden liberarse en este momento.
 *
 * `limite` y `subPedidoIds` existen para el job y las pruebas. El job usa un
 * lote acotado; las pruebas pueden restringir el trabajo a sus propios IDs
 * para no interferir con otros archivos que corren en paralelo.
 */
export async function subPedidosElegiblesParaLiberar({
  ahora = new Date(),
  limite = null,
  subPedidoIds = null,
} = {}) {
  return consultarCandidatos({ ahora, limite, subPedidoIds });
}

async function marcarLiberado(tx, subPedidoId, ahora) {
  const actualizados = await tx.subPedido.updateMany({
    where: {
      id: subPedidoId,
      saldoLiberadoEn: null,
    },
    data: { saldoLiberadoEn: ahora },
  });

  if (actualizados.count !== 1) {
    throw new Error(
      `No se pudo marcar el sub-pedido ${subPedidoId} como liberado; ` +
        'otro proceso pudo haberlo tomado.',
    );
  }
}

/**
 * Libera un sub-pedido dentro de una transaccion ya abierta.
 *
 * Se deja exportada para pruebas de concurrencia y para poder reutilizarla en
 * una transaccion mayor sin abrir una segunda conexion.
 */
export async function liberarSubPedidoEnTx({
  tx,
  subPedidoId,
  ahora = new Date(),
}) {
  if (!tx) throw new Error('liberarSubPedidoEnTx requiere una transaccion.');
  const fecha = normalizarFecha(ahora);

  const ids = await consultarCandidatos({
    tx,
    ahora: fecha,
    limite: 1,
    subPedidoIds: [subPedidoId],
    bloquear: true,
  });

  if (ids.length === 0) {
    return { liberado: false, motivo: 'no_elegible' };
  }

  const sub = await tx.subPedido.findUnique({
    where: { id: subPedidoId },
    include: {
      pedido: {
        select: {
          configSnapshot: true,
          metodoPago: true,
        },
      },
    },
  });

  if (!sub) throw new Error(`No existe el sub-pedido ${subPedidoId}.`);

  const liberacion = calcularMontoLiberacion(sub);

  // Esta funcion calcula la comision objetivo y las reversas que faltan. La
  // de plataforma se ignora a proposito: ya se contabilizo al completar cada
  // reembolso y repetirla aqui reduciria dos veces el ingreso de la plataforma.
  const calculo = await calcularComisionObjetivoEnTx(tx, sub);

  const reembolsosLocales = await tx.reembolso.findMany({
    where: {
      subPedidoId,
      estado: 'completado',
      movimientos: {
        none: {
          tipo: 'reembolso',
          localId: { not: null },
        },
      },
    },
    select: {
      id: true,
      monto: true,
      pagoId: true,
      disputaId: true,
    },
    orderBy: { id: 'asc' },
  });

  const totalReembolsos = reembolsosLocales.reduce(
    (total, reembolso) => sumar(total, reembolso.monto),
    0n,
  );

  const neto = restar(
    restar(
      sumar(liberacion, calculo.reversa),
      totalReembolsos,
    ),
    calculo.ajuste,
  );

  if (neto < 0n) {
    throw new Error(
      `El neto de liberacion del sub-pedido ${subPedidoId} es negativo ` +
        `(${neto}). Revisa los snapshots y los reembolsos antes de reintentar.`,
    );
  }

  if (neto === 0n) {
    // Todo lo que tenia que recibir el vendedor ya se reembolso. La ventana
    // se cierra sin mover dinero.
    await marcarLiberado(tx, subPedidoId, fecha);
    return {
      liberado: true,
      neto,
      asientos: [],
    };
  }

  if (liberacion < 0n) {
    throw new Error(
      `La liberacion bruta del sub-pedido ${subPedidoId} es negativa ` +
        `(${liberacion}). No se puede escribir un movimiento con ese monto.`,
    );
  }

  const asientos = [];

  if (liberacion > 0n) {
    await registrarMovimiento({
      tipo: 'liberacion',
      monto: liberacion,
      localId: sub.localId,
      subPedidoId,
    });
    asientos.push({ tipo: 'liberacion', monto: liberacion });
  }

  // El credito por reversa va antes del descuento del reembolso. Asi una
  // devolucion grande nunca hace que `saldo_por_pagar` quede negativo a mitad
  // de la transaccion, aunque el CHECK de la base lo rechazaria y toda la
  // liberacion haria rollback.
  if (calculo.reversa > 0n) {
    await registrarMovimiento({
      tipo: 'reversa_comision',
      monto: calculo.reversa,
      localId: sub.localId,
      subPedidoId,
    });
    asientos.push({ tipo: 'reversa_comision', monto: calculo.reversa });
  }

  for (const reembolso of reembolsosLocales) {
    await registrarMovimiento({
      tipo: 'reembolso',
      monto: reembolso.monto,
      localId: sub.localId,
      subPedidoId,
      pagoId: reembolso.pagoId,
      reembolsoId: reembolso.id,
      disputaId: reembolso.disputaId,
    });
    asientos.push({
      tipo: 'reembolso',
      monto: reembolso.monto,
      reembolsoId: reembolso.id,
    });
  }

  if (calculo.ajuste > 0n) {
    await registrarMovimiento({
      tipo: 'ajuste_redondeo',
      monto: calculo.ajuste,
      localId: sub.localId,
      subPedidoId,
      direccion: 'debito',
      cuentaAjuste: 'saldoPorPagar',
    });
    asientos.push({ tipo: 'ajuste_redondeo', monto: calculo.ajuste });
  }

  await marcarLiberado(tx, subPedidoId, fecha);

  return {
    liberado: true,
    neto,
    asientos,
  };
}

/** Libera un sub-pedido en su propia transaccion. */
export async function liberarSubPedido({
  subPedidoId,
  ahora = new Date(),
} = {}) {
  if (!Number.isInteger(subPedidoId) || subPedidoId <= 0) {
    throw new Error('liberarSubPedido requiere un subPedidoId positivo.');
  }

  return withTransaccion((tx) =>
    liberarSubPedidoEnTx({ tx, subPedidoId, ahora }),
  );
}

/**
 * Job de liberacion.
 *
 * Primero toma un lote acotado de candidatos (sin bloquear) y despues procesa
 * cada uno en su propia transaccion. Dentro de esa transaccion se vuelve a
 * consultar la elegibilidad con `FOR UPDATE SKIP LOCKED`, por lo que dos jobs
 * simultaneos no procesan la misma fila. Un fallo en una fila no impide que se
 * procesen las demas.
 */
export async function liberarSaldos({
  ahora = new Date(),
  limite = TAMANO_LOTE,
  subPedidoIds = null,
} = {}) {
  const fecha = normalizarFecha(ahora);
  const candidatos = await subPedidosElegiblesParaLiberar({
    ahora: fecha,
    limite,
    subPedidoIds,
  });

  let liberados = 0;
  let omitidos = 0;
  let sinAsientos = 0;
  let errores = 0;

  for (const subPedidoId of candidatos) {
    try {
      const resultado = await liberarSubPedido({
        subPedidoId,
        ahora: fecha,
      });

      if (resultado.liberado) {
        liberados += 1;
        if (resultado.neto === 0n) sinAsientos += 1;
      } else {
        omitidos += 1;
      }
    } catch (err) {
      errores += 1;
      logger.error(
        { err, subPedidoId },
        'no se pudo liberar un sub-pedido',
      );
    }
  }

  return {
    revisados: candidatos.length,
    liberados,
    omitidos,
    sinAsientos,
    errores,
  };
}
