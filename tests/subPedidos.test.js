import './helpers/entorno.js';
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { opcionesConBase, prisma, cerrarConexion } from './helpers/base.js';
import {
  cliente,
  crearUsuarioConSesion,
} from './helpers/http.js';
import {
  crearCatalogoParaVendedor,
  crearPedidoDePrueba,
} from './helpers/datos.js';

/**
 * MAQUINA DE ESTADOS DEL SUB-PEDIDO - ETAPA 2
 * ===========================================
 * pendiente -> preparando -> enviado -> entregado
 * La confirma el comprador o el vendedor. Entregar NO libera saldo.
 */

const CON_BASE = await opcionesConBase();

after(async () => {
  await cerrarConexion();
});

async function montarSubPedido() {
  const vendedor = await crearUsuarioConSesion({
    nombre: 'Vendedor',
    roles: ['vendedor'],
  });
  const comprador = await crearUsuarioConSesion({
    nombre: 'Comprador',
    roles: ['comprador'],
  });
  const { local, variante } = await crearCatalogoParaVendedor({
    vendedorId: vendedor.id,
    precio: 10000n,
    stockInicial: 10,
  });

  const { pedido, subPedido } = await crearPedidoDePrueba({
    local,
    variante,
    compradorId: comprador.id,
    cantidad: 3,
    estadoPedido: 'en_proceso',
    estadoSubPedido: 'pendiente',
  });

  return { vendedor, comprador, local, variante, pedido, subPedido };
}

describe('POST /api/v1/sub-pedidos/{id}/aceptar', () => {
  test('el vendedor pasa el sub-pedido de pendiente a preparando', CON_BASE, async () => {
    const { vendedor, subPedido } = await montarSubPedido();

    const r = await vendedor.cliente.post(
      `/api/v1/sub-pedidos/${subPedido.id}/aceptar`,
      {},
    );

    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.id, subPedido.id);
    assert.equal(r.body.estado, 'preparando');

    const db = await prisma.subPedido.findUnique({
      where: { id: subPedido.id },
    });
    assert.equal(db.estado, 'preparando');

    const historial = await prisma.historialEstadoSubPedido.findFirst({
      where: { subPedidoId: subPedido.id, estadoNuevo: 'preparando' },
      orderBy: { id: 'desc' },
    });
    assert.equal(historial.estadoAnterior, 'pendiente');
    assert.equal(historial.cambiadoPor, vendedor.id);
  });

  test('aceptar dos veces da 409', CON_BASE, async () => {
    const { vendedor, subPedido } = await montarSubPedido();

    const primera = await vendedor.cliente.post(
      `/api/v1/sub-pedidos/${subPedido.id}/aceptar`,
      {},
    );
    assert.equal(primera.status, 200);

    const segunda = await vendedor.cliente.post(
      `/api/v1/sub-pedidos/${subPedido.id}/aceptar`,
      {},
    );
    assert.equal(segunda.status, 409);
    assert.equal(segunda.body.error.codigo, 'transicion_invalida');
  });

  test('un comprador no puede aceptar', CON_BASE, async () => {
    const { comprador, subPedido } = await montarSubPedido();

    const r = await comprador.cliente.post(
      `/api/v1/sub-pedidos/${subPedido.id}/aceptar`,
      {},
    );

    assert.equal(r.status, 403);
    assert.equal(r.body.error.codigo, 'sin_permiso');
  });

  test('otro vendedor no puede aceptar un sub-pedido ajeno', CON_BASE, async () => {
    const { subPedido } = await montarSubPedido();
    const otroVendedor = await crearUsuarioConSesion({
      nombre: 'Otro vendedor',
      roles: ['vendedor'],
    });

    const r = await otroVendedor.cliente.post(
      `/api/v1/sub-pedidos/${subPedido.id}/aceptar`,
      {},
    );

    assert.equal(r.status, 403);
    assert.equal(r.body.error.codigo, 'sin_permiso');
  });
});

describe('POST /api/v1/sub-pedidos/{id}/enviar', () => {
  test('exige evidencia y guarda la transicion', CON_BASE, async () => {
    const { vendedor, subPedido } = await montarSubPedido();

    await vendedor.cliente.post(
      `/api/v1/sub-pedidos/${subPedido.id}/aceptar`,
      {},
    );

    const sinEvidencia = await vendedor.cliente.post(
      `/api/v1/sub-pedidos/${subPedido.id}/enviar`,
      {},
    );
    assert.equal(sinEvidencia.status, 400);
    assert.equal(sinEvidencia.body.error.codigo, 'validacion_invalida');

    const conEvidencia = await vendedor.cliente.post(
      `/api/v1/sub-pedidos/${subPedido.id}/enviar`,
      { evidencia_envio: 'Guia 12345, transportadora XYZ' },
    );

    assert.equal(conEvidencia.status, 200, JSON.stringify(conEvidencia.body));
    assert.equal(conEvidencia.body.estado, 'enviado');
    assert.equal(
      conEvidencia.body.evidencia_envio,
      'Guia 12345, transportadora XYZ',
    );
  });

  test('no se puede enviar desde pendiente', CON_BASE, async () => {
    const { vendedor, subPedido } = await montarSubPedido();

    const r = await vendedor.cliente.post(
      `/api/v1/sub-pedidos/${subPedido.id}/enviar`,
      { evidencia_envio: 'Guia 12345' },
    );

    assert.equal(r.status, 409);
    assert.equal(r.body.error.codigo, 'transicion_invalida');
  });
});

