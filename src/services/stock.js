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

import { aBigInt } from '../lib/dinero.js';

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

export class ErrorAjusteStockNegativo extends Error {
  constructor(varianteId, diferencia, stockActual) {
    super(
      `El ajuste de ${diferencia} dejaria el stock de la variante ${varianteId} ` +
        `en negativo (stock actual: ${stockActual}).`,
    );
    this.name = 'ErrorAjusteStockNegativo';
    this.varianteId = varianteId;
    this.diferencia = diferencia;
    this.stockActual = stockActual;
  }
}

export class ErrorVarianteNoEncontrada extends Error {
  constructor(varianteId) {
    super(`No existe la variante ${varianteId}.`);
    this.name = 'ErrorVarianteNoEncontrada';
    this.varianteId = varianteId;
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
  const precioBig = aBigInt(precio, 'precio');
  if (precioBig < 0n) {
    throw new Error(`Precio invalido: ${precio}`);
  }
  if (!Number.isInteger(stock) || stock < 0) {
    throw new Error(`Stock inicial invalido: ${stock}`);
  }

  return cliente.productoVariante.create({
    data: { productoId, atributos, precio: precioBig, stock, activo },
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

/**
 * Ajuste manual del vendedor, siempre por diferencia y por el modulo de stock.
 * El WHERE hace que el resultado nunca quede negativo, incluso con dos ajustes
 * simultaneos: si la fila no se actualiza, no se toca nada.
 */
export async function ajustarStock(tx, varianteId, diferencia) {
  validarVariante(varianteId);

  if (!Number.isInteger(diferencia)) {
    throw new Error(`Diferencia de stock invalida: ${diferencia}`);
  }
  if (diferencia === 0) {
    throw new Error('La diferencia de stock no puede ser cero.');
  }
  if (Math.abs(diferencia) > 1_000_000) {
    throw new Error('La diferencia de stock excede el limite permitido.');
  }

  const filas = await tx.$executeRaw`
    UPDATE "producto_variante"
       SET "stock" = "stock" + ${diferencia}
     WHERE "id" = ${varianteId}
       AND "stock" + ${diferencia} >= 0
  `;

  if (filas === 0) {
    const variante = await tx.productoVariante.findUnique({
      where: { id: varianteId },
      select: { stock: true },
    });

    if (!variante) throw new ErrorVarianteNoEncontrada(varianteId);
    throw new ErrorAjusteStockNegativo(varianteId, diferencia, variante.stock);
  }

  return filas;
}
