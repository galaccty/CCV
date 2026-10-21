import { prisma } from '../lib/prisma.js';
import { convertirBigIntAJson } from '../lib/dinero.js';
import { errorNoEncontrado } from '../lib/errores.js';
import { envolverLista } from '../lib/validacion.js';
import { ESTADOS_LOCAL_VENTA } from '../domain/estados.js';

/**
 * CATALOGO PUBLICO (Etapa 3)
 * ===========================
 * Las rutas publicas solo muestran locales que pueden vender (`activo` o
 * `en_plazo`), productos activos y variantes activas. No hay busqueda
 * full-text todavia: eso llega en la Etapa 5.
 */

export function serializarRubro(rubro) {
  return { id: rubro.id, nombre: rubro.nombre };
}

export function serializarCategoria(categoria) {
  return {
    id: categoria.id,
    nombre: categoria.nombre,
    padre_id: categoria.padreId,
    rubro_id: categoria.rubroId,
  };
}

export function serializarSubcategoria(subcategoria) {
  return {
    id: subcategoria.id,
    local_id: subcategoria.localId,
    nombre: subcategoria.nombre,
  };
}

export function serializarVariante(variante) {
  return {
    id: variante.id,
    producto_id: variante.productoId,
    atributos: variante.atributos,
    precio: variante.precio,
    stock: variante.stock,
    activo: variante.activo,
  };
}

export function serializarProducto(producto) {
  return {
    id: producto.id,
    local_id: producto.localId,
    categoria_global_id: producto.categoriaGlobalId,
    subcategoria_local_id: producto.subcategoriaLocalId,
    nombre: producto.nombre,
    descripcion: producto.descripcion,
    fotos: producto.fotos,
    atributos: producto.atributos,
    activo: producto.activo,
    creado_en: producto.creadoEn,
    variantes: (producto.variantes ?? []).map(serializarVariante),
  };
}

export function serializarVariantePublica(variante) {
  const existencias = Number(variante.stock);

  return {
    id: variante.id,
    producto_id: variante.productoId,
    atributos: variante.atributos,
    precio: variante.precio,
    // El inventario exacto no se expone en el catalogo publico. Cuando quedan
    // cinco unidades o menos se informa el numero para mostrar urgencia; por
    // encima de cinco solo se dice que hay disponibilidad.
    disponible: existencias > 0,
    ...(existencias <= 5 ? { unidades_restantes: existencias } : {}),
  };
}

export function serializarProductoCatalogoPublico(producto) {
  return {
    id: producto.id,
    local_id: producto.localId,
    categoria_global_id: producto.categoriaGlobalId,
    subcategoria_local_id: producto.subcategoriaLocalId,
    nombre: producto.nombre,
    descripcion: producto.descripcion,
    fotos: producto.fotos,
    atributos: producto.atributos,
    activo: producto.activo,
    creado_en: producto.creadoEn,
    variantes: (producto.variantes ?? []).map(serializarVariantePublica),
  };
}

export function serializarLocalPublico(local) {
  const serializado = serializarLocal(local);

  if (local.productos) {
    serializado.productos = local.productos.map(
      serializarProductoCatalogoPublico,
    );
  }

  return serializado;
}

export function serializarLocalResumen(local) {
  return {
    id: local.id,
    nombre: local.nombre,
    logo_url: local.logoUrl,
    banner_fondo_url: local.bannerFondoUrl,
    promedio_calificacion: local.promedioCalificacion,
    total_calificaciones: local.totalCalificaciones,
    ...(local.rubro ? { rubro: serializarRubro(local.rubro) } : {}),
  };
}

export function serializarProductoPublico(producto) {
  return {
    id: producto.id,
    local_id: producto.localId,
    categoria_global_id: producto.categoriaGlobalId,
    subcategoria_local_id: producto.subcategoriaLocalId,
    nombre: producto.nombre,
    descripcion: producto.descripcion,
    fotos: producto.fotos,
    atributos: producto.atributos,
    creado_en: producto.creadoEn,
    local: serializarLocalResumen(producto.local),
    variantes: (producto.variantes ?? []).map(serializarVariantePublica),
  };
}

