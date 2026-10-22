import '../helpers/entorno.js';
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { opcionesConBase, prisma, cerrarConexion } from '../helpers/base.js';
import {
  cliente,
  crearUsuarioConSesion,
} from '../helpers/http.js';
import { crearCatalogo, crearUsuarioDirecto } from '../helpers/datos.js';
import { withTransaccion } from '../../src/lib/transaccion.js';
import { registrarMovimiento } from '../../src/services/ledger.js';
import {
  confirmarPagoDeuda,
  reportarPagoDeuda,
} from '../../src/services/pagoDeuda.js';

/**
 * PAGOS DE LA DEUDA DE COMISION - ETAPA 4b
 * ========================================
 * Reportar no mueve el ledger. Confirmar cobra una sola vez, con
 * `pago_deuda_id` en el movimiento y recalculando el estado del local.
 */

const CON_BASE = await opcionesConBase();

after(async () => {
  await cerrarConexion();
});

function clave(prefijo = 'pago-deuda') {
  return `${prefijo}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

async function crearAdminConSesion() {
  const admin = await crearUsuarioConSesion({ roles: ['comprador'] });
  await prisma.usuarioRol.create({
    data: { usuarioId: admin.id, rol: 'admin' },
  });
  return admin;
}

async function crearDeuda(localId, monto) {
  await withTransaccion(async () => {
    await registrarMovimiento({
      tipo: 'deuda_reembolso',
      monto,
      localId,
    });
  });
}

async function saldoDeuda(localId) {
  const cuenta = await prisma.cuentaLocal.findUnique({ where: { localId } });
  return cuenta.saldoDeuda;
}

function cuerpoReporte(localId, monto, extra = {}) {
  return {
    local_id: localId,
    monto,
    metodo: 'transferencia',
    referencia: clave('ref'),
    comprobante_url: 'https://ejemplo.com/comprobante.pdf',
    ...extra,
  };
}

describe('reportar y confirmar un pago de deuda', () => {
  test('el reporte queda pendiente y no toca el ledger', CON_BASE, async () => {
    const vendedor = await crearUsuarioConSesion({ roles: ['vendedor'] });
    const { local } = await crearCatalogo({
      vendedorId: vendedor.id,
      precio: 10000n,
    });
    await crearDeuda(local.id, 30000n);

    const r = await vendedor.cliente.post(
      '/api/v1/vendedor/deuda/pagos',
      cuerpoReporte(local.id, 12000),
      { 'Idempotency-Key': clave() },
    );

    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.estado, 'pendiente');
    assert.equal(r.body.local_id, local.id);
    assert.equal(r.body.monto, 12000);
    assert.equal(r.body.reportado_por, vendedor.id);
    assert.equal(await saldoDeuda(local.id), 30000n);

    const movimientos = await prisma.ledger.count({ where: { localId: local.id } });
    assert.equal(movimientos, 1);
    assert.equal(
      await prisma.ledger.count({
        where: { localId: local.id, tipo: 'cobro_deuda' },
      }),
      0,
    );
  });

  test('el admin confirma: un cobro_deuda con pago_deuda_id y deuda menor', CON_BASE, async () => {
    const vendedor = await crearUsuarioConSesion({ roles: ['vendedor'] });
    const admin = await crearAdminConSesion();
    const { local } = await crearCatalogo({
      vendedorId: vendedor.id,
      precio: 10000n,
    });
    await crearDeuda(local.id, 30000n);

    const reporte = await vendedor.cliente.post(
      '/api/v1/vendedor/deuda/pagos',
      cuerpoReporte(local.id, 12000),
      { 'Idempotency-Key': clave() },
    );

    const r = await admin.cliente.post(
      `/api/v1/admin/pagos-deuda/${reporte.body.id}/confirmar`,
      undefined,
      { 'Idempotency-Key': clave() },
    );

    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.estado, 'confirmado');
    assert.equal(r.body.confirmado_por, admin.id);
    assert.ok(r.body.fecha_confirmacion);
    assert.equal(await saldoDeuda(local.id), 18000n);

    const movimientos = await prisma.ledger.findMany({
      where: { localId: local.id, tipo: 'cobro_deuda' },
    });
    assert.equal(movimientos.length, 1);
    assert.equal(movimientos[0].monto, 12000n);
    assert.equal(movimientos[0].pagoDeudaId, reporte.body.id);
  });

  test('el admin registra un pago directo y nace confirmado', CON_BASE, async () => {
    const vendedor = await crearUsuarioConSesion({ roles: ['vendedor'] });
    const admin = await crearAdminConSesion();
    const { local } = await crearCatalogo({ vendedorId: vendedor.id });
    await crearDeuda(local.id, 25000n);

    const r = await admin.cliente.post(
      `/api/v1/admin/locales/${local.id}/pagos-deuda`,
      {
        monto: 25000,
        metodo: 'manual',
        referencia: clave('manual'),
      },
      { 'Idempotency-Key': clave() },
    );

    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.estado, 'confirmado');
    assert.equal(r.body.reportado_por, admin.id);
    assert.equal(r.body.confirmado_por, admin.id);
    assert.equal(await saldoDeuda(local.id), 0n);
    assert.equal(
      await prisma.ledger.count({
        where: { localId: local.id, tipo: 'cobro_deuda' },
      }),
      1,
    );

    const localActualizado = await prisma.local.findUnique({
      where: { id: local.id },
    });
    assert.equal(localActualizado.estado, 'activo');
  });

  test('rechaza un pago mayor que la deuda', CON_BASE, async () => {
    const vendedor = await crearUsuarioConSesion({ roles: ['vendedor'] });
    const { local } = await crearCatalogo({ vendedorId: vendedor.id });
    await crearDeuda(local.id, 5000n);

    const r = await vendedor.cliente.post(
      '/api/v1/vendedor/deuda/pagos',
      cuerpoReporte(local.id, 5001),
      { 'Idempotency-Key': clave() },
    );

    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.error.codigo, 'monto_excede_deuda');
    assert.equal(await saldoDeuda(local.id), 5000n);
  });

  test('rechaza una referencia duplicada', CON_BASE, async () => {
    const vendedor = await crearUsuarioConSesion({ roles: ['vendedor'] });
    const { local } = await crearCatalogo({ vendedorId: vendedor.id });
    await crearDeuda(local.id, 30000n);
    const referencia = clave('duplicada');

    const primera = await vendedor.cliente.post(
      '/api/v1/vendedor/deuda/pagos',
      cuerpoReporte(local.id, 10000, { referencia }),
      { 'Idempotency-Key': clave() },
    );
    assert.equal(primera.status, 201);

    const segunda = await vendedor.cliente.post(
      '/api/v1/vendedor/deuda/pagos',
      cuerpoReporte(local.id, 10000, { referencia }),
      { 'Idempotency-Key': clave() },
    );

    assert.equal(segunda.status, 409, JSON.stringify(segunda.body));
    assert.equal(segunda.body.error.codigo, 'referencia_pago_duplicada');
  });

  test('el vendedor no puede reportar pagos de un local ajeno', CON_BASE, async () => {
    const vendedorA = await crearUsuarioConSesion({ roles: ['vendedor'] });
    const vendedorB = await crearUsuarioConSesion({ roles: ['vendedor'] });
    const { local } = await crearCatalogo({ vendedorId: vendedorA.id });
    await crearDeuda(local.id, 10000n);

    const r = await vendedorB.cliente.post(
      '/api/v1/vendedor/deuda/pagos',
      cuerpoReporte(local.id, 1000),
      { 'Idempotency-Key': clave() },
    );

    assert.equal(r.status, 404, JSON.stringify(r.body));
  });
});

describe('concurrencia y idempotencia de pagos de deuda', () => {
  test('dos confirmaciones simultaneas cobran una sola vez', CON_BASE, async () => {
    const vendedor = await crearUsuarioDirecto({
      nombre: 'Vendedor',
      roles: ['vendedor'],
    });
    const admin = await crearUsuarioDirecto({
      nombre: 'Admin',
      roles: ['admin'],
    });
    const { local } = await crearCatalogo({ vendedorId: vendedor.id });
    await crearDeuda(local.id, 30000n);

    const pago = await reportarPagoDeuda({
      usuario: vendedor,
      datos: {
        local_id: local.id,
        monto: 10000,
        metodo: 'transferencia',
        referencia: clave('concurrente'),
        comprobante_url: null,
      },
    });

    const resultados = await Promise.allSettled([
      confirmarPagoDeuda({ admin, id: pago.id }),
      confirmarPagoDeuda({ admin, id: pago.id }),
    ]);

    const exitosas = resultados.filter((r) => r.status === 'fulfilled');
    const fallidas = resultados.filter((r) => r.status === 'rejected');

    assert.equal(exitosas.length, 1);
    assert.equal(fallidas.length, 1);
    assert.equal(fallidas[0].reason.codigo, 'pago_deuda_no_pendiente');
    assert.equal(await saldoDeuda(local.id), 20000n);

    const movimientos = await prisma.ledger.findMany({
      where: { localId: local.id, tipo: 'cobro_deuda' },
    });
    assert.equal(movimientos.length, 1);
    assert.equal(movimientos[0].pagoDeudaId, pago.id);
  });

  test('reintentar con la misma Idempotency-Key no cobra dos veces', CON_BASE, async () => {
    const vendedor = await crearUsuarioConSesion({ roles: ['vendedor'] });
    const admin = await crearAdminConSesion();
    const { local } = await crearCatalogo({ vendedorId: vendedor.id });
    await crearDeuda(local.id, 30000n);

    const reporte = await vendedor.cliente.post(
      '/api/v1/vendedor/deuda/pagos',
      cuerpoReporte(local.id, 10000),
      { 'Idempotency-Key': clave() },
    );

    const idempotencyKey = clave('confirmar');
    const primera = await admin.cliente.post(
      `/api/v1/admin/pagos-deuda/${reporte.body.id}/confirmar`,
      undefined,
      { 'Idempotency-Key': idempotencyKey },
    );
    const segunda = await admin.cliente.post(
      `/api/v1/admin/pagos-deuda/${reporte.body.id}/confirmar`,
      undefined,
      { 'Idempotency-Key': idempotencyKey },
    );

    assert.equal(primera.status, 200, JSON.stringify(primera.body));
    assert.equal(segunda.status, 200, JSON.stringify(segunda.body));
    assert.equal(segunda.body.id, primera.body.id);
    assert.equal(await saldoDeuda(local.id), 20000n);
    assert.equal(
      await prisma.ledger.count({
        where: { localId: local.id, tipo: 'cobro_deuda' },
      }),
      1,
    );
  });
});
