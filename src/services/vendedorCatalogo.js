import { prisma } from '../lib/prisma.js';
import { withTransaccion } from '../lib/transaccion.js';
import { convertirBigIntAJson } from '../lib/dinero.js';
import {
  ErrorApi,
  errorNoEncontrado,
  errorSinPermiso,
} from '../lib/errores.js';
import { envolverLista } from '../lib/validacion.js';
import {
  crearVariante as crearVarianteConStock,
  ajustarStock,
  ErrorAjusteStockNegativo,
  ErrorVarianteNoEncontrada,
} from './stock.js';
import {
  serializarLocal,
  serializarProducto,
  serializarSubcategoria,
  serializarVariante,
} from './catalogo.js';

/**
 * CATALOGO DEL VENDEDOR (Etapa 3)
 * ================================
 * Todo pasa por el dueno del local. Los productos no se borran: se desactivan.
 * El stock inicial y los ajustes se escriben UNICAMENTE por el modulo de stock.
 */

async function cargarLocalPropio(usuario, localId) {
  const local = await prisma.local.findUnique({
    where: { id: localId },
    include: { rubro: true },
  });

  if (!local) throw errorNoEncontrado('Local no encontrado.');
  if (local.usuarioId !== usuario.id) throw errorSinPermiso();
  return local;
}

async function cargarProductoPropio(usuario, productoId) {
  const producto = await prisma.producto.findUnique({
    where: { id: productoId },
    include: {
      local: true,
      variantes: { orderBy: { id: 'asc' } },
    },
  });

  if (!producto) throw errorNoEncontrado('Producto no encontrado.');
  if (producto.local.usuarioId !== usuario.id) throw errorSinPermiso();
  return producto;
}

async function cargarVariantePropia(usuario, varianteId) {
  const variante = await prisma.productoVariante.findUnique({
    where: { id: varianteId },
    include: { producto: { include: { local: true } } },
  });

  if (!variante) throw errorNoEncontrado('Variante no encontrada.');
  if (variante.producto.local.usuarioId !== usuario.id) throw errorSinPermiso();
  return variante;
}

async function validarCategoria({ local, categoriaGlobalId, subcategoriaLocalId }) {
  const categoria = await prisma.categoriaGlobal.findUnique({
    where: { id: categoriaGlobalId },
  });

  if (!categoria) {
    throw new ErrorApi(
      'categoria_no_encontrada',
      'La categoria global no existe.',
      422,
    );
  }

  if (categoria.rubroId !== null && categoria.rubroId !== local.rubroId) {
    throw new ErrorApi(
      'categoria_no_corresponde_al_rubro',
      'La categoria global pertenece a otro rubro.',
      422,
    );
  }

  if (subcategoriaLocalId !== undefined && subcategoriaLocalId !== null) {
    const subcategoria = await prisma.subcategoriaLocal.findUnique({
      where: { id: subcategoriaLocalId },
    });

    if (!subcategoria || subcategoria.localId !== local.id) {
      throw new ErrorApi(
        'subcategoria_de_otro_local',
        'La subcategoria no pertenece a este local.',
        422,
      );
    }
  }
}

export async function crearLocal({ usuario, datos }) {
  const rubro = await prisma.rubro.findUnique({
    where: { id: datos.rubro_id },
  });
  if (!rubro) {
    throw new ErrorApi('rubro_no_encontrado', 'El rubro no existe.', 422);
  }

  const local = await prisma.local.create({
    data: {
      usuarioId: usuario.id,
      rubroId: datos.rubro_id,
      nombre: datos.nombre,
      logoUrl: datos.logo_url ?? null,
      bannerFondoUrl: datos.banner_fondo_url ?? null,
      latitud: datos.latitud,
      longitud: datos.longitud,
      estado: 'pendiente_aprobacion',
    },
    include: { rubro: true },
  });

  return convertirBigIntAJson(serializarLocal(local));
}

