import { prisma } from '../lib/prisma.js';
import { withTransaccion } from '../lib/transaccion.js';
import { aBigInt, convertirBigIntAJson } from '../lib/dinero.js';
import { ErrorApi, errorNoEncontrado } from '../lib/errores.js';
import { envolverLista } from '../lib/validacion.js';
import { cuentaBancariaCompleta } from '../lib/cifradoBancario.js';
import { completarEnTx } from './idempotencia.js';
import { registrarMovimiento } from './ledger.js';
import { recalcularEstadoLocal } from './estadoLocal.js';
import { obtenerConfiguracionEnTransaccion } from './configuracion.js';
import {
  copiarCifradoBancario,
  datosBancariosDesdeLocal,
  datosBancariosDesdeSnapshot,
  serializarCuentaDestinoCompleta,
  serializarCuentaDestinoEnmascarada,
} from './cuentaBancaria.js';

/**
 * LIQUIDACIONES Y COMPENSACION DE DEUDA (Etapa 4e)
 * =================================================
 * Una liquidacion agrupa el saldo liberado de un local. Se crea en borrador
 * con una vista previa, se prepara y recien ahi se mueve el ledger:
 *
 *   borrador -> en_proceso -> pagada
 *   borrador -> en_proceso -> fallida
 *   borrador -> cancelada
 *
 * Reglas que sostiene este modulo:
 *   - la deuda solo se compensa en `preparar`, con saldo_por_pagar ya liberado;
 *   - el cliente nunca manda montos (las rutas ni siquiera los aceptan);
 *   - preparar bloquea cuenta_local y revalida que el borrador siga vigente;
 *   - fallar repone exactamente los montos debitados, con enlaces al origen;
 *   - confirmar no escribe ledger y una liquidacion pagada es inmutable.
 */

const ESTADOS_ABIERTOS = ['borrador', 'en_proceso'];

function fechaParaJson(fecha) {
  return fecha ?? null;
}

function serializarMovimiento(movimiento) {
  return {
    ledger_id: movimiento.ledgerId,
    rol: movimiento.rol,
    ledger_origen_id: movimiento.ledgerOrigenId,
    tipo: movimiento.ledger?.tipo ?? null,
    monto: movimiento.ledger?.monto ?? 0n,
    fecha: movimiento.ledger?.fecha ?? null,
  };
}

function fuenteCuentaDestino(liquidacion) {
  const tieneSnapshot =
    liquidacion.fechaPreparacion !== null ||
    liquidacion.bancoDestino !== null ||
    liquidacion.numeroCuentaDestinoCifrado !== null;

  if (tieneSnapshot) {
    return datosBancariosDesdeSnapshot(liquidacion);
  }

  if (liquidacion.local) {
    return datosBancariosDesdeLocal(liquidacion.local);
  }

  return null;
}

/**
 * @param {object} liquidacion
 * @param {object} opciones
 * @param {boolean} opciones.detalle incluye movimientos
 * @param {boolean} opciones.revelarCompleto solo el detalle de admin
 */
export function serializarLiquidacion(
  liquidacion,
  { detalle = false, revelarCompleto = false } = {},
) {
  const fuente = fuenteCuentaDestino(liquidacion);
  const cuentaDestino = fuente
    ? revelarCompleto
      ? serializarCuentaDestinoCompleta(fuente)
      : serializarCuentaDestinoEnmascarada(fuente)
    : null;

  return {
    id: liquidacion.id,
    local_id: liquidacion.localId,
    estado: liquidacion.estado,
    fecha_creacion: fechaParaJson(liquidacion.fechaCreacion),
    fecha_preparacion: fechaParaJson(liquidacion.fechaPreparacion),
    fecha_pago: fechaParaJson(liquidacion.fechaPago),
    monto_liberado: liquidacion.montoLiberado,
    monto_reembolsado: liquidacion.montoReembolsado,
    monto_compensado: liquidacion.montoCompensado,
    total_pagado: liquidacion.totalPagado,
    referencia_payout: liquidacion.referenciaPayout,
    metodo_pago: liquidacion.metodoPago,
    comprobante_url: liquidacion.comprobanteUrl,
    creado_por: liquidacion.creadoPor,
    preparado_por: liquidacion.preparadoPor,
    pagado_por: liquidacion.pagadoPor,
    motivo_fallo: liquidacion.motivoFallo,
    cuenta_destino: cuentaDestino,
    ...(detalle
      ? {
          movimientos: (liquidacion.movimientos ?? []).map(
            serializarMovimiento,
          ),
        }
      : {}),
  };
}

