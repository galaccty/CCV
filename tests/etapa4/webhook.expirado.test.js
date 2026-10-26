import '../helpers/entorno.js';
import { test, describe, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { opcionesConBase, prisma, cerrarConexion } from '../helpers/base.js';
import {
  crearEvento,
  crearPagoPendiente,
  enviarEvento,
  claveUnica,
} from '../helpers/wompi.js';
import {
  establecerReembolsoManualParaPruebas,
  limpiarWompiFalso,
  registrarTransaccionFalsa,
} from '../../src/services/pagos.js';
import { expirarPagos } from '../../src/jobs/expirarPagos.js';

/**
 * WEBHOOK TARDIO DESPUES DE LA EXPIRACION (Etapa 4f-2)
 * =====================================================
 * El job expira el pago y cancela el pedido. Si Wompi aprueba despues, el
 * dinero si entro: se registra el pago y se crea un reembolso manual
 * pendiente, pero no se revive la venta ni se descuenta stock.
 *
 * La prueba complementa la de `tests/webhook.test.js` con las invariantes de
 * stock y ledger que importan para el cierre de la Etapa 4.
 */

const CON_BASE = await opcionesConBase();

after(async () => {
  await cerrarConexion();
});

afterEach(() => {
  establecerReembolsoManualParaPruebas(null);
  limpiarWompiFalso();
});

describe('webhook de pago aprobado despues de expirar', () => {
  test(
    'no revive el pedido ni descuenta stock y crea el reembolso manual pendiente',
    CON_BASE,
    async () => {
      const caso = await crearPagoPendiente({
        cantidad: 3,
        stockInicial: 10,
        precio: 10000n,
      });
      const { pedido, pago, variante, montoEnCentavos } = caso;

      const stockInicial = await prisma.productoVariante.findUnique({
        where: { id: variante.id },
      });
      assert.equal(stockInicial.stock, 10);

      // El pago queda expirado y el pedido/sub-pedido cancelados. El stock
      // digital no se habia tocado porque solo se descuenta al aprobar.
      const expiracion = await expirarPagos({
        ahora: new Date(Date.now() + 2 * 60 * 60 * 1000),
        pagoIds: [pago.id],
      });
      assert.equal(expiracion.expirados, 1);

      const pagoExpirado = await prisma.pago.findUnique({
        where: { id: pago.id },
      });
      assert.equal(pagoExpirado.estado, 'expirado');

      const pedidoCancelado = await prisma.pedido.findUnique({
        where: { id: pedido.id },
        include: { subPedidos: true },
      });
      assert.equal(pedidoCancelado.estado, 'cancelado');
      assert.equal(pedidoCancelado.subPedidos[0].estado, 'cancelado');

      const stockTrasExpirar = await prisma.productoVariante.findUnique({
        where: { id: variante.id },
      });
      assert.equal(stockTrasExpirar.stock, 10);

      // Wompi aprueba tarde. En produccion el dinero ya entro y el reembolso
      // debe hacerse manualmente, con alerta para el admin.
      establecerReembolsoManualParaPruebas(true);

      const idTransaccion = `tx-${claveUnica('tardio')}`;
      registrarTransaccionFalsa({
        id: idTransaccion,
        reference: pago.referencia,
        status: 'APPROVED',
        amountInCents: montoEnCentavos,
      });

      const evento = crearEvento({
        id: idTransaccion,
        reference: pago.referencia,
        status: 'APPROVED',
        amountInCents: montoEnCentavos,
      });

      const respuesta = await enviarEvento(evento);
      assert.equal(respuesta.status, 200, JSON.stringify(respuesta.body));
      assert.deepEqual(respuesta.body, {
        recibido: true,
        resultado: 'ok',
        reembolso: true,
      });

      const pagoTardio = await prisma.pago.findUnique({
        where: { id: pago.id },
        include: { reembolsos: true },
      });
      assert.equal(pagoTardio.estado, 'aprobado');
      assert.equal(pagoTardio.montoReembolsado, 0n);
      assert.equal(pagoTardio.reembolsos.length, 1);
      assert.equal(pagoTardio.reembolsos[0].estado, 'pendiente');
      assert.equal(pagoTardio.reembolsos[0].motivo, 'pedido_expirado');

      const pedidoTardio = await prisma.pedido.findUnique({
        where: { id: pedido.id },
        include: { subPedidos: true },
      });
      assert.equal(pedidoTardio.estado, 'reembolso_pendiente');
      assert.notEqual(pedidoTardio.estado, 'en_proceso');
      assert.notEqual(pedidoTardio.estado, 'completado');
      assert.equal(pedidoTardio.subPedidos[0].estado, 'cancelado');
      assert.equal(pedidoTardio.subPedidos[0].fechaEntrega, null);

      const alerta = await prisma.alerta.findUnique({
        where: { clave: `reembolso_pendiente_manual:pago:${pago.id}` },
      });
      assert.ok(alerta, 'el admin debe ver la alerta de reembolso manual');
      assert.equal(alerta.tipo, 'reembolso_pendiente_manual');
      assert.equal(alerta.estado, 'abierta');
      assert.equal(alerta.pagoId, pago.id);
      assert.equal(alerta.pedidoId, pedido.id);

      // El dinero entro y se registra una sola vez; no hay venta ni comision
      // porque la venta nunca se confirmo. El reembolso manual tampoco escribe
      // el movimiento de salida hasta que el admin lo ejecute.
      assert.equal(
        await prisma.ledger.count({
          where: { pagoId: pago.id, tipo: 'pago_recibido' },
        }),
        1,
      );
      assert.equal(
        await prisma.ledger.count({
          where: {
            pagoId: pago.id,
            tipo: { in: ['venta', 'comision', 'reembolso'] },
          },
        }),
        0,
      );

      const stockFinal = await prisma.productoVariante.findUnique({
        where: { id: variante.id },
      });
      assert.equal(stockFinal.stock, 10);
    },
  );
});
