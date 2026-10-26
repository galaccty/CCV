import '../helpers/entorno.js';
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { opcionesConBase, prisma, cerrarConexion } from '../helpers/base.js';
import {
  cliente,
  crearUsuarioConSesion,
} from '../helpers/http.js';
import {
  crearCatalogoParaVendedor,
  crearPagoDePrueba,
  crearPedidoDePrueba,
} from '../helpers/datos.js';
import { descontarStock } from '../../src/services/stock.js';
import { completarReembolso } from '../../src/services/reembolsos.js';
import { withTransaccion } from '../../src/lib/transaccion.js';

/**
 * CANCELACIONES - ETAPA 4f-1
 * ==========================
 * Se prueba por HTTP porque importan las reglas de rol, CSRF, idempotencia y
 * la respuesta que recibe el cliente. Las carreras se lanzan con dos sesiones
 * distintas del mismo usuario o con comprador y vendedor a la vez.
 */

const CON_BASE = await opcionesConBase();

after(async () => {
  await cerrarConexion();
});

function clave(prefijo = 'cancelacion') {
  return `${prefijo}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function idempotencia(prefijo) {
  return { 'Idempotency-Key': clave(prefijo) };
}

async function crearAdminConSesion() {
  const admin = await crearUsuarioConSesion({ roles: ['comprador'] });
  await prisma.usuarioRol.create({
    data: { usuarioId: admin.id, rol: 'admin' },
  });
  return admin;
}

async function iniciarOtraSesion(usuario) {
  const agente = cliente();
  const login = await agente.post('/api/v1/auth/login', {
    email: usuario.email,
    contrasena: usuario.contrasena,
  });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  return agente;
}

async function crearEscenario({
  metodoPago = 'tarjeta',
  estadoPedido = 'en_proceso',
  estadoSubPedido = 'por_aceptar',
  estadoPago = 'aprobado',
  cantidad = 2,
  precio = 10000n,
  costoEnvio = 2000n,
  comision = 1000n,
  descontar = metodoPago !== 'efectivo',
} = {}) {
  const vendedor = await crearUsuarioConSesion({ roles: ['vendedor'] });
  const comprador = await crearUsuarioConSesion({ roles: ['comprador'] });
  const { local, variante } = await crearCatalogoParaVendedor({
    vendedorId: vendedor.id,
    precio,
    stockInicial: 10,
  });

  const { pedido, subPedido, detalle } = await crearPedidoDePrueba({
    local,
    variante,
    compradorId: comprador.id,
    cantidad,
    comision,
    costoEnvio,
    metodoPago,
    estadoPedido,
    estadoSubPedido,
  });

  const pago = await crearPagoDePrueba({
    pedido,
    monto: pedido.total,
    metodoPago,
    estado: estadoPago,
  });

  if (descontar) {
    await withTransaccion((tx) =>
      descontarStock(tx, variante.id, cantidad),
    );
  }

  return {
    vendedor,
    comprador,
    local,
    variante,
    pedido,
    subPedido,
    detalle,
    pago,
  };
}

async function estadoStock(varianteId) {
  const variante = await prisma.productoVariante.findUnique({
    where: { id: varianteId },
    select: { stock: true },
  });
  return variante.stock;
}

describe('cancelaciones digitales', () => {
  test(
    'el comprador cancela en por_aceptar: reembolso total con envio, stock y auditoria',
    CON_BASE,
    async () => {
      const escenario = await crearEscenario({
        cantidad: 2,
        precio: 10000n,
        costoEnvio: 2000n,
        comision: 1000n,
      });
      const url = `/api/v1/sub-pedidos/${escenario.subPedido.id}/cancelar`;

      const sinClave = await escenario.comprador.cliente.post(url, {
        motivo: 'ya no lo necesito',
      });
      assert.equal(sinClave.status, 400, JSON.stringify(sinClave.body));

      // Aunque el cliente intente imponer montos, solo se usa el motivo.
      const respuesta = await escenario.comprador.cliente.post(
        url,
        {
          motivo: 'ya no lo necesito',
          monto: 1,
          monto_reembolso: 1,
          reembolso: { monto: 1 },
        },
        idempotencia('digital'),
      );

      assert.equal(respuesta.status, 200, JSON.stringify(respuesta.body));
      assert.equal(respuesta.body.estado, 'cancelado');
      assert.equal(respuesta.body.reembolso.estado, 'pendiente');
      assert.equal(respuesta.body.reembolso.monto, 22000);
      assert.equal(respuesta.body.reembolso.monto_envio, 2000);
      assert.equal(respuesta.body.reembolso.incluye_envio, true);
      assert.equal(respuesta.body.reembolso.lineas.length, 1);
      assert.equal(respuesta.body.reembolso.lineas[0].monto, 20000);
      assert.equal(respuesta.body.devoluciones_stock.length, 1);
      assert.equal(respuesta.body.devoluciones_stock[0].origen, 'cancelacion');
      assert.equal(
        respuesta.body.devoluciones_stock[0].variante_id,
        escenario.variante.id,
      );

      const sub = await prisma.subPedido.findUnique({
        where: { id: escenario.subPedido.id },
      });
      assert.equal(sub.estado, 'cancelado');

      const pedido = await prisma.pedido.findUnique({
        where: { id: escenario.pedido.id },
      });
      assert.equal(pedido.estado, 'cancelado');

      assert.equal(await estadoStock(escenario.variante.id), 10);

      const devolucion = await prisma.devolucionStock.findUnique({
        where: {
          subPedidoId_detalleId: {
            subPedidoId: escenario.subPedido.id,
            detalleId: escenario.detalle.id,
          },
        },
      });
      assert.equal(devolucion.origen, 'cancelacion');
      assert.equal(devolucion.cantidad, 2);

      const auditoria = await prisma.auditoriaAdmin.findFirst({
        where: {
          accion: 'cancelar_sub_pedido',
          objetoId: String(escenario.subPedido.id),
        },
      });
      assert.ok(auditoria);
      assert.equal(auditoria.adminId, escenario.comprador.id);
      assert.equal(auditoria.detalle.actor_tipo, 'comprador');
      assert.equal(auditoria.detalle.motivo, 'ya no lo necesito');
      assert.equal(auditoria.detalle.estado_anterior, 'por_aceptar');
      assert.equal(auditoria.detalle.efectivo_aceptado, false);
      assert.equal(
        auditoria.detalle.reembolso_id,
        respuesta.body.reembolso.id,
      );

      // El reembolso sigue el flujo 4c-2a: al completarlo se mueve el dinero,
      // no se vuelve a tocar stock y el sub-pedido sigue cancelado.
      const completado = await completarReembolso({
        reembolsoId: respuesta.body.reembolso.id,
      });
      assert.equal(completado.estado, 'completado');

      const subDespues = await prisma.subPedido.findUnique({
        where: { id: escenario.subPedido.id },
      });
      assert.equal(subDespues.estado, 'cancelado');
      assert.equal(await estadoStock(escenario.variante.id), 10);
      assert.equal(
        await prisma.devolucionStock.count({
          where: { subPedidoId: escenario.subPedido.id },
        }),
        1,
      );

      const asientos = await prisma.ledger.findMany({
        where: { reembolsoId: respuesta.body.reembolso.id },
        orderBy: { id: 'asc' },
      });
      assert.deepEqual(
        asientos.map((asiento) => [
          asiento.tipo,
          asiento.localId,
          asiento.monto,
        ]),
        [
          ['reembolso', null, 22000n],
          ['reversa_comision', null, 1000n],
        ],
      );
    },
  );

  test(
    'dos cancelaciones simultaneas producen un solo reembolso y una sola devolucion',
    CON_BASE,
    async () => {
      const escenario = await crearEscenario();
      const url = `/api/v1/sub-pedidos/${escenario.subPedido.id}/cancelar`;
      const segundaSesion = await iniciarOtraSesion(escenario.comprador);

      const [primera, segunda] = await Promise.all([
        escenario.comprador.cliente.post(
          url,
          { motivo: 'cancelacion simultanea A' },
          idempotencia('simultanea-a'),
        ),
        segundaSesion.post(
          url,
          { motivo: 'cancelacion simultanea B' },
          idempotencia('simultanea-b'),
        ),
      ]);

      const estados = [primera.status, segunda.status].sort((a, b) => a - b);
      assert.deepEqual(estados, [200, 409]);

      assert.equal(
        await prisma.reembolso.count({
          where: { subPedidoId: escenario.subPedido.id },
        }),
        1,
      );
      assert.equal(
        await prisma.reembolsoLinea.count({
          where: {
            reembolso: { subPedidoId: escenario.subPedido.id },
          },
        }),
        1,
      );
      assert.equal(
        await prisma.devolucionStock.count({
          where: { subPedidoId: escenario.subPedido.id },
        }),
        1,
      );
      assert.equal(
        await prisma.auditoriaAdmin.count({
          where: {
            accion: 'cancelar_sub_pedido',
            objetoId: String(escenario.subPedido.id),
          },
        }),
        1,
      );
      assert.equal(await estadoStock(escenario.variante.id), 10);
    },
  );
});

describe('cancelaciones: reglas de estado y permisos', () => {
  test(
    'cancelar en enviado se rechaza y no toca stock ni crea reembolso',
    CON_BASE,
    async () => {
      const escenario = await crearEscenario({ estadoSubPedido: 'enviado' });
      const respuesta = await escenario.comprador.cliente.post(
        `/api/v1/sub-pedidos/${escenario.subPedido.id}/cancelar`,
        { motivo: 'me arrepenti' },
        idempotencia('enviado'),
      );

      assert.equal(respuesta.status, 409, JSON.stringify(respuesta.body));
      assert.equal(respuesta.body.error.codigo, 'transicion_invalida');

      const sub = await prisma.subPedido.findUnique({
        where: { id: escenario.subPedido.id },
      });
      assert.equal(sub.estado, 'enviado');
      assert.equal(await estadoStock(escenario.variante.id), 8);
      assert.equal(
        await prisma.reembolso.count({
          where: { subPedidoId: escenario.subPedido.id },
        }),
        0,
      );
      assert.equal(
        await prisma.auditoriaAdmin.count({
          where: {
            accion: 'cancelar_sub_pedido',
            objetoId: String(escenario.subPedido.id),
          },
        }),
        0,
      );
    },
  );

  test(
    'un comprador ajeno no puede cancelar',
    CON_BASE,
    async () => {
      const escenario = await crearEscenario();
      const ajeno = await crearUsuarioConSesion({ roles: ['comprador'] });

      const respuesta = await ajeno.cliente.post(
        `/api/v1/sub-pedidos/${escenario.subPedido.id}/cancelar`,
        { motivo: 'no es mi pedido' },
        idempotencia('ajeno'),
      );

      assert.equal(respuesta.status, 403, JSON.stringify(respuesta.body));
      assert.equal(respuesta.body.error.codigo, 'sin_permiso');

      const sub = await prisma.subPedido.findUnique({
        where: { id: escenario.subPedido.id },
      });
      assert.equal(sub.estado, 'por_aceptar');
      assert.equal(await estadoStock(escenario.variante.id), 8);
      assert.equal(
        await prisma.reembolso.count({
          where: { subPedidoId: escenario.subPedido.id },
        }),
        0,
      );
    },
  );

  test(
    'cancelar mientras el vendedor acepta deja un unico resultado consistente',
    CON_BASE,
    async () => {
      const escenario = await crearEscenario({
        metodoPago: 'efectivo',
        estadoPago: 'pendiente',
        descontar: false,
      });
      const url = `/api/v1/sub-pedidos/${escenario.subPedido.id}/cancelar`;

      const [cancelacion, aceptacion] = await Promise.all([
        escenario.comprador.cliente.post(
          url,
          { motivo: 'carrera con la aceptacion' },
          idempotencia('carrera'),
        ),
        escenario.vendedor.cliente.post(
          `/api/v1/sub-pedidos/${escenario.subPedido.id}/aceptar`,
        ),
      ]);

      const estados = [cancelacion.status, aceptacion.status].sort(
        (a, b) => a - b,
      );
      assert.deepEqual(estados, [200, 409]);

      const sub = await prisma.subPedido.findUnique({
        where: { id: escenario.subPedido.id },
      });
      const unidadesEnStock = await estadoStock(escenario.variante.id);
      const auditorias = await prisma.auditoriaAdmin.count({
        where: {
          accion: 'cancelar_sub_pedido',
          objetoId: String(escenario.subPedido.id),
        },
      });
      const reembolsos = await prisma.reembolso.count({
        where: { subPedidoId: escenario.subPedido.id },
      });
      const devoluciones = await prisma.devolucionStock.count({
        where: { subPedidoId: escenario.subPedido.id },
      });
      const historial = await prisma.historialEstadoSubPedido.count({
        where: { subPedidoId: escenario.subPedido.id },
      });

      assert.equal(historial, 1);
      assert.equal(reembolsos, 0);

      if (sub.estado === 'cancelado') {
        assert.equal(cancelacion.status, 200);
        assert.equal(unidadesEnStock, 10);
        assert.equal(devoluciones, 0);
        assert.equal(auditorias, 1);
      } else {
        assert.equal(sub.estado, 'preparando');
        assert.equal(aceptacion.status, 200);
        assert.equal(unidadesEnStock, 8);
        assert.equal(devoluciones, 0);
        assert.equal(auditorias, 0);
      }
    },
  );
});

describe('cancelaciones en efectivo aceptado', () => {
  test(
    'el vendedor cancela en preparando: stock devuelto, sin deuda y listado admin',
    CON_BASE,
    async () => {
      const escenario = await crearEscenario({
        metodoPago: 'efectivo',
        estadoPago: 'pendiente',
        descontar: false,
      });
      const url = `/api/v1/sub-pedidos/${escenario.subPedido.id}/cancelar`;

      const aceptar = await escenario.vendedor.cliente.post(
        `/api/v1/sub-pedidos/${escenario.subPedido.id}/aceptar`,
      );
      assert.equal(aceptar.status, 200, JSON.stringify(aceptar.body));
      assert.equal(await estadoStock(escenario.variante.id), 8);

      const compradorIntenta = await escenario.comprador.cliente.post(
        url,
        { motivo: 'quiero cancelar' },
        idempotencia('comprador-preparando'),
      );
      assert.equal(
        compradorIntenta.status,
        409,
        JSON.stringify(compradorIntenta.body),
      );
      assert.equal(
        compradorIntenta.body.error.codigo,
        'cancelacion_requiere_vendedor',
      );
      assert.equal(await estadoStock(escenario.variante.id), 8);

      const cancelacion = await escenario.vendedor.cliente.post(
        url,
        { motivo: 'el comprador no respondio' },
        idempotencia('vendedor-preparando'),
      );
      assert.equal(
        cancelacion.status,
        200,
        JSON.stringify(cancelacion.body),
      );
      assert.equal(cancelacion.body.estado, 'cancelado');
      assert.equal(cancelacion.body.reembolso, null);
      assert.equal(cancelacion.body.devoluciones_stock.length, 1);

      assert.equal(await estadoStock(escenario.variante.id), 10);

      const pago = await prisma.pago.findUnique({
        where: { id: escenario.pago.id },
      });
      assert.equal(pago.estado, 'rechazado');
      assert.equal(
        await prisma.reembolso.count({
          where: { subPedidoId: escenario.subPedido.id },
        }),
        0,
      );
      assert.equal(
        await prisma.ledger.count({
          where: {
            subPedidoId: escenario.subPedido.id,
            tipo: { in: ['comision', 'deuda_reembolso'] },
          },
        }),
        0,
      );

      const cuenta = await prisma.cuentaLocal.findUnique({
        where: { localId: escenario.local.id },
      });
      assert.equal(cuenta?.saldoDeuda ?? 0n, 0n);

      const auditoria = await prisma.auditoriaAdmin.findFirst({
        where: {
          accion: 'cancelar_sub_pedido',
          objetoId: String(escenario.subPedido.id),
        },
      });
      assert.ok(auditoria);
      assert.equal(auditoria.adminId, escenario.vendedor.id);
      assert.equal(auditoria.detalle.actor_tipo, 'vendedor');
      assert.equal(auditoria.detalle.motivo, 'el comprador no respondio');
      assert.equal(auditoria.detalle.estado_anterior, 'preparando');
      assert.equal(auditoria.detalle.efectivo_aceptado, true);
      assert.equal(auditoria.detalle.stock_devuelto, true);

      const admin = await crearAdminConSesion();
      const lista = await admin.cliente.get(
        `/api/v1/admin/cancelaciones-efectivo?local_id=${escenario.local.id}`,
      );
      assert.equal(lista.status, 200, JSON.stringify(lista.body));
      assert.equal(lista.body.paginacion.total, 1);
      assert.equal(lista.body.datos.length, 1);

      const fila = lista.body.datos[0];
      assert.equal(fila.sub_pedido_id, escenario.subPedido.id);
      assert.equal(fila.pedido_id, escenario.pedido.id);
      assert.equal(fila.local_id, escenario.local.id);
      assert.equal(fila.actor_id, escenario.vendedor.id);
      assert.equal(fila.actor_tipo, 'vendedor');
      assert.equal(fila.motivo, 'el comprador no respondio');
      assert.equal(fila.estado_anterior, 'preparando');
      assert.equal(fila.efectivo_aceptado, true);
      assert.equal(fila.monto_reembolso, 0);
      assert.equal(fila.reembolso_id, null);

      const dia = auditoria.fecha.toISOString().slice(0, 10);
      for (const filtro of [
        `fecha=${dia}`,
        `desde=${dia}&hasta=${dia}`,
        `fecha_desde=${dia}&fecha_hasta=${dia}`,
      ]) {
        const filtrada = await admin.cliente.get(
          `/api/v1/admin/cancelaciones-efectivo?local_id=${escenario.local.id}&${filtro}`,
        );
        assert.equal(filtrada.status, 200, JSON.stringify(filtrada.body));
        assert.equal(filtrada.body.paginacion.total, 1, filtro);
        assert.equal(filtrada.body.datos[0].id, auditoria.id);
      }

      const otroLocal = await admin.cliente.get(
        `/api/v1/admin/cancelaciones-efectivo?local_id=${escenario.local.id + 999999}`,
      );
      assert.equal(otroLocal.status, 200, JSON.stringify(otroLocal.body));
      assert.equal(otroLocal.body.paginacion.total, 0);
      assert.equal(otroLocal.body.datos.length, 0);

      const paginada = await admin.cliente.get(
        `/api/v1/admin/cancelaciones-efectivo?local_id=${escenario.local.id}&pagina=1&por_pagina=1`,
      );
      assert.equal(paginada.status, 200, JSON.stringify(paginada.body));
      assert.equal(paginada.body.paginacion.pagina, 1);
      assert.equal(paginada.body.paginacion.por_pagina, 1);
      assert.equal(paginada.body.paginacion.total, 1);
    },
  );
});
