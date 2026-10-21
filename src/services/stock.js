/**
 * MODULO DE STOCK
 * ===============
 * Unico lugar autorizado a escribir `producto_variante.stock`.
 *
 * Invariante 7: el descuento es atomico. No se hace "leer stock, restar en
 * JavaScript, guardar", porque dos compradores simultaneos leerian el mismo
 * valor y venderian dos veces la misma unidad. Se hace con un solo UPDATE:
 *
 *   UPDATE producto_variante
 *      SET stock = stock - n
 *    WHERE id = ? AND stock >= n AND activo = true
 *
 * Si la fila no se actualiza, no habia stock suficiente (o la variante esta
 * inactiva) y la transaccion entera se revierte.
 *
 * La devolucion (`devolverStock`) se usa solo al cancelar un pedido que ya
 * habia descontado stock. No se usa para "arreglar" inventarios a mano.
 */

export class ErrorStockInsuficiente extends Error {
  constructor(varianteId, cantidad) {
    super(
      `No hay stock suficiente para la variante ${varianteId} (se pidieron ${cantidad}).`,
    );
    this.name = 'ErrorStockInsuficiente';
    this.varianteId = varianteId;
    this.cantidad = cantidad;
  }
}

function validarCantidad(cantidad) {
  if (!Number.isInteger(cantidad) || cantidad <= 0) {
    throw new Error(`Cantidad de stock invalida: ${cantidad}`);
  }
}

function validarVariante(varianteId) {
  if (!Number.isInteger(varianteId) || varianteId <= 0) {
    throw new Error(`Variante invalida: ${varianteId}`);
  }
}

/**
 * Crea una variante con su stock inicial.
 *
 * Existe para que ni las pruebas ni la carga de datos escriban
 * `productoVariante.create` por fuera de este modulo. El stock inicial es un
 * dato de creacion, no un ajuste posterior.
 */
export async function crearVariante(
  cliente,
  { productoId, atributos = null, precio, stock = 0, activo = true },
) {
  if (!Number.isInteger(productoId) || productoId <= 0) {
    throw new Error(`Producto invalido: ${productoId}`);
  }
  if (!Number.isInteger(precio) || precio < 0) {
    throw new Error(`Precio invalido: ${precio}`);
  }
  if (!Number.isInteger(stock) || stock < 0) {
    throw new Error(`Stock inicial invalido: ${stock}`);
  }

  return cliente.productoVariante.create({
    data: { productoId, atributos, precio, stock, activo },
  });
}

/**
 * Descuenta stock de forma atomica.
 * @param {object} tx Cliente de Prisma o cliente de transaccion.
 * @returns {number} filas actualizadas (siempre 1; si no, lanza).
 */
export async function descontarStock(tx, varianteId, cantidad) {
  validarVariante(varianteId);
  validarCantidad(cantidad);

  const filas = await tx.$executeRaw`
    UPDATE "producto_variante"
       SET "stock" = "stock" - ${cantidad}
     WHERE "id" = ${varianteId}
       AND "stock" >= ${cantidad}
       AND "activo" = true
  `;

  if (filas === 0) {
    throw new ErrorStockInsuficiente(varianteId, cantidad);
  }

  return filas;
}

/**
 * Devuelve stock al cancelar un pedido que ya lo habia descontado.
 * No valida un maximo: el stock puede volver a su valor original.
 */
export async function devolverStock(tx, varianteId, cantidad) {
  validarVariante(varianteId);
  validarCantidad(cantidad);

  const filas = await tx.$executeRaw`
    UPDATE "producto_variante"
       SET "stock" = "stock" + ${cantidad}
     WHERE "id" = ${varianteId}
  `;

  if (filas === 0) {
    throw new Error(`No existe la variante ${varianteId}.`);
  }

  return filas;
}
