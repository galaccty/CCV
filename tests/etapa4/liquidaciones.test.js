import '../helpers/entorno.js';
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { opcionesConBase, prisma, cerrarConexion } from '../helpers/base.js';
import {
  crearCatalogo,
  crearCuentaBancariaDePrueba,
  crearPagoDePrueba,
  crearPedidoConLineas,
  crearPedidoDePrueba,
  crearReembolsoDePrueba,
  crearUsuarioDirecto,
  sembrarConfiguracion,
} from '../helpers/datos.js';
import { withTransaccion } from '../../src/lib/transaccion.js';
import { registrarMovimiento } from '../../src/services/ledger.js';
import { recalcularEstadoLocal } from '../../src/services/estadoLocal.js';
import {
  cancelarLiquidacion,
  confirmarLiquidacion,
  crearLiquidacion,
  fallarLiquidacion,
  listarLiquidacionesAdmin,
  obtenerLiquidacionAdmin,
  obtenerLiquidacionVendedor,
  prepararLiquidacion,
} from '../../src/services/liquidaciones.js';
import {
  completarReembolso,
  crearReembolso,
} from '../../src/services/reembolsos.js';

/**
 * LIQUIDACIONES Y COMPENSACION - ETAPA 4e
 * =======================================
 * Cubre la deuda compensada total y parcial, el saldo congelado, el limite
 * sobre el neto, los totales, los snapshots, las reversas, la inmutabilidad,
 * la concurrencia y la carrera con un reembolso.
 *
 * Cada prueba crea su propio local. La base de pruebas se comparte entre
 * archivos, asi que nunca se asume que una liquidacion es la unica del sistema.
 */

const CON_BASE = await opcionesConBase();

after(async () => {
  await cerrarConexion();
});

