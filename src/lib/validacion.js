import { z } from 'zod';

export const POR_PAGINA_POR_DEFECTO = 20;
export const POR_PAGINA_MAXIMO = 100;

/**
 * Lee los parametros de paginacion de la query.
 * Toda lista devuelve { datos, paginacion: { pagina, por_pagina, total, paginas } }
 */
export function leerPaginacion(query = {}) {
  const pagina = Math.max(1, Number.parseInt(query.pagina ?? '1', 10) || 1);
  const pedidoPorPagina = Number.parseInt(
    query.por_pagina ?? String(POR_PAGINA_POR_DEFECTO),
    10,
  );
  const porPagina = Math.min(
    POR_PAGINA_MAXIMO,
    Math.max(1, Number.isNaN(pedidoPorPagina) ? POR_PAGINA_POR_DEFECTO : pedidoPorPagina),
  );
  const saltar = (pagina - 1) * porPagina;
  return { pagina, porPagina, saltar };
}

/** Envuelve una lista en la forma de respuesta de la seccion 6. */
export function envolverLista(datos, { pagina, porPagina }, total) {
  return {
    datos,
    paginacion: {
      pagina,
      por_pagina: porPagina,
      total,
      paginas: porPagina > 0 ? Math.ceil(total / porPagina) : 0,
    },
  };
}

/**
 * Convierte de snake_case (base de datos) a snake_case (JSON).
 * El backend y el frontend hablan el mismo idioma, asi que aqui no hay nada
 * que convertir: la funcion existe para dejar el criterio explicito y para
 * que las respuestas de las rutas nuevas no inventen camelCase.
 */
export function aJson(fila) {
  return fila;
}

// ---------------------------------------------------------------------------
// Esquemas de validacion de la Etapa 1
// ---------------------------------------------------------------------------

export const esquemaRegistro = z.object({
  nombre: z.string().trim().min(2, 'El nombre es obligatorio.').max(120),
  email: z.string().trim().toLowerCase().email('El correo no es valido.'),
  contrasena: z.string().min(1, 'La contrasena es obligatoria.'),
  roles: z.array(z.enum(['comprador', 'vendedor'])).min(1).optional(),
  acepto_terminos: z.literal(true, {
    errorMap: () => ({ message: 'Debes aceptar los terminos y condiciones.' }),
  }),
});

export const esquemaLogin = z.object({
  email: z.string().trim().toLowerCase().email('El correo no es valido.'),
  contrasena: z.string().min(1, 'La contrasena es obligatoria.'),
});

export const esquemaSolicitarReset = z.object({
  email: z.string().trim().toLowerCase().email('El correo no es valido.'),
});

export const esquemaRestablecer = z.object({
  token: z.string().min(10, 'El token es obligatorio.'),
  contrasena: z.string().min(1, 'La contrasena es obligatoria.'),
});

export const esquemaVerificarEmail = z.object({
  token: z.string().min(10, 'El token es obligatorio.'),
});

export const esquemaReenviarVerificacion = z.object({
  email: z.string().trim().toLowerCase().email('El correo no es valido.'),
});

const esquemaTelefono = z
  .string()
  .trim()
  .regex(
    /^\+?[0-9]{7,15}$/,
    'El telefono debe tener entre 7 y 15 digitos, con + opcional al inicio.',
  );

export const esquemaActualizarPerfil = z
  .object({
    nombre: z.string().trim().min(2, 'El nombre es obligatorio.').max(120).optional(),
    telefono: esquemaTelefono.nullable().optional(),
  })
  .refine((datos) => Object.keys(datos).length > 0, {
    message: 'Envia al menos un campo para actualizar.',
  });

export const esquemaCambiarContrasena = z.object({
  contrasena_actual: z.string().min(1, 'La contrasena actual es obligatoria.'),
  contrasena_nueva: z.string().min(1, 'La contrasena nueva es obligatoria.'),
});

// ---------------------------------------------------------------------------
// Esquemas de validacion de la Etapa 2
// ---------------------------------------------------------------------------

