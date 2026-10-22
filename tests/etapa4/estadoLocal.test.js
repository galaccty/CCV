import '../helpers/entorno.js';
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {
  opcionesConBase,
  prisma,
  cerrarConexion,
  BASE_DE_PRUEBAS,
} from '../helpers/base.js';
import {
  crearCatalogo,
  crearPedidoDePrueba,
  crearPagoDePrueba,
  crearReembolsoDePrueba,
  crearUsuarioDirecto,
} from '../helpers/datos.js';
import { withTransaccion } from '../../src/lib/transaccion.js';
import { registrarMovimiento } from '../../src/services/ledger.js';
import { recalcularEstadoLocal } from '../../src/services/estadoLocal.js';
import { cambiarEstadoLocal } from '../../src/services/adminCatalogo.js';

const { Client } = pg;
const CON_BASE = await opcionesConBase();
const DIA = new Date('2026-10-22T12:00:00.000Z');
const LIMITE = 50000n;
const PLAZO = 15;

after(async () => {
  await cerrarConexion();
});

function diaEsperado(desde, dias) {
  const fecha = new Date(desde);
  fecha.setUTCHours(0, 0, 0, 0);
  fecha.setUTCDate(fecha.getUTCDate() + dias);
  return fecha.toISOString().slice(0, 10);
}

function fechaDe(fecha) {
  return fecha ? new Date(fecha).toISOString().slice(0, 10) : null;
}

async function crearLocal(estado = 'activo') {
  const { local } = await crearCatalogo({ estadoLocal: estado });
  const cuenta = await prisma.cuentaLocal.findUnique({
    where: { localId: local.id },
  });
  assert.ok(cuenta, 'el trigger debe crear la cuenta del local');
  return local;
}

async function mover({ tipo, monto, localId, subPedidoId = null }) {
  return withTransaccion(() =>
    registrarMovimiento({ tipo, monto, localId, subPedidoId }),
  );
}

async function recalcular(localId, ahora = DIA) {
  return withTransaccion((tx) =>
    recalcularEstadoLocal(localId, tx, { ahora }),
  );
}

async function leer(localId) {
  return prisma.local.findUnique({
    where: { id: localId },
    select: {
      estado: true,
      cuenta: {
        select: {
          saldoDeuda: true,
          saldoPorPagar: true,
          saldoCongelado: true,
          fechaLimitePago: true,
        },
      },
    },
  });
}

/** Cambia a bloqueado usando el mismo contexto que usaria el job diario. */
async function bloquearComoJob(localId) {
  await withTransaccion(async (tx) => {
    await tx.$queryRaw`SELECT set_config('ccv.estado_local_sistema', '1', true)`;
    await tx.local.update({
      where: { id: localId },
      data: { estado: 'bloqueado' },
    });
  });
}

async function adminPrueba() {
  return crearUsuarioDirecto({ nombre: 'Admin', roles: ['admin'] });
}

async function suspender(admin, localId) {
  return cambiarEstadoLocal({ admin, id: localId, estado: 'suspendido' });
}

async function reactivar(admin, localId) {
  return cambiarEstadoLocal({ admin, id: localId, estado: 'activo' });
}

