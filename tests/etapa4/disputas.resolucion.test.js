import '../helpers/entorno.js';
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { opcionesConBase, prisma, cerrarConexion } from '../helpers/base.js';
import {
  crearCatalogo,
  crearPagoDePrueba,
  crearPedidoDePrueba,
  crearUsuarioDirecto,
} from '../helpers/datos.js';
import { crearUsuarioConSesion } from '../helpers/http.js';
import { withTransaccion } from '../../src/lib/transaccion.js';
import { registrarMovimiento } from '../../src/services/ledger.js';
import { descontarStock } from '../../src/services/stock.js';
import { abrirDisputa } from '../../src/services/disputas.js';
import {
  registrarProductoRecibido,
  resolverDisputa,
} from '../../src/services/disputas.js';
import { completarReembolso } from '../../src/services/reembolsos.js';

/**
 * RESOLUCION DE DISPUTAS Y STOCK - ETAPA 4c-2b
 * ============================================
 * Cubre la transicion unica de la disputa, la restauracion del estado
 * anterior, la descongelacion, el reembolso con precios congelados y las dos
 * formas de devolver stock: automatica sin entrega y manual con entrega.
 */

const CON_BASE = await opcionesConBase();

after(async () => {
  await cerrarConexion();
});

async function asentar(datos) {
  return withTransaccion(() => registrarMovimiento(datos));
}

async function crearAdmin() {
  return crearUsuarioDirecto({ nombre: 'Admin', roles: ['admin'] });
}

async function crearAdminConSesion() {
  const admin = await crearUsuarioConSesion({ roles: ['comprador'] });
  await prisma.usuarioRol.create({
    data: { usuarioId: admin.id, rol: 'admin' },
  });
  return admin;
}

async function crearEscenario({
  cantidad = 1,
  precio = 10000n,
  comision = 0n,
  costoEnvio = 0n,
  metodoPago = 'tarjeta',
  estadoSubPedido = 'entregado',
  descontar = false,
  evidenciaInicial = false,
} = {}) {
  const { local, variante } = await crearCatalogo({ precio });
  const comprador = await crearUsuarioDirecto({
    nombre: 'Comprador',
    roles: ['comprador'],
  });
  const pedido = await crearPedidoDePrueba({
    local,
    variante,
    compradorId: comprador.id,
    cantidad,
    comision,
    costoEnvio,
    metodoPago,
    estadoPedido: 'en_proceso',
    estadoSubPedido,
  });
  const pago = await crearPagoDePrueba({
    pedido: pedido.pedido,
    metodoPago,
    estado: 'aprobado',
  });

  if (comision > 0n) {
    await asentar({
      tipo: 'comision',
      monto: comision,
      subPedidoId: pedido.subPedido.id,
      pagoId: pago.id,
      localId: metodoPago === 'efectivo' ? local.id : null,
    });
  }

  if (descontar) {
    await descontarStock(prisma, variante.id, cantidad);
  }

  const disputa = await abrirDisputa({
    usuario: comprador,
    subPedidoId: pedido.subPedido.id,
    datos: {
      motivo: 'El producto no corresponde.',
      lineas: [{ detalle_id: pedido.detalle.id, cantidad }],
      ...(evidenciaInicial
        ? {
            evidencia_inicial: {
              tipo: 'texto',
              contenido: 'Evidencia del comprador',
            },
          }
        : {}),
    },
  });

  return {
    ...pedido,
    local,
    variante,
    pago,
    comprador,
    disputa,
  };
}

function datosComprador(escenario, { lineas, incluyeEnvio = false } = {}) {
  return {
    favor: 'comprador',
    resolucion: 'Se aprueba el reembolso.',
    lineas:
      lineas ??
      [
        {
          detalle_id: escenario.detalle.id,
          cantidad: escenario.detalle.cantidad,
        },
      ],
    incluye_envio: incluyeEnvio,
  };
}

