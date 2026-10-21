import { prisma } from '../lib/prisma.js';
import { ErrorApi } from '../lib/errores.js';

/**
 * IDEMPOTENCIA (invariante 10)
 * ============================
 * La clave la manda el cliente en `Idempotency-Key`. Se guarda por usuario y
 * por ruta, con vigencia de 24 horas.
 *
 * Estados:
 *   - en_proceso: alguien ya tomo la clave y todavia no termino. Se responde
 *     409 y el cliente espera.
 *   - completada: se guardo el codigo HTTP y el cuerpo. Un reintento devuelve
 *     EXACTAMENTE la misma respuesta, sin crear otro pedido ni otro pago.
 *
 * Si la operacion falla con 5xx, la ruta llama a `liberar` para que el
 * reintento pueda volver a intentar. Las respuestas de negocio (4xx) se
 * guardan como completadas: reintentar la misma clave devuelve el mismo error.
 */

const VIGENCIA_MS = 24 * 60 * 60 * 1000;

export async function reservar({ usuarioId, ruta, clave }) {
  const ahora = new Date();

  const existente = await prisma.idempotencia.findUnique({
    where: { usuarioId_ruta_clave: { usuarioId, ruta, clave } },
  });

  if (existente) {
    if (existente.expira <= ahora) {
      // La clave vieja ya no protege nada. Se borra y se vuelve a reservar.
      await prisma.idempotencia.delete({ where: { id: existente.id } });
    } else if (existente.estado === 'en_proceso') {
      throw new ErrorApi(
        'solicitud_en_proceso',
        'Ya hay una solicitud con esa clave en proceso. Espera a que termine.',
        409,
      );
    } else {
      return { repetida: true, fila: existente };
    }
  }

  try {
    const fila = await prisma.idempotencia.create({
      data: {
        clave,
        usuarioId,
        ruta,
        estado: 'en_proceso',
        expira: new Date(ahora.getTime() + VIGENCIA_MS),
      },
    });
    return { repetida: false, fila };
  } catch (err) {
    // Dos peticiones simultaneas con la misma clave: una gano la carrera.
    if (err?.code === 'P2002') {
      const otra = await prisma.idempotencia.findUnique({
        where: { usuarioId_ruta_clave: { usuarioId, ruta, clave } },
      });

      if (otra?.estado === 'completada') {
        return { repetida: true, fila: otra };
      }

      throw new ErrorApi(
        'solicitud_en_proceso',
        'Ya hay una solicitud con esa clave en proceso. Espera a que termine.',
        409,
      );
    }

    throw err;
  }
}

/** Marca la clave como completada dentro de la MISMA transaccion del negocio. */
export async function completarEnTx(tx, id, codigoHttp, respuestaJson) {
  if (!id) return;
  await tx.idempotencia.update({
    where: { id },
    data: { estado: 'completada', codigoHttp, respuestaJson },
  });
}

/**
 * Marca una reserva como completada fuera de la transaccion del negocio.
 * Se usa para guardar la respuesta de un error 4xx, de modo que reintentar con
 * la misma clave devuelva exactamente el mismo error. Solo toca filas que
 * sigan en_proceso para no sobrescribir una respuesta exitosa ya guardada.
 */
export async function completar(id, codigoHttp, respuestaJson) {
  if (!id) return;
  await prisma.idempotencia.updateMany({
    where: { id, estado: 'en_proceso' },
    data: { estado: 'completada', codigoHttp, respuestaJson },
  });
}

/** Borra la reserva para permitir reintentar despues de un 5xx. */
export async function liberar(id) {
  if (!id) return;
  await prisma.idempotencia
    .deleteMany({ where: { id, estado: 'en_proceso' } })
    .catch(() => {});
}