describe('recalcular_estado_local - todas las ramas', () => {
  test('sin deuda queda activo y limpia la fecha', CON_BASE, async () => {
    const local = await crearLocal('activo');

    const resultado = await recalcular(local.id);

    const fila = await leer(local.id);
    assert.equal(fila.estado, 'activo');
    assert.equal(fila.cuenta.fechaLimitePago, null);
    assert.equal(resultado.motivo, 'sin_deuda');
  });

  test('deuda dentro del limite queda activo', CON_BASE, async () => {
    const local = await crearLocal('activo');
    await mover({ tipo: 'deuda_reembolso', monto: 10000n, localId: local.id });

    const resultado = await recalcular(local.id);

    const fila = await leer(local.id);
    assert.equal(fila.cuenta.saldoDeuda, 10000n);
    assert.equal(fila.estado, 'activo');
    assert.equal(fila.cuenta.fechaLimitePago, null);
    assert.equal(resultado.motivo, 'dentro_del_limite');
  });

  test('deuda sobre el limite pasa a en_plazo con hoy + plazo_dias', CON_BASE, async () => {
    const local = await crearLocal('activo');
    await mover({
      tipo: 'deuda_reembolso',
      monto: LIMITE + 1n,
      localId: local.id,
    });

    const resultado = await recalcular(local.id);

    const fila = await leer(local.id);
    assert.equal(fila.estado, 'en_plazo');
    assert.equal(fechaDe(fila.cuenta.fechaLimitePago), diaEsperado(DIA, PLAZO));
    assert.equal(resultado.motivo, 'sobre_limite');
  });

  test(
    'un reembolso efectivo incumplido lleva a en_plazo aunque no haya deuda',
    CON_BASE,
    async () => {
      const { local, variante } = await crearCatalogo({ estadoLocal: 'activo' });
      const { pedido, subPedido } = await crearPedidoDePrueba({
        local,
        variante,
        estadoPedido: 'completado',
        estadoSubPedido: 'entregado',
      });
      const pago = await crearPagoDePrueba({ pedido, estado: 'aprobado' });
      await crearReembolsoDePrueba({
        pago,
        subPedido,
        monto: 1000n,
        estado: 'incumplido',
        tipo: 'efectivo',
      });

      const resultado = await recalcular(local.id, DIA);

      const fila = await leer(local.id);
      assert.equal(fila.cuenta.saldoDeuda, 0n);
      assert.equal(fila.estado, 'en_plazo');
      assert.equal(fechaDe(fila.cuenta.fechaLimitePago), diaEsperado(DIA, PLAZO));
      assert.equal(resultado.motivo, 'reembolso_incumplido');
    },
  );

  test('la fecha existente nunca se corre hacia adelante', CON_BASE, async () => {
    const local = await crearLocal('activo');
    await mover({
      tipo: 'deuda_reembolso',
      monto: LIMITE + 1n,
      localId: local.id,
    });

    await recalcular(local.id, DIA);
    const fechaOriginal = (await leer(local.id)).cuenta.fechaLimitePago;

    await recalcular(local.id, new Date('2026-10-23T12:00:00.000Z'));
    const fechaSiguiente = (await leer(local.id)).cuenta.fechaLimitePago;

    assert.equal(fechaSiguiente.getTime(), fechaOriginal.getTime());
    assert.equal(fechaDe(fechaSiguiente), diaEsperado(DIA, PLAZO));
  });

  test(
    'un en_plazo que salda la deuda vuelve a activo y limpia la fecha',
    CON_BASE,
    async () => {
      const local = await crearLocal('activo');
      await mover({
        tipo: 'deuda_reembolso',
        monto: LIMITE + 1n,
        localId: local.id,
      });
      await recalcular(local.id);

      await mover({
        tipo: 'cobro_deuda',
        monto: LIMITE + 1n,
        localId: local.id,
      });
      const resultado = await recalcular(local.id);

      const fila = await leer(local.id);
      assert.equal(fila.cuenta.saldoDeuda, 0n);
      assert.equal(fila.estado, 'activo');
      assert.equal(fila.cuenta.fechaLimitePago, null);
      assert.equal(resultado.motivo, 'sin_deuda');
    },
  );

  test(
    'un bloqueado sin deuda ni incumplidos vuelve a activo y limpia la fecha',
    CON_BASE,
    async () => {
      const local = await crearLocal('activo');
      await mover({
        tipo: 'deuda_reembolso',
        monto: LIMITE + 1n,
        localId: local.id,
      });
      await recalcular(local.id);
      await bloquearComoJob(local.id);

      await mover({
        tipo: 'cobro_deuda',
        monto: LIMITE + 1n,
        localId: local.id,
      });

      const resultado = await recalcular(local.id);
      const fila = await leer(local.id);

      assert.equal(fila.estado, 'activo');
      assert.equal(fila.cuenta.fechaLimitePago, null);
      assert.equal(resultado.motivo, 'desbloqueado');
    },
  );

  test('un bloqueado con deuda sigue bloqueado', CON_BASE, async () => {
    const local = await crearLocal('bloqueado');
    await mover({ tipo: 'deuda_reembolso', monto: 1000n, localId: local.id });

    const resultado = await recalcular(local.id);

    const fila = await leer(local.id);
    assert.equal(fila.estado, 'bloqueado');
    assert.equal(resultado.motivo, 'sigue_bloqueado');
  });

  test('suspendido no se toca', CON_BASE, async () => {
    const local = await crearLocal('suspendido');
    await mover({
      tipo: 'deuda_reembolso',
      monto: LIMITE + 1n,
      localId: local.id,
    });

    const resultado = await recalcular(local.id);

    const fila = await leer(local.id);
    assert.equal(fila.estado, 'suspendido');
    assert.equal(fila.cuenta.fechaLimitePago, null);
    assert.equal(resultado.motivo, 'estado_administrativo');
  });

  test('pendiente_aprobacion no se toca', CON_BASE, async () => {
    const local = await crearLocal('pendiente_aprobacion');
    await mover({
      tipo: 'deuda_reembolso',
      monto: LIMITE + 1n,
      localId: local.id,
    });

    const resultado = await recalcular(local.id);

    const fila = await leer(local.id);
    assert.equal(fila.estado, 'pendiente_aprobacion');
    assert.equal(resultado.motivo, 'estado_administrativo');
  });
});

