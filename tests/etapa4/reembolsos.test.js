import '../helpers/entorno.js';
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { opcionesConBase, prisma, cerrarConexion } from '../helpers/base.js';
import {
  crearCatalogo,
  crearPagoDePrueba,
  crearPedidoConLineas,
  crearPedidoDePrueba,
} from '../helpers/datos.js';
import { crearVariante } from '../../src/services/stock.js';
import { crearUsuarioConSesion } from '../helpers/http.js';
import { withTransaccion } from '../../src/lib/transaccion.js';
import { registrarMovimiento } from '../../src/services/ledger.js';
import { calcularMontoLiberacion } from '../../src/services/liberacion.js';
import {
  completarReembolso,
  crearReembolso,
  fallarReembolso,
} from '../../src/services/reembolsos.js';

/**
 * REEMBOLSOS POR LINEA - ETAPA 4c-2a
 * ===================================
 * Se prueba el circuito completo sin la resolucion de disputas de 4c-2b:
 *
 *   - el backend calcula con precios congelados y descarta montos del cliente;
 *   - completar antes de liberar asienta el reembolso y la reversa de comision
 *     de plataforma, sin tocar el saldo del vendedor;
 *   - completar despues de liberar mueve el ledger local, revierte comision y
 *     usa el saldo congelado/disponible antes de crear deuda;
 *   - las lineas y snapshots no cambian;
 *   - el pago queda conciliado con la suma de reembolsos completados.
 */

const CON_BASE = await opcionesConBase();

after(async () => {
  await cerrarConexion();
});

async function asentar(datos) {
  return withTransaccion(() => registrarMovimiento(datos));
}

async function cuenta(localId) {
  const fila = await prisma.cuentaLocal.findUnique({ where: { localId } });
  assert.ok(fila, 'el local debe tener cuenta_local');
  return fila;
}

async function movimientosDe(reembolsoId) {
  return prisma.ledger.findMany({
    where: { reembolsoId },
    orderBy: { id: 'asc' },
  });
}

async function crearEscenario({
  cantidad = 1,
  precio = 10000n,
  comision = 0n,
  costoEnvio = 0n,
  metodoPago = 'tarjeta',
  estadoSubPedido = 'entregado',
  liberar = false,
  pagar = 0n,
  pagoMonto = null,
} = {}) {
  const { local, variante } = await crearCatalogo({ precio });
  const pedido = await crearPedidoDePrueba({
    local,
    variante,
    cantidad,
    comision,
    costoEnvio,
    metodoPago,
    estadoPedido: 'en_proceso',
    estadoSubPedido,
  });

  const pago = await crearPagoDePrueba({
    pedido: pedido.pedido,
    monto: pagoMonto ?? pedido.pedido.total,
    metodoPago,
    estado: 'aprobado',
  });

  if (comision > 0n) {
    await asentar({
      tipo: 'comision',
      monto: comision,
      subPedidoId: pedido.subPedido.id,
      pagoId: pago.id,
    });
  }

  if (liberar) {
    const monto = calcularMontoLiberacion(pedido.subPedido);
    await asentar({
      tipo: 'liberacion',
      monto,
      localId: local.id,
      subPedidoId: pedido.subPedido.id,
    });
    await prisma.subPedido.update({
      where: { id: pedido.subPedido.id },
      data: { saldoLiberadoEn: new Date() },
    });
  }

  if (pagar > 0n) {
    await asentar({
      tipo: 'pago_a_local',
      monto: pagar,
      localId: local.id,
      subPedidoId: pedido.subPedido.id,
    });
  }

  return { ...pedido, local, variante, pago };
}

function cuerpoReembolso({ detalleId, cantidad = 1, extra = {} } = {}) {
  return {
    motivo: 'Reembolso de prueba',
    lineas: [{ detalle_id: detalleId, cantidad }],
    ...extra,
  };
}

async function crearReembolsoDeEscenario(escenario, opciones = {}) {
  return crearReembolso({
    subPedidoId: escenario.subPedido.id,
    datos: cuerpoReembolso({
      detalleId: escenario.detalle.id,
      ...opciones,
    }),
    registradoPor: opciones.registradoPor ?? null,
  });
}

