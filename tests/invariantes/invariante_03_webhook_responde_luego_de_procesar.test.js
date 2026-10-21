import '../helpers/entorno.js';
import { test, describe, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { estadoInvariante } from '../helpers/pendiente.js';
import { opcionesConBase, prisma, cerrarConexion } from '../helpers/base.js';
import {
  crearPagoPendiente,
  crearEvento,
  enviarEvento,
  claveUnica,
} from '../helpers/wompi.js';
import {
  limpiarWompiFalso,
  registrarTransaccionFalsa,
} from '../../src/services/pagos.js';

/**
 * INVARIANTE 3 - el webhook responde 200 solo despues de procesar.
 *
 *   - Evento aprobado: primero se escribe el pago, el stock y el ledger; solo
 *     entonces se responde 200.
 *   - Firma invalida: se registra el evento y se responde 401; no se procesa.
 *   - Falla transitoria: se responde 5xx y el evento queda sin procesar para
 *     que Wompi reintente.
 */

export const ESTADO = estadoInvariante({
  aplica: true,
  etapa: 'Etapa 2',
  motivo: 'La ruta /api/v1/pagos/webhook ya existe.',
});

const CON_BASE = await opcionesConBase();

after(async () => {
  await cerrarConexion();
});

beforeEach(() => {
  limpiarWompiFalso();
});

describe('invariante 3 - el webhook responde 200 solo despues de procesar', () => {
  test('responde 200 despues de procesar el evento', CON_BASE, async () => {
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

    const r = await enviarEvento(evento);

    assert.equal(r.status, 200);
    assert.equal(r.body.resultado, 'ok');

    // Cuando llega la respuesta, TODO lo del evento ya esta confirmado.
    const pagoDb = await prisma.pago.findUnique({ where: { id: pago.id } });
    assert.equal(pagoDb.estado, 'aprobado');

    const pedidoDb = await prisma.pedido.findUnique({
      where: { id: pedido.id },
    });
    assert.equal(pedidoDb.estado, 'en_proceso');

    const varianteDb = await prisma.productoVariante.findUnique({
      where: { id: variante.id },
    });
    assert.equal(varianteDb.stock, 7);

    const eventos = await prisma.eventoWebhook.findMany({
      where: { referencia: pago.referencia },
    });
    assert.equal(eventos.length, 1);
    assert.equal(eventos[0].procesado, true);
    assert.equal(eventos[0].resultado, 'ok');
  });

  test('responde 5xx si el procesamiento falla de forma transitoria', CON_BASE, async () => {
    const { pago, montoEnCentavos } = await crearPagoPendiente();
    const idTransaccion = `tx-${claveUnica()}`;

    const evento = crearEvento({
      id: idTransaccion,
      reference: pago.referencia,
      amountInCents: montoEnCentavos,
    });

    // No se registra la transaccion en el Wompi falso: la consulta no la
    // encuentra y el procesamiento no puede seguir.
    const r = await enviarEvento(evento);

    assert.ok(r.status >= 500, `se esperaba 5xx y llego ${r.status}`);
    assert.equal(r.body.error.codigo, 'wompi_no_confirma');

    const registrado = await prisma.eventoWebhook.findFirst({
      where: { referencia: pago.referencia },
      orderBy: { id: 'desc' },
    });
    assert.equal(registrado.procesado, false);
    assert.equal(registrado.resultado, null);

    const pagoDb = await prisma.pago.findUnique({ where: { id: pago.id } });
    assert.equal(pagoDb.estado, 'pendiente');
  });

  test('firma invalida: registra el evento, responde 401 y no procesa', CON_BASE, async () => {
    const { variante, pago, montoEnCentavos } = await crearPagoPendiente();

    const evento = crearEvento({
      id: `tx-${claveUnica()}`,
      reference: pago.referencia,
      amountInCents: montoEnCentavos,
      checksum: '0'.repeat(64),
    });

    const r = await enviarEvento(evento);

    assert.equal(r.status, 401);
    assert.equal(r.body.error.codigo, 'firma_invalida');

    const registrado = await prisma.eventoWebhook.findFirst({
      where: { referencia: pago.referencia },
      orderBy: { id: 'desc' },
    });
    assert.equal(registrado.procesado, true);
    assert.equal(registrado.resultado, 'firma_invalida');

    const pagoDb = await prisma.pago.findUnique({ where: { id: pago.id } });
    assert.equal(pagoDb.estado, 'pendiente');

    const varianteDb = await prisma.productoVariante.findUnique({
      where: { id: variante.id },
    });
    assert.equal(varianteDb.stock, 10);
  });
});