describe('trigger ccv_estado_local_solo_sistema', () => {
  test('rechaza poner en_plazo o bloqueado a mano', CON_BASE, async () => {
    const local = await crearLocal('activo');

    await assert.rejects(
      () => prisma.local.update({ where: { id: local.id }, data: { estado: 'en_plazo' } }),
      /estado de deuda|invariante 9|restrict/i,
    );
    await assert.rejects(
      () => prisma.local.update({ where: { id: local.id }, data: { estado: 'bloqueado' } }),
      /estado de deuda|invariante 9|restrict/i,
    );
  });

  test('rechaza desbloquear a mano', CON_BASE, async () => {
    const local = await crearLocal('bloqueado');

    await assert.rejects(
      () => prisma.local.update({ where: { id: local.id }, data: { estado: 'activo' } }),
      /estado de deuda|invariante 9|restrict/i,
    );
  });

  test('rechaza reactivar un suspendido a mano', CON_BASE, async () => {
    const local = await crearLocal('suspendido');

    await assert.rejects(
      () => prisma.local.update({ where: { id: local.id }, data: { estado: 'activo' } }),
      /estado de deuda|invariante 9|restrict/i,
    );
  });

  test('el admin puede aprobar y suspender', CON_BASE, async () => {
    const pendiente = await crearLocal('pendiente_aprobacion');
    const activo = await prisma.local.update({
      where: { id: pendiente.id },
      data: { estado: 'activo' },
    });
    assert.equal(activo.estado, 'activo');

    const suspendido = await prisma.local.update({
      where: { id: pendiente.id },
      data: { estado: 'suspendido' },
    });
    assert.equal(suspendido.estado, 'suspendido');

    const bloqueado = await crearLocal('bloqueado');
    const suspendidoDesdeBloqueado = await prisma.local.update({
      where: { id: bloqueado.id },
      data: { estado: 'suspendido' },
    });
    assert.equal(suspendidoDesdeBloqueado.estado, 'suspendido');
  });

  test(
    'el contexto marcado por recalcular no se filtra a otra transaccion',
    CON_BASE,
    async () => {
      const local = await crearLocal('activo');
      await mover({
        tipo: 'deuda_reembolso',
        monto: LIMITE + 1n,
        localId: local.id,
      });

      await recalcular(local.id);
      assert.equal((await leer(local.id)).estado, 'en_plazo');

      await assert.rejects(
        () =>
          prisma.local.update({
            where: { id: local.id },
            data: { estado: 'bloqueado' },
          }),
        /estado de deuda|invariante 9|restrict/i,
      );
    },
  );

  test(
    'set_config(..., true) no sobrevive al commit ni a otra conexion',
    CON_BASE,
    async () => {
      const local = await crearLocal('activo');
      const conexionA = new Client({ connectionString: BASE_DE_PRUEBAS });
      const conexionB = new Client({ connectionString: BASE_DE_PRUEBAS });

      try {
        await conexionA.connect();
        await conexionB.connect();

        await conexionA.query('BEGIN');
        await conexionA.query(
          `SELECT set_config('ccv.estado_local_sistema', '1', true)`,
        );
        await conexionA.query('COMMIT');

        const contexto = await conexionA.query(
          `SELECT current_setting('ccv.estado_local_sistema', true) AS valor`,
        );
        assert.ok(
          contexto.rows[0].valor === '' || contexto.rows[0].valor === null,
          'el contexto debe quedar vacio despues del commit',
        );

        await assert.rejects(
          () =>
            conexionA.query('UPDATE "local" SET "estado" = $1 WHERE "id" = $2', [
              'bloqueado',
              local.id,
            ]),
          /estado de deuda|invariante 9|restrict/i,
        );

        await assert.rejects(
          () =>
            conexionB.query('UPDATE "local" SET "estado" = $1 WHERE "id" = $2', [
              'bloqueado',
              local.id,
            ]),
          /estado de deuda|invariante 9|restrict/i,
        );
      } finally {
        await conexionA.end();
        await conexionB.end();
      }
    },
  );
});