async function stockDe(varianteId) {
  const variante = await prisma.productoVariante.findUnique({
    where: { id: varianteId },
    select: { stock: true },
  });
  return variante.stock;
}

describe('resolucion de disputas', () => {
  test('a favor del vendedor restaura el estado y descongela el saldo retenido', CON_BASE, async () => {
    const escenario = await crearEscenario();
    const admin = await crearAdmin();

    await asentar({
      tipo: 'liberacion',
      monto: 5000n,
      localId: escenario.local.id,
      subPedidoId: escenario.subPedido.id,
    });
    await asentar({
      tipo: 'congelacion',
      monto: 3000n,
      localId: escenario.local.id,
      subPedidoId: escenario.subPedido.id,
      disputaId: escenario.disputa.id,
    });

    const antes = await prisma.subPedido.findUnique({
      where: { id: escenario.subPedido.id },
    });

    const respuesta = await resolverDisputa({
      disputaId: escenario.disputa.id,
      admin,
      datos: {
        favor: 'vendedor',
        resolucion: 'El comprador no presento pruebas suficientes.',
      },
    });

    assert.equal(respuesta.estado, 'resuelta_vendedor');
    assert.equal(respuesta.reembolso, null);
    assert.equal(respuesta.sub_pedido.estado, 'entregado');

    const sub = await prisma.subPedido.findUnique({
      where: { id: escenario.subPedido.id },
    });
    assert.equal(sub.estado, 'entregado');
    assert.equal(sub.fechaEntrega?.getTime(), antes.fechaEntrega?.getTime());

    const movimientos = await prisma.ledger.findMany({
      where: { disputaId: escenario.disputa.id },
      orderBy: { id: 'asc' },
    });
    assert.deepEqual(
      movimientos.map((movimiento) => movimiento.tipo),
      ['congelacion', 'descongelacion'],
    );

    const cuenta = await prisma.cuentaLocal.findUnique({
      where: { localId: escenario.local.id },
    });
    assert.equal(cuenta.saldoPorPagar, 5000n);
    assert.equal(cuenta.saldoCongelado, 0n);
  });

  test('dos resoluciones simultaneas dejan una sola resolucion ganadora', CON_BASE, async () => {
    const escenario = await crearEscenario();
    const admin = await crearAdmin();

    const resultados = await Promise.allSettled([
      resolverDisputa({
        disputaId: escenario.disputa.id,
        admin,
        datos: datosComprador(escenario),
      }),
      resolverDisputa({
        disputaId: escenario.disputa.id,
        admin,
        datos: {
          favor: 'vendedor',
          resolucion: 'Resolucion simultanea del vendedor.',
        },
      }),
    ]);

    const cumplidas = resultados.filter((r) => r.status === 'fulfilled');
    const rechazadas = resultados.filter((r) => r.status === 'rejected');

    assert.equal(cumplidas.length, 1);
    assert.equal(rechazadas.length, 1);
    assert.equal(rechazadas[0].reason.codigo, 'disputa_cerrada');

    const disputa = await prisma.disputa.findUnique({
      where: { id: escenario.disputa.id },
    });
    assert.notEqual(disputa.estado, 'abierta');

    const reembolsos = await prisma.reembolso.count({
      where: { disputaId: escenario.disputa.id },
    });
    assert.ok(reembolsos <= 1);
  });

  test('resolver una disputa ya cerrada devuelve 409', CON_BASE, async () => {
    const escenario = await crearEscenario();
    const admin = await crearAdmin();

    await resolverDisputa({
      disputaId: escenario.disputa.id,
      admin,
      datos: datosComprador(escenario),
    });

    await assert.rejects(
      () =>
        resolverDisputa({
          disputaId: escenario.disputa.id,
          admin,
          datos: datosComprador(escenario),
        }),
      (err) => err.codigo === 'disputa_cerrada' && err.estado === 409,
    );
  });

  test('a favor del comprador con entrega no devuelve stock automaticamente', CON_BASE, async () => {
    const escenario = await crearEscenario({
      cantidad: 2,
      descontar: true,
    });
    const admin = await crearAdmin();

    const stockAntes = await stockDe(escenario.variante.id);
    const respuesta = await resolverDisputa({
      disputaId: escenario.disputa.id,
      admin,
      datos: datosComprador(escenario, {
        lineas: [
          {
            detalle_id: escenario.detalle.id,
            cantidad: 1,
          },
        ],
      }),
    });

    assert.equal(respuesta.estado, 'resuelta_comprador');
    assert.equal(respuesta.sub_pedido.estado, 'en_disputa');
    assert.equal(respuesta.reembolso.estado, 'pendiente');
    assert.equal(respuesta.reembolso.monto, 10000);
    assert.equal(respuesta.reembolso.lineas[0].cantidad, 1);

    const sub = await prisma.subPedido.findUnique({
      where: { id: escenario.subPedido.id },
    });
    assert.equal(sub.estado, 'en_disputa');

    assert.equal(await stockDe(escenario.variante.id), stockAntes);
    assert.equal(
      await prisma.devolucionStock.count({
        where: { subPedidoId: escenario.subPedido.id },
      }),
      0,
    );
  });

  test('sin entrega cancela, reembolsa todo con envio y devuelve stock en la misma transaccion', CON_BASE, async () => {
    const escenario = await crearEscenario({
      cantidad: 2,
      comision: 2000n,
      costoEnvio: 2000n,
      estadoSubPedido: 'enviado',
      descontar: true,
    });
    const admin = await crearAdmin();
    const stockInicial = await prisma.productoVariante.findUnique({
      where: { id: escenario.variante.id },
      select: { stock: true },
    });

    const respuesta = await resolverDisputa({
      disputaId: escenario.disputa.id,
      admin,
      // Aunque el admin mande solo una linea, sin entrega se reembolsa todo.
      datos: datosComprador(escenario, {
        lineas: [
          {
            detalle_id: escenario.detalle.id,
            cantidad: 1,
          },
        ],
        incluyeEnvio: false,
      }),
    });

    assert.equal(respuesta.estado, 'resuelta_comprador');
    assert.equal(respuesta.sub_pedido.estado, 'cancelado');
    assert.equal(respuesta.reembolso.monto, 22000);
    assert.equal(respuesta.reembolso.incluye_envio, true);
    assert.equal(respuesta.reembolso.lineas[0].cantidad, 2);

    assert.equal(
      await stockDe(escenario.variante.id),
      stockInicial.stock + 2,
    );

    const devoluciones = await prisma.devolucionStock.findMany({
      where: { subPedidoId: escenario.subPedido.id },
    });
    assert.equal(devoluciones.length, 1);
    assert.equal(devoluciones[0].origen, 'disputa_sin_entrega');

    // Completar el reembolso no revive el sub-pedido cancelado.
    await completarReembolso({
      reembolsoId: respuesta.reembolso.id,
      admin,
    });
    const sub = await prisma.subPedido.findUnique({
      where: { id: escenario.subPedido.id },
    });
    assert.equal(sub.estado, 'cancelado');

    const reversa = await prisma.ledger.findFirst({
      where: {
        subPedidoId: escenario.subPedido.id,
        tipo: 'reversa_comision',
        localId: null,
      },
    });
    assert.ok(reversa, 'la comision de plataforma debe revertirse');
    assert.equal(reversa.monto, 2000n);
  });
});

