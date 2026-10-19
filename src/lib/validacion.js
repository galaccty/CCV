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