import { transaccionActual } from '../lib/transaccion.js';
import { obtenerConfiguracionEnTransaccion } from './configuracion.js';

/**
 * ESTADO DEL LOCAL POR DEUDA (invariante 9)
 * =========================================
 * Un local no pasa a `en_plazo` ni a `bloqueado` porque alguien lo cambie a
 * mano. Solo esta funcion (y el job diario que la llama) decide esos estados.
 * El trigger `ccv_estado_local_solo_sistema` rechaza el resto de escrituras.
 *
 * La fila del local se bloquea con FOR UPDATE. El recalculo se hace dentro de
 * la misma transaccion que movio la deuda o el saldo: si el commit falla, el
 * estado tambien vuelve atras.
 *
 * Reglas (seccion 4.7):
 *   - suspendido y pendiente_aprobacion no se tocan;
 *   - bloqueado solo vuelve a activo con deuda <= 0 y sin reembolsos efectivos
 *     incumplidos;
 *   - con reembolsos incumplidos o deuda sobre el limite: en_plazo, con la
 *     fecha minima entre la existente y hoy + plazo_dias;
 *   - sin deuda o deuda dentro del limite: activo y se limpia la fecha.
 */

const ESTADOS_SIN_RECALCULO = new Set(['suspendido', 'pendiente_aprobacion']);
const LIMITE_DEUDA_POR_DEFECTO = 50000n;
const PLAZO_DIAS_POR_DEFECTO = 15;

function diaUtc(ahora) {
  return new Date(
    Date.UTC(ahora.getUTCFullYear(), ahora.getUTCMonth(), ahora.getUTCDate()),
  );
}

function sumarDias(fecha, dias) {
  const resultado = new Date(fecha);
  resultado.setUTCDate(resultado.getUTCDate() + dias);
  return resultado;
}

function fechaMinima(existente, propuesta) {
  if (!existente) return propuesta;
  return existente.getTime() <= propuesta.getTime() ? existente : propuesta;
}

function mismaFecha(a, b) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.getTime() === b.getTime();
}

function leerEnteroConfig(valor, porDefecto) {
  return typeof valor === 'number' && Number.isFinite(valor)
    ? Math.trunc(valor)
    : porDefecto;
}

/**
 * Recalcula el estado de deuda de un local.
 *
 * @param {number} localId
 * @param {object} [tx] cliente de Prisma de la transaccion abierta
 * @param {{ahora?: Date}} [opciones] fecha de referencia, para pruebas y jobs
 */
export async function recalcularEstadoLocal(
  localId,
  tx = transaccionActual()?.tx,
  { ahora = new Date() } = {},
) {
  if (!Number.isInteger(localId) || localId <= 0) {
    throw new Error(`Local invalido: ${localId}`);
  }

  const cliente = tx ?? transaccionActual()?.tx;
  if (!cliente) {
    throw new Error(
      'recalcularEstadoLocal debe ejecutarse dentro de withTransaccion() o ' +
        'recibir el cliente de una transaccion abierta.',
    );
  }

  const filas = await cliente.$queryRaw`
    SELECT "estado"::text AS "estado"
      FROM "local"
     WHERE "id" = ${localId}
     FOR UPDATE
  `;

  if (filas.length === 0) {
    throw new Error(`No existe el local ${localId}.`);
  }

  const estadoAnterior = filas[0].estado;
  const cuenta = await cliente.cuentaLocal.findUnique({ where: { localId } });

  if (!cuenta) {
    throw new Error(
      `El local ${localId} no tiene cuenta_local. Revisa la migracion de la Etapa 4a.`,
    );
  }

  const config = await obtenerConfiguracionEnTransaccion(cliente, [
    'limite_deuda',
    'plazo_dias',
  ]);

  const limiteDeuda = BigInt(
    Math.max(0, leerEnteroConfig(config.limite_deuda, Number(LIMITE_DEUDA_POR_DEFECTO))),
  );
  const plazoDias = Math.max(
    0,
    leerEnteroConfig(config.plazo_dias, PLAZO_DIAS_POR_DEFECTO),
  );

  const incumplidos = await cliente.reembolso.count({
    where: {
      tipo: 'efectivo',
      estado: 'incumplido',
      subPedido: { is: { localId } },
    },
  });

  const fechaActual = cuenta.fechaLimitePago;
  const propuesta = sumarDias(diaUtc(ahora), plazoDias);

  let estado = estadoAnterior;
  let fechaLimitePago = fechaActual;
  let motivo = 'sin_cambio';

  if (ESTADOS_SIN_RECALCULO.has(estadoAnterior)) {
    motivo = 'estado_administrativo';
  } else if (estadoAnterior === 'bloqueado') {
    if (cuenta.saldoDeuda <= 0n && incumplidos === 0) {
      estado = 'activo';
      fechaLimitePago = null;
      motivo = 'desbloqueado';
    } else {
      motivo = 'sigue_bloqueado';
    }
  } else if (incumplidos > 0) {
    estado = 'en_plazo';
    fechaLimitePago = fechaMinima(fechaActual, propuesta);
    motivo = 'reembolso_incumplido';
  } else if (cuenta.saldoDeuda <= 0n) {
    estado = 'activo';
    fechaLimitePago = null;
    motivo = 'sin_deuda';
  } else if (cuenta.saldoDeuda > limiteDeuda) {
    estado = 'en_plazo';
    fechaLimitePago = fechaMinima(fechaActual, propuesta);
    motivo = 'sobre_limite';
  } else {
    estado = 'activo';
    fechaLimitePago = null;
    motivo = 'dentro_del_limite';
  }

  const cambioEstado = estado !== estadoAnterior;
  const cambioFecha = !mismaFecha(fechaLimitePago, fechaActual);

  if (cambioEstado) {
    // Tercer argumento true: el contexto dura solo esta transaccion. Sin el,
    // quedaria pegado a la conexion del pool y otra peticion podria cambiar
    // el estado del local sin pasar por esta funcion.
    await cliente.$queryRaw`
      SELECT set_config('ccv.estado_local_sistema', '1', true)
    `;
    await cliente.local.update({
      where: { id: localId },
      data: { estado },
    });
  }

  if (cambioFecha) {
    // fecha_limite_pago vive en cuenta_local, pero no es un saldo: el ledger
    // sigue siendo el unico que mueve saldo_deuda/por_pagar/congelado.
    await cliente.cuentaLocal.update({
      where: { localId },
      data: { fechaLimitePago },
    });
  }

  return {
    localId,
    estadoAnterior,
    estado,
    fechaLimitePago,
    motivo,
    cambioEstado,
    cambioFecha,
  };
}
