import { prisma } from '../lib/prisma.js';
import { convertirBigIntAJson } from '../lib/dinero.js';
import {
  ErrorApi,
  errorNoEncontrado,
} from '../lib/errores.js';
import { envolverLista } from '../lib/validacion.js';
import {
  serializarCategoria,
  serializarLocal,
  serializarRubro,
} from './catalogo.js';

/**
 * ADMINISTRACION DEL CATALOGO (Etapa 3)
 * =====================================
 * El admin administra rubros, categorias globales y la aprobacion/suspension de
 * locales. Los estados `en_plazo` y `bloqueado` son de deuda y no se tocan
 * desde estas rutas (seccion 4.7 de la especificacion).
 */

const ESTADOS_ADMIN = new Set(['activo', 'suspendido']);

export async function listarLocalesAdmin({
  estado,
  pagina,
  porPagina,
}) {
  const where = estado ? { estado } : {};

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

export async function cambiarEstadoLocal({ admin, id, estado }) {
  if (!ESTADOS_ADMIN.has(estado)) {
    throw new ErrorApi(
      'estado_local_invalido',
      'Solo se puede aprobar (activo) o suspender un local.',
      422,
    );
  }

  const local = await prisma.local.findUnique({
    where: { id },
    include: { rubro: true },
  });

  if (!local) throw errorNoEncontrado('Local no encontrado.');

  if (local.estado === 'bloqueado') {
    throw new ErrorApi(
      'estado_solo_sistema',
      'El estado bloqueado solo lo libera el sistema cuando la deuda se resuelve.',
      409,
    );
  }

  if (estado === 'activo' && local.estado === 'en_plazo') {
    throw new ErrorApi(
      'estado_controlado_por_deuda',
      'Un local en plazo no se reactiva desde el panel mientras tenga deuda.',
      409,
    );
  }

  if (local.estado === estado) {
    return convertirBigIntAJson(serializarLocal(local));
  }

  const actualizado = await prisma.$transaction(async (tx) => {
    const localActualizado = await tx.local.update({
      where: { id: local.id },
      data: { estado },
      include: { rubro: true },
    });

    await tx.auditoriaAdmin.create({
      data: {
        origen: 'admin',
        adminId: admin.id,
        accion: 'cambiar_estado_local',
        objeto: 'local',
        objetoId: String(local.id),
        detalle: { estado_anterior: local.estado, estado_nuevo: estado },
      },
    });

    return localActualizado;
  });

  return convertirBigIntAJson(serializarLocal(actualizado));
}

export async function crearRubro({ datos }) {
  const rubro = await prisma.rubro.create({ data: { nombre: datos.nombre } });
  return serializarRubro(rubro);
}

export async function actualizarRubro({ id, datos }) {
  const rubro = await prisma.rubro.findUnique({ where: { id } });
  if (!rubro) throw errorNoEncontrado('Rubro no encontrado.');

  const actualizado = await prisma.rubro.update({
    where: { id: rubro.id },
    data: { nombre: datos.nombre },
  });

  return serializarRubro(actualizado);
}

async function validarPadre({ padreId, categoriaId }) {
  if (padreId === undefined || padreId === null) return;

  if (categoriaId !== undefined && padreId === categoriaId) {
    throw new ErrorApi(
      'categoria_padre_invalida',
      'Una categoria no puede ser su propio padre.',
      422,
    );
  }

  const padre = await prisma.categoriaGlobal.findUnique({
    where: { id: padreId },
  });
  if (!padre) {
    throw new ErrorApi(
      'categoria_padre_invalida',
      'La categoria padre no existe.',
      422,
    );
  }

  if (categoriaId === undefined) return;

  let actual = padre;
  const visitados = new Set();
  while (actual) {
    if (actual.id === categoriaId) {
      throw new ErrorApi(
        'categoria_padre_invalida',
        'La categoria padre no puede ser descendiente de la categoria.',
        422,
      );
    }
    if (visitados.has(actual.id)) break;
    visitados.add(actual.id);

    actual = actual.padreId
      ? await prisma.categoriaGlobal.findUnique({
          where: { id: actual.padreId },
        })
      : null;
  }
}

async function validarRubroDeCategoria({ rubroId }) {
  if (rubroId === undefined || rubroId === null) return;

  const rubro = await prisma.rubro.findUnique({ where: { id: rubroId } });
  if (!rubro) {
    throw new ErrorApi('rubro_no_encontrado', 'El rubro no existe.', 422);
  }
}

async function validarProductosCompatibles({ categoriaId, rubroId }) {
  if (rubroId === undefined || rubroId === null) return;

  const incompatibles = await prisma.producto.count({
    where: {
      categoriaGlobalId: categoriaId,
      local: { rubroId: { not: rubroId } },
    },
  });

  if (incompatibles > 0) {
    throw new ErrorApi(
      'categoria_con_productos_incompatibles',
      'No se puede asignar ese rubro: hay productos de locales de otro rubro usando la categoria.',
      422,
    );
  }
}

export async function crearCategoriaGlobal({ datos }) {
  await validarPadre({ padreId: datos.padre_id });
  await validarRubroDeCategoria({ rubroId: datos.rubro_id });

  const categoria = await prisma.categoriaGlobal.create({
    data: {
      nombre: datos.nombre,
      padreId: datos.padre_id ?? null,
      rubroId: datos.rubro_id ?? null,
    },
  });

  return serializarCategoria(categoria);
}

export async function actualizarCategoriaGlobal({ id, datos }) {
  const categoria = await prisma.categoriaGlobal.findUnique({ where: { id } });
  if (!categoria) throw errorNoEncontrado('Categoria no encontrada.');

  await validarPadre({ padreId: datos.padre_id, categoriaId: id });
  await validarRubroDeCategoria({ rubroId: datos.rubro_id });

  if (datos.rubro_id !== undefined) {
    await validarProductosCompatibles({
      categoriaId: id,
      rubroId: datos.rubro_id,
    });
  }

  const actualizada = await prisma.categoriaGlobal.update({
    where: { id },
    data: {
      ...(datos.nombre !== undefined ? { nombre: datos.nombre } : {}),
      ...(datos.padre_id !== undefined ? { padreId: datos.padre_id } : {}),
      ...(datos.rubro_id !== undefined ? { rubroId: datos.rubro_id } : {}),
    },
  });

  return serializarCategoria(actualizada);
}
