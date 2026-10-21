import { prisma } from '../lib/prisma.js';
import { withTransaccion } from '../lib/transaccion.js';
import {
  aBigInt,
  aNumeroSeguro,
  aplicarPorcentaje,
  convertirBigIntAJson,
  dividirRedondeando,
  multiplicar,
  porcentajeABasisPuntos,
  sumar,
} from '../lib/dinero.js';
import { ErrorApi, errorNoEncontrado } from '../lib/errores.js';
import {
  CLAVES_CONGELADAS,
  cargarConfiguracion,
  obtener,
} from './configuracion.js';
import { completarEnTx } from './idempotencia.js';

/**
 * CHECKOUT (seccion 4.1.1)
 * ========================
 * El backend calcula TODO: precios, subtotal, comision, envio y total. El
 * cliente solo manda variante_id y cantidad; cualquier monto que intente
 * mandar se ignora porque Zod lo descarta.
 *
 * El stock SOLO se verifica, no se descuenta. El descuento atomico ocurre
 * cuando el pago se confirma (webhook).
 *
 * En la Etapa 2 todos los items tienen que ser del mismo local. El checkout
 * multi-local llega en la Etapa 3.
 */

const RADIO_TIERRA_KM = 6371;

function aRadianes(grados) {
  return (grados * Math.PI) / 180;
}