async function bloquearCuenta(tx, localId) {
  const filas = await tx.$queryRaw`
    SELECT "saldo_deuda" AS "saldoDeuda",
           "saldo_por_pagar" AS "saldoPorPagar",
           "saldo_congelado" AS "saldoCongelado"
      FROM "cuenta_local"
     WHERE "local_id" = ${localId}
     FOR UPDATE
  `;

  if (filas.length === 0) {
    // Un local sin movimientos financieros todavia no tiene cuenta. No es un
    // error: la vista previa es cero y la creacion responde "nada para
    // liquidar". El primer movimiento crea la cuenta en el servicio del ledger.
    return {
      saldoDeuda: 0n,
      saldoPorPagar: 0n,
      saldoCongelado: 0n,
    };
  }

  return {
    saldoDeuda: aBigInt(filas[0].saldoDeuda, 'saldo_deuda'),
    saldoPorPagar: aBigInt(filas[0].saldoPorPagar, 'saldo_por_pagar'),
    saldoCongelado: aBigInt(filas[0].saldoCongelado, 'saldo_congelado'),
  };
}

async function bloquearLiquidacion(tx, id) {
  const filas = await tx.$queryRaw`
    SELECT "id"
      FROM "liquidacion"
     WHERE "id" = ${id}
     FOR UPDATE
  `;

  if (filas.length === 0) {
    throw errorNoEncontrado('Liquidacion no encontrada.');
  }
}

async function movimientosElegibles(tx, localId) {
  const filas = await tx.$queryRaw`
    SELECT l."id", l."tipo", l."monto"
      FROM "ledger" l
     WHERE l."local_id" = ${localId}
       AND l."tipo" IN ('liberacion', 'reembolso')
       AND NOT EXISTS (
         SELECT 1
           FROM "liquidacion_movimiento" lm
           JOIN "liquidacion" liq ON liq."id" = lm."liquidacion_id"
          WHERE lm."ledger_id" = l."id"
            AND liq."estado" IN ('en_proceso', 'pagada')
       )
     ORDER BY l."id" ASC
  `;

  let montoReembolsado = 0n;
  for (const fila of filas) {
    if (fila.tipo === 'reembolso') {
      montoReembolsado += aBigInt(fila.monto, 'monto_reembolsado');
    }
  }

  return { movimientos: filas, montoReembolsado };
}

function calcularVistaPrevia(cuenta, montoReembolsado) {
  const disponible = cuenta.saldoPorPagar;
  const montoLiberado = disponible + montoReembolsado;
  const montoCompensado =
    cuenta.saldoDeuda < disponible ? cuenta.saldoDeuda : disponible;
  const totalPagado = disponible - montoCompensado;

  return {
    disponible,
    montoLiberado,
    montoReembolsado,
    montoCompensado,
    totalPagado,
  };
}

async function leerMontoMinimo(tx) {
  const config = await obtenerConfiguracionEnTransaccion(tx, [
    'monto_minimo_liquidacion',
  ]);
  const valor = config.monto_minimo_liquidacion;
  return BigInt(
    typeof valor === 'number' && Number.isFinite(valor)
      ? Math.max(0, Math.trunc(valor))
      : 0,
  );
}

function errorEstadoInvalido(estado) {
  return new ErrorApi(
    'liquidacion_estado_invalido',
    `La liquidacion esta en estado ${estado} y no permite esa operacion.`,
    409,
  );
}

function errorDatosCambiaron() {
  return new ErrorApi(
    'liquidacion_datos_cambiaron',
    'Los saldos o reembolsos del local cambiaron desde que se creo el borrador. Crea una liquidacion nueva.',
    409,
  );
}

function errorNadaParaLiquidar() {
  return new ErrorApi(
    'liquidacion_nada_para_liquidar',
    'El local no tiene saldo liberado disponible para liquidar.',
    409,
  );
}