export const ESTADOS_SUB_PEDIDO = [
  'por_aceptar',
  'preparando',
  'enviado',
  'entregado',
  'en_disputa',
  'cancelado',
  'reembolsado',
  'reembolsado_parcial',
];

export const esquemaIdPositivo = z.coerce.number().int().positive();

/**
 * Las coordenadas llegan del frontend: el backend no geocodifica. Se valida
 * un rectangulo aproximado de Colombia (incluye San Andres y Providencia).
 */
export const LIMITES_COLOMBIA = Object.freeze({
  latitudMin: -5,
  latitudMax: 14,
  longitudMin: -83,
  longitudMax: -66,
});

export const esquemaDireccionEntrega = z.object({
  texto: z.string().trim().min(5, 'La direccion es obligatoria.').max(500),
  latitud: z.coerce
    .number()
    .min(LIMITES_COLOMBIA.latitudMin, 'La latitud esta fuera de Colombia.')
    .max(LIMITES_COLOMBIA.latitudMax, 'La latitud esta fuera de Colombia.'),
  longitud: z.coerce
    .number()
    .min(LIMITES_COLOMBIA.longitudMin, 'La longitud esta fuera de Colombia.')
    .max(LIMITES_COLOMBIA.longitudMax, 'La longitud esta fuera de Colombia.'),
});

/**
 * El checkout solo acepta variante_id y cantidad. Cualquier monto que mande el
 * cliente (precio, subtotal, total, comision) se descarta: Zod solo deja las
 * claves declaradas.
 */
export const esquemaCheckout = z.object({
  direccion: esquemaDireccionEntrega,
  metodo_pago: z.enum(['tarjeta', 'pse', 'nequi', 'efectivo'], {
    errorMap: () => ({
      message: 'El metodo de pago debe ser tarjeta, pse, nequi o efectivo.',
    }),
  }),
  items: z
    .array(
      z.object({
        variante_id: z.coerce.number().int().positive(),
        cantidad: z.coerce.number().int().min(1).max(999),
      }),
    )
    .min(1, 'El pedido necesita al menos un producto.')
    .max(50, 'El pedido no puede tener mas de 50 lineas.'),
});

export const esquemaEnviarSubPedido = z.object({
  evidencia_envio: z
    .string()
    .trim()
    .min(1, 'La evidencia de envio es obligatoria.')
    .max(2000),
});

export const esquemaListaSubPedidos = z.object({
  estado: z.enum(ESTADOS_SUB_PEDIDO).optional(),
});

// ---------------------------------------------------------------------------
// Esquemas de validacion de la Etapa 3
// ---------------------------------------------------------------------------

const esquemaJsonObjeto = z.record(z.string(), z.unknown());

const esquemaUrlArchivo = z.string().trim().min(1).max(2000);

export const ESTADOS_LOCAL_ADMIN = ['activo', 'suspendido'];

export const esquemaCrearLocal = z.object({
  rubro_id: z.coerce.number().int().positive(),
  nombre: z.string().trim().min(2).max(160),
  logo_url: z.string().trim().min(1).max(2000).nullable().optional(),
  banner_fondo_url: z.string().trim().min(1).max(2000).nullable().optional(),
  latitud: z.coerce.number().min(-90).max(90),
  longitud: z.coerce.number().min(-180).max(180),
});

export const esquemaActualizarLocal = esquemaCrearLocal
  .partial()
  .refine((datos) => Object.keys(datos).length > 0, {
    message: 'Envia al menos un campo para actualizar.',
  });

export const esquemaCrearSubcategoria = z.object({
  nombre: z.string().trim().min(1).max(120),
});

export const esquemaActualizarSubcategoria = esquemaCrearSubcategoria;

export const esquemaCrearVariante = z.object({
  atributos: esquemaJsonObjeto.nullable().optional(),
  precio: z.coerce.number().int().positive(),
  stock: z.coerce.number().int().min(0).max(1_000_000).default(0),
  activo: z.boolean().optional().default(true),
});

