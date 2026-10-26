import { Prisma } from '../../generated/prisma/index.js';
import { prisma } from '../lib/prisma.js';
import { withTransaccion } from '../lib/transaccion.js';
import { ErrorApi } from '../lib/errores.js';
import {
  CLAVES_CONFIGURACION,
  CLAVES_QUE_RECALCULAN_LOCALES,
  DEFINICIONES_CONFIGURACION,
  esCongelada,
  serializarValorConfiguracion,
  validarValorConfiguracion,
} from '../domain/configuracion.js';
import {
  cargarConfiguracion,
  interpretarValorConfiguracion,
  limpiarCacheConfiguracion,
} from './configuracion.js';
import { recalcularEstadoLocal } from './estadoLocal.js';

/**
 * CONFIGURACION DESDE EL PANEL ADMIN (Etapa 4f-2)
 * ===============================================
 * Solo se editan claves declaradas en `src/domain/configuracion.js`. El tipo y
 * el rango se validan dos veces: en Zod (borde HTTP) y aca (servicio).
 *
 * Un cambio de `limite_deuda` o `plazo_dias` recalcula TODOS los locales en la
 * misma transaccion, en orden de id para reducir el riesgo de deadlocks. Cada
 * clave modificada deja su propia fila de auditoria con actor, valor anterior,
 * valor nuevo y fecha.
 *
 * Las claves congeladas solo cambian el snapshot de pedidos futuros. No se
 * reescriben snapshots ni comisiones historicas.
 */

function ordenarConfiguracion(filas) {
  const porClave = new Map(filas.map((fila) => [fila.clave, fila]));

  return CLAVES_CONFIGURACION.filter((clave) => porClave.has(clave)).map(
    (clave) => {
      const fila = porClave.get(clave);
      const definicion = DEFINICIONES_CONFIGURACION[clave];
      return {
        clave,
        valor: interpretarValorConfiguracion(fila.valor, fila.tipo),
        tipo: fila.tipo,
        descripcion: fila.descripcion ?? definicion?.descripcion ?? null,
        congelada: esCongelada(clave),
        actualizado_en: fila.actualizadoEn,
      };
    },
  );
}

export async function listarConfiguracionAdmin() {
  const filas = await prisma.configuracion.findMany();
  return { datos: ordenarConfiguracion(filas) };
}

function validarCambios(valores) {
  if (!valores || typeof valores !== 'object' || Array.isArray(valores)) {
    throw new ErrorApi(
      'configuracion_invalida',
      'El campo valores debe ser un objeto de clave a valor.',
      400,
    );
  }

  const claves = Object.keys(valores);
  if (claves.length === 0) {
    throw new ErrorApi(
      'configuracion_invalida',
      'Envia al menos una clave de configuracion.',
      400,
    );
  }

  const errores = [];
  for (const clave of claves) {
    const problema = validarValorConfiguracion(clave, valores[clave]);
    if (problema) errores.push({ campo: `valores.${clave}`, problema });
  }

  if (errores.length > 0) {
    throw new ErrorApi(
      'configuracion_invalida',
      'Hay claves o valores de configuracion invalidos.',
      400,
      errores,
    );
  }

  return claves;
}

async function bloquearConfiguracion(tx, claves) {
  if (claves.length === 0) return [];

  return tx.$queryRaw(
    Prisma.sql`
      SELECT "clave"
        FROM "configuracion"
       WHERE "clave" IN (${Prisma.join(claves.map((clave) => Prisma.sql`${clave}`))})
       FOR UPDATE
    `,
  );
}

export async function actualizarConfiguracionAdmin({ admin, valores }) {
  const claves = validarCambios(valores);

  let respuesta;
  try {
    respuesta = await withTransaccion(async (tx) => {
      const bloqueadas = await bloquearConfiguracion(tx, claves);
      const existentes = new Set(bloqueadas.map((fila) => fila.clave));
      const faltantes = claves.filter((clave) => !existentes.has(clave));

      if (faltantes.length > 0) {
        throw new ErrorApi(
          'configuracion_incompleta',
          `Faltan claves de configuracion en la base: ${faltantes.join(', ')}.`,
          409,
        );
      }

      const filas = await tx.configuracion.findMany({
        where: { clave: { in: claves } },
        orderBy: { clave: 'asc' },
      });
      const porClave = new Map(filas.map((fila) => [fila.clave, fila]));
      const fecha = new Date();
      const cambios = [];

      for (const clave of claves) {
        const fila = porClave.get(clave);
        const definicion = DEFINICIONES_CONFIGURACION[clave];
        const valorAnterior = interpretarValorConfiguracion(
          fila.valor,
          fila.tipo,
        );
        const valorNuevo = valores[clave];

        if (fila.tipo !== definicion.tipo) {
          throw new ErrorApi(
            'configuracion_invalida',
            `La clave ${clave} esta guardada como ${fila.tipo}, pero debe ser ${definicion.tipo}.`,
            409,
          );
        }

        await tx.configuracion.update({
          where: { clave },
          data: { valor: serializarValorConfiguracion(valorNuevo) },
        });

        const congelada = esCongelada(clave);
        cambios.push({
          clave,
          valor_anterior: valorAnterior,
          valor_nuevo: valorNuevo,
          congelada,
          afecta_pedidos_nuevos: congelada,
          mensaje: congelada
            ? 'El valor nuevo se aplica solo a pedidos creados desde ahora; los pedidos existentes conservan su snapshot.'
            : 'El valor nuevo se lee en vivo en la proxima operacion que use esta clave.',
        });

        await tx.auditoriaAdmin.create({
          data: {
            origen: 'admin',
            adminId: admin.id,
            accion: 'actualizar_configuracion',
            objeto: 'configuracion',
            objetoId: clave,
            detalle: {
              actor_id: admin.id,
              fecha: fecha.toISOString(),
              valor_anterior: valorAnterior,
              valor_nuevo: valorNuevo,
              congelada,
            },
          },
        });
      }

      let localesRecalculados = 0;
      if (
        claves.some((clave) => CLAVES_QUE_RECALCULAN_LOCALES.includes(clave))
      ) {
        const locales = await tx.local.findMany({
          select: { id: true },
          orderBy: { id: 'asc' },
        });

        for (const local of locales) {
          await recalcularEstadoLocal(local.id, tx, { ahora: fecha });
        }
        localesRecalculados = locales.length;
      }

      const finales = await tx.configuracion.findMany();

      return {
        datos: ordenarConfiguracion(finales),
        cambios,
        locales_recalculados: localesRecalculados,
      };
    });
  } finally {
    // La cache del proceso HTTP se descarta incluso si la transaccion falla:
    // asi nunca queda un valor viejo servido despues de un cambio.
    limpiarCacheConfiguracion();
  }

  await cargarConfiguracion({ forzar: true });
  return respuesta;
}