async function hayActividadNueva(tx, liquidacion) {
  const desde = liquidacion.fechaCreacion;

  const [reembolsos, disputas] = await Promise.all([
    tx.reembolso.count({
      where: {
        subPedido: { localId: liquidacion.localId },
        OR: [
          { fecha: { gt: desde } },
          { completadoEn: { gt: desde } },
        ],
        estado: { in: ['pendiente', 'completado'] },
      },
    }),
    tx.disputa.count({
      where: {
        subPedido: { localId: liquidacion.localId },
        OR: [
          { fechaApertura: { gt: desde } },
          { fechaResolucion: { gt: desde } },
        ],
      },
    }),
  ]);

  return reembolsos > 0 || disputas > 0;
}

const INCLUIR_LISTA = {
  local: {
    select: {
      id: true,
      nombre: true,
      estado: true,
      banco: true,
      tipoCuentaBancaria: true,
      numeroCuentaCifrado: true,
      titularCuenta: true,
      documentoTitularCifrado: true,
    },
  },
};

const INCLUIR_DETALLE = {
  ...INCLUIR_LISTA,
  movimientos: {
    include: { ledger: true },
    orderBy: [{ ledgerId: 'asc' }],
  },
};

function respuesta(liquidacion, opciones = {}) {
  return convertirBigIntAJson(
    serializarLiquidacion(liquidacion, opciones),
  );
}

function traducirErrorUnico(err, codigo, mensaje) {
  if (err?.code === 'P2002') {
    return new ErrorApi(codigo, mensaje, 409);
  }
  return err;
}

// ---------------------------------------------------------------------------
// Crear borrador
// ---------------------------------------------------------------------------

export async function crearLiquidacion({
  admin,
  datos,
  idempotenciaId = null,
}) {
  try {
    return await withTransaccion(async (tx) => {
      const local = await tx.local.findUnique({
        where: { id: datos.local_id },
        select: {
          id: true,
          nombre: true,
          estado: true,
          banco: true,
          tipoCuentaBancaria: true,
          numeroCuentaCifrado: true,
          titularCuenta: true,
          documentoTitularCifrado: true,
        },
      });

      if (!local) throw errorNoEncontrado('Local no encontrado.');

      if (local.estado === 'suspendido' && !datos.confirmar_local_suspendido) {
        throw new ErrorApi(
          'liquidacion_local_suspendido',
          'El local esta suspendido. Confirma explicitamente que quieres liquidarlo.',
          409,
        );
      }

      // El lock de la cuenta serializa las creaciones del mismo local y evita
      // que dos administradores calculen la misma vista previa a la vez.
      const cuenta = await bloquearCuenta(tx, local.id);

      const abierta = await tx.liquidacion.findFirst({
        where: {
          localId: local.id,
          estado: { in: ESTADOS_ABIERTOS },
        },
        select: { id: true },
      });

      if (abierta) {
        throw new ErrorApi(
          'liquidacion_abierta',
          'El local ya tiene una liquidacion abierta.',
          409,
          { liquidacion_id: abierta.id },
        );
      }

      const { movimientos, montoReembolsado } = await movimientosElegibles(
        tx,
        local.id,
      );
      const vista = calcularVistaPrevia(cuenta, montoReembolsado);

      if (vista.disponible <= 0n) throw errorNadaParaLiquidar();

      const minimo = await leerMontoMinimo(tx);
      if (vista.disponible < minimo) {
        throw new ErrorApi(
          'liquidacion_minimo_no_alcanzado',
          `El saldo disponible (${vista.disponible} pesos) no alcanza el minimo de liquidacion (${minimo} pesos).`,
          409,
          {
            saldo_disponible: vista.disponible.toString(),
            monto_minimo: minimo.toString(),
          },
        );
      }

      const creada = await tx.liquidacion.create({
        data: {
          localId: local.id,
          estado: 'borrador',
          montoLiberado: vista.montoLiberado,
          montoReembolsado: vista.montoReembolsado,
          montoCompensado: vista.montoCompensado,
          totalPagado: vista.totalPagado,
          creadoPor: admin.id,
        },
      });

      await tx.auditoriaAdmin.create({
        data: {
          origen: 'admin',
          adminId: admin.id,
          accion: 'crear_liquidacion',
          objeto: 'liquidacion',
          objetoId: String(creada.id),
          detalle: {
            local_id: local.id,
            monto_liberado: vista.montoLiberado.toString(),
            monto_reembolsado: vista.montoReembolsado.toString(),
            monto_compensado: vista.montoCompensado.toString(),
            total_pagado: vista.totalPagado.toString(),
            movimientos_previos: movimientos.length,
          },
        },
      });

      const salida = respuesta({ ...creada, local });
      await completarEnTx(tx, idempotenciaId, 201, salida);
      return salida;
    });
  } catch (err) {
    throw traducirErrorUnico(
      err,
      'liquidacion_abierta',
      'El local ya tiene una liquidacion abierta.',
    );
  }
}