/** Distancia Haversine en metros, redondeada al metro. */
export function distanciaEnMetros(lat1, lon1, lat2, lon2) {
  const dLat = aRadianes(lat2 - lat1);
  const dLon = aRadianes(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(aRadianes(lat1)) *
      Math.cos(aRadianes(lat2)) *
      Math.sin(dLon / 2) ** 2;
  const km = 2 * RADIO_TIERRA_KM * Math.asin(Math.sqrt(a));
  return Math.max(0, Math.round(km * 1000));
}

/** Envio = tarifa_base + tarifa_por_km * distancia, redondeado al peso. */
export function calcularCostoEnvio({
  latitudLocal,
  longitudLocal,
  latitudEntrega,
  longitudEntrega,
  tarifaBase,
  tarifaPorKm,
}) {
  const distanciaMetros = distanciaEnMetros(
    latitudLocal,
    longitudLocal,
    latitudEntrega,
    longitudEntrega,
  );

  const variables = dividirRedondeando(
    multiplicar(aBigInt(tarifaPorKm, 'tarifa_por_km'), BigInt(distanciaMetros)),
    1000n,
  );

  return {
    costo: sumar(aBigInt(tarifaBase, 'tarifa_base_envio'), variables),
    distanciaMetros,
  };
}

/** Comision = max(redondear(subtotal * porcentaje), comision_minima). */
export function calcularComision({ subtotal, porcentaje, comisionMinima }) {
  const calculada = aplicarPorcentaje(
    subtotal,
    porcentajeABasisPuntos(porcentaje),
  );
  const minima = aBigInt(comisionMinima, 'comision_minima');
  return calculada > minima ? calculada : minima;
}

export async function leerConfiguracionCongelada() {
  await cargarConfiguracion();

  const snapshot = {};
  for (const clave of CLAVES_CONGELADAS) {
    const valor = obtener(clave);
    if (valor === undefined) {
      throw new ErrorApi(
        'configuracion_incompleta',
        `Falta la configuracion "${clave}".`,
        500,
      );
    }
    snapshot[clave] = valor;
  }
  snapshot.tomado_en = new Date().toISOString();
  return snapshot;
}

function agruparItems(items) {
  const mapa = new Map();

  for (const item of items) {
    const acumulado = (mapa.get(item.variante_id) ?? 0) + item.cantidad;
    if (acumulado > 999) {
      throw new ErrorApi(
        'validacion_invalida',
        'La cantidad total por variante no puede superar 999.',
        400,
      );
    }
    mapa.set(item.variante_id, acumulado);
  }

  return [...mapa.entries()].map(([varianteId, cantidad]) => ({
    varianteId,
    cantidad,
  }));
}

async function prepararPedido({ datos }) {
  const snapshot = await leerConfiguracionCongelada();
  const agrupados = agruparItems(datos.items);
  const ids = agrupados.map((item) => item.varianteId);

  const variantes = await prisma.productoVariante.findMany({
    where: { id: { in: ids } },
    include: { producto: { include: { local: true } } },
  });

  const porId = new Map(variantes.map((variante) => [variante.id, variante]));

  if (porId.size !== ids.length) {
    throw new ErrorApi(
      'variante_no_disponible',
      'Una o mas variantes no existen.',
      422,
    );
  }

  for (const item of agrupados) {
    const variante = porId.get(item.varianteId);
    if (
      !variante.activo ||
      !variante.producto.activo ||
      variante.producto.local.estado !== 'activo'
    ) {
      throw new ErrorApi(
        'variante_no_disponible',
        `La variante ${item.varianteId} no esta disponible.`,
        422,
      );
    }
  }

  const localId = variantes[0].producto.localId;
  if (variantes.some((variante) => variante.producto.localId !== localId)) {
    throw new ErrorApi(
      'varios_locales_no_soportado',
      'En esta etapa todos los productos del pedido deben ser del mismo local.',
      422,
    );
  }

  const faltantes = agrupados
    .filter((item) => porId.get(item.varianteId).stock < item.cantidad)
    .map((item) => ({
      variante_id: item.varianteId,
      disponible: porId.get(item.varianteId).stock,
      pedido: item.cantidad,
    }));

  if (faltantes.length > 0) {
    throw new ErrorApi(
      'stock_insuficiente',
      'No hay stock suficiente para uno o mas productos.',
      422,
      faltantes,
    );
  }

  const lineas = agrupados.map((item) => {
    const variante = porId.get(item.varianteId);
    return {
      variante,
      cantidad: item.cantidad,
      precioUnitario: variante.precio,
      subtotal: multiplicar(variante.precio, BigInt(item.cantidad)),
    };
  });

  const subtotal = lineas.reduce((total, linea) => total + linea.subtotal, 0n);
  const pedidoMinimo = aBigInt(snapshot.pedido_minimo, 'pedido_minimo');

  if (subtotal < pedidoMinimo) {
    throw new ErrorApi(
      'pedido_minimo_no_alcanzado',
      `El pedido minimo es de ${aNumeroSeguro(pedidoMinimo)} pesos.`,
      422,
      {
        minimo: aNumeroSeguro(pedidoMinimo),
        subtotal: aNumeroSeguro(subtotal),
      },
    );
  }

  const local = variantes[0].producto.local;
  const envio = calcularCostoEnvio({
    latitudLocal: local.latitud,
    longitudLocal: local.longitud,
    latitudEntrega: datos.direccion.latitud,
    longitudEntrega: datos.direccion.longitud,
    tarifaBase: snapshot.tarifa_base_envio,
    tarifaPorKm: snapshot.tarifa_por_km,
  });

  const comision = calcularComision({
    subtotal,
    porcentaje: snapshot.porcentaje_comision,
    comisionMinima: snapshot.comision_minima,
  });

  const total = sumar(subtotal, envio.costo);

  return {
    snapshot,
    lineas,
    local,
    subtotal,
    comision,
    costoEnvio: envio.costo,
    distanciaMetros: envio.distanciaMetros,
    total,
  };
}

export function serializarPedido(pedido) {
  return {
    id: pedido.id,
    usuario_id: pedido.usuarioId,
    estado: pedido.estado,
    metodo_pago: pedido.metodoPago,
    total: pedido.total,
    direccion: {
      texto: pedido.direccionTexto,
      latitud: pedido.direccionLatitud,
      longitud: pedido.direccionLongitud,
    },
    config_snapshot: pedido.configSnapshot,
    creado_en: pedido.creadoEn,
    sub_pedidos: (pedido.subPedidos ?? []).map((sub) => ({
      id: sub.id,
      pedido_id: sub.pedidoId,
      local_id: sub.localId,
      nombre_local: sub.nombreLocal,
      subtotal_productos: sub.subtotalProductos,
      costo_envio: sub.costoEnvio,
      comision: sub.comision,
      total: sub.total,
      estado: sub.estado,
      evidencia_envio: sub.evidenciaEnvio,
      entrega_confirmada_por: sub.entregaConfirmadaPor,
      fecha_entrega: sub.fechaEntrega,
      saldo_liberado_en: sub.saldoLiberadoEn,
      detalles: (sub.detalles ?? []).map((detalle) => ({
        id: detalle.id,
        variante_id: detalle.varianteId,
        nombre_producto: detalle.nombreProducto,
        atributos_elegidos: detalle.atributosElegidos,
        cantidad: detalle.cantidad,
        precio_unitario: detalle.precioUnitario,
      })),
    })),
  };
}

function incluirPedido() {
  return {
    subPedidos: {
      include: { detalles: true },
      orderBy: { id: 'asc' },
    },
  };
}

/**
 * Crea el pedido completo dentro de una transaccion. El stock no se toca.
 */
export async function crearPedido({ usuario, datos, idempotenciaId }) {
  const preparado = await prepararPedido({ datos });

  return withTransaccion(async (tx) => {
    const pedido = await tx.pedido.create({
      data: {
        usuarioId: usuario.id,
        direccionTexto: datos.direccion.texto,
        direccionLatitud: datos.direccion.latitud,
        direccionLongitud: datos.direccion.longitud,
        total: preparado.total,
        metodoPago: datos.metodo_pago,
        estado: 'pendiente_pago',
        configSnapshot: preparado.snapshot,
      },
    });

    const subPedido = await tx.subPedido.create({
      data: {
        pedidoId: pedido.id,
        localId: preparado.local.id,
        nombreLocal: preparado.local.nombre,
        subtotalProductos: preparado.subtotal,
        costoEnvio: preparado.costoEnvio,
        comision: preparado.comision,
        total: preparado.total,
        estado: 'pendiente',
      },
    });

    for (const linea of preparado.lineas) {
      await tx.detalleProducto.create({
        data: {
          subPedidoId: subPedido.id,
          varianteId: linea.variante.id,
          nombreProducto: linea.variante.producto.nombre,
          atributosElegidos:
            linea.variante.atributos === null
              ? undefined
              : linea.variante.atributos,
          cantidad: linea.cantidad,
          precioUnitario: linea.precioUnitario,
        },
      });
    }

    await tx.historialEstadoSubPedido.create({
      data: {
        subPedidoId: subPedido.id,
        estadoAnterior: null,
        estadoNuevo: 'pendiente',
        cambiadoPor: usuario.id,
      },
    });

    const completo = await tx.pedido.findUnique({
      where: { id: pedido.id },
      include: incluirPedido(),
    });

    const respuesta = convertirBigIntAJson(serializarPedido(completo));
    await completarEnTx(tx, idempotenciaId, 201, respuesta);

    return respuesta;
  });
}

export async function listarPedidos({ usuario, pagina, porPagina }) {
  const where = { usuarioId: usuario.id };
  const total = await prisma.pedido.count({ where });
  const pedidos = await prisma.pedido.findMany({
    where,
    include: incluirPedido(),
    orderBy: { creadoEn: 'desc' },
    skip: (pagina - 1) * porPagina,
    take: porPagina,
  });

  return convertirBigIntAJson({
    datos: pedidos.map(serializarPedido),
    paginacion: {
      pagina,
      por_pagina: porPagina,
      total,
      paginas: Math.ceil(total / porPagina),
    },
  });
}

export async function obtenerPedido({ usuario, id }) {
  const esAdmin = usuario.roles.includes('admin');
  const where = esAdmin ? { id } : { id, usuarioId: usuario.id };

  const pedido = await prisma.pedido.findFirst({
    where,
    include: incluirPedido(),
  });

  if (!pedido) throw errorNoEncontrado('Pedido no encontrado.');

  return convertirBigIntAJson(serializarPedido(pedido));
}
