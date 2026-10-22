import { prisma } from '../lib/prisma.js';
import { withTransaccion } from '../lib/transaccion.js';
import { aBigInt, convertirBigIntAJson } from '../lib/dinero.js';
import {
  ErrorApi,
  errorNoEncontrado,
} from '../lib/errores.js';
import { envolverLista } from '../lib/validacion.js';
import { completarEnTx } from './idempotencia.js';
import { registrarMovimiento } from './ledger.js';
import { recalcularEstadoLocal } from './estadoLocal.js';

/**
 * PAGOS DE LA DEUDA DE COMISION (Etapa 4b)
 * ========================================
 * El vendedor reporta un pago con su referencia y comprobante. Ese reporte NO
 * toca el ledger: queda pendiente hasta que un admin lo confirme. El admin
 * tambien puede registrar un pago que ya recibio, en cuyo caso nace confirmado.
 *
 * La deuda se reduce con `registrarMovimiento({tipo: 'cobro_deuda'})`, nunca
 * con un UPDATE directo a `cuenta_local`. El movimiento guarda `pago_deuda_id`
 * y el UNIQUE parcial de la base impide que un mismo pago cobre dos veces.
 *
 * Confirmar un pago y recalcular el estado del local ocurren en la misma
 * transaccion: si el cobro falla, el pago sigue pendiente.
 */

export function serializarPagoDeuda(pago) {
  return {
    id: pago.id,
    local_id: pago.localId,
    monto: pago.monto,
    metodo: pago.metodo,
    referencia: pago.referencia,
    comprobante_url: pago.comprobanteUrl,
    estado: pago.estado,
    reportado_por: pago.reportadoPor,
    confirmado_por: pago.confirmadoPor,
    fecha_reporte: pago.fechaReporte,
    fecha_confirmacion: pago.fechaConfirmacion,
    motivo_rechazo: pago.motivoRechazo,
  };
}

async function bloquearCuentaDeuda(tx, localId) {
  const filas = await tx.$queryRaw`
    SELECT "saldo_deuda" AS "deudaActual"
      FROM "cuenta_local"
     WHERE "local_id" = ${localId}
     FOR UPDATE
  `;

  if (filas.length === 0) {
    throw new Error(`No existe la cuenta del local ${localId}.`);
  }

  return filas[0].deudaActual;
}

function exigirMontoDentroDeLaDeuda(monto, saldoDeuda) {
  if (monto > saldoDeuda) {
    throw new ErrorApi(
      'monto_excede_deuda',
      `El pago supera la deuda actual del local (${saldoDeuda} pesos).`,
      409,
      { saldo_deuda: saldoDeuda.toString(), monto: monto.toString() },
    );
  }
}

function traducirReferenciaDuplicada(err) {
  if (err?.code === 'P2002') {
    return new ErrorApi(
      'referencia_pago_duplicada',
      'Ya existe un pago de deuda con esa referencia.',
      409,
    );
  }
  return err;
}

export async function reportarPagoDeuda({
  usuario,
  datos,
  idempotenciaId = null,
}) {
  const monto = aBigInt(datos.monto, 'monto');

  try {
    return await withTransaccion(async (tx) => {
      const local = await tx.local.findFirst({
        where: { id: datos.local_id, usuarioId: usuario.id },
        select: { id: true },
      });

      if (!local) throw errorNoEncontrado('Local no encontrado.');

      const deudaActual = await bloquearCuentaDeuda(tx, local.id);
      exigirMontoDentroDeLaDeuda(monto, deudaActual);

      const pago = await tx.pagoDeuda.create({
        data: {
          localId: local.id,
          monto,
          metodo: datos.metodo,
          referencia: datos.referencia,
          comprobanteUrl: datos.comprobante_url ?? null,
          estado: 'pendiente',
          reportadoPor: usuario.id,
        },
      });

      const respuesta = convertirBigIntAJson(serializarPagoDeuda(pago));
      await completarEnTx(tx, idempotenciaId, 201, respuesta);

      return respuesta;
    });
  } catch (err) {
    throw traducirReferenciaDuplicada(err);
  }
}