describe('POST /api/v1/sub-pedidos/{id}/entregar', () => {
  test('el comprador confirma y el pedido queda completado sin liberar saldo', CON_BASE, async () => {
    const { vendedor, comprador, pedido, subPedido } = await montarSubPedido();

    await vendedor.cliente.post(
      `/api/v1/sub-pedidos/${subPedido.id}/aceptar`,
      {},
    );
    await vendedor.cliente.post(
      `/api/v1/sub-pedidos/${subPedido.id}/enviar`,
      { evidencia_envio: 'Guia 12345' },
    );

    const r = await comprador.cliente.post(
      `/api/v1/sub-pedidos/${subPedido.id}/entregar`,
      {},
    );

    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.estado, 'entregado');
    assert.equal(r.body.entrega_confirmada_por, 'comprador');
    assert.notEqual(r.body.fecha_entrega, null);
    assert.equal(
      r.body.saldo_liberado_en,
      null,
      'entregar no libera dinero: eso es Etapa 4',
    );

    const pedidoDb = await prisma.pedido.findUnique({
      where: { id: pedido.id },
    });
    assert.equal(pedidoDb.estado, 'completado');
  });

  test('el vendedor tambien puede confirmar la entrega', CON_BASE, async () => {
    const { vendedor, subPedido } = await montarSubPedido();

    await vendedor.cliente.post(
      `/api/v1/sub-pedidos/${subPedido.id}/aceptar`,
      {},
    );
    await vendedor.cliente.post(
      `/api/v1/sub-pedidos/${subPedido.id}/enviar`,
      { evidencia_envio: 'Guia 12345' },
    );

    const r = await vendedor.cliente.post(
      `/api/v1/sub-pedidos/${subPedido.id}/entregar`,
      {},
    );

    assert.equal(r.status, 200);
    assert.equal(r.body.estado, 'entregado');
    assert.equal(r.body.entrega_confirmada_por, 'vendedor');
  });

  test('un tercero no puede confirmar la entrega', CON_BASE, async () => {
    const { vendedor, subPedido } = await montarSubPedido();
    const tercero = await crearUsuarioConSesion();

    await vendedor.cliente.post(
      `/api/v1/sub-pedidos/${subPedido.id}/aceptar`,
      {},
    );
    await vendedor.cliente.post(
      `/api/v1/sub-pedidos/${subPedido.id}/enviar`,
      { evidencia_envio: 'Guia 12345' },
    );

    const r = await tercero.cliente.post(
      `/api/v1/sub-pedidos/${subPedido.id}/entregar`,
      {},
    );

    assert.equal(r.status, 403);
    assert.equal(r.body.error.codigo, 'sin_permiso');
  });

  test('no se puede entregar desde pendiente', CON_BASE, async () => {
    const { comprador, subPedido } = await montarSubPedido();

    const r = await comprador.cliente.post(
      `/api/v1/sub-pedidos/${subPedido.id}/entregar`,
      {},
    );

    assert.equal(r.status, 409);
    assert.equal(r.body.error.codigo, 'transicion_invalida');
  });
});

describe('GET /api/v1/vendedor/sub-pedidos', () => {
  test('lista solo los sub-pedidos de los locales del vendedor y filtra por estado', CON_BASE, async () => {
    const uno = await montarSubPedido();
    const dos = await montarSubPedido();

    const listaUno = await uno.vendedor.cliente.get(
      '/api/v1/vendedor/sub-pedidos',
    );
    assert.equal(listaUno.status, 200);
    assert.equal(listaUno.body.paginacion.total, 1);
    assert.equal(listaUno.body.datos[0].id, uno.subPedido.id);

    const listaDos = await dos.vendedor.cliente.get(
      '/api/v1/vendedor/sub-pedidos',
    );
    assert.equal(listaDos.body.paginacion.total, 1);
    assert.equal(listaDos.body.datos[0].id, dos.subPedido.id);

    const filtradaPendiente = await uno.vendedor.cliente.get(
      '/api/v1/vendedor/sub-pedidos?estado=pendiente',
    );
    assert.equal(filtradaPendiente.body.paginacion.total, 1);

    const filtradaEntregado = await uno.vendedor.cliente.get(
      '/api/v1/vendedor/sub-pedidos?estado=entregado',
    );
    assert.equal(filtradaEntregado.body.paginacion.total, 0);
  });

  test('un comprador no puede ver el panel del vendedor', CON_BASE, async () => {
    const comprador = await crearUsuarioConSesion();

    const r = await comprador.cliente.get('/api/v1/vendedor/sub-pedidos');

    assert.equal(r.status, 403);
    assert.equal(r.body.error.codigo, 'sin_permiso');
  });

  test('exige sesion', CON_BASE, async () => {
    const r = await cliente().get('/api/v1/vendedor/sub-pedidos');
    assert.equal(r.status, 401);
  });
});
