import '../helpers/entorno.js';
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { opcionesConBase, prisma, cerrarConexion } from '../helpers/base.js';
import {
  crearCatalogo,
  crearPedidoDePrueba,
} from '../helpers/datos.js';
import { withTransaccion } from '../../src/lib/transaccion.js';
import { registrarMovimiento } from '../../src/services/ledger.js';
import { conciliar } from '../../src/jobs/conciliar.js';
import { verificarIntegridad } from '../../src/jobs/integridad.js';

/**
 * CONCILIACION E INTEGRIDAD - ETAPA 4F-2
 * =======================================
 * Para provocar una diferencia real hay que saltarse los triggers que
 * protegen los saldos y los totales. Se usa `session_replication_role=replica`
 * dentro de una transaccion de prueba. El job debe detectar el daño, dejar una
 * alerta y NO corregir ni un peso: la reparacion siempre es manual.
 */

const CON_BASE = await opcionesConBase();

after(async () => {
  await cerrarConexion();
});

async function escribirSaltandoTriggers(sql) {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(
      "SET LOCAL session_replication_role = replica",
    );
    await tx.$executeRawUnsafe(sql);
  });
}

async function prepararLocalConDeuda(monto = 5000n) {
  const { local } = await crearCatalogo({ precio: 10000n });

  await withTransaccion((tx) =>
    registrarMovimiento({
      tipo: 'comision',
      monto,
      localId: local.id,
    }),
  );

  return local;
}

describe('job conciliacion_nocturna', () => {
  test(
    'detecta una cuenta alterada, deduplica la alerta y no corrige la cuenta',
    CON_BASE,
    async () => {
      const local = await prepararLocalConDeuda(5000n);
      const cuentaAntes = await prisma.cuentaLocal.findUnique({
        where: { localId: local.id },
      });
      assert.equal(cuentaAntes.saldoDeuda, 5000n);

      const alterado = cuentaAntes.saldoDeuda + 700n;

      try {
        await escribirSaltandoTriggers(
          `UPDATE "cuenta_local" SET "saldo_deuda" = ${alterado} WHERE "local_id" = ${local.id}`,
        );

        const primero = await conciliar({ localIds: [local.id] });
        assert.equal(primero.revisados, 1);
        assert.equal(primero.con_diferencias, 1);
        assert.equal(primero.alertas, 1);

        const alerta = await prisma.alerta.findUnique({
          where: { clave: `conciliacion:local:${local.id}` },
        });
        assert.ok(alerta);
        assert.equal(alerta.tipo, 'conciliacion_saldo');
        assert.equal(alerta.estado, 'abierta');
        assert.equal(alerta.localId, local.id);
        assert.equal(alerta.detalle.diferencias[0].campo, 'saldo_deuda');
        assert.equal(
          alerta.detalle.diferencias[0].cuenta,
          alterado.toString(),
        );
        assert.equal(alerta.detalle.diferencias[0].ledger, '5000');

        const creadaEn = alerta.creadaEn;
        const primeraDeteccion = alerta.ultimaDeteccionEn;

        const cuentaDespues = await prisma.cuentaLocal.findUnique({
          where: { localId: local.id },
        });
        assert.equal(
          cuentaDespues.saldoDeuda,
          alterado,
          'el job no debe corregir la cuenta',
        );

        await new Promise((resolve) => setTimeout(resolve, 20));
        const segundo = await conciliar({ localIds: [local.id] });
        assert.equal(segundo.con_diferencias, 1);
        assert.equal(segundo.alertas, 1);

        const alertaFinal = await prisma.alerta.findUnique({
          where: { clave: `conciliacion:local:${local.id}` },
        });
        assert.ok(alertaFinal);
        assert.equal(
          alertaFinal.id,
          alerta.id,
          'la misma inconsistencia debe reutilizar la alerta abierta',
        );
        assert.equal(alertaFinal.estado, 'abierta');
        assert.equal(
          alertaFinal.creadaEn.getTime(),
          creadaEn.getTime(),
          'la fecha de creacion no debe cambiar',
        );
        assert.ok(
          alertaFinal.ultimaDeteccionEn > primeraDeteccion,
          'la fecha de ultima deteccion debe actualizarse',
        );
        assert.equal(
          await prisma.alerta.count({
            where: {
              clave: `conciliacion:local:${local.id}`,
            },
          }),
          1,
        );
        assert.equal(
          (
            await prisma.cuentaLocal.findUnique({
              where: { localId: local.id },
            })
          ).saldoDeuda,
          alterado,
        );
      } finally {
        await escribirSaltandoTriggers(
          `UPDATE "cuenta_local" SET "saldo_deuda" = ${cuentaAntes.saldoDeuda} WHERE "local_id" = ${local.id}`,
        );
      }
    },
  );
});

describe('job verificacion_integridad', () => {
  test('detecta un total inconsistente y no lo corrige', CON_BASE, async () => {
    const { local, variante } = await crearCatalogo({ precio: 10000n });
    const { pedido } = await crearPedidoDePrueba({
      local,
      variante,
      metodoPago: 'tarjeta',
      estadoPedido: 'en_proceso',
      estadoSubPedido: 'preparando',
    });

    const totalOriginal = pedido.total;
    const totalAlterado = totalOriginal + 100n;

    try {
      await escribirSaltandoTriggers(
        `UPDATE "pedido" SET "total" = ${totalAlterado} WHERE "id" = ${pedido.id}`,
      );

      const primero = await verificarIntegridad({
        pedidoIds: [pedido.id],
        localIds: [local.id],
      });
      assert.ok(primero.pedidos_revisados >= 1);
      assert.ok(primero.diferencias >= 1);

      const alerta = await prisma.alerta.findUnique({
        where: { clave: `integridad:pedido_total:${pedido.id}` },
      });
      assert.ok(alerta);
      assert.equal(alerta.tipo, 'integridad_total_pedido');
      assert.equal(alerta.estado, 'abierta');
      assert.equal(alerta.detalle.total_pedido, totalAlterado.toString());
      assert.equal(alerta.detalle.suma_sub_pedidos, totalOriginal.toString());

      const pedidoDb = await prisma.pedido.findUnique({
        where: { id: pedido.id },
      });
      assert.equal(
        pedidoDb.total,
        totalAlterado,
        'el job no debe reparar el total',
      );

      const segundo = await verificarIntegridad({
        pedidoIds: [pedido.id],
        localIds: [local.id],
      });
      assert.ok(segundo.diferencias >= 1);
      assert.equal(
        await prisma.alerta.count({
          where: { clave: `integridad:pedido_total:${pedido.id}` },
        }),
        1,
      );
      assert.equal(
        (
          await prisma.pedido.findUnique({
            where: { id: pedido.id },
          })
        ).total,
        totalAlterado,
      );
    } finally {
      await escribirSaltandoTriggers(
        `UPDATE "pedido" SET "total" = ${totalOriginal} WHERE "id" = ${pedido.id}`,
      );
    }
  });
});
