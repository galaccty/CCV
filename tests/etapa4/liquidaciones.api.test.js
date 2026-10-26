import '../helpers/entorno.js';
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { opcionesConBase, prisma, cerrarConexion } from '../helpers/base.js';
import {
  crearCatalogoParaVendedor,
  crearUsuarioDirecto,
} from '../helpers/datos.js';
import { crearUsuarioConSesion } from '../helpers/http.js';
import { withTransaccion } from '../../src/lib/transaccion.js';
import { registrarMovimiento } from '../../src/services/ledger.js';

/**
 * RUTAS DE LIQUIDACIONES - ETAPA 4e
 * =================================
 * Comprueba el contrato HTTP: permisos, Idempotency-Key, montos calculados
 * por el backend, mascaras del vendedor y cuenta completa solo en el detalle
 * de admin.
 */

const CON_BASE = await opcionesConBase();

after(async () => {
  await cerrarConexion();
});

const CUENTA = {
  banco: 'Banco API',
  tipo_cuenta: 'corriente',
  numero_cuenta: '1234567890123456',
  titular: 'Titular API',
  documento_titular: '1122334455',
};

function clave(prefijo = 'api-liquidacion') {
  return `${prefijo}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

async function crearAdminConSesion() {
  const admin = await crearUsuarioConSesion({ roles: ['comprador'] });
  await prisma.usuarioRol.create({
    data: { usuarioId: admin.id, rol: 'admin' },
  });
  return admin;
}

async function asentar(datos) {
  return withTransaccion(() => registrarMovimiento(datos));
}

async function crearEscenarioHttp({ estadoLocal = 'activo' } = {}) {
  const vendedor = await crearUsuarioConSesion({ roles: ['vendedor'] });
  const { local } = await crearCatalogoParaVendedor({
    vendedorId: vendedor.id,
    estadoLocal,
  });
  return { vendedor, local };
}

describe('API de liquidaciones', () => {
  test(
    'flujo completo: montos del backend, mascaras, idempotencia y detalle admin',
    CON_BASE,
    async () => {
      const { vendedor, local } = await crearEscenarioHttp();
      const admin = await crearAdminConSesion();

      const banco = await vendedor.cliente.put(
        `/api/v1/vendedor/locales/${local.id}/cuenta-bancaria`,
        CUENTA,
      );
      assert.equal(banco.status, 200, JSON.stringify(banco.body));
      assert.equal(banco.body.numero_cuenta_enmascarado, '****3456');
      assert.equal(
        banco.body.documento_titular_enmascarado,
        '****4455',
      );

      await asentar({
        tipo: 'liberacion',
        monto: 40n,
        localId: local.id,
      });
      await asentar({
        tipo: 'deuda_reembolso',
        monto: 100n,
        localId: local.id,
      });

      const idempotencyKey = clave('crear');
      const creacion = await admin.cliente.post(
        '/api/v1/admin/liquidaciones',
        {
          local_id: local.id,
          // El cliente intenta imponer montos: el backend debe ignorarlos.
          monto_liberado: 999999,
          monto_compensado: 999999,
          total_pagado: 123,
        },
        { 'Idempotency-Key': idempotencyKey },
      );
      assert.equal(creacion.status, 201, JSON.stringify(creacion.body));
      assert.equal(creacion.body.local_id, local.id);
      assert.equal(creacion.body.estado, 'borrador');
      assert.equal(creacion.body.monto_liberado, 40);
      assert.equal(creacion.body.monto_compensado, 40);
      assert.equal(creacion.body.total_pagado, 0);
      assert.equal(creacion.body.cuenta_destino.numero_cuenta, undefined);

      const repetida = await admin.cliente.post(
        '/api/v1/admin/liquidaciones',
        { local_id: local.id },
        { 'Idempotency-Key': idempotencyKey },
      );
      assert.equal(repetida.status, 201);
      assert.equal(repetida.body.id, creacion.body.id);
      assert.deepEqual(repetida.body, creacion.body);
      assert.equal(
        await prisma.liquidacion.count({ where: { localId: local.id } }),
        1,
      );

      const listaAdmin = await admin.cliente.get(
        `/api/v1/admin/liquidaciones?local_id=${local.id}`,
      );
      assert.equal(listaAdmin.status, 200, JSON.stringify(listaAdmin.body));
      assert.equal(listaAdmin.body.datos.length, 1);
      const filaLista = listaAdmin.body.datos[0];
      assert.equal(filaLista.cuenta_destino.numero_cuenta, undefined);
      assert.equal(
        filaLista.cuenta_destino.numero_cuenta_enmascarado,
        '****3456',
      );

      const detalleAdmin = await admin.cliente.get(
        `/api/v1/admin/liquidaciones/${creacion.body.id}`,
      );
      assert.equal(
        detalleAdmin.status,
        200,
        JSON.stringify(detalleAdmin.body),
      );
      assert.equal(
        detalleAdmin.body.cuenta_destino.numero_cuenta,
        CUENTA.numero_cuenta,
      );
      assert.equal(
        detalleAdmin.body.cuenta_destino.documento_titular,
        CUENTA.documento_titular,
      );
      assert.equal(
        detalleAdmin.body.cuenta_destino.numero_cuenta_enmascarado,
        '****3456',
      );
      assert.equal(detalleAdmin.body.monto_compensado, 40);
      assert.equal(detalleAdmin.body.total_pagado, 0);

      const auditoriaDetalle = await prisma.auditoriaAdmin.findFirst({
        where: {
          accion: 'ver_datos_bancarios_liquidacion',
          objetoId: String(creacion.body.id),
        },
        orderBy: { id: 'desc' },
      });
      assert.ok(auditoriaDetalle, 'el detalle admin debe quedar auditado');
      assert.equal(auditoriaDetalle.adminId, admin.id);
      assert.equal(auditoriaDetalle.objeto, 'liquidacion');
      assert.equal(
        auditoriaDetalle.detalle.liquidacion_id,
        creacion.body.id,
      );
      assert.equal(auditoriaDetalle.detalle.local_id, local.id);
      assert.deepEqual(auditoriaDetalle.detalle.campos_revelados, [
        'numero_cuenta',
        'documento_titular',
      ]);
      assert.ok(auditoriaDetalle.fecha instanceof Date);
      assert.equal(
        JSON.stringify(auditoriaDetalle.detalle).includes(CUENTA.numero_cuenta),
        false,
        'la auditoria no debe copiar el numero de cuenta',
      );

      const listaVendedor = await vendedor.cliente.get(
        '/api/v1/vendedor/liquidaciones',
      );
      assert.equal(
        listaVendedor.status,
        200,
        JSON.stringify(listaVendedor.body),
      );
      assert.equal(listaVendedor.body.datos.length, 1);
      assert.equal(
        listaVendedor.body.datos[0].cuenta_destino.numero_cuenta,
        undefined,
      );
      assert.equal(
        listaVendedor.body.datos[0].cuenta_destino
          .numero_cuenta_enmascarado,
        '****3456',
      );

      const detalleVendedor = await vendedor.cliente.get(
        `/api/v1/vendedor/liquidaciones/${creacion.body.id}`,
      );
      assert.equal(
        detalleVendedor.status,
        200,
        JSON.stringify(detalleVendedor.body),
      );
      assert.equal(
        detalleVendedor.body.cuenta_destino.numero_cuenta,
        undefined,
      );
      assert.equal(
        detalleVendedor.body.cuenta_destino.numero_cuenta_enmascarado,
        '****3456',
      );
      assert.equal(
        JSON.stringify(detalleVendedor.body).includes(CUENTA.numero_cuenta),
        false,
      );

      const preparacion = await admin.cliente.post(
        `/api/v1/admin/liquidaciones/${creacion.body.id}/preparar`,
        undefined,
        { 'Idempotency-Key': clave('preparar') },
      );
      assert.equal(
        preparacion.status,
        200,
        JSON.stringify(preparacion.body),
      );
      assert.equal(preparacion.body.estado, 'en_proceso');
      assert.equal(preparacion.body.monto_compensado, 40);
      assert.equal(preparacion.body.total_pagado, 0);
      assert.equal(
        preparacion.body.cuenta_destino.numero_cuenta,
        undefined,
      );

      const snapshot = await prisma.liquidacion.findUnique({
        where: { id: creacion.body.id },
        select: {
          numeroCuentaDestinoCifrado: true,
          documentoTitularDestinoCifrado: true,
        },
      });
      assert.match(snapshot.numeroCuentaDestinoCifrado, /^v1\./);
      assert.match(snapshot.documentoTitularDestinoCifrado, /^v1\./);
      assert.equal(
        JSON.stringify(snapshot).includes(CUENTA.numero_cuenta),
        false,
      );
      assert.equal(
        JSON.stringify(snapshot).includes(CUENTA.documento_titular),
        false,
      );

      const cuenta = await prisma.cuentaLocal.findUnique({
        where: { localId: local.id },
      });
      assert.equal(cuenta.saldoDeuda, 60n);
      assert.equal(cuenta.saldoPorPagar, 0n);

      const comprobanteInvalido = await admin.cliente.post(
        `/api/v1/admin/liquidaciones/${creacion.body.id}/confirmar`,
        {
          referencia_payout: clave('payout-malo'),
          comprobante_url: 'http://ejemplo.com/comprobante.pdf',
        },
        { 'Idempotency-Key': clave('confirmar-malo') },
      );
      assert.equal(
        comprobanteInvalido.status,
        400,
        JSON.stringify(comprobanteInvalido.body),
      );
      assert.equal(
        comprobanteInvalido.body.error.codigo,
        'validacion_invalida',
      );
      const sigueEnProceso = await prisma.liquidacion.findUnique({
        where: { id: creacion.body.id },
        select: { estado: true },
      });
      assert.equal(sigueEnProceso.estado, 'en_proceso');

      const confirmacion = await admin.cliente.post(
        `/api/v1/admin/liquidaciones/${creacion.body.id}/confirmar`,
        {
          referencia_payout: clave('payout'),
          comprobante_url: 'https://ejemplo.com/comprobante.pdf',
          total_pagado: 999999,
        },
        { 'Idempotency-Key': clave('confirmar') },
      );
      assert.equal(
        confirmacion.status,
        200,
        JSON.stringify(confirmacion.body),
      );
      assert.equal(confirmacion.body.estado, 'pagada');
      assert.equal(confirmacion.body.total_pagado, 0);
      assert.ok(confirmacion.body.fecha_pago);

      const inmutable = await admin.cliente.post(
        `/api/v1/admin/liquidaciones/${creacion.body.id}/cancelar`,
        undefined,
        { 'Idempotency-Key': clave('cancelar') },
      );
      assert.equal(inmutable.status, 409, JSON.stringify(inmutable.body));
      assert.equal(
        inmutable.body.error.codigo,
        'liquidacion_estado_invalido',
      );
      assert.equal(
        await prisma.ledger.count({
          where: { localId: local.id, tipo: 'pago_a_local' },
        }),
        0,
      );
    },
  );

  test('exige admin, Idempotency-Key y respeta la propiedad del vendedor', CON_BASE, async () => {
    const { vendedor, local } = await crearEscenarioHttp();
    const comprador = await crearUsuarioConSesion({ roles: ['comprador'] });
    const otroVendedor = await crearUsuarioConSesion({ roles: ['vendedor'] });
    const admin = await crearAdminConSesion();

    await vendedor.cliente.put(
      `/api/v1/vendedor/locales/${local.id}/cuenta-bancaria`,
      CUENTA,
    );
    await asentar({ tipo: 'liberacion', monto: 10000n, localId: local.id });

    const sinClave = await admin.cliente.post(
      '/api/v1/admin/liquidaciones',
      { local_id: local.id },
    );
    assert.equal(sinClave.status, 400, JSON.stringify(sinClave.body));
    assert.equal(
      sinClave.body.error.codigo,
      'validacion_invalida',
    );

    const sinAdmin = await comprador.cliente.post(
      '/api/v1/admin/liquidaciones',
      { local_id: local.id },
      { 'Idempotency-Key': clave('sin-admin') },
    );
    assert.equal(sinAdmin.status, 403, JSON.stringify(sinAdmin.body));

    const creada = await admin.cliente.post(
      '/api/v1/admin/liquidaciones',
      { local_id: local.id },
      { 'Idempotency-Key': clave('propiedad') },
    );
    assert.equal(creada.status, 201, JSON.stringify(creada.body));

    const ajena = await otroVendedor.cliente.get(
      `/api/v1/vendedor/liquidaciones/${creada.body.id}`,
    );
    assert.equal(ajena.status, 404, JSON.stringify(ajena.body));

    const listaAjena = await otroVendedor.cliente.get(
      '/api/v1/vendedor/liquidaciones',
    );
    assert.equal(listaAjena.status, 200, JSON.stringify(listaAjena.body));
    assert.equal(
      listaAjena.body.datos.some((fila) => fila.id === creada.body.id),
      false,
    );

    const adminNoVendedor = await admin.cliente.get(
      `/api/v1/vendedor/liquidaciones/${creada.body.id}`,
    );
    assert.equal(
      adminNoVendedor.status,
      403,
      JSON.stringify(adminNoVendedor.body),
    );
  });

  test('un local suspendido exige confirmacion explicita', CON_BASE, async () => {
    const { vendedor, local } = await crearEscenarioHttp({
      estadoLocal: 'suspendido',
    });
    const admin = await crearAdminConSesion();

    await vendedor.cliente.put(
      `/api/v1/vendedor/locales/${local.id}/cuenta-bancaria`,
      CUENTA,
    );
    await asentar({ tipo: 'liberacion', monto: 5000n, localId: local.id });

    const sinConfirmar = await admin.cliente.post(
      '/api/v1/admin/liquidaciones',
      { local_id: local.id },
      { 'Idempotency-Key': clave('suspendido-no') },
    );
    assert.equal(sinConfirmar.status, 409, JSON.stringify(sinConfirmar.body));
    assert.equal(
      sinConfirmar.body.error.codigo,
      'liquidacion_local_suspendido',
    );
    assert.equal(
      await prisma.liquidacion.count({ where: { localId: local.id } }),
      0,
    );

    const confirmada = await admin.cliente.post(
      '/api/v1/admin/liquidaciones',
      { local_id: local.id, confirmar_local_suspendido: true },
      { 'Idempotency-Key': clave('suspendido-si') },
    );
    assert.equal(confirmada.status, 201, JSON.stringify(confirmada.body));
    assert.equal(confirmada.body.estado, 'borrador');
    assert.equal(confirmada.body.total_pagado, 5000);
  });
});
