/**
 * SEMILLA DE CONFIGURACION Y TAXONOMIA
 * ====================================
 * Carga la tabla `configuracion` con las once claves de la seccion 3 y los
 * rubros/categorias globales de arranque de la Etapa 3.
 *
 * OJO: los valores de configuracion son VALORES DE EJEMPLO. La especificacion
 * deja varios de ellos como decision pendiente (seccion 2). Cambialos cuando
 * tengas los numeros reales de Wompi y la respuesta del abogado y del contador.
 *
 * El script se puede volver a ejecutar las veces que quieras: usa upsert o
 * busquedas por nombre, asi que actualiza lo que exista y no duplica nada.
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
    'Subtotal minimo de productos por local (sin envio). Congelado en el pedido.'],
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
  ['dias_reembolso_efectivo', '5', 'entero',
    'Dias que el vendedor tiene para reembolsar en efectivo antes de incumplir. Se lee en vivo.'],
  ['intentos_maximos_reembolso', '5', 'entero',
    'Intentos antes de marcar un reembolso como fallido y alertar. Se lee en vivo.'],
  ['monto_minimo_liquidacion', '0', 'entero',
    'Monto minimo de una liquidacion; 0 permite lotes de cualquier tamano. Se lee en vivo.'],
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

/**
 * Taxonomia inicial de la Etapa 3. Son datos de arranque: el admin puede
 * editarlos despues desde /api/v1/admin/rubros y /api/v1/admin/categorias-globales.
 *
 * Las categorias de la lista son las raices y sus hijas. Los rubros que no
 * tienen categorias se pueden poblar mas adelante.
 */
export const TAXONOMIA_INICIAL = [
  {
    rubro: 'Ropa y accesorios',
    categoriaRaiz: 'Ropa',
    hijas: ['Camisetas', 'Buzos', 'Pantalones', 'Accesorios'],
  },
  {
    rubro: 'Tecnología',
    categoriaRaiz: 'Tecnología',
    hijas: ['Computadores', 'Celulares', 'Accesorios'],
  },
  {
    rubro: 'Comida y bebidas',
    categoriaRaiz: 'Comida',
    hijas: ['Postres', 'Bebidas', 'Comidas'],
  },
  {
    rubro: 'Perfumería y belleza',
    categoriaRaiz: 'Perfumería',
    hijas: ['Perfumes', 'Cuidado personal'],
  },
  { rubro: 'Calzado', categoriaRaiz: null, hijas: [] },
  { rubro: 'Hogar', categoriaRaiz: null, hijas: [] },
  { rubro: 'Arte y manualidades', categoriaRaiz: null, hijas: [] },
  { rubro: 'Mascotas', categoriaRaiz: null, hijas: [] },
];

export async function sembrarTaxonomia() {
  let rubrosCreados = 0;
  let categoriasCreadas = 0;

  for (const grupo of TAXONOMIA_INICIAL) {
    let rubro = await prisma.rubro.findUnique({
      where: { nombre: grupo.rubro },
    });

    if (!rubro) {
      rubro = await prisma.rubro.create({ data: { nombre: grupo.rubro } });
      rubrosCreados += 1;
    }

    if (!grupo.categoriaRaiz) continue;

    let raiz = await prisma.categoriaGlobal.findFirst({
      where: {
        nombre: grupo.categoriaRaiz,
        rubroId: rubro.id,
        padreId: null,
      },
    });

    if (!raiz) {
      raiz = await prisma.categoriaGlobal.create({
        data: {
          nombre: grupo.categoriaRaiz,
          rubroId: rubro.id,
        },
      });
      categoriasCreadas += 1;
    }

    for (const nombreHija of grupo.hijas) {
      const hija = await prisma.categoriaGlobal.findFirst({
        where: {
          nombre: nombreHija,
          rubroId: rubro.id,
          padreId: raiz.id,
        },
      });

      if (!hija) {
        await prisma.categoriaGlobal.create({
          data: {
            nombre: nombreHija,
            rubroId: rubro.id,
            padreId: raiz.id,
          },
        });
        categoriasCreadas += 1;
      }
    }
  }

  return {
    rubrosCreados,
    categoriasCreadas,
    totalRubros: await prisma.rubro.count(),
    totalCategorias: await prisma.categoriaGlobal.count(),
  };
}

// Si se ejecuta directo (npm run seed), siembra y cierra.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const filas = await sembrarConfiguracion();
    const taxonomia = await sembrarTaxonomia();
    logger.info(
      { total: filas.length, ...taxonomia },
      'configuracion y taxonomia sembradas',
    );
    console.log('\nConfiguracion cargada:\n');
    for (const f of filas) {
      console.log(`  ${f.clave.padEnd(26)} ${String(f.valor).padEnd(10)} ${f.tipo}`);
    }
    console.log('\nTaxonomia inicial:');
    console.log(
      `  rubros: ${taxonomia.totalRubros} (nuevos: ${taxonomia.rubrosCreados})`,
    );
    console.log(
      `  categorias: ${taxonomia.totalCategorias} (nuevas: ${taxonomia.categoriasCreadas})`,
    );
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