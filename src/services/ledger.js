import { transaccionActual } from '../lib/transaccion.js';
import { aBigInt } from '../lib/dinero.js';

/**
 * LEDGER: UNICA FUENTE DE VERDAD DEL DINERO (invariantes 1 y 6)
 * ============================================================
 * Ningun otro modulo escribe `cuenta_local`. Cada movimiento:
 *
 *   1. Se inserta en `ledger`.
 *   2. Actualiza el saldo que corresponda en `cuenta_local`.
 *
 * Las dos cosas pasan en la MISMA transaccion. Si la actualizacion del saldo
 * falla (por ejemplo, un CHECK de saldo no negativo), el movimiento tampoco
 * queda. No existe un estado intermedio.
 *
 * `registrarMovimiento` no recibe un cliente de Prisma: lo saca del contexto
 * de `withTransaccion`. Asi es imposible llamarlo fuera de una transaccion y
 * olvidarse de la atomicidad.
 *
 * Efectos de cada tipo en la Etapa 2:
 *   - venta: crea la cuenta del local, pero NO suma saldo_por_pagar. La
 *     liberacion ocurre recien con el job de retencion (Etapa 4).
 *   - comision: no toca la cuenta del local; es ingreso de la plataforma.
 *   - pago_recibido: no toca la cuenta del local; es el pago del comprador.
 *   - reembolso: si tiene local_id, descuenta saldo_por_pagar. En la Etapa 2
 *     el reembolso por fallo de stock es de plataforma (local_id nulo).
 *   - pago_a_local: descuenta saldo_por_pagar (Etapa 4).
 *   - cobro_deuda: descuenta saldo_deuda (Etapa 4).
 */

const TIPOS = new Set([
  'venta',
  'comision',
  'reversa_comision',
  'pago_recibido',
  'cobro_deuda',
  'pago_a_local',
  'reembolso',
  'ingreso_publicidad',
  'ajuste',
  'ajuste_redondeo',
]);

const EFECTOS = {
  venta: null,
  comision: null,
  reversa_comision: null,
  pago_recibido: null,
  ingreso_publicidad: null,
  ajuste: null,
  ajuste_redondeo: null,
  pago_a_local: { campo: 'saldoPorPagar', signo: -1 },
  cobro_deuda: { campo: 'saldoDeuda', signo: -1 },
  reembolso: { campo: 'saldoPorPagar', signo: -1 },
};

function validarId(valor, campo) {
  if (valor === null || valor === undefined) return null;
  if (!Number.isInteger(valor) || valor <= 0) {
    throw new Error(`El campo ${campo} debe ser un id positivo.`);
  }
  return valor;
}

async function asegurarCuenta(tx, localId) {
  return tx.cuentaLocal.upsert({
    where: { localId },
    create: { localId },
    update: {},
  });
}

/**
 * Registra un movimiento y actualiza el saldo en la misma transaccion.
 *
 * @param {object} datos
 * @param {string} datos.tipo
 * @param {bigint|number|string} datos.monto pesos enteros, positivo
 * @param {number|null} [datos.localId]
 * @param {number|null} [datos.subPedidoId]
 * @param {number|null} [datos.pagoId]
 * @param {number|null} [datos.reembolsoId]
 */
export async function registrarMovimiento({
  tipo,
  monto,
  localId = null,
  subPedidoId = null,
  pagoId = null,
  reembolsoId = null,
}) {
  const contexto = transaccionActual();

  if (!contexto?.tx) {
    throw new Error(
      'INVARIANTE 1: registrarMovimiento debe ejecutarse dentro de ' +
        'withTransaccion(). El ledger y los saldos se actualizan en la misma ' +
        'transaccion.',
    );
  }

  if (!TIPOS.has(tipo)) {
    throw new Error(`Tipo de movimiento invalido: ${tipo}`);
  }

  const montoBig = aBigInt(monto, 'monto');
  if (montoBig <= 0n) {
    throw new Error('El monto de un movimiento debe ser mayor que cero.');
  }

  const tx = contexto.tx;
  const movimiento = await tx.ledger.create({
    data: {
      tipo,
      monto: montoBig,
      localId: validarId(localId, 'local_id'),
      subPedidoId: validarId(subPedidoId, 'sub_pedido_id'),
      pagoId: validarId(pagoId, 'pago_id'),
      reembolsoId: validarId(reembolsoId, 'reembolso_id'),
    },
  });

  if (localId) {
    await asegurarCuenta(tx, localId);

    const efecto = EFECTOS[tipo];
    if (efecto) {
      const delta = efecto.signo < 0 ? -montoBig : montoBig;
      await tx.cuentaLocal.update({
        where: { localId },
        data: { [efecto.campo]: { increment: delta } },
      });
    }
  }

  return movimiento;
}
