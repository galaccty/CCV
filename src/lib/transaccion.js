import { AsyncLocalStorage } from 'node:async_hooks';
import { prisma } from './prisma.js';

/**
 * GUARDIAN DEL INVARIANTE 4
 * ==========================
 * "Nunca se llama a la API de Wompi dentro de una transaccion de base de datos."
 *
 * No alcanza con acordarse. Este envoltorio marca, con AsyncLocalStorage,
 * que hay una transaccion abierta. Cualquier cliente externo (hoy Wompi,
 * manana el proveedor de correo o el de archivos) consulta esa marca al
 * ejecutarse y lanza un error si la encuentra.
 *
 * El contexto viaja con las promesas, asi que funciona aunque el codigo
 * haga awaits en medio. No es infalible si alguien se salta el envoltorio
 * con db.$transaction(...) directo: por eso el invariante 4 tiene tambien
 * una regla de lint que prohibe eso.
 */

/**
 * El contexto se exporta para que las pruebas puedan abrirlo directamente y
 * verificar el guardian sin depender de una base de datos conectada.
 */
export const contextoTransaccion = new AsyncLocalStorage();

/** Devuelve el cliente de transaccion si estamos dentro de una, si no null. */
export function transaccionActual() {
  return contextoTransaccion.getStore() ?? null;
}

export function hayTransaccionAbierta() {
  return transaccionActual() !== null;
}

/**
 * Lanza si hay una transaccion abierta. Lo llaman los clientes externos
 * al principio de cada metodo publico.
 */
export function exigirFueraDeTransaccion(nombreServicio) {
  if (hayTransaccionAbierta()) {
    throw new Error(
      `INVARIANTE 4: se intentó llamar a "${nombreServicio}" dentro de una ` +
        'transacción de base de datos. Las llamadas a servicios externos van DESPUÉS del commit.',
    );
  }
}

/**
 * Ejecuta `fn` dentro de una transaccion de base de datos.
 * El cliente que se pasa a `fn` (tx) es el unico que debe usarse dentro;
 * el `prisma` global no ve los cambios hasta que la transaccion confirme.
 */
export function withTransaccion(fn) {
  return prisma.$transaction(async (tx) => {
    return contextoTransaccion.run({ abierto: true }, () => fn(tx));
  });
}

/**
 * Para el camino B de la seccion 4.1.4 (fallo de stock):
 * primero se aborta la transaccion A y despues, en otra, se registra
 * el reembolso. Por eso existen estas dos funciones separadas en lugar de
 * una sola con reintentos.
 */
export function despuesDelCommit(tarea) {
  // process.nextTick corre despues de que la transaccion actual termina.
  // Si la transaccion falla, la tarea nunca se agenda.
  return process.nextTick(tarea);
}