export const esquemaActualizarVariante = z
  .object({
    atributos: esquemaJsonObjeto.nullable().optional(),
    precio: z.coerce.number().int().positive().optional(),
    activo: z.boolean().optional(),
  })
  .refine((datos) => Object.keys(datos).length > 0, {
    message: 'Envia al menos un campo para actualizar.',
  });

export const esquemaCrearProducto = z.object({
  local_id: z.coerce.number().int().positive(),
  categoria_global_id: z.coerce.number().int().positive(),
  subcategoria_local_id: z.coerce.number().int().positive().nullable().optional(),
  nombre: z.string().trim().min(1).max(200),
  descripcion: z.string().trim().max(5000).nullable().optional(),
  fotos: z.array(esquemaUrlArchivo).max(20).nullable().optional(),
  atributos: esquemaJsonObjeto.nullable().optional(),
  variantes: z.array(esquemaCrearVariante).min(1).max(50),
});

export const esquemaActualizarProducto = z
  .object({
    categoria_global_id: z.coerce.number().int().positive().optional(),
    subcategoria_local_id: z.coerce.number().int().positive().nullable().optional(),
    nombre: z.string().trim().min(1).max(200).optional(),
    descripcion: z.string().trim().max(5000).nullable().optional(),
    fotos: z.array(esquemaUrlArchivo).max(20).nullable().optional(),
    atributos: esquemaJsonObjeto.nullable().optional(),
    activo: z.boolean().optional(),
  })
  .refine((datos) => Object.keys(datos).length > 0, {
    message: 'Envia al menos un campo para actualizar.',
  });

export const esquemaAjusteStock = z.object({
  diferencia: z.coerce
    .number()
    .int()
    .min(-1_000_000)
    .max(1_000_000)
    .refine((valor) => valor !== 0, {
      message: 'La diferencia de stock no puede ser cero.',
    }),
});

export const esquemaItemCarrito = z.object({
  cantidad: z.coerce.number().int().min(1).max(999),
});

export const esquemaCotizarCarrito = z.object({
  direccion: esquemaDireccionEntrega,
});

export const esquemaCrearDireccion = esquemaDireccionEntrega;

export const esquemaActualizarDireccion = esquemaDireccionEntrega
  .partial()
  .refine((datos) => Object.keys(datos).length > 0, {
    message: 'Envia al menos un campo para actualizar.',
  });

export const esquemaCrearRubro = z.object({
  nombre: z.string().trim().min(1).max(120),
});

export const esquemaActualizarRubro = esquemaCrearRubro;

export const esquemaCrearCategoriaGlobal = z.object({
  nombre: z.string().trim().min(1).max(120),
  padre_id: z.coerce.number().int().positive().nullable().optional(),
  rubro_id: z.coerce.number().int().positive().nullable().optional(),
});

export const esquemaActualizarCategoriaGlobal = z
  .object({
    nombre: z.string().trim().min(1).max(120).optional(),
    padre_id: z.coerce.number().int().positive().nullable().optional(),
    rubro_id: z.coerce.number().int().positive().nullable().optional(),
  })
  .refine((datos) => Object.keys(datos).length > 0, {
    message: 'Envia al menos un campo para actualizar.',
  });

export const esquemaCambiarEstadoLocal = z.object({
  estado: z.enum(ESTADOS_LOCAL_ADMIN),
});

export const esquemaFiltrosLocales = z.object({
  rubro_id: z.coerce.number().int().positive().optional(),
  categoria_global_id: z.coerce.number().int().positive().optional(),
  estado: z
    .enum([
      'pendiente_aprobacion',
      'activo',
      'en_plazo',
      'bloqueado',
      'suspendido',
    ])
    .optional(),
});

export const esquemaFiltrosProductos = z.object({
  local_id: z.coerce.number().int().positive().optional(),
  categoria_global_id: z.coerce.number().int().positive().optional(),
  subcategoria_local_id: z.coerce.number().int().positive().optional(),
});

