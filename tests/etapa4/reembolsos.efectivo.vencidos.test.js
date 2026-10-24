import '../helpers/entorno.js';
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { opcionesConBase, prisma, cerrarConexion } from '../helpers/base.js';
import {
  crearCatalogo,
  crearPagoDePrueba,
  crearPedidoDePrueba,
  crearUsuarioDirecto,
} from '../helpers/datos.js';
import { abrirDisputa, resolverDisputa } from '../../src/services/disputas.js';
import { reembolsosEfectivoVencidos } from '../../src/jobs/reembolsosEfectivoVencidos.js';

/**
 * JOB DE REEMBOLSOS EN EFECTIVO VENCIDOS - ETAPA 4c-2b
 * ====================================================
 * El job convierte el incumplimiento en una sola deuda del local y deja el
 * estado local en `en_plazo`. Debe poder correr dos veces sin duplicar nada.
 */

const CON_BASE = await opcionesConBase();

after(async () => {
  await cerrarConexion();
});

const DIA_MS = 24 * 60 * 60 * 1000;

async function crearEscenarioVencido({ ahora = new Date() } = {}) {
  const { local, variante } = await crearCatalogo({ precio: 10000n });
  const comprador = await crearUsuarioDirecto({
    nombre: 'Comprador',
    roles: ['comprador'],
  });
  const admin = await crearUsuarioDirecto({
    nombre: 'Admin',
    roles: ['admin'],
  });
  const pedido = await crearPedidoDePrueba({
    local,
    variante,
    compradorId: comprador.id,
    cantidad: 1,
    metodoPago: 'efectivo',
    estadoPedido: 'en_proceso',
    estadoSubPedido: 'entregado',
  });
  await crearPagoDePrueba({
    pedido: pedido.pedido,
    metodoPago: 'efectivo',
    estado: 'aprobado',
  });

  const disputa = await abrirDisputa({
    usuario: comprador,
    subPedidoId: pedido.subPedido.id,
    datos: {
      motivo: 'No recibio el dinero de vuelta.',
      lineas: [
        {
          detalle_id: pedido.detalle.id,
          cantidad: 1,
        },
      ],
    },
  });

  // Se resuelve diez dias atras: la fecha limite del reembolso en efectivo
  // queda cinco dias atras (dias_reembolso_efectivo = 5 en las pruebas).
  const resolucion = await resolverDisputa({
    disputaId: disputa.id,
    admin,
    datos: {
      favor: 'comprador',
      resolucion: 'Se ordena devolver el dinero en efectivo.',
      lineas: [
        {
          detalle_id: pedido.detalle.id,
          cantidad: 1,
        },
      ],
    },
    ahora: new Date(ahora.getTime() - 10 * DIA_MS),
  });

  return {
    ...pedido,
    local,
    admin,
    disputa,
    reembolso: resolucion.reembolso,
  };
}

describe('job reembolsos en efectivo vencidos', () => {
  test('vence, escribe una deuda y deja el local en en_plazo', CON_BASE, async () => {
    const escenario = await crearEscenarioVencido();
    const ahora = new Date();

    assert.equal(escenario.reembolso.tipo, 'efectivo');
    assert.equal(escenario.reembolso.estado, 'pendiente');
    assert.ok(new Date(escenario.reembolso.fecha_limite) < ahora);

    const resultado = await reembolsosEfectivoVencidos({ ahora });

    assert.equal(resultado.revisados, 1);
    assert.equal(resultado.incumplidos, 1);

    const reembolso = await prisma.reembolso.findUnique({
      where: { id: escenario.reembolso.id },
    });
    assert.equal(reembolso.estado, 'incumplido');

    const deudas = await prisma.ledger.findMany({
      where: {
        reembolsoId: reembolso.id,
        tipo: 'deuda_reembolso',
      },
    });
    assert.equal(deudas.length, 1);
    assert.equal(deudas[0].monto, 10000n);
    assert.equal(deudas[0].localId, escenario.local.id);

    const local = await prisma.local.findUnique({
      where: { id: escenario.local.id },
    });
    assert.equal(local.estado, 'en_plazo');

    const cuenta = await prisma.cuentaLocal.findUnique({
      where: { localId: escenario.local.id },
    });
    assert.equal(cuenta.saldoDeuda, 10000n);

    const sub = await prisma.subPedido.findUnique({
      where: { id: escenario.subPedido.id },
    });
    assert.equal(sub.estado, 'en_disputa');

    // Segunda corrida: no hay pendientes nuevos y la deuda no se duplica.
    const segunda = await reembolsosEfectivoVencidos({ ahora });
    assert.deepEqual(segunda, { revisados: 0, incumplidos: 0 });
    assert.equal(
      await prisma.ledger.count({
        where: {
          reembolsoId: reembolso.id,
          tipo: 'deuda_reembolso',
        },
      }),
      1,
    );
    assert.equal(
      (
        await prisma.cuentaLocal.findUnique({
          where: { localId: escenario.local.id },
        })
      ).saldoDeuda,
      10000n,
    );
    assert.equal(
      (
        await prisma.local.findUnique({
          where: { id: escenario.local.id },
        })
      ).estado,
      'en_plazo',
    );
  });

  test('dos ejecuciones concurrentes solo vencen el reembolso una vez', CON_BASE, async () => {
    const escenario = await crearEscenarioVencido();
    const ahora = new Date();

    const resultados = await Promise.all([
      reembolsosEfectivoVencidos({ ahora }),
      reembolsosEfectivoVencidos({ ahora }),
    ]);

    assert.equal(
      resultados.reduce((total, fila) => total + fila.incumplidos, 0),
      1,
    );
    assert.equal(
      await prisma.ledger.count({
        where: {
          reembolsoId: escenario.reembolso.id,
          tipo: 'deuda_reembolso',
        },
      }),
      1,
    );
  });

  test('no toca un reembolso en efectivo cuya fecha limite aun no llego', CON_BASE, async () => {
    const escenario = await crearEscenarioVencido();
    const antesDeVencer = new Date(
      new Date(escenario.reembolso.fecha_limite).getTime() - 1000,
    );

    const resultado = await reembolsosEfectivoVencidos({
      ahora: antesDeVencer,
    });

    assert.equal(resultado.incumplidos, 0);
    assert.equal(
      (
        await prisma.reembolso.findUnique({
          where: { id: escenario.reembolso.id },
        })
      ).estado,
      'pendiente',
    );
  });
});