describe('reactivacion de un local suspendido', () => {
  test('sin deuda vuelve a activo', CON_BASE, async () => {
    const admin = await adminPrueba();
    const local = await crearLocal('activo');

    await suspender(admin, local.id);
    assert.equal((await leer(local.id)).estado, 'suspendido');

    const respuesta = await reactivar(admin, local.id);
    const fila = await leer(local.id);

    assert.equal(respuesta.estado, 'activo');
    assert.equal(fila.estado, 'activo');
    assert.equal(
      (await prisma.local.findUnique({ where: { id: local.id } }))
        .estadoPrevioSuspension,
      null,
    );
  });

  test('con deuda sobre el limite vuelve a en_plazo', CON_BASE, async () => {
    const admin = await adminPrueba();
    const local = await crearLocal('activo');
    await mover({
      tipo: 'deuda_reembolso',
      monto: LIMITE + 1n,
      localId: local.id,
    });

    await suspender(admin, local.id);
    const respuesta = await reactivar(admin, local.id);
    const fila = await leer(local.id);

    assert.equal(respuesta.estado, 'en_plazo');
    assert.equal(fila.estado, 'en_plazo');
    assert.equal(fila.cuenta.saldoDeuda, LIMITE + 1n);
  });

  test('bloqueado -> suspendido -> reactivar vuelve a bloqueado', CON_BASE, async () => {
    const admin = await adminPrueba();
    const local = await crearLocal('activo');
    await mover({
      tipo: 'deuda_reembolso',
      monto: LIMITE + 1n,
      localId: local.id,
    });
    await recalcular(local.id);
    await bloquearComoJob(local.id);
    assert.equal((await leer(local.id)).estado, 'bloqueado');

    await suspender(admin, local.id);
    assert.equal((await leer(local.id)).estado, 'suspendido');
    assert.equal(
      (await prisma.local.findUnique({ where: { id: local.id } }))
        .estadoPrevioSuspension,
      'bloqueado',
    );

    const respuesta = await reactivar(admin, local.id);
    const fila = await leer(local.id);

    assert.equal(respuesta.estado, 'bloqueado');
    assert.equal(fila.estado, 'bloqueado');
    assert.equal(fila.cuenta.saldoDeuda, LIMITE + 1n);
  });
});