export const esquemaFiltrosCategorias = z.object({
  rubro_id: z.coerce.number().int().positive().optional(),
  padre_id: z.coerce.number().int().positive().nullable().optional(),
});

export const esquemaLocalQuery = z.object({
  local_id: z.coerce.number().int().positive(),
});

export const METODOS_PAGO_DEUDA = ['transferencia', 'efectivo', 'manual'];
export const ESTADOS_PAGO_DEUDA = ['pendiente', 'confirmado', 'rechazado'];

const esquemaMontoPagoDeuda = z.coerce
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);

const esquemaReferenciaPagoDeuda = z.string().trim().min(1).max(255);

const esquemaComprobantePagoDeuda = z
  .string()
  .trim()
  .min(1)
  .max(2000)
  .nullable()
  .optional();

export const esquemaReportarPagoDeuda = z.object({
  local_id: z.coerce.number().int().positive(),
  monto: esquemaMontoPagoDeuda,
  metodo: z.enum(METODOS_PAGO_DEUDA),
  referencia: esquemaReferenciaPagoDeuda,
  comprobante_url: esquemaComprobantePagoDeuda,
});

export const esquemaRegistrarPagoDeuda = z.object({
  monto: esquemaMontoPagoDeuda,
  metodo: z.enum(METODOS_PAGO_DEUDA),
  referencia: esquemaReferenciaPagoDeuda,
  comprobante_url: esquemaComprobantePagoDeuda,
});

export const esquemaFiltrosPagosDeuda = z.object({
  local_id: z.coerce.number().int().positive().optional(),
  estado: z.enum(ESTADOS_PAGO_DEUDA).optional(),
});

// ---------------------------------------------------------------------------
// Esquemas de validacion de la Etapa 4c-1 (disputas y evidencia)
// ---------------------------------------------------------------------------

export const ESTADOS_DISPUTA = [
  'abierta',
  'resuelta_comprador',
  'resuelta_vendedor',
];

export const TIPOS_EVIDENCIA = ['texto', 'url'];

const esquemaEvidencia = z
  .object({
    tipo: z.enum(TIPOS_EVIDENCIA),
    contenido: z
      .string()
      .trim()
      .min(1, 'La evidencia no puede estar vacia.')
      .max(4000, 'La evidencia no puede superar 4000 caracteres.'),
  })
  .superRefine((datos, ctx) => {
    if (datos.tipo !== 'url') return;

    if (!datos.contenido.startsWith('https://')) {
      ctx.addIssue({
        code: 'custom',
        path: ['contenido'],
        message: 'La URL de la evidencia debe empezar por https://.',
      });
      return;
    }

    try {
      const url = new URL(datos.contenido);
      if (url.protocol !== 'https:') {
        ctx.addIssue({
          code: 'custom',
          path: ['contenido'],
          message: 'La URL de la evidencia debe usar https.',
        });
      }
    } catch {
      ctx.addIssue({
        code: 'custom',
        path: ['contenido'],
        message: 'La URL de la evidencia no es valida.',
      });
    }
  });

export const esquemaAgregarEvidencia = esquemaEvidencia;

export const esquemaAbrirDisputa = z
  .object({
    motivo: z
      .string()
      .trim()
      .min(1, 'El motivo de la disputa es obligatorio.')
      .max(2000),
    lineas: z
      .array(
        z.object({
          detalle_id: z.coerce.number().int().positive(),
          cantidad: z.coerce.number().int().min(1).max(999),
        }),
      )
      .min(1, 'La disputa necesita al menos una linea.')
      .max(50, 'La disputa no puede tener mas de 50 lineas.'),
    evidencia_inicial: esquemaEvidencia.optional(),
  })
  .superRefine((datos, ctx) => {
    const vistos = new Set();

    datos.lineas.forEach((linea, indice) => {
      if (vistos.has(linea.detalle_id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['lineas', indice, 'detalle_id'],
          message: 'No repitas la misma linea en la disputa.',
        });
      }
      vistos.add(linea.detalle_id);
    });
  });

