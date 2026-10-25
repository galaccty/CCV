import '../helpers/entorno.js';
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { estadoInvariante } from '../helpers/pendiente.js';
import { opcionesConBase, prisma, cerrarConexion } from '../helpers/base.js';
import {
  crearCatalogo,
  crearCuentaBancariaDePrueba,
  crearPagoDePrueba,
  crearPedidoDePrueba,
  crearUsuarioDirecto,
} from '../helpers/datos.js';
import { withTransaccion } from '../../src/lib/transaccion.js';
import { registrarMovimiento } from '../../src/services/ledger.js';
import { recalcularEstadoLocal } from '../../src/services/estadoLocal.js';
import {
  crearLiquidacion,
  prepararLiquidacion,
} from '../../src/services/liquidaciones.js';

/**
 * INVARIANTE 8 - la deuda se compensa solo en liquidacion y solo con saldo liberado.
 *
 * Las ramas completas (reversas, concurrencia, limites y totales) viven en
 * tests/etapa4/liquidaciones.test.js. Aca se fija el invariante: una deuda no
 * se descuenta sola al generarse ni al liberarse saldo, el saldo que todavia
 * no se libero no se toca y la compensacion solo ocurre en la preparacion.
 */

export const ESTADO = estadoInvariante({
  aplica: true,
  etapa: 'Etapa 4e',
  motivo:
    'La compensacion de deuda existe desde la 4e y solo se ejecuta al preparar una liquidacion.',
});

const CON_BASE = await opcionesConBase();

after(async () => {
  await cerrarConexion();
});

async function asentar(datos) {
  return withTransaccion(() => registrarMovimiento(datos));
}

async function crearAdmin() {
  return crearUsuarioDirecto({
    nombre: 'Admin invariante 8',
    roles: ['admin'],
  });
}

async function cuentaDe(localId) {
  return prisma.cuentaLocal.findUnique({ where: { localId } });
}

async function crearBorrador(admin, localId) {
  return crearLiquidacion({ admin, datos: { local_id: localId } });
}