describe('reembolsos - calculo con precios congelados', () => {
  test('ignora montos del cliente y calcula con detalle_producto', CON_BASE, async () => {
    const escenario = await crearEscenario({ cantidad: 2, precio: 10000n });

    const reembolso = await crearReembolso({
      subPedidoId: escenario.subPedido.id,
      datos: cuerpoReembolso({
        detalleId: escenario.detalle.id,
        cantidad: 1,
        extra: {
          // El cliente intenta imponer el monto. El backend debe ignorarlo.
          monto: 1,
          monto_envio: 1,
          incluye_envio: false,
        },
      }),
    });

    assert.equal(reembolso.monto, 10000);
    assert.equal(reembolso.monto_envio, 0);
    assert.equal(reembolso.incluye_envio, false);
    assert.equal(reembolso.lineas.length, 1);
    assert.equal(reembolso.lineas[0].detalle_id, escenario.detalle.id);
    assert.equal(reembolso.lineas[0].cantidad, 1);
    assert.equal(reembolso.lineas[0].monto, 10000);

    const enBase = await prisma.reembolso.findUnique({
      where: { id: reembolso.id },
      include: { lineas: true },
    });
    assert.equal(enBase.monto, 10000n);
    assert.equal(enBase.lineas[0].monto, 10000n);
  });

  test('no permite reembolsar mas de lo cobrado en el pago', CON_BASE, async () => {
    const escenario = await crearEscenario({
      cantidad: 3,
      precio: 10000n,
      pagoMonto: 20000n,
    });

    await assert.rejects(
      () =>
        crearReembolso({
          subPedidoId: escenario.subPedido.id,
          datos: cuerpoReembolso({
            detalleId: escenario.detalle.id,
            cantidad: 3,
          }),
        }),
      (err) => err.codigo === 'reembolso_excede_pago',
    );

    assert.equal(
      await prisma.reembolso.count({
        where: { subPedidoId: escenario.subPedido.id },
      }),
      0,
    );
  });

  test('no incluye envio si el sub-pedido ya fue entregado', CON_BASE, async () => {
    const escenario = await crearEscenario({
      cantidad: 1,
      precio: 10000n,
      costoEnvio: 2000n,
    });

    await assert.rejects(
      () =>
        crearReembolso({
          subPedidoId: escenario.subPedido.id,
          datos: cuerpoReembolso({
            detalleId: escenario.detalle.id,
            extra: { incluye_envio: true },
          }),
        }),
      (err) => err.codigo === 'envio_no_reembolsable',
    );
  });

  test('la base rechaza un reembolso cuyas lineas no suman el monto', CON_BASE, async () => {
    const escenario = await crearEscenario({ cantidad: 1, precio: 10000n });

    await assert.rejects(
      () =>
        prisma.reembolso.create({
          data: {
            pagoId: escenario.pago.id,
            subPedidoId: escenario.subPedido.id,
            tipo: 'digital',
            monto: 10000n,
            estado: 'pendiente',
            motivo: 'sin lineas',
          },
        }),
      /no coincide con el monto|reembolso/i,
    );

    assert.equal(
      await prisma.reembolso.count({
        where: { subPedidoId: escenario.subPedido.id },
      }),
      0,
    );
  });
});

describe('reembolsos - completar antes y despues de liberar', () => {
  test('antes de liberar asienta reembolso y reversa de plataforma, sin tocar al vendedor', CON_BASE, async () => {
    const escenario = await crearEscenario({
      cantidad: 1,
      precio: 10000n,
      comision: 2000n,
    });

    const reembolso = await crearReembolsoDeEscenario(escenario);
    assert.equal(reembolso.monto, 10000);
    assert.equal(reembolso.desde_congelado, false);

    const completado = await completarReembolso({
      reembolsoId: reembolso.id,
    });

    assert.equal(completado.estado, 'completado');
    assert.equal(completado.completado_en !== null, true);

    const movimientos = await movimientosDe(reembolso.id);
    assert.deepEqual(
      movimientos.map((movimiento) => [
        movimiento.tipo,
        movimiento.localId,
        movimiento.monto,
      ]),
      [
        ['reembolso', null, 10000n],
        ['reversa_comision', null, 2000n],
      ],
    );

    const cuentaLocal = await cuenta(escenario.local.id);
    assert.equal(cuentaLocal.saldoPorPagar, 0n);
    assert.equal(cuentaLocal.saldoCongelado, 0n);
    assert.equal(cuentaLocal.saldoDeuda, 0n);

    const pago = await prisma.pago.findUnique({
      where: { id: escenario.pago.id },
    });
    assert.equal(pago.montoReembolsado, 10000n);
    assert.equal(pago.estado, 'reembolsado');

    const subPedido = await prisma.subPedido.findUnique({
      where: { id: escenario.subPedido.id },
    });
    assert.equal(subPedido.estado, 'reembolsado');
    assert.equal(subPedido.subtotalProductos, 10000n);
    assert.equal(subPedido.comision, 2000n);
    assert.equal(subPedido.total, 10000n);
  });

  test('despues de liberar usa congelado, revierte comision y deja la cuenta en cero', CON_BASE, async () => {
    const escenario = await crearEscenario({
      cantidad: 1,
      precio: 10000n,
      comision: 2000n,
      liberar: true,
    });

    assert.equal((await cuenta(escenario.local.id)).saldoPorPagar, 8000n);

    const reembolso = await crearReembolsoDeEscenario(escenario);
    assert.equal(reembolso.desde_congelado, true);

    const antesDeCompletar = await cuenta(escenario.local.id);
    assert.equal(antesDeCompletar.saldoPorPagar, 0n);
    assert.equal(antesDeCompletar.saldoCongelado, 8000n);

    await completarReembolso({ reembolsoId: reembolso.id });

    const movimientos = await movimientosDe(reembolso.id);
    assert.deepEqual(
      movimientos.map((movimiento) => [
        movimiento.tipo,
        movimiento.localId,
        movimiento.monto,
      ]),
      [
        ['congelacion', escenario.local.id, 8000n],
        ['reembolso', null, 10000n],
        ['descongelacion', escenario.local.id, 8000n],
        ['reversa_comision', null, 2000n],
        ['reversa_comision', escenario.local.id, 2000n],
        ['reembolso', escenario.local.id, 10000n],
      ],
    );

    const cuentaLocal = await cuenta(escenario.local.id);
    assert.equal(cuentaLocal.saldoPorPagar, 0n);
    assert.equal(cuentaLocal.saldoCongelado, 0n);
    assert.equal(cuentaLocal.saldoDeuda, 0n);
  });
});

