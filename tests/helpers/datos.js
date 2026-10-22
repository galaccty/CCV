/**
 * ARMADOR DE DATOS PARA LAS PRUEBAS
 * =================================
 * Crea las filas minimas para probar pedidos, snapshots y protecciones.
 *
 * No usa las rutas HTTP a proposito: estas pruebas son de la base y de los
 * triggers, no del contrato. Las pruebas de API viven aparte y usan el
 * cliente HTTP.
 *
 * La variante se crea con `crearVariante` del modulo de stock, nunca con
 * `productoVariante.create` directo: el guardian del invariante 7 revisa que
 * no haya escrituras de stock por fuera.
 */

import { prisma } from './base.js';
import { crearVariante } from '../../src/services/stock.js';
import { aBigInt, multiplicar, sumar } from '../../src/lib/dinero.js';
import { limpiarCacheConfiguracion } from '../../src/services/configuracion.js';

let contador = 0;

function sufijo() {
  contador += 1;
  return `${process.pid}-${Date.now()}-${contador}`;
}

export async function crearUsuarioDirecto({ nombre = 'Usuario de prueba', roles = ['comprador'] } = {}) {
  return prisma.usuario.create({
    data: {
      nombre,
      email: `prueba.${sufijo()}@ejemplo.com`,
      // No se usa para iniciar sesion en estas pruebas; solo cumple el NOT NULL.
      passwordHash: 'hash-de-prueba-no-utilizable',
      aceptoTerminos: true,
      fechaAceptacion: new Date(),
      emailVerificado: true,
      roles: { create: roles.map((rol) => ({ rol })) },
    },
  });
}

/**
 * Crea vendedor, rubro, local activo, categoria, producto y variante.
 * Devuelve todo para que cada prueba use lo que necesite.
 */
export async function crearCatalogo(opciones = {}) {
  const vendedor = await crearUsuarioDirecto({
    nombre: 'Vendedor',
    roles: ['vendedor'],
  });
  const catalogo = await crearCatalogoParaVendedor({
    vendedorId: vendedor.id,
    ...opciones,
  });
  return { vendedor, ...catalogo };
}

/**
 * Crea el catalogo (rubro, local, categoria, producto y variante) para un
 * vendedor que ya existe. Se usa cuando el vendedor se registro por HTTP y
 * necesitamos su mismo id para probar las rutas autenticadas.
 */
export async function crearCatalogoParaVendedor({
  vendedorId,
  precio = 10000n,
  stockInicial = 10,
  estadoLocal = 'activo',
  activoVariante = true,
  fotos = null,
  atributosVariante = { talla: 'M' },
} = {}) {
  if (!Number.isInteger(vendedorId) || vendedorId <= 0) {
    throw new Error(`Vendedor invalido: ${vendedorId}`);
  }

  const rubro = await prisma.rubro.create({
    data: { nombre: `rubro-${sufijo()}` },
  });
  const local = await prisma.local.create({
    data: {
      usuarioId: vendedorId,
      rubroId: rubro.id,
      nombre: `Local ${sufijo()}`,
      latitud: 4.65,
      longitud: -74.05,
      estado: estadoLocal,
    },
  });
  const categoria = await prisma.categoriaGlobal.create({
    data: { nombre: `categoria-${sufijo()}`, rubroId: rubro.id },
  });
  const producto = await prisma.producto.create({
    data: {
      localId: local.id,
      categoriaGlobalId: categoria.id,
      nombre: `Producto ${sufijo()}`,
      fotos,
      activo: true,
    },
  });
  const variante = await crearVariante(prisma, {
    productoId: producto.id,
    atributos: atributosVariante,
    precio,
    stock: stockInicial,
    activo: activoVariante,
  });

  return { rubro, local, categoria, producto, variante };
}

/**
 * Configuracion base de las pruebas. Los valores son los del ejemplo de la
 * especificacion; cada prueba puede sobrescribir los que necesite.
 */
const CONFIGURACION_BASE = [
  ['porcentaje_comision', '5', 'numero'],
  ['comision_minima', '2000', 'entero'],
  ['pedido_minimo', '30000', 'entero'],
  ['tarifa_base_envio', '2000', 'entero'],
  ['tarifa_por_km', '800', 'entero'],
  ['dias_retencion', '5', 'entero'],
  ['limite_deuda', '50000', 'entero'],
  ['plazo_dias', '15', 'entero'],
  ['dias_auto_entrega', '7', 'entero'],
  ['minutos_expiracion_pago', '30', 'entero'],
  ['horas_aceptacion', '48', 'entero'],
  ['dias_reembolso_efectivo', '5', 'entero'],
  ['intentos_maximos_reembolso', '5', 'entero'],
  ['monto_minimo_liquidacion', '0', 'entero'],
];

