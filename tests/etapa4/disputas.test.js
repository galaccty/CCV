import '../helpers/entorno.js';
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { opcionesConBase, prisma, cerrarConexion } from '../helpers/base.js';
import {
  crearUsuarioConSesion,
} from '../helpers/http.js';
import {
  crearCatalogoParaVendedor,
  crearPedidoDePrueba,
  crearUsuarioDirecto,
} from '../helpers/datos.js';
import { abrirDisputa } from '../../src/services/disputas.js';

/**
 * DISPUTAS Y EVIDENCIA - ETAPA 4c-1
 * ==================================
 * Se prueba la apertura con precios congelados, la serializacion de dos
 * aperturas simultaneas, los permisos por rol, la evidencia y las barreras de
 * la base (inmutabilidad, no borrado y bloqueo de evidencia cerrada).
 *
 * Esta mitad no mueve dinero: no se crean asientos de congelacion ni de
 * reembolso al abrir una disputa.
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

async function crearEscenario({
  cantidad = 2,
  precio = 10000n,
  estadoSubPedido = 'entregado',
  metodoPago = 'tarjeta',
} = {}) {
  const comprador = await crearUsuarioConSesion({ roles: ['comprador'] });
  const vendedor = await crearUsuarioConSesion({ roles: ['vendedor'] });
  const catalogo = await crearCatalogoParaVendedor({
    vendedorId: vendedor.id,
    precio,
  });
  const pedido = await crearPedidoDePrueba({
    local: catalogo.local,
    variante: catalogo.variante,
    compradorId: comprador.id,
    cantidad,
    metodoPago,
    estadoPedido: 'completado',
    estadoSubPedido,
  });

  return { comprador, vendedor, catalogo, pedido };
}

function cuerpoDisputa({ detalleId, cantidad = 1, extra = {} } = {}) {
  return {
    motivo: 'El producto no corresponde con lo publicado.',
    lineas: [{ detalle_id: detalleId, cantidad }],
    ...extra,
  };
}

async function abrirPorHttp(escenario, cuerpo = {}) {
  return escenario.comprador.cliente.post(
    `/api/v1/sub-pedidos/${escenario.pedido.subPedido.id}/disputas`,
    cuerpoDisputa({
      detalleId: escenario.pedido.detalle.id,
      ...cuerpo,
    }),
  );
}

describe('disputas - apertura', () => {
  test('calcula el monto con precios congelados y pasa el sub-pedido a en_disputa', CON_BASE, async () => {
    const escenario = await crearEscenario({ cantidad: 3, precio: 10000n });

    const respuesta = await abrirPorHttp(escenario, {
      cantidad: 2,
      extra: {
        // El cliente no puede imponer ninguno de estos montos.
        monto_reclamado: 1,
        monto_congelado: 1,
      },
    });

    assert.equal(respuesta.status, 201, JSON.stringify(respuesta.body));
    assert.equal(respuesta.body.monto_reclamado, 20000);
    assert.equal(respuesta.body.monto_congelado, 0);
    assert.equal(respuesta.body.tipo, 'digital');
    assert.equal(respuesta.body.estado, 'abierta');
    assert.equal(respuesta.body.estado_sub_pedido_anterior, 'entregado');
    assert.equal(respuesta.body.sub_pedido.estado, 'en_disputa');
    assert.equal(respuesta.body.evidencias.length, 0);

    const subPedido = await prisma.subPedido.findUnique({
      where: { id: escenario.pedido.subPedido.id },
    });
    assert.equal(subPedido.estado, 'en_disputa');
    assert.equal(subPedido.saldoLiberadoEn, null);

    const historial = await prisma.historialEstadoSubPedido.findMany({
      where: { subPedidoId: escenario.pedido.subPedido.id },
      orderBy: { id: 'asc' },
    });
    assert.equal(historial.length, 1);
    assert.equal(historial[0].estadoAnterior, 'entregado');
    assert.equal(historial[0].estadoNuevo, 'en_disputa');
    assert.equal(historial[0].cambiadoPor, escenario.comprador.id);

    const movimientos = await prisma.ledger.count({
      where: { subPedidoId: escenario.pedido.subPedido.id },
    });
    assert.equal(movimientos, 0, '4c-1 no debe mover dinero');
  });

  test('tambien se abre desde enviado y guarda el estado anterior', CON_BASE, async () => {
    const escenario = await crearEscenario({
      estadoSubPedido: 'enviado',
      cantidad: 1,
    });

    const respuesta = await abrirPorHttp(escenario);
    assert.equal(respuesta.status, 201, JSON.stringify(respuesta.body));
    assert.equal(respuesta.body.estado_sub_pedido_anterior, 'enviado');

    const subPedido = await prisma.subPedido.findUnique({
      where: { id: escenario.pedido.subPedido.id },
    });
    assert.equal(subPedido.estado, 'en_disputa');
  });

  test('dos aperturas simultaneas dejan una sola disputa', CON_BASE, async () => {
    const escenario = await crearEscenario();
    const datos = cuerpoDisputa({
      detalleId: escenario.pedido.detalle.id,
      cantidad: 1,
    });

    const resultados = await Promise.allSettled([
      abrirDisputa({
        usuario: escenario.comprador,
        subPedidoId: escenario.pedido.subPedido.id,
        datos,
      }),
      abrirDisputa({
        usuario: escenario.comprador,
        subPedidoId: escenario.pedido.subPedido.id,
        datos,
      }),
    ]);

    const cumplidas = resultados.filter((r) => r.status === 'fulfilled');
    const rechazadas = resultados.filter((r) => r.status === 'rejected');

    assert.equal(cumplidas.length, 1);
    assert.equal(rechazadas.length, 1);
    assert.equal(rechazadas[0].reason.codigo, 'disputa_duplicada');

    const disputas = await prisma.disputa.findMany({
      where: { subPedidoId: escenario.pedido.subPedido.id },
    });
    assert.equal(disputas.length, 1);

    const historial = await prisma.historialEstadoSubPedido.count({
      where: {
        subPedidoId: escenario.pedido.subPedido.id,
        estadoNuevo: 'en_disputa',
      },
    });
    assert.equal(historial, 1, 'solo la apertura ganadora deja historial');
  });

  test('un comprador ajeno no puede abrir la disputa', CON_BASE, async () => {
    const escenario = await crearEscenario();
    const ajeno = await crearUsuarioConSesion({ roles: ['comprador'] });

    const respuesta = await ajeno.cliente.post(
      `/api/v1/sub-pedidos/${escenario.pedido.subPedido.id}/disputas`,
      cuerpoDisputa({ detalleId: escenario.pedido.detalle.id }),
    );

    assert.equal(respuesta.status, 404);
    assert.equal(respuesta.body.error.codigo, 'no_encontrado');

    const disputas = await prisma.disputa.count({
      where: { subPedidoId: escenario.pedido.subPedido.id },
    });
    assert.equal(disputas, 0);
  });

  test('rechaza lineas ajenas, cantidades excedidas y estados no disputables', CON_BASE, async () => {
    const escenario = await crearEscenario({ cantidad: 2 });
    const otro = await crearEscenario({ cantidad: 1 });

    const lineaAjena = await abrirPorHttp(escenario, {
      detalleId: otro.pedido.detalle.id,
      cantidad: 1,
    });
    assert.equal(lineaAjena.status, 422);
    assert.equal(lineaAjena.body.error.codigo, 'linea_no_pertenece');

    const cantidadExcedida = await abrirPorHttp(escenario, { cantidad: 3 });
    assert.equal(cantidadExcedida.status, 422);
    assert.equal(cantidadExcedida.body.error.codigo, 'cantidad_excede_linea');

    const porAceptar = await crearEscenario({ estadoSubPedido: 'por_aceptar' });
    const noDisputable = await abrirPorHttp(porAceptar);
    assert.equal(noDisputable.status, 409);
    assert.equal(noDisputable.body.error.codigo, 'sub_pedido_no_disputable');
  });

  test('el trigger exige que el tipo de disputa coincida con el pago', CON_BASE, async () => {
    const escenario = await crearEscenario({ metodoPago: 'efectivo' });

    await assert.rejects(
      () =>
        prisma.disputa.create({
          data: {
            subPedidoId: escenario.pedido.subPedido.id,
            usuarioId: escenario.comprador.id,
            tipo: 'digital',
            motivo: 'Prueba de tipo',
            montoReclamado: 1000n,
            estadoSubPedidoAnterior: 'entregado',
          },
        }),
      /disputa_tipo_no_coincide/,
    );
  });

  test('no se abre si el saldo ya fue liberado', CON_BASE, async () => {
    const escenario = await crearEscenario();

    await prisma.subPedido.update({
      where: { id: escenario.pedido.subPedido.id },
      data: { saldoLiberadoEn: new Date() },
    });

    const respuesta = await abrirPorHttp(escenario);
    assert.equal(respuesta.status, 409);
    assert.equal(respuesta.body.error.codigo, 'saldo_ya_liberado');

    await assert.rejects(
      () =>
        prisma.disputa.create({
          data: {
            subPedidoId: escenario.pedido.subPedido.id,
            usuarioId: escenario.comprador.id,
            tipo: 'digital',
            motivo: 'Prueba de saldo liberado',
            montoReclamado: 1000n,
            estadoSubPedidoAnterior: 'entregado',
          },
        }),
      /sub_pedido_saldo_liberado/,
    );
  });
});

describe('disputas - permisos de lectura y evidencia', () => {
  test('cada rol ve solo lo suyo y el admin ve todo', CON_BASE, async () => {
    const primero = await crearEscenario();
    const segundo = await crearEscenario();
    const admin = await crearAdminConSesion();

    const abiertaPrimero = await abrirPorHttp(primero);
    const abiertaSegundo = await abrirPorHttp(segundo);
    assert.equal(abiertaPrimero.status, 201);
    assert.equal(abiertaSegundo.status, 201);

    const idPrimero = abiertaPrimero.body.id;
    const idSegundo = abiertaSegundo.body.id;

    const detalleAjeno = await segundo.comprador.cliente.get(
      `/api/v1/disputas/${idPrimero}`,
    );
    assert.equal(detalleAjeno.status, 404);

    const detalleVendedorAjeno = await segundo.vendedor.cliente.get(
      `/api/v1/disputas/${idPrimero}`,
    );
    assert.equal(detalleVendedorAjeno.status, 404);

    const evidenciaAjeno = await segundo.comprador.cliente.post(
      `/api/v1/disputas/${idPrimero}/evidencia`,
      { tipo: 'texto', contenido: 'No deberia poder escribir.' },
    );
    assert.equal(evidenciaAjeno.status, 404);

    const evidenciaVendedorAjeno = await segundo.vendedor.cliente.post(
      `/api/v1/vendedor/disputas/${idPrimero}/evidencia`,
      { tipo: 'texto', contenido: 'No deberia poder escribir.' },
    );
    assert.equal(evidenciaVendedorAjeno.status, 404);

    const listaComprador = await primero.comprador.cliente.get('/api/v1/disputas');
    assert.equal(listaComprador.status, 200);
    assert.deepEqual(
      listaComprador.body.datos.map((d) => d.id),
      [idPrimero],
    );

    const listaVendedor = await primero.vendedor.cliente.get(
      '/api/v1/vendedor/disputas',
    );
    assert.equal(listaVendedor.status, 200);
    assert.ok(listaVendedor.body.datos.some((d) => d.id === idPrimero));
    assert.ok(!listaVendedor.body.datos.some((d) => d.id === idSegundo));

    const filtroVendedor = await primero.vendedor.cliente.get(
      `/api/v1/vendedor/disputas?local_id=${primero.catalogo.local.id}`,
    );
    assert.equal(filtroVendedor.status, 200);
    assert.deepEqual(
      filtroVendedor.body.datos.map((d) => d.id),
      [idPrimero],
    );

    const localAjeno = await segundo.vendedor.cliente.get(
      `/api/v1/vendedor/disputas?local_id=${primero.catalogo.local.id}`,
    );
    assert.equal(localAjeno.status, 404);

    const listaAdmin = await admin.cliente.get('/api/v1/admin/disputas');
    assert.equal(listaAdmin.status, 200);
    assert.ok(listaAdmin.body.datos.some((d) => d.id === idPrimero));
    assert.ok(listaAdmin.body.datos.some((d) => d.id === idSegundo));

    const filtroAdmin = await admin.cliente.get(
      `/api/v1/admin/disputas?local_id=${primero.catalogo.local.id}`,
    );
    assert.equal(filtroAdmin.status, 200);
    assert.deepEqual(
      filtroAdmin.body.datos.map((d) => d.id),
      [idPrimero],
    );

    const detalleAdmin = await admin.cliente.get(`/api/v1/admin/disputas/${idPrimero}`);
    assert.equal(detalleAdmin.status, 200);
    assert.equal(detalleAdmin.body.id, idPrimero);
  });

  test('acepta texto y URL https, y rechaza texto vacio o URL http', CON_BASE, async () => {
    const escenario = await crearEscenario();
    const admin = await crearAdminConSesion();
    const abierta = await abrirPorHttp(escenario, {
      extra: {
        evidencia_inicial: {
          tipo: 'texto',
          contenido: 'El empaque llego abierto.',
        },
      },
    });
    assert.equal(abierta.status, 201);
    assert.equal(abierta.body.evidencias.length, 1);

    const id = abierta.body.id;

    const texto = await escenario.comprador.cliente.post(
      `/api/v1/disputas/${id}/evidencia`,
      { tipo: 'texto', contenido: 'Adjunto una foto del producto.' },
    );
    assert.equal(texto.status, 201);
    assert.equal(texto.body.lado, 'comprador');

    const url = await escenario.vendedor.cliente.post(
      `/api/v1/vendedor/disputas/${id}/evidencia`,
      {
        tipo: 'url',
        contenido: 'https://evidencia.ejemplo.com/foto.jpg',
      },
    );
    assert.equal(url.status, 201);
    assert.equal(url.body.lado, 'vendedor');

    const adminEvidencia = await admin.cliente.post(
      `/api/v1/admin/disputas/${id}/evidencia`,
      { tipo: 'texto', contenido: 'Revisado por el equipo de soporte.' },
    );
    assert.equal(adminEvidencia.status, 201);
    assert.equal(adminEvidencia.body.lado, 'admin');

    const vacia = await escenario.comprador.cliente.post(
      `/api/v1/disputas/${id}/evidencia`,
      { tipo: 'texto', contenido: '   ' },
    );
    assert.equal(vacia.status, 400);

    const http = await escenario.comprador.cliente.post(
      `/api/v1/disputas/${id}/evidencia`,
      { tipo: 'url', contenido: 'http://evidencia.ejemplo.com/foto.jpg' },
    );
    assert.equal(http.status, 400);

    const detalle = await escenario.comprador.cliente.get(`/api/v1/disputas/${id}`);
    assert.equal(detalle.status, 200);
    assert.equal(detalle.body.evidencias.length, 4);
  });
});

describe('disputas - protecciones de la base', () => {
  test('una disputa resuelta no acepta evidencia ni se modifica o borra', CON_BASE, async () => {
    const escenario = await crearEscenario();
    const admin = await crearUsuarioDirecto({ roles: ['admin'] });
    const abierta = await abrirPorHttp(escenario);
    assert.equal(abierta.status, 201);

    const id = abierta.body.id;

    const evidencia = await escenario.comprador.cliente.post(
      `/api/v1/disputas/${id}/evidencia`,
      { tipo: 'texto', contenido: 'Evidencia anterior a la resolucion.' },
    );
    assert.equal(evidencia.status, 201);

    await prisma.disputa.update({
      where: { id },
      data: {
        estado: 'resuelta_comprador',
        fechaResolucion: new Date(),
        resueltoPor: admin.id,
        resolucion: 'Se aprueba el reembolso.',
      },
    });

    const intentoHttp = await escenario.comprador.cliente.post(
      `/api/v1/disputas/${id}/evidencia`,
      { tipo: 'texto', contenido: 'No deberia entrar.' },
    );
    assert.equal(intentoHttp.status, 409);
    assert.equal(intentoHttp.body.error.codigo, 'disputa_cerrada');

    await assert.rejects(
      () =>
        prisma.disputaEvidencia.create({
          data: {
            disputaId: id,
            usuarioId: escenario.comprador.id,
            lado: 'comprador',
            tipo: 'texto',
            contenido: 'Tampoco deberia entrar.',
          },
        }),
      /disputa_cerrada/,
    );

    await assert.rejects(
      () =>
        prisma.disputa.update({
          where: { id },
          data: { motivo: 'Motivo cambiado' },
        }),
      /resuelta|inmutable/i,
    );

    await assert.rejects(
      () => prisma.disputaEvidencia.delete({ where: { id: evidencia.body.id } }),
      /no se modifica ni se borra/i,
    );

    await assert.rejects(
      () => prisma.disputa.delete({ where: { id } }),
      /no se borran/i,
    );

    const siguen = await prisma.disputaEvidencia.count({ where: { disputaId: id } });
    assert.equal(siguen, 1);
  });

  test('el UNIQUE parcial impide dos congelaciones para la misma disputa', CON_BASE, async () => {
    const escenario = await crearEscenario();
    const abierta = await abrirPorHttp(escenario);
    assert.equal(abierta.status, 201);

    const movimiento = {
      disputaId: abierta.body.id,
      tipo: 'congelacion',
      monto: 1000n,
    };

    await prisma.ledger.create({ data: movimiento });

    await assert.rejects(
      () => prisma.ledger.create({ data: movimiento }),
      /Unique constraint|ledger_congelacion_descongelacion_por_disputa/i,
    );

    // Descongelacion es otro tipo permitido por el indice parcial.
    await prisma.ledger.create({
      data: { ...movimiento, tipo: 'descongelacion' },
    });
  });
});