export const esquemaFiltrosDisputas = z.object({
  estado: z.enum(ESTADOS_DISPUTA).optional(),
  local_id: z.coerce.number().int().positive().optional(),
});

// ---------------------------------------------------------------------------
// Esquemas de validacion de la Etapa 4c-2b (resolucion y producto recibido)
// ---------------------------------------------------------------------------

const esquemaLineaResolucion = z.object({
  detalle_id: z.coerce.number().int().positive(),
  cantidad: z.coerce.number().int().min(1).max(999),
});

export const esquemaResolverDisputa = z
  .object({
    favor: z.enum(['comprador', 'vendedor']),
    resolucion: z
      .string()
      .trim()
      .min(1, 'La resolucion es obligatoria.')
      .max(2000, 'La resolucion no puede superar 2000 caracteres.')
      .optional(),
    // Alias aceptado para clientes que llaman `motivo` al texto de la
    // decision. No se guarda como motivo de la disputa original.
    motivo: z
      .string()
      .trim()
      .min(1, 'La resolucion es obligatoria.')
      .max(2000, 'La resolucion no puede superar 2000 caracteres.')
      .optional(),
    lineas: z
      .array(esquemaLineaResolucion)
      .min(1, 'La resolucion necesita al menos una linea.')
      .max(50, 'La resolucion no puede tener mas de 50 lineas.')
      .optional(),
    incluye_envio: z.boolean().optional().default(false),
  })
  .superRefine((datos, ctx) => {
    if (!datos.resolucion && !datos.motivo) {
      ctx.addIssue({
        code: 'custom',
        path: ['resolucion'],
        message: 'La resolucion es obligatoria.',
      });
    }

    const vistos = new Set();
    for (const [indice, linea] of (datos.lineas ?? []).entries()) {
      if (vistos.has(linea.detalle_id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['lineas', indice, 'detalle_id'],
          message: 'No repitas la misma linea en la resolucion.',
        });
      }
      vistos.add(linea.detalle_id);
    }
  });

export const esquemaProductoRecibido = z
  .object({
    lineas: z
      .array(
        z.object({
          detalle_id: z.coerce.number().int().positive(),
          cantidad: z.coerce.number().int().min(1).max(999).optional(),
        }),
      )
      .min(1, 'La confirmacion necesita al menos una linea.')
      .max(50, 'La confirmacion no puede tener mas de 50 lineas.')
      .optional(),
  })
  .superRefine((datos, ctx) => {
    const vistos = new Set();
    for (const [indice, linea] of (datos.lineas ?? []).entries()) {
      if (vistos.has(linea.detalle_id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['lineas', indice, 'detalle_id'],
          message: 'No repitas la misma linea en la confirmacion.',
        });
      }
      vistos.add(linea.detalle_id);
    }
  });

// ---------------------------------------------------------------------------
// Esquemas de validacion de la Etapa 4c-2a (reembolsos por linea)
// ---------------------------------------------------------------------------

/**
 * La entrada solo trae lineas y cantidades. Cualquier `monto` que mande el
 * cliente se descarta: el backend lo recalcula con `detalle_producto`.
 */
export const esquemaCrearReembolso = z
  .object({
    motivo: z
      .string()
      .trim()
      .min(1, 'El motivo del reembolso es obligatorio.')
      .max(200),
    lineas: z
      .array(
        z.object({
          detalle_id: z.coerce.number().int().positive(),
          cantidad: z.coerce.number().int().min(1).max(999),
        }),
      )
      .min(1, 'El reembolso necesita al menos una linea.')
      .max(50, 'El reembolso no puede tener mas de 50 lineas.'),
    incluye_envio: z.boolean().optional().default(false),
    disputa_id: z.coerce.number().int().positive().nullable().optional(),
  })
  .superRefine((datos, ctx) => {
    const vistos = new Set();

    datos.lineas.forEach((linea, indice) => {
      if (vistos.has(linea.detalle_id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['lineas', indice, 'detalle_id'],
          message: 'No repitas la misma linea en el reembolso.',
        });
      }
      vistos.add(linea.detalle_id);
    });
  });