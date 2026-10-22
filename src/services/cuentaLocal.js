import { prisma } from '../lib/prisma.js';
import { convertirBigIntAJson } from '../lib/dinero.js';
import { errorNoEncontrado } from '../lib/errores.js';
import { envolverLista } from '../lib/validacion.js';

/**
 * CUENTA Y MOVIMIENTOS DEL LOCAL (Etapa 4b)
 * =========================================
 * La cuenta es una vista de solo lectura sobre `cuenta_local`: sus saldos los
 * mueve exclusivamente el ledger. El vendedor solo ve locales propios; el admin
 * ve cualquiera. Los movimientos tambien son de solo lectura y muestran los
 * enlaces al pago de deuda, pago, reembolso y sub-pedido que los originaron.
 */

function serializarCuenta(local, incluirUsuario) {
  const cuenta = local.cuenta;

  return {
    local_id: local.id,
    ...(incluirUsuario ? { usuario_id: local.usuarioId } : {}),
    nombre: local.nombre,
    estado: local.estado,
    puede_vender: local.estado === 'activo' || local.estado === 'en_plazo',
    saldo_deuda: cuenta.saldoDeuda,
    saldo_por_pagar: cuenta.saldoPorPagar,
    saldo_congelado: cuenta.saldoCongelado,
    fecha_limite_pago: cuenta.fechaLimitePago
      ? cuenta.fechaLimitePago.toISOString().slice(0, 10)
      : null,
    actualizado_en: cuenta.actualizadoEn,
  };
}

async function cargarLocalConCuenta({ localId, usuario, incluirUsuario }) {
  const local = await prisma.local.findFirst({
    where: {
      id: localId,
      ...(incluirUsuario ? {} : { usuarioId: usuario.id }),
    },
    include: { cuenta: true },
  });

  if (!local || !local.cuenta) {
    throw errorNoEncontrado('Local no encontrado.');
  }

  return local;
}

export async function obtenerCuentaVendedor({ usuario, localId }) {
  const local = await cargarLocalConCuenta({
    localId,
    usuario,
    incluirUsuario: false,
  });

  return convertirBigIntAJson(serializarCuenta(local, false));
}

export async function obtenerCuentaAdmin({ localId }) {
  const local = await cargarLocalConCuenta({
    localId,
    incluirUsuario: true,
  });

  return convertirBigIntAJson(serializarCuenta(local, true));
}

function serializarMovimiento(movimiento) {
  return {
    id: movimiento.id,
    local_id: movimiento.localId,
    sub_pedido_id: movimiento.subPedidoId,
    pago_id: movimiento.pagoId,
    reembolso_id: movimiento.reembolsoId,
    pago_deuda_id: movimiento.pagoDeudaId,
    tipo: movimiento.tipo,
    monto: movimiento.monto,
    fecha: movimiento.fecha,
  };
}

async function listarMovimientosDeLocal({ localId, pagina, porPagina }) {
  const where = { localId };
  const total = await prisma.ledger.count({ where });
  const movimientos = await prisma.ledger.findMany({
    where,
    orderBy: [{ fecha: 'desc' }, { id: 'desc' }],
    skip: (pagina - 1) * porPagina,
    take: porPagina,
  });

  return convertirBigIntAJson(
    envolverLista(
      movimientos.map(serializarMovimiento),
      { pagina, porPagina },
      total,
    ),
  );
}

export async function listarMovimientosVendedor({
  usuario,
  localId,
  pagina,
  porPagina,
}) {
  await cargarLocalConCuenta({
    localId,
    usuario,
    incluirUsuario: false,
  });

  return listarMovimientosDeLocal({ localId, pagina, porPagina });
}

export async function listarMovimientosAdmin({ localId, pagina, porPagina }) {
  await cargarLocalConCuenta({
    localId,
    incluirUsuario: true,
  });

  return listarMovimientosDeLocal({ localId, pagina, porPagina });
}
