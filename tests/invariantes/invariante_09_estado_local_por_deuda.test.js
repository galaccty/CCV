import '../helpers/entorno.js';
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { estadoInvariante } from '../helpers/pendiente.js';
import { opcionesConBase, prisma, cerrarConexion } from '../helpers/base.js';
import { crearCatalogo } from '../helpers/datos.js';
import { withTransaccion } from '../../src/lib/transaccion.js';
import { registrarMovimiento } from '../../src/services/ledger.js';
import { recalcularEstadoLocal } from '../../src/services/estadoLocal.js';

/**
 * INVARIANTE 9 - el estado de un local por deuda solo lo cambia
 * recalcular_estado_local y el job diario.
 *
 * Las ramas completas de la funcion viven en
 * tests/etapa4/estadoLocal.test.js. Aca se comprueba el invariante desde la
 * base: el trigger rechaza los cambios manuales a en_plazo/bloqueado y el
 * contexto de sistema no se queda pegado a la conexion.
 */

export const ESTADO = estadoInvariante({
  aplica: true,
  etapa: 'Etapa 4a',
  motivo: 'La maquina de estados y el trigger estan activos desde la 4a.',
});

const CON_BASE = await opcionesConBase();
const DIA = new Date('2026-10-22T12:00:00.000Z');

after(async () => {
  await cerrarConexion();
});

async function mover({ tipo, monto, localId }) {
  return withTransaccion(() =>
    registrarMovimiento({ tipo, monto, localId }),
  );
}

async function recalcular(localId) {
  return withTransaccion((tx) =>
    recalcularEstadoLocal(localId, tx, { ahora: DIA }),
  );
}

async function leer(localId) {
  return prisma.local.findUnique({
    where: { id: localId },
    select: {
      estado: true,
      cuenta: {
        select: { saldoDeuda: true, fechaLimitePago: true },
      },
    },
  });
}

describe('invariante 9 - el estado de un local por deuda solo lo cambia recalcular_estado_local', () => {
  test('recalcular_estado_local cubre las ramas de deuda', CON_BASE, async () => {
    const { local } = await crearCatalogo({ estadoLocal: 'activo' });
    await mover({ tipo: 'deuda_reembolso', monto: 50001n, localId: local.id });

    await recalcular(local.id);
    const enPlazo = await leer(local.id);
    assert.equal(enPlazo.estado, 'en_plazo');
    assert.ok(enPlazo.cuenta.fechaLimitePago);

    await mover({ tipo: 'cobro_deuda', monto: 50001n, localId: local.id });
    await recalcular(local.id);
    const activo = await leer(local.id);
    assert.equal(activo.estado, 'activo');
    assert.equal(activo.cuenta.fechaLimitePago, null);
  });

  test('volver a activo limpia la fecha limite', CON_BASE, async () => {
    const { local } = await crearCatalogo({ estadoLocal: 'activo' });
    await mover({ tipo: 'deuda_reembolso', monto: 50001n, localId: local.id });
    await recalcular(local.id);
    assert.ok((await leer(local.id)).cuenta.fechaLimitePago);

    await mover({ tipo: 'cobro_deuda', monto: 50001n, localId: local.id });
    await recalcular(local.id);

    assert.equal((await leer(local.id)).cuenta.fechaLimitePago, null);
  });

  test('un local suspendido o pendiente de aprobacion no lo toca el recalculo', CON_BASE, async () => {
    for (const estado of ['suspendido', 'pendiente_aprobacion']) {
      const { local } = await crearCatalogo({ estadoLocal: estado });
      await mover({ tipo: 'deuda_reembolso', monto: 50001n, localId: local.id });
      await recalcular(local.id);
      assert.equal((await leer(local.id)).estado, estado);
    }
  });

  test('el trigger rechaza los estados de deuda manuales y el desbloqueo', CON_BASE, async () => {
    const { local } = await crearCatalogo({ estadoLocal: 'activo' });

    for (const estado of ['en_plazo', 'bloqueado']) {
      await assert.rejects(
        () => prisma.local.update({ where: { id: local.id }, data: { estado } }),
        /estado de deuda|invariante 9|restrict/i,
      );
    }

    const { local: bloqueado } = await crearCatalogo({ estadoLocal: 'bloqueado' });
    await assert.rejects(
      () =>
        prisma.local.update({
          where: { id: bloqueado.id },
          data: { estado: 'activo' },
        }),
      /estado de deuda|invariante 9|restrict/i,
    );
  });

  test('el admin puede aprobar y suspender', CON_BASE, async () => {
    const { local } = await crearCatalogo({
      estadoLocal: 'pendiente_aprobacion',
    });

    assert.equal(
      (await prisma.local.update({
        where: { id: local.id },
        data: { estado: 'activo' },
      })).estado,
      'activo',
    );
    assert.equal(
      (await prisma.local.update({
        where: { id: local.id },
        data: { estado: 'suspendido' },
      })).estado,
      'suspendido',
    );
  });

  test('el contexto de sistema no se filtra a la transaccion siguiente', CON_BASE, async () => {
    const { local } = await crearCatalogo({ estadoLocal: 'activo' });
    await mover({ tipo: 'deuda_reembolso', monto: 50001n, localId: local.id });
    await recalcular(local.id);

    await assert.rejects(
      () =>
        prisma.local.update({
          where: { id: local.id },
          data: { estado: 'bloqueado' },
        }),
      /estado de deuda|invariante 9|restrict/i,
    );
  });
});