describe('invariante 8 - la deuda se compensa solo en liquidacion y solo con saldo liberado', () => {
  test(
    'nunca se compensa de forma continua: la deuda y la liberacion no se tocan solas',
    CON_BASE,
    async () => {
      const { local, variante } = await crearCatalogo();
      await crearCuentaBancariaDePrueba(local);

      // Una venta en efectivo deja comision adeudada, no saldo a pagar.
      await crearPedidoDePrueba({
        local,
        variante,
        metodoPago: 'efectivo',
        estadoPedido: 'completado',
        estadoSubPedido: 'entregado',
        comision: 500n,
      });
      await asentar({ tipo: 'comision', monto: 500n, localId: local.id });

      const conDeuda = await cuentaDe(local.id);
      assert.equal(conDeuda.saldoDeuda, 500n);
      assert.equal(conDeuda.saldoPorPagar, 0n);

      // Liberar saldo tampoco dispara una compensacion automatica.
      await asentar({ tipo: 'liberacion', monto: 200n, localId: local.id });

      const conSaldo = await cuentaDe(local.id);
      assert.equal(conSaldo.saldoDeuda, 500n);
      assert.equal(conSaldo.saldoPorPagar, 200n);
      assert.equal(
        await prisma.ledger.count({
          where: { localId: local.id, tipo: 'cobro_deuda' },
        }),
        0,
        'la deuda no puede compensarse al generarse ni al liberar saldo',
      );

      const admin = await crearAdmin();
      const borrador = await crearBorrador(admin, local.id);
      assert.equal(
        await prisma.ledger.count({
          where: { localId: local.id, tipo: 'cobro_deuda' },
        }),
        0,
        'crear el borrador solo calcula la vista previa',
      );

      await prepararLiquidacion({ admin, id: borrador.id });

      const compensada = await cuentaDe(local.id);
      assert.equal(compensada.saldoDeuda, 300n);
      assert.equal(compensada.saldoPorPagar, 0n);
      assert.equal(
        await prisma.ledger.count({
          where: { localId: local.id, tipo: 'cobro_deuda' },
        }),
        1,
      );
    },
  );

  test(
    'no se compensa saldo retenido: solo el saldo ya liberado entra al lote',
    CON_BASE,
    async () => {
      const { local, variante } = await crearCatalogo();
      await crearCuentaBancariaDePrueba(local);

      // Venta digital entregada pero todavia no liberada.
      const { pedido, subPedido } = await crearPedidoDePrueba({
        local,
        variante,
        cantidad: 1,
        estadoPedido: 'completado',
        estadoSubPedido: 'entregado',
        comision: 0n,
      });
      await crearPagoDePrueba({
        pedido,
        monto: pedido.total,
        estado: 'aprobado',
      });

      await asentar({ tipo: 'comision', monto: 100n, localId: local.id });

      const retenido = await prisma.subPedido.findUnique({
        where: { id: subPedido.id },
        select: { saldoLiberadoEn: true, estado: true },
      });
      assert.equal(retenido.saldoLiberadoEn, null);
      assert.equal(retenido.estado, 'entregado');

      const admin = await crearAdmin();
      await assert.rejects(
        () => crearBorrador(admin, local.id),
        (err) => {
          assert.equal(err.codigo, 'liquidacion_nada_para_liquidar');
          return true;
        },
      );

      const sinLote = await cuentaDe(local.id);
      assert.equal(sinLote.saldoDeuda, 100n);
      assert.equal(sinLote.saldoPorPagar, 0n);
      assert.equal(
        await prisma.ledger.count({
          where: { localId: local.id, tipo: 'cobro_deuda' },
        }),
        0,
      );

      // Ahora hay 40 liberados de otra operacion. El saldo retenido de la
      // venta digital sigue sin entrar al lote ni pagarse.
      await asentar({ tipo: 'liberacion', monto: 40n, localId: local.id });
      const borrador = await crearBorrador(admin, local.id);
      assert.equal(borrador.monto_liberado, 40);
      assert.equal(borrador.monto_compensado, 40);
      assert.equal(borrador.total_pagado, 0);

      await prepararLiquidacion({ admin, id: borrador.id });

      const despues = await prisma.subPedido.findUnique({
        where: { id: subPedido.id },
        select: { saldoLiberadoEn: true },
      });
      assert.equal(despues.saldoLiberadoEn, null);
      assert.equal(
        await prisma.ledger.count({
          where: {
            tipo: 'liberacion',
            subPedidoId: subPedido.id,
          },
        }),
        0,
        'la liquidacion no puede liberar por su cuenta saldo retenido',
      );

      const cuenta = await cuentaDe(local.id);
      assert.equal(cuenta.saldoDeuda, 60n);
      assert.equal(cuenta.saldoPorPagar, 0n);
    },
  );

  test(
    'si no alcanza, compensa lo disponible y el resto sigue como deuda',
    CON_BASE,
    async () => {
      const { local } = await crearCatalogo();
      await crearCuentaBancariaDePrueba(local);
      await asentar({ tipo: 'deuda_reembolso', monto: 100n, localId: local.id });
      await asentar({ tipo: 'liberacion', monto: 40n, localId: local.id });

      const admin = await crearAdmin();
      const borrador = await crearBorrador(admin, local.id);
      assert.equal(borrador.monto_compensado, 40);
      assert.equal(borrador.total_pagado, 0);

      await prepararLiquidacion({ admin, id: borrador.id });

      const cuenta = await cuentaDe(local.id);
      assert.equal(cuenta.saldoDeuda, 60n);
      assert.equal(cuenta.saldoPorPagar, 0n);
      assert.equal(
        await prisma.ledger.count({
          where: { localId: local.id, tipo: 'pago_a_local' },
        }),
        0,
      );
    },
  );

  test(
    'limite_deuda se evalua sobre el saldo neto despues de compensar',
    CON_BASE,
    async () => {
      const { local } = await crearCatalogo({ estadoLocal: 'activo' });
      await crearCuentaBancariaDePrueba(local);
      await asentar({
        tipo: 'deuda_reembolso',
        monto: 60000n,
        localId: local.id,
      });
      await asentar({ tipo: 'liberacion', monto: 10000n, localId: local.id });

      await withTransaccion((tx) => recalcularEstadoLocal(local.id, tx));

      const antes = await prisma.local.findUnique({
        where: { id: local.id },
        select: { estado: true },
      });
      assert.equal(antes.estado, 'en_plazo');

      const admin = await crearAdmin();
      const borrador = await crearBorrador(admin, local.id);
      await prepararLiquidacion({ admin, id: borrador.id });

      const cuenta = await cuentaDe(local.id);
      assert.equal(cuenta.saldoDeuda, 50000n);
      assert.equal(cuenta.saldoPorPagar, 0n);

      const despues = await prisma.local.findUnique({
        where: { id: local.id },
        select: {
          estado: true,
          cuenta: { select: { fechaLimitePago: true } },
        },
      });
      assert.equal(despues.estado, 'activo');
      assert.equal(despues.cuenta.fechaLimitePago, null);
    },
  );
});
