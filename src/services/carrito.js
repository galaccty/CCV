import { prisma } from '../lib/prisma.js';
import { withTransaccion } from '../lib/transaccion.js';
import {
  aBigInt,
  convertirBigIntAJson,
  sumar,
} from '../lib/dinero.js';
import { ErrorApi, errorNoEncontrado } from '../lib/errores.js';
import { puedeVenderLocal } from '../domain/estados.js';
import {
  calcularCostoEnvio,
  leerConfiguracionCongelada,
} from './pedidos.js';

/**
 * CARRITO MULTI-LOCAL (Etapa 3)
 * =============================
 * El carrito es una ayuda de compra, no una reserva. El checkout vuelve a
 * validar stock, precios y estado de cada local. Se vacia de las unidades
 * compradas cuando el pago se aprueba (transaccion A del webhook), no al crear
 * el pedido.
 */

const INCLUDE_CARRITO = {
  items: {
    orderBy: { creadoEn: 'asc' },
    include: {
      variante: {
        include: {
          producto: {
            include: { local: true },
          },
        },
      },
    },
  },
};

function precioSubtotal(precio, cantidad) {
  return precio * BigInt(cantidad);
}

/**
 * La foto principal es la primera del arreglo `fotos` del producto.
 * Los datos viejos pueden tener null u otra forma: solo se aceptan strings.
 */
function fotoPrincipal(fotos) {
  if (!Array.isArray(fotos)) return null;
  return fotos.find((foto) => typeof foto === 'string' && foto.trim() !== '') ?? null;
}

function serializarItem(item) {
  const { variante } = item;
  const producto = variante.producto;
  const local = producto.local;
  const disponible =
    variante.activo &&
    producto.activo &&
    puedeVenderLocal(local.estado) &&
    variante.stock >= item.cantidad;

  return {
    id: item.id,
    variante_id: item.varianteId,
    cantidad: item.cantidad,
    local_id: local.id,
    nombre_local: local.nombre,
    producto_id: producto.id,
    nombre_producto: producto.nombre,
    atributos: variante.atributos,
    foto_principal: fotoPrincipal(producto.fotos),
    precio_unitario: variante.precio,
    subtotal: precioSubtotal(variante.precio, item.cantidad),
    disponible,
  };
}

function serializarCarrito(carrito) {
  if (!carrito) {
    return { id: null, items: [], total_productos: 0n };
  }

  const items = carrito.items.map(serializarItem);
  const totalProductos = items.reduce(
    (total, item) => total + item.subtotal,
    0n,
  );

  return {
    id: carrito.id,
    items,
    total_productos: totalProductos,
  };
}

async function cargarCarrito(usuarioId) {
  return prisma.carrito.findUnique({
    where: { usuarioId },
    include: INCLUDE_CARRITO,
  });
}

export async function verCarrito({ usuario }) {
  const carrito = await cargarCarrito(usuario.id);
  return convertirBigIntAJson(serializarCarrito(carrito));
}

/**
 * Cotiza el carrito guardado contra una direccion de entrega.
 *
 * Es una lectura pura: no crea pedido, no reserva stock y no descuenta nada.
 * A diferencia del checkout, no falla cuando el pedido minimo no se alcanza:
 * devuelve `cumple_pedido_minimo` y `faltante_pedido_minimo` para que el
 * frontend pueda avisar antes de pagar.
 */
export async function cotizarCarrito({ usuario, direccion }) {
  const carrito = await cargarCarrito(usuario.id);
  const snapshot = await leerConfiguracionCongelada();
  const pedidoMinimo = aBigInt(snapshot.pedido_minimo, 'pedido_minimo');

  const porLocal = new Map();

  for (const item of carrito?.items ?? []) {
    const local = item.variante.producto.local;
    let grupo = porLocal.get(local.id);

    if (!grupo) {
      grupo = { local, subtotal: 0n };
      porLocal.set(local.id, grupo);
    }

    grupo.subtotal = sumar(
      grupo.subtotal,
      precioSubtotal(item.variante.precio, item.cantidad),
    );
  }

  const locales = [...porLocal.values()].map(({ local, subtotal }) => {
    const envio = calcularCostoEnvio({
      latitudLocal: local.latitud,
      longitudLocal: local.longitud,
      latitudEntrega: direccion.latitud,
      longitudEntrega: direccion.longitud,
      tarifaBase: snapshot.tarifa_base_envio,
      tarifaPorKm: snapshot.tarifa_por_km,
    });
    const cumple = subtotal >= pedidoMinimo;

    return {
      local_id: local.id,
      nombre_local: local.nombre,
      subtotal_productos: subtotal,
      costo_envio: envio.costo,
      pedido_minimo: pedidoMinimo,
      cumple_pedido_minimo: cumple,
      faltante_pedido_minimo: cumple ? 0n : pedidoMinimo - subtotal,
      total: sumar(subtotal, envio.costo),
    };
  });

  const total = locales.reduce((suma, local) => sumar(suma, local.total), 0n);

  return convertirBigIntAJson({ locales, total });
}

async function validarVarianteDisponible(varianteId) {
  const variante = await prisma.productoVariante.findUnique({
    where: { id: varianteId },
    include: {
      producto: {
        include: { local: true },
      },
    },
  });

  if (!variante) throw errorNoEncontrado('Variante no encontrada.');

  if (
    !variante.activo ||
    !variante.producto.activo ||
    !puedeVenderLocal(variante.producto.local.estado)
  ) {
    throw new ErrorApi(
      'variante_no_disponible',
      'La variante o su local no estan disponibles para vender.',
      422,
    );
  }

  return variante;
}

export async function fijarItem({ usuario, varianteId, cantidad }) {
  await validarVarianteDisponible(varianteId);

  await withTransaccion(async (tx) => {
    const carrito = await tx.carrito.upsert({
      where: { usuarioId: usuario.id },
      create: { usuarioId: usuario.id },
      update: {},
    });

    await tx.carritoItem.upsert({
      where: {
        carritoId_varianteId: {
          carritoId: carrito.id,
          varianteId,
        },
      },
      create: { carritoId: carrito.id, varianteId, cantidad },
      update: { cantidad },
    });
  });

  return verCarrito({ usuario });
}

export async function quitarItem({ usuario, varianteId }) {
  await prisma.carritoItem.deleteMany({
    where: {
      varianteId,
      carrito: { usuarioId: usuario.id },
    },
  });
}

export async function vaciarCarrito({ usuario }) {
  await prisma.carritoItem.deleteMany({
    where: { carrito: { usuarioId: usuario.id } },
  });
}

/**
 * Se llama desde la transaccion A del webhook, despues de descontar stock y
 * antes del commit. Si el carrito tiene mas unidades que las compradas, solo
 * se descuentan las unidades incluidas en el pedido.
 */
export async function descontarItemsDePedido(tx, usuarioId, lineas) {
  const carrito = await tx.carrito.findUnique({
    where: { usuarioId },
    select: { id: true },
  });
  if (!carrito) return;

  const cantidades = new Map();
  for (const linea of lineas) {
    cantidades.set(
      linea.varianteId,
      (cantidades.get(linea.varianteId) ?? 0) + linea.cantidad,
    );
  }

  for (const [varianteId, cantidad] of cantidades) {
    await tx.carritoItem.deleteMany({
      where: {
        carritoId: carrito.id,
        varianteId,
        cantidad: { lte: cantidad },
      },
    });

    await tx.carritoItem.updateMany({
      where: {
        carritoId: carrito.id,
        varianteId,
        cantidad: { gt: cantidad },
      },
      data: { cantidad: { decrement: cantidad } },
    });
  }
}
