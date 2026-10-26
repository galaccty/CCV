import '../helpers/entorno.js';
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { opcionesConBase, prisma, cerrarConexion } from '../helpers/base.js';
import { crearUsuarioConSesion } from '../helpers/http.js';
import {
  crearCatalogo,
  crearPagoDePrueba,
  crearPedidoDePrueba,
  crearReembolsoDePrueba,
} from '../helpers/datos.js';
import { withTransaccion } from '../../src/lib/transaccion.js';
import { registrarMovimiento } from '../../src/services/ledger.js';
import { recalcularEstadoLocal } from '../../src/services/estadoLocal.js';
import { abrirAlerta } from '../../src/services/alertas.js';

/**
 * API ADMIN DE LA ETAPA 4F-2
 * ==========================
 * Configuracion editable, alertas y listado de reembolsos. Se prueba por HTTP
 * porque importan el rol admin, CSRF, validacion Zod y la forma exacta de las
 * respuestas del contrato.
 */

const CON_BASE = await opcionesConBase();

after(async () => {
  await cerrarConexion();
});

async function crearAdminConSesion() {
  const admin = await crearUsuarioConSesion({ roles: ['comprador'] });
  await prisma.usuarioRol.create({
    data: { usuarioId: admin.id, rol: 'admin' },
  });
  return admin;
}

function sufijo() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

describe('configuracion admin', () => {
  test('GET lista las claves con tipo y si estan congeladas', CON_BASE, async () => {
    const admin = await crearAdminConSesion();

    const r = await admin.cliente.get('/api/v1/admin/configuracion');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.datos.length, 14);

    const comision = r.body.datos.find(
      (fila) => fila.clave === 'porcentaje_comision',
    );
    assert.equal(comision.tipo, 'numero');
    assert.equal(comision.congelada, true);

    const limite = r.body.datos.find((fila) => fila.clave === 'limite_deuda');
    assert.equal(limite.tipo, 'entero');
    assert.equal(limite.congelada, false);
  });

  test('PATCH rechaza claves no permitidas y valores fuera de rango', CON_BASE, async () => {
    const admin = await crearAdminConSesion();

    const desconocida = await admin.cliente.patch(
      '/api/v1/admin/configuracion',
      { valores: { clave_inventada: 1 } },
    );
    assert.equal(desconocida.status, 400, JSON.stringify(desconocida.body));

    const fueraDeRango = await admin.cliente.patch(
      '/api/v1/admin/configuracion',
      { valores: { porcentaje_comision: 101 } },
    );
    assert.equal(fueraDeRango.status, 400, JSON.stringify(fueraDeRango.body));

    const tipoIncorrecto = await admin.cliente.patch(
      '/api/v1/admin/configuracion',
      { valores: { limite_deuda: '100' } },
    );
    assert.equal(
      tipoIncorrecto.status,
      400,
      JSON.stringify(tipoIncorrecto.body),
    );

    const vacio = await admin.cliente.patch('/api/v1/admin/configuracion', {
      valores: {},
    });
    assert.equal(vacio.status, 400, JSON.stringify(vacio.body));
  });

  test(
    'cambiar limite_deuda recalcula todos los locales y audita',
    CON_BASE,
    async () => {
      const admin = await crearAdminConSesion();
      const fila = await prisma.configuracion.findUnique({
        where: { clave: 'limite_deuda' },
      });
      const limiteOriginal = Number.parseInt(fila.valor, 10);
      const limiteNuevo = limiteOriginal + 7;
      const { local } = await crearCatalogo({ precio: 10000n });

      await withTransaccion((tx) =>
        registrarMovimiento({
          tipo: 'comision',
          monto: BigInt(limiteOriginal + 6),
          localId: local.id,
        }),
      );

      const antes = await withTransaccion((tx) =>
        recalcularEstadoLocal(local.id, tx, { ahora: new Date() }),
      );
      assert.equal(antes.estado, 'en_plazo');

      try {
        const r = await admin.cliente.patch(
          '/api/v1/admin/configuracion',
          { valores: { limite_deuda: limiteNuevo } },
        );
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assert.ok(r.body.locales_recalculados >= 1);

        const cambio = r.body.cambios.find(
          (filaCambio) => filaCambio.clave === 'limite_deuda',
        );
        assert.equal(cambio.valor_anterior, limiteOriginal);
        assert.equal(cambio.valor_nuevo, limiteNuevo);
        assert.equal(cambio.congelada, false);

        const localDb = await prisma.local.findUnique({
          where: { id: local.id },
        });
        assert.equal(localDb.estado, 'activo');

        const auditorias = await prisma.auditoriaAdmin.findMany({
          where: {
            adminId: admin.id,
            accion: 'actualizar_configuracion',
            objetoId: 'limite_deuda',
          },
          orderBy: { id: 'desc' },
        });
        const auditoria = auditorias[0];
        assert.ok(auditoria);
        assert.equal(auditoria.detalle.actor_id, admin.id);
        assert.equal(auditoria.detalle.valor_anterior, limiteOriginal);
        assert.equal(auditoria.detalle.valor_nuevo, limiteNuevo);
        assert.ok(Date.parse(auditoria.detalle.fecha) > 0);
      } finally {
        const restaurado = await admin.cliente.patch(
          '/api/v1/admin/configuracion',
          { valores: { limite_deuda: limiteOriginal } },
        );
        assert.equal(restaurado.status, 200, JSON.stringify(restaurado.body));
      }
    },
  );

  test(
    'cambiar una clave congelada indica que solo afecta pedidos nuevos',
    CON_BASE,
    async () => {
      const admin = await crearAdminConSesion();

      const r = await admin.cliente.patch('/api/v1/admin/configuracion', {
        valores: { porcentaje_comision: 5 },
      });
      assert.equal(r.status, 200, JSON.stringify(r.body));

      const cambio = r.body.cambios.find(
        (filaCambio) => filaCambio.clave === 'porcentaje_comision',
      );
      assert.equal(cambio.congelada, true);
      assert.equal(cambio.afecta_pedidos_nuevos, true);
      assert.match(cambio.mensaje, /pedidos creados desde ahora/i);
    },
  );
});