function clave(prefijo = 'liquidacion') {
  return `${prefijo}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

async function asentar(datos) {
  return withTransaccion(() => registrarMovimiento(datos));
}

async function crearAdmin() {
  return crearUsuarioDirecto({ nombre: 'Admin de liquidaciones', roles: ['admin'] });
}

async function crearEscenario({
  liberado = 0n,
  reembolsado = 0n,
  deuda = 0n,
  congelado = 0n,
  banco = true,
  estadoLocal = 'activo',
  numeroCuenta = '000123456789',
  documentoTitular = '1020304050',
} = {}) {
  const { local, vendedor, variante } = await crearCatalogo({ estadoLocal });

  if (banco) {
    await crearCuentaBancariaDePrueba(local, {
      numero_cuenta: numeroCuenta,
      documento_titular: documentoTitular,
    });
  }

  if (liberado > 0n) {
    await asentar({ tipo: 'liberacion', monto: liberado, localId: local.id });
  }

  if (reembolsado > 0n) {
    await asentar({ tipo: 'reembolso', monto: reembolsado, localId: local.id });
  }

  if (congelado > 0n) {
    await asentar({ tipo: 'congelacion', monto: congelado, localId: local.id });
  }

  if (deuda > 0n) {
    await asentar({ tipo: 'deuda_reembolso', monto: deuda, localId: local.id });
  }

  return { local, vendedor, variante };
}

async function cuentaDe(localId) {
  return prisma.cuentaLocal.findUnique({ where: { localId } });
}

async function crearBorrador(admin, localId) {
  return crearLiquidacion({ admin, datos: { local_id: localId } });
}

async function capturarError(promesa) {
  try {
    await promesa;
    return null;
  } catch (err) {
    return err;
  }
}

describe('liquidaciones - compensacion de deuda', () => {
  test(
    'deuda 100 y saldo liberado 40: deuda 60, total pagado 0 y cuenta en cero',
    CON_BASE,
    async () => {
      const { local } = await crearEscenario({ liberado: 40n, deuda: 100n });
      const admin = await crearAdmin();

      const borrador = await crearBorrador(admin, local.id);
      assert.equal(borrador.estado, 'borrador');
      assert.equal(borrador.monto_liberado, 40);
      assert.equal(borrador.monto_reembolsado, 0);
      assert.equal(borrador.monto_compensado, 40);
      assert.equal(borrador.total_pagado, 0);
      assert.equal(borrador.cuenta_destino.numero_cuenta_enmascarado, '****6789');
      assert.equal(
        borrador.cuenta_destino.documento_titular_enmascarado,
        '****4050',
      );
      assert.equal(
        JSON.stringify(borrador).includes('000123456789'),
        false,
        'el numero completo no puede salir en la respuesta del borrador',
      );

      // Crear no compensa ni mueve el ledger: solo hace la vista previa.
      const antes = await cuentaDe(local.id);
      assert.equal(antes.saldoDeuda, 100n);
      assert.equal(antes.saldoPorPagar, 40n);
      assert.equal(
        await prisma.ledger.count({ where: { localId: local.id } }),
        2,
      );

      const preparada = await prepararLiquidacion({ admin, id: borrador.id });
      assert.equal(preparada.estado, 'en_proceso');
      assert.equal(preparada.monto_compensado, 40);
      assert.equal(preparada.total_pagado, 0);

      const despues = await cuentaDe(local.id);
      assert.equal(despues.saldoDeuda, 60n);
      assert.equal(despues.saldoPorPagar, 0n);
      assert.equal(despues.saldoCongelado, 0n);

      const cobros = await prisma.ledger.findMany({
        where: { localId: local.id, tipo: 'cobro_deuda' },
      });
      assert.equal(cobros.length, 1);
      assert.equal(cobros[0].monto, 40n);
      assert.equal(
        await prisma.ledger.count({
          where: { localId: local.id, tipo: 'pago_a_local' },
        }),
        0,
        'con total pagado 0 no debe existir pago al local',
      );

      const enlaces = await prisma.liquidacionMovimiento.findMany({
        where: { liquidacionId: borrador.id },
        include: { ledger: true },
        orderBy: { ledgerId: 'asc' },
      });
      assert.deepEqual(
        enlaces.map((enlace) => enlace.rol).sort(),
        ['compensacion', 'liberacion'],
      );

      const pagada = await confirmarLiquidacion({
        admin,
        id: borrador.id,
        datos: {
          referencia_payout: clave('pago-total'),
          comprobante_url: null,
        },
      });
      assert.equal(pagada.estado, 'pagada');
      assert.ok(pagada.fecha_pago);
      assert.equal(pagada.referencia_payout.startsWith('pago-total-'), true);

      const final = await cuentaDe(local.id);
      assert.equal(final.saldoDeuda, 60n);
      assert.equal(final.saldoPorPagar, 0n);
      assert.equal(final.saldoCongelado, 0n);
      assert.equal(
        await prisma.ledger.count({
          where: { localId: local.id, tipo: 'pago_a_local' },
        }),
        0,
      );
    },
  );

  test(
    'compensacion parcial: total pagado = liberado - compensado y la cuenta queda en cero',
    CON_BASE,
    async () => {
      const { local } = await crearEscenario({
        liberado: 30000n,
        deuda: 5000n,
      });
      const admin = await crearAdmin();

      const borrador = await crearBorrador(admin, local.id);
      assert.equal(borrador.monto_liberado, 30000);
      assert.equal(borrador.monto_compensado, 5000);
      assert.equal(borrador.total_pagado, 25000);

      const preparada = await prepararLiquidacion({ admin, id: borrador.id });
      assert.equal(preparada.estado, 'en_proceso');
      assert.equal(preparada.monto_compensado, 5000);
      assert.equal(preparada.total_pagado, 25000);

      const despues = await cuentaDe(local.id);
      assert.equal(despues.saldoDeuda, 0n);
      assert.equal(despues.saldoPorPagar, 0n);
      assert.equal(despues.saldoCongelado, 0n);

      const movimientos = await prisma.ledger.findMany({
        where: { localId: local.id },
        orderBy: { id: 'asc' },
      });
      const compensacion = movimientos.find(
        (movimiento) => movimiento.tipo === 'cobro_deuda',
      );
      const pago = movimientos.find(
        (movimiento) => movimiento.tipo === 'pago_a_local',
      );
      assert.equal(compensacion.monto, 5000n);
      assert.equal(pago.monto, 25000n);

      const pagada = await confirmarLiquidacion({
        admin,
        id: borrador.id,
        datos: { referencia_payout: clave('parcial') },
      });
      assert.equal(pagada.estado, 'pagada');
      assert.equal(pagada.total_pagado, 25000);
    },
  );

  test(
    'el saldo congelado no se compensa ni se toca',
    CON_BASE,
    async () => {
      const { local } = await crearEscenario({
        liberado: 100n,
        congelado: 60n,
        deuda: 100n,
      });
      const admin = await crearAdmin();

      const borrador = await crearBorrador(admin, local.id);
      assert.equal(borrador.monto_liberado, 40);
      assert.equal(borrador.monto_compensado, 40);
      assert.equal(borrador.total_pagado, 0);

      await prepararLiquidacion({ admin, id: borrador.id });

      const cuenta = await cuentaDe(local.id);
      assert.equal(cuenta.saldoDeuda, 60n);
      assert.equal(cuenta.saldoPorPagar, 0n);
      assert.equal(cuenta.saldoCongelado, 60n);
      assert.equal(
        await prisma.ledger.count({
          where: { localId: local.id, tipo: 'cobro_deuda' },
        }),
        1,
      );
    },
  );

  test(
    'limite_deuda se evalua sobre el saldo neto despues de compensar',
    CON_BASE,
    async () => {
      const { local } = await crearEscenario({
        liberado: 10000n,
        deuda: 60000n,
      });
      const admin = await crearAdmin();

      await withTransaccion((tx) => recalcularEstadoLocal(local.id, tx));
      const antes = await prisma.local.findUnique({
        where: { id: local.id },
        select: { estado: true },
      });
      assert.equal(antes.estado, 'en_plazo');

      const borrador = await crearBorrador(admin, local.id);
      assert.equal(borrador.monto_compensado, 10000);
      assert.equal(borrador.total_pagado, 0);

      await prepararLiquidacion({ admin, id: borrador.id });

      const cuenta = await cuentaDe(local.id);
      const despues = await prisma.local.findUnique({
        where: { id: local.id },
        select: {
          estado: true,
          cuenta: { select: { fechaLimitePago: true } },
        },
      });

      assert.equal(cuenta.saldoDeuda, 50000n);
      assert.equal(cuenta.saldoPorPagar, 0n);
      assert.equal(despues.estado, 'activo');
      assert.equal(despues.cuenta.fechaLimitePago, null);
    },
  );
});

describe('liquidaciones - minimos y contenido del lote', () => {
  test(
    'rechaza crear sin saldo liberado o por debajo del minimo',
    CON_BASE,
    async () => {
      const admin = await crearAdmin();
      const sinSaldo = await crearEscenario({ deuda: 100n });

      // Un local que nunca tuvo movimientos tampoco tiene fila de cuenta.
      const { local: sinCuenta } = await crearCatalogo();
      const errorSinCuenta = await capturarError(
        crearBorrador(admin, sinCuenta.id),
      );
      assert.equal(
        errorSinCuenta?.codigo,
        'liquidacion_nada_para_liquidar',
      );

      const errorSinSaldo = await capturarError(
        crearBorrador(admin, sinSaldo.local.id),
      );
      assert.equal(errorSinSaldo?.codigo, 'liquidacion_nada_para_liquidar');
      assert.equal(
        await prisma.liquidacion.count({
          where: { localId: sinSaldo.local.id },
        }),
        0,
      );

      const { local } = await crearEscenario({ liberado: 5000n });

      await sembrarConfiguracion({ monto_minimo_liquidacion: 10000 });
      try {
        const errorMinimo = await capturarError(crearBorrador(admin, local.id));
        assert.equal(
          errorMinimo?.codigo,
          'liquidacion_minimo_no_alcanzado',
        );
        assert.equal(
          await prisma.liquidacion.count({ where: { localId: local.id } }),
          0,
        );
      } finally {
        await sembrarConfiguracion({ monto_minimo_liquidacion: 0 });
      }
    },
  );

  test(
    'los reembolsos previos entran en monto_liberado y quedan enlazados',
    CON_BASE,
    async () => {
      const { local } = await crearEscenario({
        liberado: 10000n,
        reembolsado: 3000n,
      });
      const admin = await crearAdmin();

      const borrador = await crearBorrador(admin, local.id);
      assert.equal(borrador.monto_liberado, 10000);
      assert.equal(borrador.monto_reembolsado, 3000);
      assert.equal(borrador.monto_compensado, 0);
      assert.equal(borrador.total_pagado, 7000);

      await prepararLiquidacion({ admin, id: borrador.id });
      const cuenta = await cuentaDe(local.id);
      assert.equal(cuenta.saldoPorPagar, 0n);
      assert.equal(cuenta.saldoDeuda, 0n);

      const enlaces = await prisma.liquidacionMovimiento.findMany({
        where: { liquidacionId: borrador.id },
        include: { ledger: true },
        orderBy: { ledgerId: 'asc' },
      });
      assert.deepEqual(
        enlaces.map((enlace) => enlace.rol).sort(),
        ['liberacion', 'pago', 'reembolso'],
      );

      const pago = enlaces.find((enlace) => enlace.rol === 'pago');
      assert.equal(pago.ledger.monto, 7000n);
    },
  );

  test(
    'un reembolso nuevo despues del borrador invalida la preparacion',
    CON_BASE,
    async () => {
      const { local, variante } = await crearEscenario({
        liberado: 100n,
        deuda: 200n,
      });
      const admin = await crearAdmin();
      const { pedido, subPedido } = await crearPedidoDePrueba({
        local,
        variante,
        estadoPedido: 'completado',
        estadoSubPedido: 'entregado',
      });
      const pago = await crearPagoDePrueba({ pedido, estado: 'aprobado' });

      const borrador = await crearBorrador(admin, local.id);
      assert.equal(borrador.monto_compensado, 100);
      assert.equal(borrador.total_pagado, 0);

      // El reembolso queda pendiente y no mueve el ledger, pero es actividad
      // nueva del local: el borrador ya no representa el estado actual.
      await crearReembolsoDePrueba({
        pago,
        subPedido,
        monto: 1000n,
        estado: 'pendiente',
      });

      const error = await capturarError(
        prepararLiquidacion({ admin, id: borrador.id }),
      );
      assert.equal(error?.codigo, 'liquidacion_datos_cambiaron');

      const cuenta = await cuentaDe(local.id);
      assert.equal(cuenta.saldoDeuda, 200n);
      assert.equal(cuenta.saldoPorPagar, 100n);
      const sigue = await prisma.liquidacion.findUnique({
        where: { id: borrador.id },
        select: { estado: true },
      });
      assert.equal(sigue.estado, 'borrador');
    },
  );

  test(
    'exige cuenta bancaria al preparar y conserva el snapshot aunque el vendedor la cambie',
    CON_BASE,
    async () => {
      const { local, vendedor } = await crearEscenario({
        liberado: 10000n,
        banco: false,
      });
      const admin = await crearAdmin();

      const borrador = await crearBorrador(admin, local.id);
      const sinCuenta = await capturarError(
        prepararLiquidacion({ admin, id: borrador.id }),
      );
      assert.equal(sinCuenta?.codigo, 'cuenta_bancaria_incompleta');
      assert.equal((await cuentaDe(local.id)).saldoPorPagar, 10000n);

      await crearCuentaBancariaDePrueba(local, {
        numero_cuenta: '111122223333',
        documento_titular: '555566667777',
      });

      const preparada = await prepararLiquidacion({ admin, id: borrador.id });
      assert.equal(preparada.estado, 'en_proceso');
      assert.equal(
        preparada.cuenta_destino.numero_cuenta_enmascarado,
        '****3333',
      );

      const detalle = await obtenerLiquidacionAdmin({ id: borrador.id });
      assert.equal(detalle.cuenta_destino.numero_cuenta, '111122223333');
      assert.equal(detalle.cuenta_destino.documento_titular, '555566667777');

      await crearCuentaBancariaDePrueba(local, {
        numero_cuenta: '999988887777',
        documento_titular: '444433332222',
      });

      const detalleDespues = await obtenerLiquidacionAdmin({ id: borrador.id });
      assert.equal(
        detalleDespues.cuenta_destino.numero_cuenta,
        '111122223333',
        'el admin debe ver el snapshot, no la cuenta actual',
      );
      assert.equal(
        detalleDespues.cuenta_destino.documento_titular,
        '555566667777',
      );

      const detalleVendedor = await obtenerLiquidacionVendedor({
        usuario: vendedor,
        id: borrador.id,
      });
      assert.equal(
        detalleVendedor.cuenta_destino.numero_cuenta_enmascarado,
        '****3333',
      );
      assert.equal(detalleVendedor.cuenta_destino.numero_cuenta, undefined);
      assert.equal(
        JSON.stringify(detalleVendedor).includes('111122223333'),
        false,
      );

      const lista = await listarLiquidacionesAdmin({
        localId: local.id,
        pagina: 1,
        porPagina: 50,
      });
      const fila = lista.datos.find((item) => item.id === borrador.id);
      assert.ok(fila);
      assert.equal(fila.cuenta_destino.numero_cuenta, undefined);
      assert.equal(fila.cuenta_destino.numero_cuenta_enmascarado, '****3333');

      const cifrados = await prisma.$queryRaw`
        SELECT "numero_cuenta_destino_cifrado",
               "documento_titular_destino_cifrado",
               "banco_destino",
               "titular_destino"
          FROM "liquidacion"
         WHERE "id" = ${borrador.id}
      `;
      assert.equal(cifrados.length, 1);
      assert.equal(
        JSON.stringify(cifrados[0]).includes('111122223333'),
        false,
      );
      assert.equal(
        JSON.stringify(cifrados[0]).includes('555566667777'),
        false,
      );
    },
  );
});

describe('liquidaciones - concurrencia', () => {
  test(
    'dos creaciones simultaneas dejan una sola liquidacion abierta',
    CON_BASE,
    async () => {
      const { local } = await crearEscenario({ liberado: 10000n });
      const admin = await crearAdmin();

      const resultados = await Promise.allSettled([
        crearBorrador(admin, local.id),
        crearBorrador(admin, local.id),
      ]);

      const exitosas = resultados.filter((r) => r.status === 'fulfilled');
      const fallidas = resultados.filter((r) => r.status === 'rejected');

      assert.equal(exitosas.length, 1);
      assert.equal(fallidas.length, 1);
      assert.equal(fallidas[0].reason.codigo, 'liquidacion_abierta');
      assert.equal(
        await prisma.liquidacion.count({
          where: {
            localId: local.id,
            estado: { in: ['borrador', 'en_proceso'] },
          },
        }),
        1,
      );
    },
  );

  test(
    'dos preparaciones simultaneas asientan una sola vez',
    CON_BASE,
    async () => {
      const { local } = await crearEscenario({
        liberado: 30000n,
        deuda: 5000n,
      });
      const admin = await crearAdmin();
      const borrador = await crearBorrador(admin, local.id);

      const resultados = await Promise.allSettled([
        prepararLiquidacion({ admin, id: borrador.id }),
        prepararLiquidacion({ admin, id: borrador.id }),
      ]);

      const exitosas = resultados.filter((r) => r.status === 'fulfilled');
      const fallidas = resultados.filter((r) => r.status === 'rejected');
      assert.equal(exitosas.length, 1);
      assert.equal(fallidas.length, 1);
      assert.equal(fallidas[0].reason.codigo, 'liquidacion_estado_invalido');

      const cuenta = await cuentaDe(local.id);
      assert.equal(cuenta.saldoDeuda, 0n);
      assert.equal(cuenta.saldoPorPagar, 0n);
      assert.equal(
        await prisma.ledger.count({
          where: { localId: local.id, tipo: 'cobro_deuda' },
        }),
        1,
      );
      assert.equal(
        await prisma.ledger.count({
          where: { localId: local.id, tipo: 'pago_a_local' },
        }),
        1,
      );
    },
  );

  test(
    'confirmar y fallar a la vez dejan un solo resultado terminal coherente',
    CON_BASE,
    async () => {
      const { local } = await crearEscenario({
        liberado: 10000n,
        deuda: 4000n,
      });
      const admin = await crearAdmin();
      const borrador = await crearBorrador(admin, local.id);
      await prepararLiquidacion({ admin, id: borrador.id });

      const resultados = await Promise.allSettled([
        confirmarLiquidacion({
          admin,
          id: borrador.id,
          datos: { referencia_payout: clave('carrera-confirmar') },
        }),
        fallarLiquidacion({
          admin,
          id: borrador.id,
          datos: { motivo_fallo: 'El banco no confirmo la transferencia.' },
        }),
      ]);

      const exitosas = resultados.filter((r) => r.status === 'fulfilled');
      const fallidas = resultados.filter((r) => r.status === 'rejected');
      assert.equal(exitosas.length, 1);
      assert.equal(fallidas.length, 1);
      assert.equal(fallidas[0].reason.codigo, 'liquidacion_estado_invalido');

      const fila = await prisma.liquidacion.findUnique({
        where: { id: borrador.id },
        select: { estado: true },
      });
      const cuenta = await cuentaDe(local.id);

      if (fila.estado === 'pagada') {
        assert.equal(cuenta.saldoDeuda, 0n);
        assert.equal(cuenta.saldoPorPagar, 0n);
        assert.equal(
          await prisma.ledger.count({
            where: { localId: local.id, tipo: 'reversa_pago_a_local' },
          }),
          0,
        );
      } else {
        assert.equal(fila.estado, 'fallida');
        assert.equal(cuenta.saldoDeuda, 4000n);
        assert.equal(cuenta.saldoPorPagar, 10000n);
        assert.equal(
          await prisma.ledger.count({
            where: { localId: local.id, tipo: 'reversa_cobro_deuda' },
          }),
          1,
        );
        assert.equal(
          await prisma.ledger.count({
            where: { localId: local.id, tipo: 'reversa_pago_a_local' },
          }),
          1,
        );
      }
    },
  );

  test(
    'dos confirmaciones simultaneas pagan una sola vez',
    CON_BASE,
    async () => {
      const { local } = await crearEscenario({ liberado: 10000n });
      const admin = await crearAdmin();
      const borrador = await crearBorrador(admin, local.id);
      await prepararLiquidacion({ admin, id: borrador.id });

      const resultados = await Promise.allSettled([
        confirmarLiquidacion({
          admin,
          id: borrador.id,
          datos: { referencia_payout: clave('confirmar-a') },
        }),
        confirmarLiquidacion({
          admin,
          id: borrador.id,
          datos: { referencia_payout: clave('confirmar-b') },
        }),
      ]);

      const exitosas = resultados.filter((r) => r.status === 'fulfilled');
      const fallidas = resultados.filter((r) => r.status === 'rejected');
      assert.equal(exitosas.length, 1);
      assert.equal(fallidas.length, 1);
      assert.equal(fallidas[0].reason.codigo, 'liquidacion_estado_invalido');

      const fila = await prisma.liquidacion.findUnique({
        where: { id: borrador.id },
        select: { estado: true, referenciaPayout: true },
      });
      assert.equal(fila.estado, 'pagada');
      assert.ok(fila.referenciaPayout);
    },
  );
});

describe('liquidaciones - fallas, reversas e inmutabilidad', () => {
  test(
    'fallar devuelve exactamente los saldos y permite liquidar de nuevo',
    CON_BASE,
    async () => {
      const { local } = await crearEscenario({
        liberado: 10000n,
        deuda: 4000n,
      });
      const admin = await crearAdmin();
      const borrador = await crearBorrador(admin, local.id);

      await prepararLiquidacion({ admin, id: borrador.id });
      const durante = await cuentaDe(local.id);
      assert.equal(durante.saldoDeuda, 0n);
      assert.equal(durante.saldoPorPagar, 0n);

      const fallida = await fallarLiquidacion({
        admin,
        id: borrador.id,
        datos: { motivo_fallo: 'El banco rechazo la transferencia.' },
      });

      assert.equal(fallida.estado, 'fallida');
      assert.equal(fallida.motivo_fallo, 'El banco rechazo la transferencia.');
      assert.equal(fallida.fecha_pago, null);

      const restaurada = await cuentaDe(local.id);
      assert.equal(restaurada.saldoDeuda, 4000n);
      assert.equal(restaurada.saldoPorPagar, 10000n);
      assert.equal(restaurada.saldoCongelado, 0n);

      const enlaces = await prisma.liquidacionMovimiento.findMany({
        where: { liquidacionId: borrador.id },
        include: { ledger: true },
        orderBy: { ledgerId: 'asc' },
      });
      const porRol = new Map(enlaces.map((enlace) => [enlace.rol, enlace]));

      assert.ok(porRol.has('liberacion'));
      assert.ok(porRol.has('compensacion'));
      assert.ok(porRol.has('pago'));
      assert.ok(porRol.has('reversa_cobro_deuda'));
      assert.ok(porRol.has('reversa_pago_a_local'));

      const compensacion = porRol.get('compensacion');
      const pago = porRol.get('pago');
      const reversaCompensacion = porRol.get('reversa_cobro_deuda');
      const reversaPago = porRol.get('reversa_pago_a_local');

      assert.equal(reversaCompensacion.ledgerOrigenId, compensacion.ledgerId);
      assert.equal(reversaCompensacion.ledger.tipo, 'reversa_cobro_deuda');
      assert.equal(reversaCompensacion.ledger.monto, 4000n);
      assert.equal(reversaPago.ledgerOrigenId, pago.ledgerId);
      assert.equal(reversaPago.ledger.tipo, 'reversa_pago_a_local');
      assert.equal(reversaPago.ledger.monto, 6000n);

      const nuevoBorrador = await crearBorrador(admin, local.id);
      assert.equal(nuevoBorrador.monto_liberado, 10000);
      assert.equal(nuevoBorrador.monto_compensado, 4000);
      assert.equal(nuevoBorrador.total_pagado, 6000);

      await prepararLiquidacion({ admin, id: nuevoBorrador.id });
      const pagada = await confirmarLiquidacion({
        admin,
        id: nuevoBorrador.id,
        datos: { referencia_payout: clave('reintento') },
      });
      assert.equal(pagada.estado, 'pagada');

      const final = await cuentaDe(local.id);
      assert.equal(final.saldoDeuda, 0n);
      assert.equal(final.saldoPorPagar, 0n);

      const fallidas = await prisma.liquidacion.count({
        where: { localId: local.id, estado: 'fallida' },
      });
      assert.equal(fallidas, 1);
    },
  );

  test(
    'una liquidacion pagada es inmutable y los enlaces no se borran',
    CON_BASE,
    async () => {
      const { local } = await crearEscenario({ liberado: 10000n });
      const admin = await crearAdmin();
      const borrador = await crearBorrador(admin, local.id);
      await prepararLiquidacion({ admin, id: borrador.id });
      await confirmarLiquidacion({
        admin,
        id: borrador.id,
        datos: { referencia_payout: clave('inmutable') },
      });

      const enlaces = await prisma.liquidacionMovimiento.findMany({
        where: { liquidacionId: borrador.id },
      });
      assert.ok(enlaces.length > 0);
      const enlace = enlaces[0];

      const cancelar = await capturarError(
        cancelarLiquidacion({ admin, id: borrador.id }),
      );
      const fallar = await capturarError(
        fallarLiquidacion({
          admin,
          id: borrador.id,
          datos: { motivo_fallo: 'Ya estaba pagada.' },
        }),
      );
      const preparar = await capturarError(
        prepararLiquidacion({ admin, id: borrador.id }),
      );

      for (const error of [cancelar, fallar, preparar]) {
        assert.equal(error?.codigo, 'liquidacion_estado_invalido');
      }

      await assert.rejects(
        () =>
          prisma.liquidacion.update({
            where: { id: borrador.id },
            data: { totalPagado: 1n },
          }),
        /inmutable|invariante 11|restrict/i,
      );
      await assert.rejects(
        () => prisma.liquidacion.delete({ where: { id: borrador.id } }),
        /no se borran|invariante 11|restrict/i,
      );
      await assert.rejects(
        () =>
          prisma.liquidacionMovimiento.delete({
            where: {
              liquidacionId_ledgerId: {
                liquidacionId: enlace.liquidacionId,
                ledgerId: enlace.ledgerId,
              },
            },
          }),
        /no se modifican|invariante 11|restrict/i,
      );

      const fila = await prisma.liquidacion.findUnique({
        where: { id: borrador.id },
      });
      assert.ok(fila);
      assert.equal(fila.estado, 'pagada');
      assert.equal(fila.totalPagado, 10000n);
    },
  );

  test(
    'la referencia de payout no se puede repetir entre liquidaciones',
    CON_BASE,
    async () => {
      const admin = await crearAdmin();
      const primera = await crearEscenario({ liberado: 10000n });
      const segunda = await crearEscenario({ liberado: 20000n });

      const borradorA = await crearBorrador(admin, primera.local.id);
      const borradorB = await crearBorrador(admin, segunda.local.id);
      await prepararLiquidacion({ admin, id: borradorA.id });
      await prepararLiquidacion({ admin, id: borradorB.id });

      const referencia = clave('duplicada');
      await confirmarLiquidacion({
        admin,
        id: borradorA.id,
        datos: { referencia_payout: referencia },
      });

      const error = await capturarError(
        confirmarLiquidacion({
          admin,
          id: borradorB.id,
          datos: { referencia_payout: referencia },
        }),
      );
      assert.equal(error?.codigo, 'referencia_payout_duplicada');

      const sigue = await prisma.liquidacion.findUnique({
        where: { id: borradorB.id },
        select: { estado: true },
      });
      assert.equal(sigue.estado, 'en_proceso');

      const pagada = await confirmarLiquidacion({
        admin,
        id: borradorB.id,
        datos: { referencia_payout: clave('unica') },
      });
      assert.equal(pagada.estado, 'pagada');
    },
  );

  test(
    'cancelar un borrador no mueve el ledger y permite crear otro',
    CON_BASE,
    async () => {
      const { local } = await crearEscenario({ liberado: 10000n });
      const admin = await crearAdmin();
      const ledgerAntes = await prisma.ledger.count({
        where: { localId: local.id },
      });

      const borrador = await crearBorrador(admin, local.id);
      const cancelada = await cancelarLiquidacion({
        admin,
        id: borrador.id,
      });
      assert.equal(cancelada.estado, 'cancelada');

      assert.equal(
        await prisma.ledger.count({ where: { localId: local.id } }),
        ledgerAntes,
      );
      assert.equal(
        await prisma.liquidacionMovimiento.count({
          where: { liquidacionId: borrador.id },
        }),
        0,
      );
      const cuenta = await cuentaDe(local.id);
      assert.equal(cuenta.saldoPorPagar, 10000n);

      const segundo = await crearBorrador(admin, local.id);
      assert.notEqual(segundo.id, borrador.id);
      const error = await capturarError(
        confirmarLiquidacion({
          admin,
          id: borrador.id,
          datos: { referencia_payout: clave('cancelada') },
        }),
      );
      assert.equal(error?.codigo, 'liquidacion_estado_invalido');
    },
  );
});

describe('liquidaciones - carrera con un reembolso', () => {
  test(
    'completar un reembolso durante la preparacion nunca deja saldos negativos',
    CON_BASE,
    async () => {
      const { local, variante } = await crearCatalogo({ precio: 5000n });
      await crearCuentaBancariaDePrueba(local);
      const { pedido, subPedido, detalles } = await crearPedidoConLineas({
        local,
        lineas: [{ variante, cantidad: 2 }],
        estadoPedido: 'completado',
        estadoSubPedido: 'entregado',
        comision: 0n,
        configSnapshot: {
          porcentaje_comision: 0,
          comision_minima: 0,
          pedido_minimo: 0,
          tarifa_base_envio: 0,
          tarifa_por_km: 0,
          dias_retencion: 0,
          tomado_en: new Date().toISOString(),
        },
      });
      const pago = await crearPagoDePrueba({
        pedido,
        monto: pedido.total,
        estado: 'aprobado',
      });

      await asentar({
        tipo: 'liberacion',
        monto: 10000n,
        localId: local.id,
        subPedidoId: subPedido.id,
      });
      await prisma.subPedido.update({
        where: { id: subPedido.id },
        data: { saldoLiberadoEn: new Date() },
      });

      const reembolso = await crearReembolso({
        subPedidoId: subPedido.id,
        datos: {
          motivo: 'Producto incompleto',
          lineas: [{ detalle_id: detalles[0].id, cantidad: 1 }],
        },
      });
      assert.equal(reembolso.monto, 5000);

      const admin = await crearAdmin();
      const borrador = await crearBorrador(admin, local.id);
      assert.equal(borrador.monto_liberado, 5000);
      assert.equal(borrador.total_pagado, 5000);

      const resultados = await Promise.allSettled([
        prepararLiquidacion({ admin, id: borrador.id }),
        completarReembolso({ reembolsoId: reembolso.id }),
      ]);

      const preparacion = resultados[0];
      const completado = resultados[1];
      assert.equal(completado.status, 'fulfilled', completado.reason?.message);

      const cuenta = await cuentaDe(local.id);
      assert.ok(cuenta.saldoDeuda >= 0n);
      assert.ok(cuenta.saldoPorPagar >= 0n);
      assert.ok(cuenta.saldoCongelado >= 0n);
      assert.equal(cuenta.saldoCongelado, 0n);

      const liquidacion = await prisma.liquidacion.findUnique({
        where: { id: borrador.id },
        select: { estado: true },
      });

      if (preparacion.status === 'fulfilled') {
        assert.equal(liquidacion.estado, 'en_proceso');
        assert.equal(cuenta.saldoPorPagar, 0n);
        assert.equal(cuenta.saldoDeuda, 0n);
        assert.equal(
          await prisma.ledger.count({
            where: { localId: local.id, tipo: 'pago_a_local' },
          }),
          1,
        );
      } else {
        assert.equal(
          preparacion.reason.codigo,
          'liquidacion_datos_cambiaron',
        );
        assert.equal(liquidacion.estado, 'borrador');
        assert.equal(cuenta.saldoPorPagar, 5000n);
        assert.equal(cuenta.saldoDeuda, 0n);
        assert.equal(
          await prisma.ledger.count({
            where: { localId: local.id, tipo: 'pago_a_local' },
          }),
          0,
        );
      }
    },
  );
});