export async function sembrarConfiguracion(sobrescrituras = {}) {
  for (const [clave, valor, tipo] of CONFIGURACION_BASE) {
    const efectivo = sobrescrituras[clave] ?? valor;
    await prisma.configuracion.upsert({
      where: { clave },
      create: { clave, valor: String(efectivo), tipo },
      update: { valor: String(efectivo), tipo },
    });
  }
  limpiarCacheConfiguracion();
}

/**
 * Crea un pedido con un sub_pedido y una linea, respetando
 * pedido.total = suma(sub_pedido.total). Los triggers diferidos lo verifican
 * al COMMIT.
 */
export async function crearPedidoDePrueba({
  local,
  variante,
  compradorId,
  cantidad = 1,
  precioUnitario,
  comision = 0n,
  costoEnvio = 0n,
  metodoPago = 'tarjeta',
  estadoPedido = 'pendiente_pago',
  estadoSubPedido = 'por_aceptar',
} = {}) {
  const comprador = compradorId
    ? { id: compradorId }
    : await crearUsuarioDirecto({ nombre: 'Comprador', roles: ['comprador'] });

  if (!Number.isInteger(cantidad) || cantidad <= 0) {
    throw new Error(`Cantidad invalida: ${cantidad}`);
  }

  const precio = aBigInt(precioUnitario ?? variante.precio, 'precioUnitario');
  const subtotal = multiplicar(precio, BigInt(cantidad));
  const envio = aBigInt(costoEnvio, 'costoEnvio');
  const comisionBig = aBigInt(comision, 'comision');
  const total = sumar(subtotal, envio);

  return prisma.$transaction(async (tx) => {
    const pedido = await tx.pedido.create({
      data: {
        usuarioId: comprador.id,
        direccionTexto: 'Calle 1 # 2-3, Bogota',
        direccionLatitud: 4.65,
        direccionLongitud: -74.05,
        total,
        metodoPago,
        estado: estadoPedido,
        configSnapshot: {
          porcentaje_comision: 5,
          comision_minima: 2000,
          pedido_minimo: 30000,
          tarifa_base_envio: 2000,
          tarifa_por_km: 800,
          dias_retencion: 5,
          tomado_en: new Date().toISOString(),
        },
      },
    });

    const subPedido = await tx.subPedido.create({
      data: {
        pedidoId: pedido.id,
        localId: local.id,
        nombreLocal: local.nombre,
        subtotalProductos: subtotal,
        costoEnvio: envio,
        comision: comisionBig,
        total,
        estado: estadoSubPedido,
      },
    });

    const detalle = await tx.detalleProducto.create({
      data: {
        subPedidoId: subPedido.id,
        varianteId: variante.id,
        nombreProducto: `Producto congelado ${variante.id}`,
        atributosElegidos: { talla: 'M' },
        cantidad,
        precioUnitario: precio,
      },
    });

    return { comprador, pedido, subPedido, detalle };
  });
}

/**
 * Crea un pedido con varias lineas desde el inicio. Los snapshots de
 * `sub_pedido` y `pedido` son inmutables, asi que no se puede agregar una
 * segunda linea despues de crear el pedido.
 */