// ---------------------------------------------------------------------------
// Preparar: unico lugar donde se compensa deuda
// ---------------------------------------------------------------------------

export async function prepararLiquidacion({
  admin,
  id,
  idempotenciaId = null,
}) {
  return withTransaccion(async (tx) => {
    await bloquearLiquidacion(tx, id);

    const liquidacion = await tx.liquidacion.findUnique({
      where: { id },
      include: INCLUIR_DETALLE,
    });

    if (!liquidacion) throw errorNoEncontrado('Liquidacion no encontrada.');
    if (liquidacion.estado !== 'borrador') {
      throw errorEstadoInvalido(liquidacion.estado);
    }

    const cuenta = await bloquearCuenta(tx, liquidacion.localId);
    const { movimientos, montoReembolsado } = await movimientosElegibles(
      tx,
      liquidacion.localId,
    );
    const vista = calcularVistaPrevia(cuenta, montoReembolsado);

    if (vista.disponible <= 0n) throw errorNadaParaLiquidar();

    const huboActividad = await hayActividadNueva(tx, liquidacion);
    if (huboActividad) throw errorDatosCambiaron();

    // El borrador guardo una vista previa. Si cualquier monto cambio, se
    // invalida completo: es mas seguro recrearlo que pagar una parte distinta.
    if (
      vista.montoLiberado !== liquidacion.montoLiberado ||
      vista.montoReembolsado !== liquidacion.montoReembolsado ||
      vista.montoCompensado !== liquidacion.montoCompensado ||
      vista.totalPagado !== liquidacion.totalPagado
    ) {
      throw errorDatosCambiaron();
    }

    const minimo = await leerMontoMinimo(tx);
    if (vista.disponible < minimo) {
      throw new ErrorApi(
        'liquidacion_minimo_no_alcanzado',
        `El saldo disponible (${vista.disponible} pesos) no alcanza el minimo de liquidacion (${minimo} pesos).`,
        409,
        {
          saldo_disponible: vista.disponible.toString(),
          monto_minimo: minimo.toString(),
        },
      );
    }

    if (!cuentaBancariaCompleta(liquidacion.local)) {
      throw new ErrorApi(
        'cuenta_bancaria_incompleta',
        'El vendedor debe registrar la cuenta bancaria completa antes de preparar el pago.',
        409,
      );
    }

    const snapshot = copiarCifradoBancario(liquidacion.local);
    const ahora = new Date();

    const actualizadas = await tx.liquidacion.updateMany({
      where: { id, estado: 'borrador' },
      data: {
        estado: 'en_proceso',
        fechaPreparacion: ahora,
        preparadoPor: admin.id,
        metodoPago: 'transferencia',
        montoLiberado: vista.montoLiberado,
        montoReembolsado: vista.montoReembolsado,
        montoCompensado: vista.montoCompensado,
        totalPagado: vista.totalPagado,
        ...snapshot,
      },
    });

    if (actualizadas.count === 0) {
      throw new ErrorApi(
        'liquidacion_estado_invalido',
        'Otro proceso ya preparo esta liquidacion.',
        409,
      );
    }

    let movimientoCompensacion = null;
    let movimientoPago = null;

    if (vista.montoCompensado > 0n) {
      movimientoCompensacion = await registrarMovimiento({
        tipo: 'cobro_deuda',
        monto: vista.montoCompensado,
        localId: liquidacion.localId,
        desdeLiquidacion: true,
      });
      await tx.liquidacionMovimiento.create({
        data: {
          liquidacionId: id,
          ledgerId: movimientoCompensacion.id,
          rol: 'compensacion',
        },
      });
    }

    if (vista.totalPagado > 0n) {
      movimientoPago = await registrarMovimiento({
        tipo: 'pago_a_local',
        monto: vista.totalPagado,
        localId: liquidacion.localId,
      });
      await tx.liquidacionMovimiento.create({
        data: {
          liquidacionId: id,
          ledgerId: movimientoPago.id,
          rol: 'pago',
        },
      });
    }

    if (movimientos.length > 0) {
      await tx.liquidacionMovimiento.createMany({
        data: movimientos.map((movimiento) => ({
          liquidacionId: id,
          ledgerId: movimiento.id,
          rol: movimiento.tipo === 'liberacion' ? 'liberacion' : 'reembolso',
        })),
      });
    }

    if (vista.montoCompensado > 0n) {
      // La deuda bajo: el estado del local se decide con el saldo neto.
      await recalcularEstadoLocal(liquidacion.localId, tx);
    }

    await tx.auditoriaAdmin.create({
      data: {
        origen: 'admin',
        adminId: admin.id,
        accion: 'preparar_liquidacion',
        objeto: 'liquidacion',
        objetoId: String(id),
        detalle: {
          local_id: liquidacion.localId,
          monto_liberado: vista.montoLiberado.toString(),
          monto_reembolsado: vista.montoReembolsado.toString(),
          monto_compensado: vista.montoCompensado.toString(),
          total_pagado: vista.totalPagado.toString(),
          movimiento_compensacion_id: movimientoCompensacion?.id ?? null,
          movimiento_pago_id: movimientoPago?.id ?? null,
        },
      },
    });

    const actualizada = await tx.liquidacion.findUnique({
      where: { id },
      include: INCLUIR_DETALLE,
    });

    const salida = respuesta(actualizada);
    await completarEnTx(tx, idempotenciaId, 200, salida);
    return salida;
  });
}