describe('reembolsos - snapshots y lineas multiples', () => {
  test('un reembolso parcial no altera los snapshots del sub-pedido', CON_BASE, async () => {
    const escenario = await crearEscenario({
      cantidad: 2,
      precio: 10000n,
      comision: 2000n,
    });

    const antes = await prisma.subPedido.findUnique({
      where: { id: escenario.subPedido.id },
    });

    const reembolso = await crearReembolsoDeEscenario(escenario, {
      cantidad: 1,
    });
    await completarReembolso({ reembolsoId: reembolso.id });

    const despues = await prisma.subPedido.findUnique({
      where: { id: escenario.subPedido.id },
    });

    assert.equal(despues.subtotalProductos, antes.subtotalProductos);
    assert.equal(despues.comision, antes.comision);
    assert.equal(despues.total, antes.total);
    assert.equal(despues.estado, 'reembolsado_parcial');
    assert.equal(antes.estado, 'entregado');
  });

  test('reparte varias lineas y conserva el residuo de redondeo de la comision', CON_BASE, async () => {
    const catalogo = await crearCatalogo({ precio: 3333n });
    const variante2 = await crearVariante(prisma, {
      productoId: catalogo.producto.id,
      atributos: { talla: 'L' },
      precio: 6667n,
      stock: 10,
      activo: true,
    });

    const pedido = await crearPedidoConLineas({
      local: catalogo.local,
      lineas: [
        { variante: catalogo.variante, cantidad: 1, precioUnitario: 3333n },
        { variante: variante2, cantidad: 1, precioUnitario: 6667n },
      ],
      comision: 3333n,
      estadoPedido: 'en_proceso',
      estadoSubPedido: 'entregado',
      configSnapshot: {
        porcentaje_comision: 33.33,
        comision_minima: 0,
        pedido_minimo: 0,
        tarifa_base_envio: 0,
        tarifa_por_km: 0,
        dias_retencion: 5,
        tomado_en: new Date().toISOString(),
      },
    });
    const pago = await crearPagoDePrueba({
      pedido: pedido.pedido,
      metodoPago: 'tarjeta',
      estado: 'aprobado',
    });

    await asentar({
      tipo: 'comision',
      monto: 3333n,
      subPedidoId: pedido.subPedido.id,
      pagoId: pago.id,
    });
    await asentar({
      tipo: 'liberacion',
      monto: calcularMontoLiberacion(pedido.subPedido),
      localId: catalogo.local.id,
      subPedidoId: pedido.subPedido.id,
    });
    await prisma.subPedido.update({
      where: { id: pedido.subPedido.id },
      data: { saldoLiberadoEn: new Date() },
    });

    const primero = await crearReembolso({
      subPedidoId: pedido.subPedido.id,
      datos: cuerpoReembolso({
        detalleId: pedido.detalles[0].id,
        cantidad: 1,
      }),
    });
    assert.equal(primero.monto, 3333);

    await completarReembolso({ reembolsoId: primero.id });
    assert.equal((await cuenta(catalogo.local.id)).saldoPorPagar, 4445n);

    const segundo = await crearReembolso({
      subPedidoId: pedido.subPedido.id,
      datos: cuerpoReembolso({
        detalleId: pedido.detalles[1].id,
        cantidad: 1,
      }),
    });
    assert.equal(segundo.monto, 6667);

    await completarReembolso({ reembolsoId: segundo.id });

    const reversas = await prisma.ledger.findMany({
      where: {
        subPedidoId: pedido.subPedido.id,
        localId: catalogo.local.id,
        tipo: 'reversa_comision',
      },
      orderBy: { id: 'asc' },
    });
    assert.deepEqual(
      reversas.map((movimiento) => movimiento.monto),
      [1111n, 2222n],
    );

    const cuentaLocal = await cuenta(catalogo.local.id);
    assert.equal(cuentaLocal.saldoPorPagar, 0n);
    assert.equal(cuentaLocal.saldoCongelado, 0n);
    assert.equal(cuentaLocal.saldoDeuda, 0n);

    const pagado = await prisma.pago.findUnique({ where: { id: pago.id } });
    assert.equal(pagado.montoReembolsado, 10000n);
    assert.equal(pagado.estado, 'reembolsado');
  });
});

