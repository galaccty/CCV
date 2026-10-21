import { prisma } from '../lib/prisma.js';
import { withTransaccion } from '../lib/transaccion.js';
import { errorNoEncontrado } from '../lib/errores.js';

/**
 * DIRECCIONES DEL COMPRADOR - Etapa 3b
 * =====================================
 * Las coordenadas las calcula el frontend. El backend no geocodifica: solo
 * valida el rango de Colombia en la capa de validacion y guarda el texto y las
 * coordenadas tal como llegaron.
 *
 * La primera direccion del usuario queda como principal. El indice unico
 * parcial de la base impide que existan dos principales al mismo tiempo.
 */

export function serializarDireccion(direccion) {
  return {
    id: direccion.id,
    usuario_id: direccion.usuarioId,
    texto: direccion.texto,
    latitud: direccion.latitud,
    longitud: direccion.longitud,
    principal: direccion.principal,
    creado_en: direccion.creadoEn,
    actualizado_en: direccion.actualizadoEn,
  };
}

export async function listarDirecciones({ usuario }) {
  const direcciones = await prisma.direccion.findMany({
    where: { usuarioId: usuario.id },
    orderBy: [{ principal: 'desc' }, { creadoEn: 'desc' }],
  });

  return { datos: direcciones.map(serializarDireccion) };
}

export async function crearDireccion({ usuario, datos }) {
  return withTransaccion(async (tx) => {
    const existentes = await tx.direccion.count({
      where: { usuarioId: usuario.id },
    });

    const direccion = await tx.direccion.create({
      data: {
        usuarioId: usuario.id,
        texto: datos.texto,
        latitud: datos.latitud,
        longitud: datos.longitud,
        principal: existentes === 0,
      },
    });

    return serializarDireccion(direccion);
  });
}

async function direccionPropia(tx, { usuario, id }) {
  const direccion = await tx.direccion.findFirst({
    where: { id, usuarioId: usuario.id },
  });

  if (!direccion) throw errorNoEncontrado('Direccion no encontrada.');
  return direccion;
}

export async function actualizarDireccion({ usuario, id, datos }) {
  return withTransaccion(async (tx) => {
    await direccionPropia(tx, { usuario, id });

    const direccion = await tx.direccion.update({
      where: { id },
      data: datos,
    });

    return serializarDireccion(direccion);
  });
}

export async function eliminarDireccion({ usuario, id }) {
  return withTransaccion(async (tx) => {
    await direccionPropia(tx, { usuario, id });
    await tx.direccion.delete({ where: { id } });
  });
}

export async function marcarDireccionPrincipal({ usuario, id }) {
  return withTransaccion(async (tx) => {
    const direccion = await direccionPropia(tx, { usuario, id });
    if (direccion.principal) return serializarDireccion(direccion);

    await tx.direccion.updateMany({
      where: { usuarioId: usuario.id, principal: true },
      data: { principal: false },
    });

    const actualizada = await tx.direccion.update({
      where: { id },
      data: { principal: true },
    });

    return serializarDireccion(actualizada);
  });
}