// ---------------------------------------------------------------------------
// Confirmar pago
// ---------------------------------------------------------------------------

export async function confirmarLiquidacion({
  admin,
  id,
  datos,
  idempotenciaId = null,
}) {
  try {
    return await withTransaccion(async (tx) => {
      await bloquearLiquidacion(tx, id);

      const liquidacion = await tx.liquidacion.findUnique({
        where: { id },
        include: INCLUIR_DETALLE,
      });

      if (!liquidacion) throw errorNoEncontrado('Liquidacion no encontrada.');
      if (liquidacion.estado !== 'en_proceso') {
        throw errorEstadoInvalido(liquidacion.estado);
      }

      const actualizadas = await tx.liquidacion.updateMany({
        where: { id, estado: 'en_proceso' },
        data: {
          estado: 'pagada',
          referenciaPayout: datos.referencia_payout,
          comprobanteUrl: datos.comprobante_url ?? null,
          fechaPago: new Date(),
          pagadoPor: admin.id,
        },
      });

      if (actualizadas.count === 0) {
        throw new ErrorApi(
          'liquidacion_estado_invalido',
          'Otro proceso ya confirmo o fallo esta liquidacion.',
          409,
        );
      }

      await tx.auditoriaAdmin.create({
        data: {
          origen: 'admin',
          adminId: admin.id,
          accion: 'confirmar_liquidacion',
          objeto: 'liquidacion',
          objetoId: String(id),
          detalle: {
            local_id: liquidacion.localId,
            referencia_payout: datos.referencia_payout,
            total_pagado: liquidacion.totalPagado.toString(),
          },
        },
      });

      const actualizada = await tx.liquidacion.findUnique({
        where: { id },
        include: INCLUIR_DETALLE,
      });

      const salida = respuesta(actualizada);
      await completarEnTx(tx, idempotenciaId, 200, salida);
      return salida;
    });
  } catch (err) {
    throw traducirErrorUnico(
      err,
      'referencia_payout_duplicada',
      'Ya existe una liquidacion con esa referencia de pago.',
    );
  }
}

// ---------------------------------------------------------------------------
// Fallar y revertir
// ---------------------------------------------------------------------------