describe('alertas admin', () => {
  test(
    'lista con filtros, resuelve con nota auditada y rechaza doble resolucion',
    CON_BASE,
    async () => {
      const admin = await crearAdminConSesion();
      const { local } = await crearCatalogo({ precio: 10000n });
      const clave = `prueba:4f2:${sufijo()}`;

      const alerta = await abrirAlerta({
        clave,
        tipo: 'conciliacion_saldo',
        severidad: 'alta',
        titulo: 'Diferencia de prueba',
        detalle: { local_id: local.id, diferencias: [] },
        localId: local.id,
      });

      const listado = await admin.cliente.get(
        `/api/v1/admin/alertas?estado=abierta&tipo=conciliacion_saldo&local_id=${local.id}&por_pagina=100`,
      );
      assert.equal(listado.status, 200, JSON.stringify(listado.body));
      assert.equal(listado.body.paginacion.total, 1);
      assert.equal(listado.body.datos[0].id, alerta.id);
      assert.equal(listado.body.datos[0].clave, clave);
      assert.equal(listado.body.datos[0].local_id, local.id);

      const resolucion = await admin.cliente.post(
        `/api/v1/admin/alertas/${alerta.id}/resolver`,
        { nota: 'Revisada con el area contable' },
      );
      assert.equal(resolucion.status, 200, JSON.stringify(resolucion.body));
      assert.equal(resolucion.body.estado, 'resuelta');
      assert.equal(resolucion.body.resuelta_por, admin.id);
      assert.equal(
        resolucion.body.nota_resolucion,
        'Revisada con el area contable',
      );

      const auditoria = await prisma.auditoriaAdmin.findFirst({
        where: {
          adminId: admin.id,
          accion: 'resolver_alerta',
          objetoId: String(alerta.id),
        },
      });
      assert.ok(auditoria);
      assert.equal(auditoria.detalle.nota, 'Revisada con el area contable');

      const repetida = await admin.cliente.post(
        `/api/v1/admin/alertas/${alerta.id}/resolver`,
        { nota: 'Segundo intento' },
      );
      assert.equal(repetida.status, 409, JSON.stringify(repetida.body));

      const reabierta = await abrirAlerta({
        clave,
        tipo: 'conciliacion_saldo',
        severidad: 'alta',
        titulo: 'Diferencia de prueba',
        detalle: { local_id: local.id, diferencias: [] },
        localId: local.id,
      });
      assert.equal(reabierta.estado, 'abierta');
      assert.equal(reabierta.resueltaEn, null);
      assert.equal(reabierta.notaResolucion, null);
    },
  );
});

describe('listado admin de reembolsos', () => {
  test(
    'pagina y filtra por estado y local con los datos del local',
    CON_BASE,
    async () => {
      const admin = await crearAdminConSesion();
      const { local, variante } = await crearCatalogo({ precio: 10000n });
      const { pedido, subPedido } = await crearPedidoDePrueba({
        local,
        variante,
        metodoPago: 'tarjeta',
        estadoPedido: 'en_proceso',
        estadoSubPedido: 'entregado',
      });
      const pago = await crearPagoDePrueba({
        pedido,
        metodoPago: 'tarjeta',
        estado: 'aprobado',
      });
      const reembolso = await crearReembolsoDePrueba({
        pago,
        subPedido,
        estado: 'pendiente',
        tipo: 'digital',
      });

      const pendientes = await admin.cliente.get(
        `/api/v1/admin/reembolsos?estado=pendiente&local_id=${local.id}&por_pagina=10`,
      );
      assert.equal(pendientes.status, 200, JSON.stringify(pendientes.body));
      assert.equal(pendientes.body.paginacion.total, 1);
      assert.equal(pendientes.body.datos[0].id, reembolso.id);
      assert.equal(pendientes.body.datos[0].local_id, local.id);
      assert.equal(pendientes.body.datos[0].local_nombre, local.nombre);
      assert.equal(pendientes.body.paginacion.pagina, 1);
      assert.equal(pendientes.body.paginacion.por_pagina, 10);

      const completados = await admin.cliente.get(
        `/api/v1/admin/reembolsos?estado=completado&local_id=${local.id}`,
      );
      assert.equal(completados.status, 200, JSON.stringify(completados.body));
      assert.equal(completados.body.paginacion.total, 0);
      assert.deepEqual(completados.body.datos, []);
    },
  );
});
