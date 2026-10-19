/**
 * Registro de tareas programadas (jobs).
 *
 * La especificacion lista nueve jobs (liberacion de saldo, bloqueo por deuda,
 * notificaciones, conciliacion, verificacion de integridad, reconstruccion de
 * promedios, retiro de anuncios vencidos, cancelacion de pedidos en efectivo
 * sin aceptar y expiracion de pedidos digitales).
 *
 * En la Etapa 1 todavia no aplica ninguno: las tablas que necesitan
 * (pago, sub_pedido, producto_variante) llegan en la Etapa 2 y la 3.
 *
 * NOTA OPERATIVA (seccion 7): las capas gratuitas de Railway y Render duermen
 * las instancias, asi que un cron no se puede confiar ahi. Hay que decidir
 * antes de la Etapa 4 entre una instancia siempre activa de pago o un
 * programador externo. Ver README.
 */

export const JOBS = {
  liberacion_saldo: { etapa: 4, activa: false, ejecutar: null },
  bloqueo_deuda: { etapa: 4, activa: false, ejecutar: null },
  notificaciones_por_lotes: { etapa: 5, activa: false, ejecutar: null },
  conciliacion_nocturna: { etapa: 4, activa: false, ejecutar: null },
  verificacion_integridad: { etapa: 4, activa: false, ejecutar: null },
  reconstruir_promedios: { etapa: 5, activa: false, ejecutar: null },
  retirar_anuncios_vencidos: { etapa: 6, activa: false, ejecutar: null },
  cancelar_efectivo_sin_aceptar: { etapa: 4, activa: false, ejecutar: null },
  expirar_pedidos_digitales: { etapa: 3, activa: false, ejecutar: null },
};

export function jobsPendientes() {
  return Object.entries(JOBS)
    .filter(([, j]) => !j.activa)
    .map(([nombre, j]) => ({ nombre, etapa: j.etapa }));
}

export async function ejecutarJobsActivos() {
  const ejecutados = [];
  for (const [nombre, job] of Object.entries(JOBS)) {
    if (!job.activa || typeof job.ejecutar !== 'function') continue;
    await job.ejecutar();
    ejecutados.push(nombre);
  }
  return ejecutados;
}