describe('producto recibido', () => {
  test('devuelve stock por linea una sola vez, incluso con dos llamadas concurrentes', CON_BASE, async () => {
    const escenario = await crearEscenario({
      cantidad: 2,
      descontar: true,
    });
    const admin = await crearAdmin();

    await resolverDisputa({
      disputaId: escenario.disputa.id,
      admin,
      datos: datosComprador(escenario, {
        lineas: [
          {
            detalle_id: escenario.detalle.id,
            cantidad: 2,
          },
        ],
      }),
    });

    const stockAntes = await stockDe(escenario.variante.id);
    const datos = {
      lineas: [
        {
          detalle_id: escenario.detalle.id,
          cantidad: 2,
        },
      ],
    };

    const [primera, segunda] = await Promise.all([
      registrarProductoRecibido({
        subPedidoId: escenario.subPedido.id,
        admin,
        datos,
      }),
      registrarProductoRecibido({
        subPedidoId: escenario.subPedido.id,
        admin,
        datos,
      }),
    ]);

    assert.equal(primera.productos.length, 1);
    assert.equal(segunda.productos.length, 1);
    assert.equal(await stockDe(escenario.variante.id), stockAntes + 2);
    assert.equal(
      await prisma.devolucionStock.count({
        where: { subPedidoId: escenario.subPedido.id },
      }),
      1,
    );
  });

  test('rechaza producto recibido si gano el vendedor o la disputa sigue abierta', CON_BASE, async () => {
    const escenario = await crearEscenario();
    const admin = await crearAdmin();

    await assert.rejects(
      () =>
        registrarProductoRecibido({
          subPedidoId: escenario.subPedido.id,
          admin,
          datos: {},
        }),
      (err) => err.codigo === 'disputa_no_comprador',
    );

    await resolverDisputa({
      disputaId: escenario.disputa.id,
      admin,
      datos: {
        favor: 'vendedor',
        resolucion: 'Gana el vendedor.',
      },
    });

    await assert.rejects(
      () =>
        registrarProductoRecibido({
          subPedidoId: escenario.subPedido.id,
          admin,
          datos: {},
        }),
      (err) => err.codigo === 'disputa_no_comprador',
    );
  });

  test('la ruta admin exige idempotencia y no duplica stock al reintentar', CON_BASE, async () => {
    const escenario = await crearEscenario({
      cantidad: 1,
      descontar: true,
    });
    const admin = await crearAdminConSesion();
    const clave = `resolver-${Date.now()}-${Math.random()}`;

    const resolver = await admin.cliente.post(
      `/api/v1/admin/disputas/${escenario.disputa.id}/resolver`,
      {
        favor: 'comprador',
        resolucion: 'Reembolso aprobado',
        lineas: [
          {
            detalle_id: escenario.detalle.id,
            cantidad: 1,
          },
        ],
      },
      { 'Idempotency-Key': clave },
    );

    assert.equal(resolver.status, 200, JSON.stringify(resolver.body));
    assert.equal(resolver.body.estado, 'resuelta_comprador');

    const repetida = await admin.cliente.post(
      `/api/v1/admin/disputas/${escenario.disputa.id}/resolver`,
      {
        favor: 'comprador',
        resolucion: 'Reembolso aprobado',
        lineas: [
          {
            detalle_id: escenario.detalle.id,
            cantidad: 1,
          },
        ],
      },
      { 'Idempotency-Key': clave },
    );

    assert.equal(repetida.status, 200);
    assert.equal(repetida.body.reembolso.id, resolver.body.reembolso.id);
    assert.equal(
      await prisma.reembolso.count({
        where: { disputaId: escenario.disputa.id },
      }),
      1,
    );

    const stockAntes = await stockDe(escenario.variante.id);
    const recibido = await admin.cliente.post(
      `/api/v1/admin/sub-pedidos/${escenario.subPedido.id}/producto-recibido`,
      {
        lineas: [
          {
            detalle_id: escenario.detalle.id,
            cantidad: 1,
          },
        ],
      },
      { 'Idempotency-Key': `producto-${Date.now()}-${Math.random()}` },
    );

    assert.equal(recibido.status, 200, JSON.stringify(recibido.body));
    assert.equal(recibido.body.productos.length, 1);
    assert.equal(await stockDe(escenario.variante.id), stockAntes + 1);
  });
});