describe('reembolsos - concurrencia, deuda y fallo', () => {
  test('un doble completado concurrente solo escribe una vez', CON_BASE, async () => {
    const escenario = await crearEscenario({
      cantidad: 1,
      precio: 10000n,
      comision: 0n,
    });
    const reembolso = await crearReembolsoDeEscenario(escenario);

    const resultados = await Promise.allSettled([
      completarReembolso({ reembolsoId: reembolso.id }),
      completarReembolso({ reembolsoId: reembolso.id }),
    ]);

    const exitosos = resultados.filter((r) => r.status === 'fulfilled');
    const fallidos = resultados.filter((r) => r.status === 'rejected');
    assert.equal(exitosos.length, 1);
    assert.equal(fallidos.length, 1);
    assert.equal(fallidos[0].reason.codigo, 'reembolso_no_pendiente');

    const movimientos = await movimientosDe(reembolso.id);
    assert.equal(
      movimientos.filter(
        (movimiento) => movimiento.tipo === 'reembolso' && movimiento.localId === null,
      ).length,
      1,
    );

    const pago = await prisma.pago.findUnique({
      where: { id: escenario.pago.id },
    });
    assert.equal(pago.montoReembolsado, 10000n);
  });

  test('post-payout aplica el disponible y el resto queda como deuda', CON_BASE, async () => {
    const escenario = await crearEscenario({
      cantidad: 1,
      precio: 10000n,
      comision: 0n,
      liberar: true,
      pagar: 8000n,
    });

    assert.equal((await cuenta(escenario.local.id)).saldoPorPagar, 2000n);

    const reembolso = await crearReembolsoDeEscenario(escenario);
    await completarReembolso({ reembolsoId: reembolso.id });

    const movimientos = await movimientosDe(reembolso.id);
    assert.deepEqual(
      movimientos
        .filter((movimiento) => movimiento.localId !== null)
        .map((movimiento) => [movimiento.tipo, movimiento.monto]),
      [
        ['congelacion', 2000n],
        ['descongelacion', 2000n],
        ['reembolso', 2000n],
        ['deuda_reembolso', 8000n],
      ],
    );

    const cuentaLocal = await cuenta(escenario.local.id);
    assert.equal(cuentaLocal.saldoPorPagar, 0n);
    assert.equal(cuentaLocal.saldoCongelado, 0n);
    assert.equal(cuentaLocal.saldoDeuda, 8000n);

    const pago = await prisma.pago.findUnique({
      where: { id: escenario.pago.id },
    });
    assert.equal(pago.montoReembolsado, 10000n);
  });

  test('fallar descongela el saldo y no registra reembolso de plataforma', CON_BASE, async () => {
    const escenario = await crearEscenario({
      cantidad: 1,
      precio: 10000n,
      comision: 0n,
      liberar: true,
    });
    const reembolso = await crearReembolsoDeEscenario(escenario, {
      cantidad: 1,
    });

    assert.equal((await cuenta(escenario.local.id)).saldoCongelado, 10000n);

    const fallido = await fallarReembolso({ reembolsoId: reembolso.id });
    assert.equal(fallido.estado, 'fallido');
    assert.equal(fallido.desde_congelado, false);

    const movimientosPlataforma = await prisma.ledger.count({
      where: { reembolsoId: reembolso.id, tipo: 'reembolso', localId: null },
    });
    assert.equal(movimientosPlataforma, 0);

    const cuentaLocal = await cuenta(escenario.local.id);
    assert.equal(cuentaLocal.saldoPorPagar, 10000n);
    assert.equal(cuentaLocal.saldoCongelado, 0n);
    assert.equal(cuentaLocal.saldoDeuda, 0n);

    const pago = await prisma.pago.findUnique({
      where: { id: escenario.pago.id },
    });
    assert.equal(pago.montoReembolsado, 0n);
  });

  test('un reembolso en efectivo no mueve el ledger', CON_BASE, async () => {
    const escenario = await crearEscenario({
      cantidad: 1,
      precio: 10000n,
      comision: 0n,
      metodoPago: 'efectivo',
    });
    const reembolso = await crearReembolsoDeEscenario(escenario);
    assert.equal(reembolso.tipo, 'efectivo');
    assert.equal(reembolso.fecha_limite !== null, true);

    await completarReembolso({ reembolsoId: reembolso.id });

    assert.equal(await prisma.ledger.count({ where: { reembolsoId: reembolso.id } }), 0);

    const pago = await prisma.pago.findUnique({
      where: { id: escenario.pago.id },
    });
    assert.equal(pago.montoReembolsado, 10000n);
  });
});

