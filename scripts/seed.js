/**
 * SEMILLA DE CONFIGURACION
 * ========================
 * Carga la tabla `configuracion` con las once claves de la seccion 3.
 *
 * OJO: estos son VALORES DE EJEMPLO. La especificacion deja varios de ellos
 * como decision pendiente (seccion 2). Cambialos cuando tengas los numeros
 * reales de Wompi y la respuesta del abogado y del contador.
 *
 * El script se puede volver a ejecutar las veces que quieras: usa upsert,
 * asi que actualiza lo que exista y no duplica nada.
 *
 *   npm run seed
 */

import { pathToFileURL } from 'node:url';
import { prisma } from '../src/lib/prisma.js';
import { logger } from '../src/lib/logger.js';

export const CONFIGURACION_INICIAL = [
  // clave, valor, tipo, descripcion
  ['porcentaje_comision', '5', 'numero',
    'Comision de la plataforma sobre el valor de los productos. Nunca sobre el envio. Congelada en el pedido.'],
  ['comision_minima', '2000', 'entero',
    'Comision minima por sub_pedido, para que los pedidos muy chicos no dejen margen negativo. Congelada en el pedido.'],
  ['pedido_minimo', '30000', 'entero',
    'Valor minimo del pedido (productos + envio). Congelado en el pedido.'],
  ['tarifa_base_envio', '2000', 'entero',
    'Base del costo de envio por sub_pedido. Congelada en el pedido.'],
  ['tarifa_por_km', '800', 'entero',
    'Costo por kilometro de distancia en linea recta (Haversine). Congelada en el pedido.'],
  ['dias_retencion', '5', 'entero',
    'Dias que el saldo del vendedor queda retenido despues de entregar, para cubrir disputas. Minimo duro de 3. Congelado en el pedido.'],

  ['limite_deuda', '50000', 'entero',
    'Saldo de deuda maximo antes de que un local pase a en_plazo. Se lee en vivo.'],
  ['plazo_dias', '15', 'entero',
    'Dias que tiene un local en_plazo para saldar su deuda. Se lee en vivo.'],
  ['dias_auto_entrega', '7', 'entero',
    'Dias en enviado sin confirmacion del comprador antes de marcar entregado por el sistema. Se lee en vivo.'],
  ['minutos_expiracion_pago', '30', 'entero',
    'Minutos que un pedido digital espera su pago antes de expirar. Se lee en vivo.'],
  ['horas_aceptacion', '48', 'entero',
    'Horas que un vendedor tiene para aceptar un pedido en efectivo antes de que se cancele. Se lee en vivo.'],
];

export async function sembrarConfiguracion({ registrarAuditoria = false } = {}) {
  const resultados = [];

  for (const [clave, valor, tipo, descripcion] of CONFIGURACION_INICIAL) {
    const existente = await prisma.configuracion.findUnique({ where: { clave } });

    const fila = await prisma.configuracion.upsert({
      where: { clave },
      create: { clave, valor, tipo, descripcion },
      update: { tipo, descripcion }, // no se pisa el valor si ya fue cambiado a mano
    });

    resultados.push({
      clave,
      valor: fila.valor,
      tipo: fila.tipo,
      cambio: existente?.valor !== fila.valor,
    });

    if (registrarAuditoria) {
      await prisma.auditoriaAdmin.create({
        data: {
          origen: 'sistema',
          accion: 'configuracion_sembrada',
          objeto: 'configuracion',
          objetoId: clave,
          detalle: { valor: fila.valor, tipo: fila.tipo },
        },
      });
    }
  }

  return resultados;
}

// Si se ejecuta directo (npm run seed), siembra y cierra.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const filas = await sembrarConfiguracion();
    logger.info({ total: filas.length }, 'configuracion sembrada');
    console.log('\nConfiguracion cargada:\n');
    for (const f of filas) {
      console.log(`  ${f.clave.padEnd(26)} ${String(f.valor).padEnd(10)} ${f.tipo}`);
    }
    console.log('\nRevisa .env.example: estos son valores de ejemplo.\n');
    await prisma.$disconnect();
  } catch (err) {
    console.error('\nNo se pudo sembrar la configuracion.');
    console.error('Revisa que DATABASE_URL sea correcta y que las migraciones esten aplicadas.');
    console.error(err.message);
    await prisma.$disconnect();
    process.exit(1);
  }
}