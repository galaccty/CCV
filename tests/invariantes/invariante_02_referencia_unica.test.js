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
import { logger } from '../../src/lib/logger.js';
import {
  limpiarWompiFalso,
  registrarTransaccionFalsa,
} from '../../src/services/pagos.js';

/**
 * INVARIANTE 2 - `pago.referencia` es UNIQUE y las referencias desconocidas
 * se registran y alertan; nunca se descartan en silencio.
 *
 * Se activa en la Etapa 2 porque ya existen la tabla pago y el webhook.
 */

export const ESTADO = estadoInvariante({
  aplica: true,
  etapa: 'Etapa 2',
  motivo: 'La tabla pago y el webhook ya existen.',
});

const CON_BASE = await opcionesConBase();

after(async () => {
  await cerrarConexion();
});

beforeEach(() => {
  limpiarWompiFalso();
});

describe('invariante 2 - referencia unica y referencias desconocidas', () => {
  test('dos pagos con la misma referencia no pueden existir', CON_BASE, async () => {
    const referencia = `UNICA-${claveUnica()}`;

    const primero = await prisma.pago.create({
      data: {
        tipoPago: 'publicidad',
        referencia,
        metodoPago: 'tarjeta',
        monto: 1000n,
      },
    });

    assert.equal(primero.referencia, referencia);

    await assert.rejects(
      () =>
        prisma.pago.create({
          data: {
            tipoPago: 'publicidad',
            referencia,
            metodoPago: 'tarjeta',
            monto: 2000n,
          },
        }),
      /P2002|unique|Unique|duplicad/i,
    );

    const conEsaReferencia = await prisma.pago.count({
      where: { referencia },
    });
    assert.equal(conEsaReferencia, 1);
  });

  test('un webhook con referencia desconocida se registra, alerta y responde 200', CON_BASE, async () => {
    const referencia = `NO-EXISTE-${claveUnica()}`;
    const evento = crearEvento({
      id: `tx-${claveUnica()}`,
      reference: referencia,
      amountInCents: 3_200_000n,
    });

    const alertas = [];
    const errorOriginal = logger.error;
    logger.error = (objeto, mensaje) => {
      alertas.push({ objeto, mensaje });
    };

    let respuesta;
    try {
      respuesta = await enviarEvento(evento);
    } finally {
      logger.error = errorOriginal;
    }

    assert.equal(respuesta.status, 200);
    assert.equal(respuesta.body.resultado, 'referencia_desconocida');

    const registrado = await prisma.eventoWebhook.findFirst({
      where: { referencia },
      orderBy: { id: 'desc' },
    });
    assert.ok(registrado, 'el evento debe quedar guardado');
    assert.equal(registrado.procesado, true);
    assert.equal(registrado.resultado, 'referencia_desconocida');

    const alerta = alertas.find(
      (a) => a.objeto?.alerta === 'pago_referencia_desconocida',
    );
    assert.ok(alerta, 'debe quedar una alerta para el administrador');
    assert.equal(alerta.objeto.referencia, referencia);
  });

  test('un webhook repetido no procesa dos veces el mismo pago', CON_BASE, async () => {
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

    const pagoDb = await prisma.pago.findUnique({ where: { id: pago.id } });
    assert.equal(pagoDb.estado, 'aprobado');

    const varianteDb = await prisma.productoVariante.findUnique({
      where: { id: variante.id },
    });
    assert.equal(varianteDb.stock, 7, 'el stock se descuenta una sola vez');

    const movimientos = await prisma.ledger.count({
      where: { pagoId: pago.id },
    });
    assert.equal(movimientos, 1, 'pago_recibido se registra una sola vez');

    const sub = await prisma.subPedido.findFirst({
      where: { pedidoId: pedido.id },
    });
    const movimientosVenta = await prisma.ledger.count({
      where: { subPedidoId: sub.id },
    });
    assert.equal(movimientosVenta, 2, 'venta y comision se registran una vez');

    const eventos = await prisma.eventoWebhook.findMany({
      where: { referencia: pago.referencia },
    });
    assert.equal(eventos.length, 2);
    assert.equal(
      eventos.every((e) => e.procesado && e.resultado === 'ok'),
      true,
    );
  });
});