describe('reembolsos - conciliacion del pago', () => {
  test('pago.monto_reembolsado coincide con la suma de completados', CON_BASE, async () => {
    const escenario = await crearEscenario({
      cantidad: 2,
      precio: 10000n,
      comision: 0n,
      pagoMonto: 20000n,
    });

    const primero = await crearReembolsoDeEscenario(escenario, {
      cantidad: 1,
    });
    await completarReembolso({ reembolsoId: primero.id });

    let pago = await prisma.pago.findUnique({
      where: { id: escenario.pago.id },
    });
    assert.equal(pago.montoReembolsado, 10000n);
    assert.equal(pago.estado, 'reembolsado_parcial');

    const segundo = await crearReembolsoDeEscenario(escenario, {
      cantidad: 1,
    });
    await completarReembolso({ reembolsoId: segundo.id });

    pago = await prisma.pago.findUnique({ where: { id: escenario.pago.id } });
    const completados = await prisma.reembolso.aggregate({
      where: { pagoId: escenario.pago.id, estado: 'completado' },
      _sum: { monto: true },
    });

    assert.equal(pago.montoReembolsado, completados._sum.monto);
    assert.equal(pago.montoReembolsado, 20000n);
    assert.equal(pago.estado, 'reembolsado');
  });
});

describe('reembolsos - rutas admin', () => {
  async function crearAdminConSesion() {
    const admin = await crearUsuarioConSesion({ roles: ['comprador'] });
    await prisma.usuarioRol.create({
      data: { usuarioId: admin.id, rol: 'admin' },
    });
    return admin;
  }

  test('exige admin e Idempotency-Key, y no duplica al reintentar', CON_BASE, async () => {
    const admin = await crearAdminConSesion();
    const comprador = await crearUsuarioConSesion({ roles: ['comprador'] });
    const escenario = await crearEscenario({
      cantidad: 1,
      precio: 10000n,
      comision: 0n,
    });
    const reembolso = await crearReembolsoDeEscenario(escenario, {
      registradoPor: admin.id,
    });
    const ruta = `/api/v1/admin/reembolsos/${reembolso.id}/completar`;
    const clave = `completar-${reembolso.id}-clave`;

    const sinPermiso = await comprador.cliente.post(
      ruta,
      {},
      { 'Idempotency-Key': clave },
    );
    assert.equal(sinPermiso.status, 403);

    const sinClave = await admin.cliente.post(ruta, {});
    assert.equal(sinClave.status, 400);

    const primera = await admin.cliente.post(
      ruta,
      {},
      { 'Idempotency-Key': clave },
    );
    assert.equal(primera.status, 200, JSON.stringify(primera.body));
    assert.equal(primera.body.estado, 'completado');
    assert.equal(primera.body.registrado_por, admin.id);

    const repetida = await admin.cliente.post(
      ruta,
      {},
      { 'Idempotency-Key': clave },
    );
    assert.equal(repetida.status, 200);
    assert.deepEqual(repetida.body, primera.body);

    const otraClave = await admin.cliente.post(
      ruta,
      {},
      { 'Idempotency-Key': `${clave}-otra` },
    );
    assert.equal(otraClave.status, 409);
    assert.equal(otraClave.body.error.codigo, 'reembolso_no_pendiente');

    assert.equal(
      await prisma.ledger.count({
        where: {
          reembolsoId: reembolso.id,
          tipo: 'reembolso',
          localId: null,
        },
      }),
      1,
    );
  });
});