export function serializarLocal(local) {
  return {
    id: local.id,
    usuario_id: local.usuarioId,
    rubro_id: local.rubroId,
    nombre: local.nombre,
    logo_url: local.logoUrl,
    banner_fondo_url: local.bannerFondoUrl,
    latitud: local.latitud,
    longitud: local.longitud,
    estado: local.estado,
    promedio_calificacion: local.promedioCalificacion,
    total_calificaciones: local.totalCalificaciones,
    creado_en: local.creadoEn,
    rubro: local.rubro ? serializarRubro(local.rubro) : undefined,
    ...(local.subcategorias
      ? { subcategorias: local.subcategorias.map(serializarSubcategoria) }
      : {}),
    ...(local.productos
      ? { productos: local.productos.map(serializarProducto) }
      : {}),
  };
}

export async function listarRubros() {
  const rubros = await prisma.rubro.findMany({ orderBy: { nombre: 'asc' } });
  return { datos: rubros.map(serializarRubro) };
}

export async function listarCategoriasGlobales({ rubroId, padreId } = {}) {
  const where = {};
  if (rubroId !== undefined) where.rubroId = rubroId;
  if (padreId !== undefined) where.padreId = padreId;

  const categorias = await prisma.categoriaGlobal.findMany({
    where,
    orderBy: [{ nombre: 'asc' }],
  });

  return { datos: categorias.map(serializarCategoria) };
}

export async function listarLocales({
  rubroId,
  categoriaGlobalId,
  pagina,
  porPagina,
} = {}) {
  const where = {
    estado: { in: [...ESTADOS_LOCAL_VENTA] },
    ...(rubroId !== undefined ? { rubroId } : {}),
    ...(categoriaGlobalId !== undefined
      ? {
          productos: {
            some: { activo: true, categoriaGlobalId },
          },
        }
      : {}),
  };

  const total = await prisma.local.count({ where });
  const locales = await prisma.local.findMany({
    where,
    include: { rubro: true },
    orderBy: [{ promedioCalificacion: 'desc' }, { nombre: 'asc' }],
    skip: (pagina - 1) * porPagina,
    take: porPagina,
  });

  return convertirBigIntAJson(
    envolverLista(locales.map(serializarLocal), { pagina, porPagina }, total),
  );
}

export async function obtenerLocal({ id }) {
  const local = await prisma.local.findFirst({
    where: { id, estado: { in: [...ESTADOS_LOCAL_VENTA] } },
    include: {
      rubro: true,
      subcategorias: { orderBy: { nombre: 'asc' } },
      productos: {
        where: { activo: true },
        orderBy: { nombre: 'asc' },
        include: {
          variantes: {
            where: { activo: true },
            orderBy: { id: 'asc' },
          },
        },
      },
    },
  });

  if (!local) throw errorNoEncontrado('Local no encontrado.');

  return convertirBigIntAJson(serializarLocalPublico(local));
}

export async function listarProductosDeLocal({
  localId,
  categoriaGlobalId,
  subcategoriaLocalId,
  pagina,
  porPagina,
} = {}) {
  const local = await prisma.local.findFirst({
    where: { id: localId, estado: { in: [...ESTADOS_LOCAL_VENTA] } },
    select: { id: true },
  });

  if (!local) throw errorNoEncontrado('Local no encontrado.');

  const where = {
    localId,
    activo: true,
    ...(categoriaGlobalId !== undefined ? { categoriaGlobalId } : {}),
    ...(subcategoriaLocalId !== undefined ? { subcategoriaLocalId } : {}),
  };

  const total = await prisma.producto.count({ where });
  const productos = await prisma.producto.findMany({
    where,
    include: {
      variantes: {
        where: { activo: true },
        orderBy: { id: 'asc' },
      },
    },
    orderBy: { nombre: 'asc' },
    skip: (pagina - 1) * porPagina,
    take: porPagina,
  });

  return convertirBigIntAJson(
    envolverLista(
      productos.map(serializarProductoCatalogoPublico),
      { pagina, porPagina },
      total,
    ),
  );
}

export async function obtenerProducto({ id }) {
  const producto = await prisma.producto.findFirst({
    where: {
      id,
      activo: true,
      local: { estado: { in: [...ESTADOS_LOCAL_VENTA] } },
    },
    include: {
      local: { include: { rubro: true } },
      variantes: {
        where: { activo: true },
        orderBy: { id: 'asc' },
      },
    },
  });

  if (!producto) throw errorNoEncontrado('Producto no encontrado.');

  return convertirBigIntAJson(serializarProductoPublico(producto));
}
