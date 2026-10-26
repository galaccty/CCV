import { prisma } from '../lib/prisma.js';
import { withTransaccion } from '../lib/transaccion.js';
import { ErrorApi, errorNoEncontrado } from '../lib/errores.js';
import { convertirBigIntAJson } from '../lib/dinero.js';
import { envolverLista } from '../lib/validacion.js';

/**
 * ALERTAS OPERATIVAS (Etapa 4f-2)
 * ==============================
 * Una alerta no mueve dinero. Es una cola de trabajo para el admin:
 * diferencias de conciliacion, totales inconsistentes, reembolsos manuales
 * pendientes y fallos de jobs.
 *
 * La `clave` es estable por causa. `abrirAlerta()` hace upsert por esa clave:
 * dos corridas del mismo job no duplican la alerta y, si el admin la habia
 * resuelto y la causa reaparece, la alerta se reabre conservando su historial
 * de creacion. Resolver exige una nota y deja auditoria.
 */

export function serializarAlerta(alerta) {
  return {
    id: alerta.id,
    clave: alerta.clave,
    tipo: alerta.tipo,
    severidad: alerta.severidad,
    estado: alerta.estado,
    titulo: alerta.titulo,
    detalle: alerta.detalle,
    local_id: alerta.localId,
    pedido_id: alerta.pedidoId,
    pago_id: alerta.pagoId,
    reembolso_id: alerta.reembolsoId,
    sub_pedido_id: alerta.subPedidoId,
    creada_en: alerta.creadaEn,
    actualizada_en: alerta.actualizadaEn,
    ultima_deteccion_en: alerta.ultimaDeteccionEn,
    resuelta_en: alerta.resueltaEn,
    resuelta_por: alerta.resueltaPor,
    nota_resolucion: alerta.notaResolucion,
  };
}

/**
 * Crea o reabre una alerta dentro de una transaccion existente.
 * Se usa desde webhooks y jobs para que la alerta sea atomica con la causa.
 */
export async function abrirAlertaEnTx(tx, datos) {
  const ahora = datos.ahora ?? new Date();
  const campos = {
    tipo: datos.tipo,
    severidad: datos.severidad ?? 'media',
    titulo: datos.titulo,
    detalle: datos.detalle ?? null,
    localId: datos.localId ?? null,
    pedidoId: datos.pedidoId ?? null,
    pagoId: datos.pagoId ?? null,
    reembolsoId: datos.reembolsoId ?? null,
    subPedidoId: datos.subPedidoId ?? null,
    ultimaDeteccionEn: ahora,
  };

  const existente = await tx.alerta.findUnique({
    where: { clave: datos.clave },
  });

  if (!existente) {
    return tx.alerta.create({
      data: {
        clave: datos.clave,
        ...campos,
      },
    });
  }

  return tx.alerta.update({
    where: { id: existente.id },
    data: {
      ...campos,
      estado: 'abierta',
      resueltaEn: null,
      resueltaPor: null,
      notaResolucion: null,
    },
  });
}

/** Variante autonoma para un job o una ruta que no esta en transaccion. */
export async function abrirAlerta(datos) {
  return withTransaccion((tx) => abrirAlertaEnTx(tx, datos));
}

export async function listarAlertasAdmin({
  estado,
  tipo,
  localId,
  pagina,
  porPagina,
}) {
  const where = {
    ...(estado ? { estado } : {}),
    ...(tipo ? { tipo } : {}),
    ...(localId ? { localId } : {}),
  };

  const [total, filas] = await Promise.all([
    prisma.alerta.count({ where }),
    prisma.alerta.findMany({
      where,
      orderBy: [{ estado: 'asc' }, { creadaEn: 'desc' }, { id: 'desc' }],
      skip: (pagina - 1) * porPagina,
      take: porPagina,
    }),
  ]);

  return convertirBigIntAJson(
    envolverLista(filas.map(serializarAlerta), { pagina, porPagina }, total),
  );
}

export async function resolverAlerta({ admin, id, nota }) {
  if (typeof nota !== 'string' || nota.trim().length < 3) {
    throw new ErrorApi(
      'nota_obligatoria',
      'La nota de resolucion debe tener al menos 3 caracteres.',
      400,
    );
  }

  return withTransaccion(async (tx) => {
    const filas = await tx.$queryRaw`
      SELECT "id"
        FROM "alerta"
       WHERE "id" = ${id}
       FOR UPDATE
    `;

    if (filas.length === 0) {
      throw errorNoEncontrado('Alerta no encontrada.');
    }

    const alerta = await tx.alerta.findUnique({ where: { id } });
    if (!alerta) throw errorNoEncontrado('Alerta no encontrada.');

    if (alerta.estado !== 'abierta') {
      throw new ErrorApi(
        'alerta_ya_resuelta',
        'La alerta ya fue resuelta.',
        409,
      );
    }

    const resuelta = await tx.alerta.update({
      where: { id },
      data: {
        estado: 'resuelta',
        resueltaEn: new Date(),
        resueltaPor: admin.id,
        notaResolucion: nota.trim(),
      },
    });

    await tx.auditoriaAdmin.create({
      data: {
        origen: 'admin',
        adminId: admin.id,
        accion: 'resolver_alerta',
        objeto: 'alerta',
        objetoId: String(id),
        detalle: {
          tipo: alerta.tipo,
          clave: alerta.clave,
          nota: nota.trim(),
        },
      },
    });

    return convertirBigIntAJson(serializarAlerta(resuelta));
  });
}
