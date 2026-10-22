import '../helpers/entorno.js';
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { opcionesConBase, prisma, cerrarConexion } from '../helpers/base.js';
import { crearCatalogo, crearPedidoDePrueba } from '../helpers/datos.js';
import { withTransaccion } from '../../src/lib/transaccion.js';
import { registrarMovimiento } from '../../src/services/ledger.js';
import { calcularMontoLiberacion } from '../../src/services/liberacion.js';

const CON_BASE = await opcionesConBase();

after(async () => {
  await cerrarConexion();
});

async function mov(datos) {
  return withTransaccion(() => registrarMovimiento(datos));
}

async function cuenta(localId) {
  const fila = await prisma.cuentaLocal.findUnique({ where: { localId } });
  assert.ok(fila, 'todo local debe tener cuenta_local');
  return fila;
}

describe('ledger - efectos de los tipos nuevos', () => {
  test('liberacion acredita la formula con envio', CON_BASE, async () => {
    const { local, variante } = await crearCatalogo({ precio: 15000n });
    const { subPedido } = await crearPedidoDePrueba({
      local,
      variante,
      cantidad: 2,
      comision: 2000n,
      costoEnvio: 2000n,
    });

    const monto = calcularMontoLiberacion(subPedido);
    assert.equal(monto, 30000n, 'subtotal 30000 + envio 2000 - comision 2000');

    const movimiento = await mov({
      tipo: 'liberacion',
      monto,
      localId: local.id,
      subPedidoId: subPedido.id,
    });

    assert.equal(movimiento.tipo, 'liberacion');
    assert.equal(movimiento.monto, 30000n);
    assert.equal((await cuenta(local.id)).saldoPorPagar, 30000n);
  });

  test('congelacion y descongelacion mueven el saldo en las dos direcciones', CON_BASE, async () => {
    const { local } = await crearCatalogo();
    await mov({ tipo: 'liberacion', monto: 30000n, localId: local.id });

    await mov({ tipo: 'congelacion', monto: 10000n, localId: local.id });
    let fila = await cuenta(local.id);
    assert.equal(fila.saldoPorPagar, 20000n);
    assert.equal(fila.saldoCongelado, 10000n);

    await mov({ tipo: 'descongelacion', monto: 4000n, localId: local.id });
    fila = await cuenta(local.id);
    assert.equal(fila.saldoPorPagar, 24000n);
    assert.equal(fila.saldoCongelado, 6000n);
  });

  test('deuda_reembolso suma deuda', CON_BASE, async () => {
    const { local } = await crearCatalogo();

    await mov({ tipo: 'deuda_reembolso', monto: 7500n, localId: local.id });

    assert.equal((await cuenta(local.id)).saldoDeuda, 7500n);
  });

  test('reversa_pago_a_local devuelve el saldo debitado', CON_BASE, async () => {
    const { local } = await crearCatalogo();
    await mov({ tipo: 'liberacion', monto: 10000n, localId: local.id });
    await mov({ tipo: 'pago_a_local', monto: 4000n, localId: local.id });
    assert.equal((await cuenta(local.id)).saldoPorPagar, 6000n);

    await mov({ tipo: 'reversa_pago_a_local', monto: 4000n, localId: local.id });

    assert.equal((await cuenta(local.id)).saldoPorPagar, 10000n);
  });

  test('reversa_cobro_deuda devuelve la deuda compensada', CON_BASE, async () => {
    const { local } = await crearCatalogo();
    await mov({ tipo: 'deuda_reembolso', monto: 10000n, localId: local.id });
    await mov({ tipo: 'cobro_deuda', monto: 3000n, localId: local.id });
    assert.equal((await cuenta(local.id)).saldoDeuda, 7000n);

    await mov({ tipo: 'reversa_cobro_deuda', monto: 3000n, localId: local.id });

    assert.equal((await cuenta(local.id)).saldoDeuda, 10000n);
  });

  test('comision con local_id suma deuda y sin local_id no toca la cuenta', CON_BASE, async () => {
    const { local, variante } = await crearCatalogo();
    const { subPedido } = await crearPedidoDePrueba({
      local,
      variante,
      comision: 2000n,
    });

    await mov({
      tipo: 'comision',
      monto: 2000n,
      localId: local.id,
      subPedidoId: subPedido.id,
    });
    assert.equal((await cuenta(local.id)).saldoDeuda, 2000n);

    await mov({
      tipo: 'comision',
      monto: 5000n,
      subPedidoId: subPedido.id,
    });
    assert.equal((await cuenta(local.id)).saldoDeuda, 2000n);
  });

  test('reversa_comision descuenta deuda si la comision fue en efectivo', CON_BASE, async () => {
    const { local, variante } = await crearCatalogo();
    const { subPedido } = await crearPedidoDePrueba({
      local,
      variante,
      comision: 2000n,
    });
    await mov({
      tipo: 'comision',
      monto: 2000n,
      localId: local.id,
      subPedidoId: subPedido.id,
    });

    await mov({
      tipo: 'reversa_comision',
      monto: 2000n,
      localId: local.id,
      subPedidoId: subPedido.id,
    });

    const fila = await cuenta(local.id);
    assert.equal(fila.saldoDeuda, 0n);
    assert.equal(fila.saldoPorPagar, 0n);
  });

  test('reversa_comision acredita saldo si la comision fue digital', CON_BASE, async () => {
    const { local, variante } = await crearCatalogo();
    const { subPedido } = await crearPedidoDePrueba({
      local,
      variante,
      comision: 2000n,
    });
    await mov({
      tipo: 'comision',
      monto: 2000n,
      pagoId: null,
      subPedidoId: subPedido.id,
    });

    await mov({
      tipo: 'reversa_comision',
      monto: 2000n,
      localId: local.id,
      subPedidoId: subPedido.id,
    });

    const fila = await cuenta(local.id);
    assert.equal(fila.saldoDeuda, 0n);
    assert.equal(fila.saldoPorPagar, 2000n);
  });

  test('reembolso descuenta por_pagar o congelado segun desdeCongelado', CON_BASE, async () => {
    const { local } = await crearCatalogo();
    await mov({ tipo: 'liberacion', monto: 10000n, localId: local.id });

    await mov({
      tipo: 'reembolso',
      monto: 3000n,
      localId: local.id,
      desdeCongelado: false,
    });
    assert.equal((await cuenta(local.id)).saldoPorPagar, 7000n);

    await mov({ tipo: 'congelacion', monto: 4000n, localId: local.id });
    await mov({
      tipo: 'reembolso',
      monto: 4000n,
      localId: local.id,
      desdeCongelado: true,
    });

    const fila = await cuenta(local.id);
    assert.equal(fila.saldoPorPagar, 3000n);
    assert.equal(fila.saldoCongelado, 0n);
  });

  test('ajuste_redondeo respeta direccion y cuenta destino', CON_BASE, async () => {
    const { local } = await crearCatalogo();
    await mov({ tipo: 'liberacion', monto: 10000n, localId: local.id });

    await mov({
      tipo: 'ajuste_redondeo',
      monto: 1n,
      localId: local.id,
      direccion: 'credito',
      cuentaAjuste: 'saldoPorPagar',
    });
    assert.equal((await cuenta(local.id)).saldoPorPagar, 10001n);

    await mov({
      tipo: 'ajuste_redondeo',
      monto: 1n,
      localId: local.id,
      direccion: 'debito',
      cuentaAjuste: 'saldoPorPagar',
    });
    assert.equal((await cuenta(local.id)).saldoPorPagar, 10000n);

    await mov({
      tipo: 'ajuste_redondeo',
      monto: 1n,
      localId: local.id,
      direccion: 'credito',
      cuentaAjuste: 'saldoDeuda',
    });
    await mov({
      tipo: 'ajuste_redondeo',
      monto: 1n,
      localId: local.id,
      direccion: 'debito',
      cuentaAjuste: 'saldoDeuda',
    });
    assert.equal((await cuenta(local.id)).saldoDeuda, 0n);
  });

  test('la UNIQUE parcial impide liberar dos veces el mismo sub_pedido', CON_BASE, async () => {
    const { local, variante } = await crearCatalogo();
    const { subPedido } = await crearPedidoDePrueba({ local, variante });
    await mov({
      tipo: 'liberacion',
      monto: 10000n,
      localId: local.id,
      subPedidoId: subPedido.id,
    });

    await assert.rejects(
      () =>
        mov({
          tipo: 'liberacion',
          monto: 10000n,
          localId: local.id,
          subPedidoId: subPedido.id,
        }),
      /unique|duplicate|duplicad/i,
    );

    assert.equal((await cuenta(local.id)).saldoPorPagar, 10000n);
  });

  test('reversa_comision con local exige sub_pedido_id', CON_BASE, async () => {
    const { local } = await crearCatalogo();

    await assert.rejects(
      () =>
        mov({
          tipo: 'reversa_comision',
          monto: 1n,
          localId: local.id,
        }),
      /sub_pedido_id/i,
    );
  });

  test('ajuste_redondeo exige direccion valida', CON_BASE, async () => {
    const { local } = await crearCatalogo();

    await assert.rejects(
      () =>
        mov({
          tipo: 'ajuste_redondeo',
          monto: 1n,
          localId: local.id,
        }),
      /direccion/i,
    );
  });
});