export async function fallarLiquidacion({
  admin,
  id,
  datos,
  idempotenciaId = null,
}) {
  return withTransaccion(async (tx) => {
    await bloquearLiquidacion(tx, id);

    const liquidacion = await tx.liquidacion.findUnique({
      where: { id },
      include: INCLUIR_DETALLE,
    });

    if (!liquidacion) throw errorNoEncontrado('Liquidacion no encontrada.');
    if (liquidacion.estado !== 'en_proceso') {
      throw errorEstadoInvalido(liquidacion.estado);
    }

    await bloquearCuenta(tx, liquidacion.localId);

    const porRol = new Map(
      liquidacion.movimientos.map((movimiento) => [movimiento.rol, movimiento]),
    );

    const compensacion = porRol.get('compensacion');
    const pago = porRol.get('pago');

    if (liquidacion.montoCompensado > 0n && !compensacion) {
      throw new Error(
        `La liquidacion ${id} no tiene enlazado el cobro de deuda que debe revertir.`,
      );
    }

    if (liquidacion.totalPagado > 0n && !pago) {
      throw new Error(
        `La liquidacion ${id} no tiene enlazado el pago al local que debe revertir.`,
      );
    }

    if (compensacion) {
      const reversa = await registrarMovimiento({
        tipo: 'reversa_cobro_deuda',
        monto: compensacion.ledger.monto,
        localId: liquidacion.localId,
        desdeLiquidacion: true,
      });
      await tx.liquidacionMovimiento.create({
        data: {
          liquidacionId: id,
          ledgerId: reversa.id,
          rol: 'reversa_cobro_deuda',
          ledgerOrigenId: compensacion.ledgerId,
        },
      });
    }

    if (pago) {
      const reversa = await registrarMovimiento({
        tipo: 'reversa_pago_a_local',
        monto: pago.ledger.monto,
        localId: liquidacion.localId,
      });
      await tx.liquidacionMovimiento.create({
        data: {
          liquidacionId: id,
          ledgerId: reversa.id,
          rol: 'reversa_pago_a_local',
          ledgerOrigenId: pago.ledgerId,
        },
      });
    }

    await recalcularEstadoLocal(liquidacion.localId, tx);

    const actualizadas = await tx.liquidacion.updateMany({
      where: { id, estado: 'en_proceso' },
      data: {
        estado: 'fallida',
        motivoFallo: datos.motivo_fallo,
      },
    });

    if (actualizadas.count === 0) {
      throw new ErrorApi(
        'liquidacion_estado_invalido',
        'Otro proceso ya confirmo o fallo esta liquidacion.',
        409,
      );
    }

    await tx.auditoriaAdmin.create({
      data: {
        origen: 'admin',
        adminId: admin.id,
        accion: 'fallar_liquidacion',
        objeto: 'liquidacion',
        objetoId: String(id),
        detalle: {
          local_id: liquidacion.localId,
          motivo_fallo: datos.motivo_fallo,
          monto_compensado_revertido: liquidacion.montoCompensado.toString(),
          total_pagado_revertido: liquidacion.totalPagado.toString(),
        },
      },
    });

    const actualizada = await tx.liquidacion.findUnique({
      where: { id },
      include: INCLUIR_DETALLE,
    });

    const salida = respuesta(actualizada);
    await completarEnTx(tx, idempotenciaId, 200, salida);
    return salida;
  });
}

// ---------------------------------------------------------------------------
// Cancelar borrador
// ---------------------------------------------------------------------------

export async function cancelarLiquidacion({
  admin,
  id,
  idempotenciaId = null,
}) {
  return withTransaccion(async (tx) => {
    await bloquearLiquidacion(tx, id);

    const liquidacion = await tx.liquidacion.findUnique({
      where: { id },
      include: INCLUIR_DETALLE,
    });

    if (!liquidacion) throw errorNoEncontrado('Liquidacion no encontrada.');
    if (liquidacion.estado !== 'borrador') {
      throw errorEstadoInvalido(liquidacion.estado);
    }

    const actualizadas = await tx.liquidacion.updateMany({
      where: { id, estado: 'borrador' },
      data: { estado: 'cancelada' },
    });

    if (actualizadas.count === 0) {
      throw new ErrorApi(
        'liquidacion_estado_invalido',
        'Otro proceso ya tomo esta liquidacion.',
        409,
      );
    }

    await tx.auditoriaAdmin.create({
      data: {
        origen: 'admin',
        adminId: admin.id,
        accion: 'cancelar_liquidacion',
        objeto: 'liquidacion',
        objetoId: String(id),
        detalle: { local_id: liquidacion.localId },
      },
    });

    const actualizada = await tx.liquidacion.findUnique({
      where: { id },
      include: INCLUIR_DETALLE,
    });

    const salida = respuesta(actualizada);
    await completarEnTx(tx, idempotenciaId, 200, salida);
    return salida;
  });
}