export async function crearPedidoConLineas({
  local,
  lineas,
  compradorId,
  comision = 0n,
  costoEnvio = 0n,
  metodoPago = 'tarjeta',
  estadoPedido = 'pendiente_pago',
  estadoSubPedido = 'por_aceptar',
  configSnapshot = null,
} = {}) {
  if (!Array.isArray(lineas) || lineas.length === 0) {
    throw new Error('El pedido necesita al menos una linea.');
  }

  const comprador = compradorId
    ? { id: compradorId }
    : await crearUsuarioDirecto({ nombre: 'Comprador', roles: ['comprador'] });

  const normalizadas = lineas.map((linea) => {
    if (!linea?.variante?.id) {
      throw new Error('Cada linea necesita una variante.');
    }
    if (!Number.isInteger(linea.cantidad) || linea.cantidad <= 0) {
      throw new Error(`Cantidad invalida: ${linea.cantidad}`);
    }
    const precio = aBigInt(
      linea.precioUnitario ?? linea.variante.precio,
      'precioUnitario',
    );
    return {
      ...linea,
      precio,
      monto: multiplicar(precio, BigInt(linea.cantidad)),
    };
  });

  const subtotal = normalizadas.reduce((total, linea) => total + linea.monto, 0n);
  const envio = aBigInt(costoEnvio, 'costoEnvio');
  const comisionBig = aBigInt(comision, 'comision');
  const total = sumar(subtotal, envio);
  const snapshot = configSnapshot ?? {
    porcentaje_comision: 5,
    comision_minima: 2000,
    pedido_minimo: 30000,
    tarifa_base_envio: 2000,
    tarifa_por_km: 800,
    dias_retencion: 5,
    tomado_en: new Date().toISOString(),
  };

  return prisma.$transaction(async (tx) => {
    const pedido = await tx.pedido.create({
      data: {
        usuarioId: comprador.id,
        direccionTexto: 'Calle 1 # 2-3, Bogota',
        direccionLatitud: 4.65,
        direccionLongitud: -74.05,
        total,
        metodoPago,
        estado: estadoPedido,
        configSnapshot: snapshot,
      },
    });

    const subPedido = await tx.subPedido.create({
      data: {
        pedidoId: pedido.id,
        localId: local.id,
        nombreLocal: local.nombre,
        subtotalProductos: subtotal,
        costoEnvio: envio,
        comision: comisionBig,
        total,
        estado: estadoSubPedido,
      },
    });

    const detalles = [];
    for (const linea of normalizadas) {
      detalles.push(
        await tx.detalleProducto.create({
          data: {
            subPedidoId: subPedido.id,
            varianteId: linea.variante.id,
            nombreProducto: `Producto congelado ${linea.variante.id}`,
            atributosElegidos: { talla: 'M', linea: detalles.length + 1 },
            cantidad: linea.cantidad,
            precioUnitario: linea.precio,
          },
        }),
      );
    }

    return { comprador, pedido, subPedido, detalles };
  });
}

export async function crearPagoDePrueba({
  pedido,
  monto = pedido.total,
  metodoPago = 'tarjeta',
  estado = 'pendiente',
} = {}) {
  return prisma.pago.create({
    data: {
      tipoPago: 'pedido',
      pedidoId: pedido.id,
      referencia: `PRUEBA-${sufijo()}`,
      metodoPago,
      monto: aBigInt(monto, 'monto'),
      estado,
    },
  });
}

export async function crearReembolsoDePrueba({
  pago,
  subPedido,
  monto = pago.monto,
  estado = 'pendiente',
  tipo = 'digital',
} = {}) {
  const montoBig = aBigInt(monto, 'monto');

  return prisma.$transaction(async (tx) => {
    const reembolso = await tx.reembolso.create({
      data: {
        pagoId: pago.id,
        subPedidoId: subPedido.id,
        tipo,
        monto: montoBig,
        estado,
        motivo: 'prueba',
        completadoEn: estado === 'completado' ? new Date() : null,
      },
    });

    // Los triggers diferidos exigen que las lineas expliquen el monto. Las
    // pruebas usan montos arbitrarios, asi que se asigna la cantidad minima
    // que cabria en el precio congelado sin pasar la cantidad original.
    const detalle = await tx.detalleProducto.findFirst({
      where: { subPedidoId: subPedido.id },
      orderBy: { id: 'asc' },
    });

    if (detalle) {
      const cantidadNecesaria =
        detalle.precioUnitario > 0n
          ? Number(
              (montoBig + detalle.precioUnitario - 1n) /
                detalle.precioUnitario,
            )
          : 1;
      const cantidad = Math.min(
        detalle.cantidad,
        Math.max(1, cantidadNecesaria),
      );

      await tx.reembolsoLinea.create({
        data: {
          reembolsoId: reembolso.id,
          detalleId: detalle.id,
          cantidad,
          monto: montoBig,
        },
      });
    }

    return reembolso;
  });
}

/** Movimiento de ledger crudo, solo para probar su inmutabilidad. */
export async function crearMovimientoDePrueba({ localId = null, monto = 1000n } = {}) {
  return prisma.ledger.create({
    data: { localId, tipo: 'ajuste', monto: aBigInt(monto, 'monto') },
  });
}