export async function listarLocalesVendedor({ usuario, pagina, porPagina }) {
  const where = { usuarioId: usuario.id };
  const total = await prisma.local.count({ where });
  const locales = await prisma.local.findMany({
    where,
    include: { rubro: true },
    orderBy: { creadoEn: 'desc' },
    skip: (pagina - 1) * porPagina,
    take: porPagina,
  });

  return convertirBigIntAJson(
    envolverLista(locales.map(serializarLocal), { pagina, porPagina }, total),
  );
}

export async function actualizarLocal({ usuario, id, datos }) {
  const local = await cargarLocalPropio(usuario, id);

  if (datos.rubro_id !== undefined && datos.rubro_id !== local.rubroId) {
    const productos = await prisma.producto.findMany({
      where: { localId: local.id },
      select: {
        id: true,
        categoriaGlobal: { select: { rubroId: true } },
      },
    });

    const incompatible = productos.find(
      (producto) =>
        producto.categoriaGlobal.rubroId !== null &&
        producto.categoriaGlobal.rubroId !== datos.rubro_id,
    );

    if (incompatible) {
      throw new ErrorApi(
        'rubro_con_productos_incompatibles',
        'No se puede cambiar el rubro: hay productos con categorias del rubro anterior.',
        422,
      );
    }

    const rubro = await prisma.rubro.findUnique({
      where: { id: datos.rubro_id },
    });
    if (!rubro) {
      throw new ErrorApi('rubro_no_encontrado', 'El rubro no existe.', 422);
    }
  }

  const actualizado = await prisma.local.update({
    where: { id: local.id },
    data: {
      ...(datos.rubro_id !== undefined ? { rubroId: datos.rubro_id } : {}),
      ...(datos.nombre !== undefined ? { nombre: datos.nombre } : {}),
      ...(datos.logo_url !== undefined ? { logoUrl: datos.logo_url } : {}),
      ...(datos.banner_fondo_url !== undefined
        ? { bannerFondoUrl: datos.banner_fondo_url }
        : {}),
      ...(datos.latitud !== undefined ? { latitud: datos.latitud } : {}),
      ...(datos.longitud !== undefined ? { longitud: datos.longitud } : {}),
    },
    include: { rubro: true },
  });

  return convertirBigIntAJson(serializarLocal(actualizado));
}

export async function crearSubcategoria({ usuario, localId, datos }) {
  const local = await cargarLocalPropio(usuario, localId);

  const subcategoria = await prisma.subcategoriaLocal.create({
    data: { localId: local.id, nombre: datos.nombre },
  });

  return serializarSubcategoria(subcategoria);
}

export async function actualizarSubcategoria({ usuario, id, datos }) {
  const subcategoria = await prisma.subcategoriaLocal.findUnique({
    where: { id },
    include: { local: true },
  });

  if (!subcategoria) throw errorNoEncontrado('Subcategoria no encontrada.');
  if (subcategoria.local.usuarioId !== usuario.id) throw errorSinPermiso();

  const actualizada = await prisma.subcategoriaLocal.update({
    where: { id: subcategoria.id },
    data: { nombre: datos.nombre },
  });

  return serializarSubcategoria(actualizada);
}

export async function listarProductosVendedor({
  usuario,
  localId,
  pagina,
  porPagina,
}) {
  const where = {
    local: { usuarioId: usuario.id },
    ...(localId !== undefined ? { localId } : {}),
  };

  const total = await prisma.producto.count({ where });
  const productos = await prisma.producto.findMany({
    where,
    include: { variantes: { orderBy: { id: 'asc' } } },
    orderBy: { creadoEn: 'desc' },
    skip: (pagina - 1) * porPagina,
    take: porPagina,
  });

  return convertirBigIntAJson(
    envolverLista(
      productos.map(serializarProducto),
      { pagina, porPagina },
      total,
    ),
  );
}

