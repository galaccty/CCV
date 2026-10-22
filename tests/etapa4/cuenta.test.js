import '../helpers/entorno.js';
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { opcionesConBase, prisma, cerrarConexion } from '../helpers/base.js';
import {
  crearUsuarioConSesion,
} from '../helpers/http.js';
import {
  crearCatalogoParaVendedor,
  crearUsuarioDirecto,
} from '../helpers/datos.js';
import { withTransaccion } from '../../src/lib/transaccion.js';
import { registrarMovimiento } from '../../src/services/ledger.js';
import {
  confirmarPagoDeuda,
  reportarPagoDeuda,
} from '../../src/services/pagoDeuda.js';

/**
 * CUENTA Y MOVIMIENTOS - ETAPA 4b
 * ===============================
 * La cuenta refleja el ledger. El vendedor solo ve sus locales; el admin ve
 * cualquiera. Los movimientos exponen los enlaces de trazabilidad, incluido
 * `pago_deuda_id` en los cobros de deuda.
 */

const CON_BASE = await opcionesConBase();

after(async () => {
  await cerrarConexion();
});

function clave(prefijo = 'cuenta') {
  return `${prefijo}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

async function crearAdminConSesion() {
  const admin = await crearUsuarioConSesion({ roles: ['comprador'] });
  await prisma.usuarioRol.create({
    data: { usuarioId: admin.id, rol: 'admin' },
  });
  return admin;
}

async function montarLocal() {
  const vendedor = await crearUsuarioConSesion({
    nombre: 'Vendedor cuenta',
    roles: ['vendedor'],
  });
  const catalogo = await crearCatalogoParaVendedor({
    vendedorId: vendedor.id,
    precio: 10000n,
  });
  return { vendedor, ...catalogo };
}

async function asentar({ tipo, monto, localId }) {
  await withTransaccion(async () => {
    await registrarMovimiento({ tipo, monto, localId });
  });
}

describe('cuenta del local', () => {
  test('el vendedor ve los saldos de su local', CON_BASE, async () => {
    const { vendedor, local } = await montarLocal();
    await asentar({ tipo: 'comision', monto: 2000n, localId: local.id });
    await asentar({ tipo: 'deuda_reembolso', monto: 1000n, localId: local.id });
    await asentar({ tipo: 'liberacion', monto: 8000n, localId: local.id });

    const r = await vendedor.cliente.get(
      `/api/v1/vendedor/cuenta?local_id=${local.id}`,
    );

    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.local_id, local.id);
    assert.equal(r.body.nombre, local.nombre);
    assert.equal(r.body.estado, 'activo');
    assert.equal(r.body.puede_vender, true);
    assert.equal(r.body.saldo_deuda, 3000);
    assert.equal(r.body.saldo_por_pagar, 8000);
    assert.equal(r.body.saldo_congelado, 0);
    assert.equal(r.body.fecha_limite_pago, null);
    assert.equal(r.body.usuario_id, undefined);
  });

  test('el admin ve cualquier local y recibe el usuario_id', CON_BASE, async () => {
    const { local } = await montarLocal();
    const admin = await crearAdminConSesion();

    const r = await admin.cliente.get(
      `/api/v1/admin/locales/${local.id}/cuenta`,
    );

    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.local_id, local.id);
    assert.equal(r.body.usuario_id, local.usuarioId);
    assert.equal(r.body.saldo_deuda, 0);
  });

  test('el vendedor no puede leer la cuenta de un local ajeno', CON_BASE, async () => {
    const { local } = await montarLocal();
    const otro = await crearUsuarioConSesion({ roles: ['vendedor'] });

    const cuenta = await otro.cliente.get(
      `/api/v1/vendedor/cuenta?local_id=${local.id}`,
    );
    const movimientos = await otro.cliente.get(
      `/api/v1/vendedor/movimientos?local_id=${local.id}`,
    );

    assert.equal(cuenta.status, 404, JSON.stringify(cuenta.body));
    assert.equal(movimientos.status, 404, JSON.stringify(movimientos.body));
  });

  test('exige local_id en la cuenta del vendedor', CON_BASE, async () => {
    const vendedor = await crearUsuarioConSesion({ roles: ['vendedor'] });

    const r = await vendedor.cliente.get('/api/v1/vendedor/cuenta');

    assert.equal(r.status, 400, JSON.stringify(r.body));
  });
});

describe('movimientos del ledger', () => {
  test('el cobro de deuda muestra su pago_deuda_id', CON_BASE, async () => {
    const { vendedor, local } = await montarLocal();
    const admin = await crearUsuarioDirecto({
      nombre: 'Admin movimientos',
      roles: ['admin'],
    });
    await asentar({ tipo: 'comision', monto: 5000n, localId: local.id });

    const pago = await reportarPagoDeuda({
      usuario: vendedor,
      datos: {
        local_id: local.id,
        monto: 5000,
        metodo: 'transferencia',
        referencia: clave('mov'),
        comprobante_url: null,
      },
    });
    await confirmarPagoDeuda({ admin, id: pago.id });

    const r = await vendedor.cliente.get(
      `/api/v1/vendedor/movimientos?local_id=${local.id}`,
    );

    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.paginacion.total, 2);

    const cobro = r.body.datos.find((m) => m.tipo === 'cobro_deuda');
    assert.ok(cobro);
    assert.equal(cobro.pago_deuda_id, pago.id);
    assert.equal(cobro.monto, 5000);
    assert.equal(cobro.local_id, local.id);

    const comision = r.body.datos.find((m) => m.tipo === 'comision');
    assert.equal(comision.pago_deuda_id, null);
  });

  test('pagina los movimientos del mas reciente al mas antiguo', CON_BASE, async () => {
    const { vendedor, local } = await montarLocal();
    await asentar({ tipo: 'comision', monto: 1000n, localId: local.id });
    await asentar({ tipo: 'liberacion', monto: 2000n, localId: local.id });
    await asentar({ tipo: 'deuda_reembolso', monto: 3000n, localId: local.id });

    const r = await vendedor.cliente.get(
      `/api/v1/vendedor/movimientos?local_id=${local.id}&pagina=1&por_pagina=2`,
    );

    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.datos.length, 2);
    assert.equal(r.body.paginacion.total, 3);
    assert.deepEqual(
      r.body.datos.map((m) => m.tipo),
      ['deuda_reembolso', 'liberacion'],
    );
  });

  test('el admin consulta los movimientos de cualquier local', CON_BASE, async () => {
    const { local } = await montarLocal();
    const admin = await crearAdminConSesion();
    await asentar({ tipo: 'venta', monto: 7000n, localId: local.id });

    const r = await admin.cliente.get(
      `/api/v1/admin/locales/${local.id}/movimientos`,
    );

    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.datos.length, 1);
    assert.equal(r.body.datos[0].tipo, 'venta');
    assert.equal(r.body.datos[0].monto, 7000);
  });
});