// ---------------------------------------------------------------------------
// Consultas
// ---------------------------------------------------------------------------

function filtrosComunes({ localId, estado }) {
  return {
    ...(localId ? { localId } : {}),
    ...(estado ? { estado } : {}),
  };
}

export async function listarLiquidacionesAdmin({
  localId,
  estado,
  pagina,
  porPagina,
}) {
  const where = filtrosComunes({ localId, estado });
  const total = await prisma.liquidacion.count({ where });
  const filas = await prisma.liquidacion.findMany({
    where,
    include: INCLUIR_LISTA,
    orderBy: [{ fechaCreacion: 'desc' }, { id: 'desc' }],
    skip: (pagina - 1) * porPagina,
    take: porPagina,
  });

  return convertirBigIntAJson(
    envolverLista(
      filas.map((fila) => serializarLiquidacion(fila)),
      { pagina, porPagina },
      total,
    ),
  );
}

async function verificarLocalVendedor(usuario, localId) {
  if (!localId) return;
  const local = await prisma.local.findFirst({
    where: { id: localId, usuarioId: usuario.id },
    select: { id: true },
  });
  if (!local) throw errorNoEncontrado('Local no encontrado.');
}

export async function listarLiquidacionesVendedor({
  usuario,
  localId,
  estado,
  pagina,
  porPagina,
}) {
  await verificarLocalVendedor(usuario, localId);

  const where = {
    ...filtrosComunes({ localId, estado }),
    ...(localId ? {} : { local: { usuarioId: usuario.id } }),
  };

  const total = await prisma.liquidacion.count({ where });
  const filas = await prisma.liquidacion.findMany({
    where,
    include: INCLUIR_LISTA,
    orderBy: [{ fechaCreacion: 'desc' }, { id: 'desc' }],
    skip: (pagina - 1) * porPagina,
    take: porPagina,
  });

  return convertirBigIntAJson(
    envolverLista(
      filas.map((fila) => serializarLiquidacion(fila)),
      { pagina, porPagina },
      total,
    ),
  );
}

export async function obtenerLiquidacionAdmin({ id, admin = null }) {
  return withTransaccion(async (tx) => {
    const liquidacion = await tx.liquidacion.findUnique({
      where: { id },
      include: INCLUIR_DETALLE,
    });

    if (!liquidacion) throw errorNoEncontrado('Liquidacion no encontrada.');

    const salida = convertirBigIntAJson(
      serializarLiquidacion(liquidacion, {
        detalle: true,
        revelarCompleto: true,
      }),
    );

    // Cada lectura del detalle admin puede exponer el numero de cuenta y el
    // documento completos. La auditoria se escribe en la misma transaccion
    // que la lectura, sin copiar los valores sensibles.
    const fuente = fuenteCuentaDestino(liquidacion);
    const campos = [];
    if (fuente?.numeroCuentaCifrado) campos.push('numero_cuenta');
    if (fuente?.documentoTitularCifrado) campos.push('documento_titular');

    await tx.auditoriaAdmin.create({
      data: {
        origen: admin ? 'admin' : 'sistema',
        adminId: admin?.id ?? null,
        accion: 'ver_datos_bancarios_liquidacion',
        objeto: 'liquidacion',
        objetoId: String(liquidacion.id),
        detalle: {
          liquidacion_id: liquidacion.id,
          local_id: liquidacion.localId,
          campos_revelados: campos,
          datos_bancarios_completos: campos.length > 0,
        },
      },
    });

    return salida;
  });
}

export async function obtenerLiquidacionVendedor({ usuario, id }) {
  const liquidacion = await prisma.liquidacion.findFirst({
    where: { id, local: { usuarioId: usuario.id } },
    include: INCLUIR_DETALLE,
  });

  if (!liquidacion) throw errorNoEncontrado('Liquidacion no encontrada.');

  return convertirBigIntAJson(
    serializarLiquidacion(liquidacion, { detalle: true }),
  );
}
