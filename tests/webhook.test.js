import './helpers/entorno.js';
import { test, describe, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import request from 'supertest';
import { app } from './helpers/http.js';
import { opcionesConBase, prisma, cerrarConexion } from './helpers/base.js';
import { crearUsuarioConSesion } from './helpers/http.js';
import { crearCatalogo } from './helpers/datos.js';
import { config } from '../src/config/entorno.js';
import {
  auditoriaWompiFalsa,
  limpiarWompiFalso,
  registrarTransaccionFalsa,
} from '../src/services/pagos.js';
import { withTransaccion } from '../src/lib/transaccion.js';
import { descontarStock } from '../src/services/stock.js';

/**
 * WEBHOOK DE WOMPI - ETAPA 2
 * ==========================
 * Se prueba con el proveedor falso: la firma se calcula de verdad y la
 * consulta de la transaccion sale de un registro en memoria. Asi se ejercita
 * el mismo camino que usara Wompi, sin llamadas HTTP.
 */

const CON_BASE = await opcionesConBase();
const SECRETO_EVENTOS = config.WOMPI_EVENTS_KEY || 'test_events_falsa';

after(async () => {
  await cerrarConexion();
});

beforeEach(() => {
  limpiarWompiFalso();
});

function sha256(texto) {
  return crypto.createHash('sha256').update(texto, 'utf8').digest('hex');
}

function crearEvento({
  id,
  reference,
  status = 'APPROVED',
  amountInCents,
  timestamp = Date.now(),
  checksum,
}) {
  const cuerpo = {
    event: 'transaction.updated',
    data: {
      transaction: {
        id,
        reference,
        status,
        amount_in_cents: Number(amountInCents),
        currency: 'COP',
      },
    },
    environment: 'test',
    signature: {
      properties: [
        'transaction.id',
        'transaction.status',
        'transaction.amount_in_cents',
      ],
      checksum: '',
    },
    timestamp,
  };

  if (checksum !== undefined) {
    cuerpo.signature.checksum = checksum;
    return cuerpo;
  }

  const cadena = `${id}${status}${amountInCents}${timestamp}${SECRETO_EVENTOS}`;
  cuerpo.signature.checksum = sha256(cadena);
  return cuerpo;
}

async function enviarEvento(cuerpo, { conCabecera = false } = {}) {
  let peticion = request(app).post('/api/v1/pagos/webhook').send(cuerpo);
  if (conCabecera) {
    peticion = peticion.set('X-Event-Checksum', cuerpo.signature.checksum);
  }
  return peticion;
}

function claveUnica(prefijo = 'webhook') {
  return `${prefijo}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

async function crearPagoPendiente({
  cantidad = 3,
  stockInicial = 10,
  precio = 10000n,
} = {}) {
  const comprador = await crearUsuarioConSesion();
  const { variante, local } = await crearCatalogo({ precio, stockInicial });

  const checkout = await comprador.cliente.post(
    '/api/v1/pedidos',
    {
      direccion: {
        texto: 'Calle 1 # 2-3, Bogota',
        latitud: 4.65,
        longitud: -74.05,
      },
      metodo_pago: 'tarjeta',
      items: [{ variante_id: variante.id, cantidad }],
    },
    { 'Idempotency-Key': claveUnica('checkout') },
  );

  assert.equal(checkout.status, 201, JSON.stringify(checkout.body));

  const pagoResp = await comprador.cliente.post(
    `/api/v1/pedidos/${checkout.body.id}/pagos`,
    undefined,
    { 'Idempotency-Key': claveUnica('pago') },
  );

  assert.equal(pagoResp.status, 201, JSON.stringify(pagoResp.body));

  return {
    comprador,
    variante,
    local,
    pedido: checkout.body,
    pago: pagoResp.body.pago,
    montoEnCentavos: BigInt(pagoResp.body.checkout.monto_en_centavos),
  };
}

describe('POST /api/v1/pagos/webhook', () => {
  test('aprueba el pago, descuenta stock y escribe el ledger en la misma transaccion', CON_BASE, async () => {
    const { variante, local, pedido, pago, montoEnCentavos } =
      await crearPagoPendiente();
    const idTransaccion = `tx-${claveUnica()}`;

    registrarTransaccionFalsa({
      id: idTransaccion,
      reference: pago.referencia,
      status: 'APPROVED',
      amountInCents: montoEnCentavos,
    });

    const evento = crearEvento({
      id: idTransaccion,
      reference: pago.referencia,
      amountInCents: montoEnCentavos,
    });

    const r = await enviarEvento(evento, { conCabecera: true });

    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body, {
      recibido: true,
      resultado: 'ok',
      reembolso: false,
    });

    const pagoDb = await prisma.pago.findUnique({ where: { id: pago.id } });
    assert.equal(pagoDb.estado, 'aprobado');
    assert.equal(pagoDb.idTransaccionWompi, idTransaccion);

    const pedidoDb = await prisma.pedido.findUnique({
      where: { id: pedido.id },
      include: { subPedidos: { include: { detalles: true } } },
    });
    assert.equal(pedidoDb.estado, 'en_proceso');
    assert.equal(pedidoDb.subPedidos[0].estado, 'pendiente');
    assert.equal(pedidoDb.subPedidos[0].saldoLiberadoEn, null);

    const varianteDb = await prisma.productoVariante.findUnique({
      where: { id: variante.id },
    });
    assert.equal(varianteDb.stock, 7);

    const sub = pedidoDb.subPedidos[0];
    const movimientos = await prisma.ledger.findMany({
      where: {
        OR: [{ pagoId: pago.id }, { subPedidoId: sub.id }],
      },
      orderBy: { id: 'asc' },
    });

    assert.equal(movimientos.length, 3);
    const porTipo = new Map(movimientos.map((m) => [m.tipo, m]));
    assert.equal(porTipo.get('pago_recibido').monto, 32000n);
    assert.equal(porTipo.get('venta').monto, 30000n);
    assert.equal(porTipo.get('venta').localId, local.id);
    assert.equal(porTipo.get('comision').monto, 2000n);

    const cuenta = await prisma.cuentaLocal.findUnique({
      where: { localId: local.id },
    });
    assert.equal(cuenta.saldoPorPagar, 0n);
    assert.equal(cuenta.saldoDeuda, 0n);
    assert.equal(cuenta.saldoCongelado, 0n);

    const eventoDb = await prisma.eventoWebhook.findFirst({
      where: { referencia: pago.referencia },
      orderBy: { id: 'desc' },
    });
    assert.equal(eventoDb.procesado, true);
    assert.equal(eventoDb.resultado, 'ok');

    // Invariante 4 en una prueba de integracion: la consulta a Wompi ocurrio
    // fuera de la transaccion de base de datos.
    assert.equal(auditoriaWompiFalsa.length, 1);
    assert.equal(auditoriaWompiFalsa[0].dentroDeTransaccion, false);
  });

  test('un evento repetido no vuelve a descontar stock ni a escribir ledger', CON_BASE, async () => {
    const { variante, pedido, pago, montoEnCentavos } =
      await crearPagoPendiente();
    const idTransaccion = `tx-${claveUnica()}`;

    registrarTransaccionFalsa({
      id: idTransaccion,
      reference: pago.referencia,
      status: 'APPROVED',
      amountInCents: montoEnCentavos,
    });

    const evento = crearEvento({
      id: idTransaccion,
      reference: pago.referencia,
      amountInCents: montoEnCentavos,
    });

    assert.equal((await enviarEvento(evento)).status, 200);
    assert.equal((await enviarEvento(evento)).status, 200);

    const varianteDb = await prisma.productoVariante.findUnique({
      where: { id: variante.id },
    });
    assert.equal(varianteDb.stock, 7);

    const movimientos = await prisma.ledger.count({
      where: {
        OR: [
          { pagoId: pago.id },
          { subPedidoId: pedido.sub_pedidos[0].id },
        ],
      },
    });
    assert.equal(movimientos, 3);

    const eventos = await prisma.eventoWebhook.findMany({
      where: { referencia: pago.referencia },
    });
    assert.equal(eventos.length, 2);
    assert.equal(eventos.every((e) => e.procesado && e.resultado === 'ok'), true);
  });

  test('firma invalida: registra el evento y responde 401', CON_BASE, async () => {
    const { pedido, pago, montoEnCentavos } = await crearPagoPendiente();

    const evento = crearEvento({
      id: 'tx-firma-mala',
      reference: pago.referencia,
      amountInCents: montoEnCentavos,
      checksum: 'f'.repeat(64),
    });

    const r = await enviarEvento(evento);

    assert.equal(r.status, 401);
    assert.equal(r.body.error.codigo, 'firma_invalida');

    const eventoDb = await prisma.eventoWebhook.findFirst({
      where: { referencia: pago.referencia },
      orderBy: { id: 'desc' },
    });
    assert.equal(eventoDb.procesado, true);
    assert.equal(eventoDb.resultado, 'firma_invalida');

    const pagoDb = await prisma.pago.findUnique({ where: { id: pago.id } });
    assert.equal(pagoDb.estado, 'pendiente');

    const pedidoDb = await prisma.pedido.findUnique({
      where: { id: pedido.id },
    });
    assert.equal(pedidoDb.estado, 'pendiente_pago');
  });

  test('referencia desconocida: registra, alerta y responde 200', CON_BASE, async () => {
    const referencia = `NO-EXISTE-${claveUnica()}`;
    const evento = crearEvento({
      id: 'tx-desconocida',
      reference: referencia,
      amountInCents: 3_200_000n,
    });

    const r = await enviarEvento(evento);

    assert.equal(r.status, 200);
    assert.equal(r.body.resultado, 'referencia_desconocida');

    const eventoDb = await prisma.eventoWebhook.findFirst({
      where: { referencia },
    });
    assert.equal(eventoDb.procesado, true);
    assert.equal(eventoDb.resultado, 'referencia_desconocida');
  });

  test('fallo transitorio: responde 5xx y deja el evento sin procesar', CON_BASE, async () => {
    const { pago, montoEnCentavos } = await crearPagoPendiente();
    const idTransaccion = `tx-${claveUnica()}`;

    const evento = crearEvento({
      id: idTransaccion,
      reference: pago.referencia,
      amountInCents: montoEnCentavos,
    });

    // Todavia no existe en el Wompi falso.
    const primero = await enviarEvento(evento);
    assert.equal(primero.status, 503);

    const eventosPendientes = await prisma.eventoWebhook.findMany({
      where: { referencia: pago.referencia },
    });
    assert.equal(eventosPendientes.length, 1);
    assert.equal(eventosPendientes[0].procesado, false);

    // Ahora si aparece: el reintento procesa el mismo evento.
    registrarTransaccionFalsa({
      id: idTransaccion,
      reference: pago.referencia,
      status: 'APPROVED',
      amountInCents: montoEnCentavos,
    });

    const segundo = await enviarEvento(evento);
    assert.equal(segundo.status, 200);
    assert.equal(segundo.body.resultado, 'ok');
  });

  test('si el monto de Wompi no coincide, no aprueba', CON_BASE, async () => {
    const { pago, montoEnCentavos } = await crearPagoPendiente();
    const idTransaccion = `tx-${claveUnica()}`;

    registrarTransaccionFalsa({
      id: idTransaccion,
      reference: pago.referencia,
      status: 'APPROVED',
      amountInCents: montoEnCentavos + 1n,
    });

    const evento = crearEvento({
      id: idTransaccion,
      reference: pago.referencia,
      amountInCents: montoEnCentavos,
    });

    const r = await enviarEvento(evento);

    assert.equal(r.status, 200);
    assert.equal(r.body.resultado, 'ignorado');

    const pagoDb = await prisma.pago.findUnique({ where: { id: pago.id } });
    assert.equal(pagoDb.estado, 'pendiente');
  });

  test('un pago rechazado queda rechazado y no toca stock', CON_BASE, async () => {
    const { variante, pago, montoEnCentavos } = await crearPagoPendiente();
    const idTransaccion = `tx-${claveUnica()}`;

    registrarTransaccionFalsa({
      id: idTransaccion,
      reference: pago.referencia,
      status: 'DECLINED',
      amountInCents: montoEnCentavos,
    });

    const evento = crearEvento({
      id: idTransaccion,
      reference: pago.referencia,
      status: 'DECLINED',
      amountInCents: montoEnCentavos,
    });

    const r = await enviarEvento(evento);

    assert.equal(r.status, 200);
    assert.equal(r.body.resultado, 'ignorado');

    const pagoDb = await prisma.pago.findUnique({ where: { id: pago.id } });
    assert.equal(pagoDb.estado, 'rechazado');

    const varianteDb = await prisma.productoVariante.findUnique({
      where: { id: variante.id },
    });
    assert.equal(varianteDb.stock, 10, 'un pago rechazado no descuenta stock');
  });

  test('transaccion B: si falla el stock, reembolsa y cancela sin llamar a Wompi dentro de la transaccion', CON_BASE, async () => {
    const { variante, pedido, pago, montoEnCentavos } =
      await crearPagoPendiente({ cantidad: 3, stockInicial: 3 });

    // Otro comprador se lleva el stock justo antes del webhook.
    await withTransaccion(async (tx) => {
      await descontarStock(tx, variante.id, 3);
    });

    const idTransaccion = `tx-${claveUnica()}`;
    registrarTransaccionFalsa({
      id: idTransaccion,
      reference: pago.referencia,
      status: 'APPROVED',
      amountInCents: montoEnCentavos,
    });

    const evento = crearEvento({
      id: idTransaccion,
      reference: pago.referencia,
      amountInCents: montoEnCentavos,
    });

    const r = await enviarEvento(evento);

    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.resultado, 'ok');
    assert.equal(r.body.reembolso, true);

    const pagoDb = await prisma.pago.findUnique({
      where: { id: pago.id },
      include: { reembolsos: true },
    });
    assert.equal(pagoDb.estado, 'reembolsado');
    assert.equal(pagoDb.montoReembolsado, 32000n);
    assert.equal(pagoDb.reembolsos.length, 1);
    assert.equal(pagoDb.reembolsos[0].monto, 32000n);
    assert.equal(pagoDb.reembolsos[0].estado, 'completado');
    assert.equal(
      pagoDb.reembolsos[0].motivo,
      'stock_insuficiente_al_confirmar_pago',
    );

    const pedidoDb = await prisma.pedido.findUnique({
      where: { id: pedido.id },
      include: { subPedidos: true },
    });
    assert.equal(pedidoDb.estado, 'reembolsado');
    assert.equal(pedidoDb.subPedidos[0].estado, 'reembolsado');

    // El checkout deja el historial inicial (null -> pendiente) y la
    // transaccion B agrega el cambio a reembolsado, con usuario nulo porque lo
    // hizo el sistema.
    const historial = await prisma.historialEstadoSubPedido.findMany({
      where: { subPedidoId: pedidoDb.subPedidos[0].id },
      orderBy: { id: 'asc' },
    });
    assert.equal(historial.length, 2);
    const pasoAReembolsado = historial.find(
      (fila) => fila.estadoNuevo === 'reembolsado',
    );
    assert.ok(pasoAReembolsado, 'debe quedar el paso a reembolsado');
    assert.equal(pasoAReembolsado.estadoAnterior, 'pendiente');
    assert.equal(pasoAReembolsado.cambiadoPor, null);

    const varianteDb = await prisma.productoVariante.findUnique({
      where: { id: variante.id },
    });
    assert.equal(varianteDb.stock, 0);

    // La transaccion A se revirtio entera: no debe haber venta, comision ni
    // pago_recibido. Solo el movimiento de reembolso de la transaccion B.
    const movimientos = await prisma.ledger.findMany({
      where: { pagoId: pago.id },
    });
    assert.equal(movimientos.length, 1);
    assert.equal(movimientos[0].tipo, 'reembolso');
    assert.equal(movimientos[0].monto, 32000n);
    assert.equal(movimientos[0].reembolsoId, pagoDb.reembolsos[0].id);
    assert.equal(movimientos[0].localId, null);

    // Repetir el evento no duplica el reembolso.
    const repetido = await enviarEvento(evento);
    assert.equal(repetido.status, 200);
    assert.equal(repetido.body.resultado, 'ok');

    const reembolsos = await prisma.reembolso.count({
      where: { pagoId: pago.id },
    });
    assert.equal(reembolsos, 1);
  });
});