export async function crearProducto({ usuario, datos }) {
  const local = await cargarLocalPropio(usuario, datos.local_id);

  await validarCategoria({
    local,
    categoriaGlobalId: datos.categoria_global_id,
    subcategoriaLocalId: datos.subcategoria_local_id,
  });

  const producto = await withTransaccion(async (tx) => {
    const creado = await tx.producto.create({
      data: {
        localId: local.id,
        categoriaGlobalId: datos.categoria_global_id,
        subcategoriaLocalId: datos.subcategoria_local_id ?? null,
        nombre: datos.nombre,
        descripcion: datos.descripcion ?? null,
        fotos: datos.fotos ?? null,
        atributos: datos.atributos ?? null,
        activo: true,
      },
    });

    for (const variante of datos.variantes) {
      await crearVarianteConStock(tx, {
        productoId: creado.id,
        atributos: variante.atributos ?? null,
        precio: variante.precio,
        stock: variante.stock,
        activo: variante.activo,
      });
    }

    return tx.producto.findUnique({
      where: { id: creado.id },
      include: { variantes: { orderBy: { id: 'asc' } } },
    });
  });

  return convertirBigIntAJson(serializarProducto(producto));
}

export async function actualizarProducto({ usuario, id, datos }) {
  const producto = await cargarProductoPropio(usuario, id);

  const categoriaGlobalId =
    datos.categoria_global_id ?? producto.categoriaGlobalId;
  const subcategoriaLocalId =
    datos.subcategoria_local_id !== undefined
      ? datos.subcategoria_local_id
      : producto.subcategoriaLocalId;

  if (
    datos.categoria_global_id !== undefined ||
    datos.subcategoria_local_id !== undefined
  ) {
    await validarCategoria({
      local: producto.local,
      categoriaGlobalId,
      subcategoriaLocalId,
    });
  }

  const actualizado = await prisma.producto.update({
    where: { id: producto.id },
    data: {
      ...(datos.categoria_global_id !== undefined
        ? { categoriaGlobalId: datos.categoria_global_id }
        : {}),
      ...(datos.subcategoria_local_id !== undefined
        ? { subcategoriaLocalId: datos.subcategoria_local_id }
        : {}),
      ...(datos.nombre !== undefined ? { nombre: datos.nombre } : {}),
      ...(datos.descripcion !== undefined
        ? { descripcion: datos.descripcion }
        : {}),
      ...(datos.fotos !== undefined ? { fotos: datos.fotos } : {}),
      ...(datos.atributos !== undefined ? { atributos: datos.atributos } : {}),
      ...(datos.activo !== undefined ? { activo: datos.activo } : {}),
    },
    include: { variantes: { orderBy: { id: 'asc' } } },
  });

  return convertirBigIntAJson(serializarProducto(actualizado));
}

export async function crearVariante({ usuario, productoId, datos }) {
  const producto = await cargarProductoPropio(usuario, productoId);

  const variante = await withTransaccion((tx) =>
    crearVarianteConStock(tx, {
      productoId: producto.id,
      atributos: datos.atributos ?? null,
      precio: datos.precio,
      stock: datos.stock,
      activo: datos.activo,
    }),
  );

  return convertirBigIntAJson(serializarVariante(variante));
}

export async function actualizarVariante({ usuario, id, datos }) {
  const variante = await cargarVariantePropia(usuario, id);

  const actualizada = await prisma.productoVariante.update({
    where: { id: variante.id },
    data: {
      ...(datos.atributos !== undefined ? { atributos: datos.atributos } : {}),
      ...(datos.precio !== undefined ? { precio: datos.precio } : {}),
      ...(datos.activo !== undefined ? { activo: datos.activo } : {}),
    },
  });

  return convertirBigIntAJson(serializarVariante(actualizada));
}

export async function ajustarStockVariante({ usuario, id, diferencia }) {
  const variante = await cargarVariantePropia(usuario, id);

  try {
    await ajustarStock(prisma, variante.id, diferencia);
  } catch (err) {
    if (err instanceof ErrorAjusteStockNegativo) {
      throw new ErrorApi(
        'stock_negativo',
        'El ajuste dejaria el stock en negativo.',
        422,
        {
          variante_id: err.varianteId,
          stock_actual: err.stockActual,
          diferencia,
        },
      );
    }
    if (err instanceof ErrorVarianteNoEncontrada) {
      throw errorNoEncontrado('Variante no encontrada.');
    }
    throw err;
  }

  const actualizada = await prisma.productoVariante.findUnique({
    where: { id: variante.id },
  });

  return convertirBigIntAJson(serializarVariante(actualizada));
}