async function aplicarCobroDeuda({ tx, pago, admin, estadoHttp, idempotenciaId }) {
  const deudaActual = await bloquearCuentaDeuda(tx, pago.localId);
  exigirMontoDentroDeLaDeuda(pago.monto, deudaActual);

  await registrarMovimiento({
    tipo: 'cobro_deuda',
    monto: pago.monto,
    localId: pago.localId,
    pagoDeudaId: pago.id,
  });

  await recalcularEstadoLocal(pago.localId, tx);

  const confirmado = await tx.pagoDeuda.findUnique({
    where: { id: pago.id },
  });

  await tx.auditoriaAdmin.create({
    data: {
      origen: 'admin',
      adminId: admin.id,
      accion: 'cobrar_deuda_local',
      objeto: 'pago_deuda',
      objetoId: String(pago.id),
      detalle: {
        local_id: pago.localId,
        monto: pago.monto.toString(),
        referencia: pago.referencia,
      },
    },
  });

  const respuesta = convertirBigIntAJson(serializarPagoDeuda(confirmado));
  await completarEnTx(tx, idempotenciaId, estadoHttp, respuesta);

  return respuesta;
}

export async function registrarPagoDeudaAdmin({
  admin,
  localId,
  datos,
  idempotenciaId = null,
}) {
  const monto = aBigInt(datos.monto, 'monto');

  try {
    return await withTransaccion(async (tx) => {
      const local = await tx.local.findUnique({
        where: { id: localId },
        select: { id: true },
      });

      if (!local) throw errorNoEncontrado('Local no encontrado.');

      const deudaActual = await bloquearCuentaDeuda(tx, local.id);
      exigirMontoDentroDeLaDeuda(monto, deudaActual);

      const pago = await tx.pagoDeuda.create({
        data: {
          localId: local.id,
          monto,
          metodo: datos.metodo,
          referencia: datos.referencia,
          comprobanteUrl: datos.comprobante_url ?? null,
          estado: 'confirmado',
          reportadoPor: admin.id,
          confirmadoPor: admin.id,
          fechaConfirmacion: new Date(),
        },
      });

      return aplicarCobroDeuda({
        tx,
        pago,
        admin,
        estadoHttp: 201,
        idempotenciaId,
      });
    });
  } catch (err) {
    throw traducirReferenciaDuplicada(err);
  }
}

export async function confirmarPagoDeuda({
  admin,
  id,
  idempotenciaId = null,
}) {
  return withTransaccion(async (tx) => {
    const pago = await tx.pagoDeuda.findUnique({ where: { id } });

    if (!pago) throw errorNoEncontrado('Pago de deuda no encontrado.');

    const actualizados = await tx.pagoDeuda.updateMany({
      where: { id, estado: 'pendiente' },
      data: {
        estado: 'confirmado',
        confirmadoPor: admin.id,
        fechaConfirmacion: new Date(),
      },
    });

    if (actualizados.count === 0) {
      throw new ErrorApi(
        'pago_deuda_no_pendiente',
        'El pago de deuda ya no esta pendiente de confirmacion.',
        409,
      );
    }

    return aplicarCobroDeuda({
      tx,
      pago,
      admin,
      estadoHttp: 200,
      idempotenciaId,
    });
  });
}

export async function listarPagosDeudaVendedor({
  usuario,
  localId,
  estado,
  pagina,
  porPagina,
}) {
  if (localId) {
    const local = await prisma.local.findFirst({
      where: { id: localId, usuarioId: usuario.id },
      select: { id: true },
    });
    if (!local) throw errorNoEncontrado('Local no encontrado.');
  }

  const where = {
    ...(localId ? { localId } : {}),
    ...(estado ? { estado } : {}),
    ...(localId ? {} : { local: { usuarioId: usuario.id } }),
  };

  const total = await prisma.pagoDeuda.count({ where });
  const pagos = await prisma.pagoDeuda.findMany({
    where,
    orderBy: [{ fechaReporte: 'desc' }, { id: 'desc' }],
    skip: (pagina - 1) * porPagina,
    take: porPagina,
  });

  return convertirBigIntAJson(
    envolverLista(
      pagos.map(serializarPagoDeuda),
      { pagina, porPagina },
      total,
    ),
  );
}
