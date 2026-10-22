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
 * Efectos:
 *   - venta: no toca la cuenta. La liberacion ocurre con el job de retencion.
 *   - liberacion: suma saldo_por_pagar. El monto se calcula como
 *     subtotal_productos + costo_envio - comision (el envio es del vendedor).
 *   - comision: sin local_id es ingreso de la plataforma. Con local_id (venta
 *     en efectivo) suma saldo_deuda.
 *   - reversa_comision: sin local_id reduce ingreso de la plataforma. Con
 *     local_id descuenta saldo_deuda si la comision fue en efectivo o acredita
 *     saldo_por_pagar si fue digital. Se infiere del movimiento original.
 *   - pago_recibido, ingreso_publicidad, ajuste: no tocan la cuenta.
 *   - reembolso: con local_id descuenta saldo_congelado si `desdeCongelado`;
 *     si no, descuenta saldo_por_pagar. Sin local_id es registro de plataforma.
 *   - congelacion: pasa saldo de por_pagar a congelado.
 *   - descongelacion: pasa saldo de congelado a por_pagar.
 *   - deuda_reembolso: suma saldo_deuda.
 *   - pago_a_local: descuenta saldo_por_pagar.
 *   - cobro_deuda: descuenta saldo_deuda.
 *   - reversa_pago_a_local: devuelve saldo_por_pagar.
 *   - reversa_cobro_deuda: devuelve saldo_deuda.
 *   - ajuste_redondeo: credito o debito explicito sobre la cuenta indicada.
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
  'liberacion',
  'congelacion',
  'descongelacion',
  'deuda_reembolso',
  'reversa_pago_a_local',
  'reversa_cobro_deuda',
]);

const CAMPOS_SALDO = new Set(['saldoDeuda', 'saldoPorPagar', 'saldoCongelado']);

const efecto = (campo, signo) => ({ campo, signo });

const EFECTOS = {
  venta: () => [],
  pago_recibido: () => [],
  ingreso_publicidad: () => [],
  ajuste: () => [],

  comision: ({ localId }) => (localId ? [efecto('saldoDeuda', 1)] : []),

  reversa_comision: async ({ tx, localId, subPedidoId }) => {
    if (!localId) return [];
    if (!subPedidoId) {
      throw new Error(
        'reversa_comision con local_id requiere sub_pedido_id para saber ' +
          'si la comision se cobro en efectivo o digitalmente.',
      );
    }

    const comisionEnEfectivo = await tx.ledger.findFirst({
      where: { subPedidoId, localId, tipo: 'comision' },
      select: { id: true },
    });

    return comisionEnEfectivo
      ? [efecto('saldoDeuda', -1)]
      : [efecto('saldoPorPagar', 1)];
  },

  reembolso: ({ localId, desdeCongelado }) => {
    if (!localId) return [];
    return [efecto(desdeCongelado ? 'saldoCongelado' : 'saldoPorPagar', -1)];
  },

  ajuste_redondeo: ({ localId, direccion, cuentaAjuste = 'saldoPorPagar' }) => {
    if (!localId) return [];
    if (direccion !== 'credito' && direccion !== 'debito') {
      throw new Error(
        'ajuste_redondeo con local_id requiere direccion "credito" o "debito".',
      );
    }
    if (!CAMPOS_SALDO.has(cuentaAjuste)) {
      throw new Error(
        `Cuenta invalida para ajuste_redondeo: ${cuentaAjuste}. ` +
          `Usa una de: ${[...CAMPOS_SALDO].join(', ')}.`,
      );
    }
    return [efecto(cuentaAjuste, direccion === 'credito' ? 1 : -1)];
  },

  liberacion: () => [efecto('saldoPorPagar', 1)],
  deuda_reembolso: () => [efecto('saldoDeuda', 1)],
  reversa_pago_a_local: () => [efecto('saldoPorPagar', 1)],
  reversa_cobro_deuda: () => [efecto('saldoDeuda', 1)],
  pago_a_local: () => [efecto('saldoPorPagar', -1)],
  cobro_deuda: () => [efecto('saldoDeuda', -1)],
  congelacion: () => [
    efecto('saldoPorPagar', -1),
    efecto('saldoCongelado', 1),
  ],
  descongelacion: () => [
    efecto('saldoCongelado', -1),
    efecto('saldoPorPagar', 1),
  ],
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
 * @param {boolean} [datos.desdeCongelado] reembolso contra saldo_congelado
 * @param {'credito'|'debito'} [datos.direccion] solo ajuste_redondeo
 * @param {'saldoDeuda'|'saldoPorPagar'|'saldoCongelado'} [datos.cuentaAjuste]
 */
export async function registrarMovimiento({
  tipo,
  monto,
  localId = null,
  subPedidoId = null,
  pagoId = null,
  reembolsoId = null,
  desdeCongelado = false,
  direccion = null,
  cuentaAjuste = 'saldoPorPagar',
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

  if (typeof desdeCongelado !== 'boolean') {
    throw new Error('El campo desde_congelado debe ser booleano.');
  }

  const montoBig = aBigInt(monto, 'monto');
  if (montoBig <= 0n) {
    throw new Error('El monto de un movimiento debe ser mayor que cero.');
  }

  const tx = contexto.tx;
  const localIdNormalizado = validarId(localId, 'local_id');
  const subPedidoIdNormalizado = validarId(subPedidoId, 'sub_pedido_id');

  // Se calcula antes de insertar: reversa_comision necesita mirar el
  // movimiento original y ajuste_redondeo valida su direccion.
  const efectos = await EFECTOS[tipo]({
    tx,
    localId: localIdNormalizado,
    subPedidoId: subPedidoIdNormalizado,
    desdeCongelado,
    direccion,
    cuentaAjuste,
  });

  const movimiento = await tx.ledger.create({
    data: {
      tipo,
      monto: montoBig,
      localId: localIdNormalizado,
      subPedidoId: subPedidoIdNormalizado,
      pagoId: validarId(pagoId, 'pago_id'),
      reembolsoId: validarId(reembolsoId, 'reembolso_id'),
    },
  });

  if (localIdNormalizado) {
    await asegurarCuenta(tx, localIdNormalizado);

    for (const cambio of efectos) {
      const delta = cambio.signo < 0 ? -montoBig : montoBig;
      await tx.cuentaLocal.update({
        where: { localId: localIdNormalizado },
        data: { [cambio.campo]: { increment: delta } },
      });
    }
  }

  return movimiento;
}
