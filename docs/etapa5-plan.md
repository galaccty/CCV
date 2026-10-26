# Plan de la Etapa 5 — búsqueda, comunidad y calificaciones

> **Estado:** propuesta para aprobación, 26/10/2026. No hay código ni migraciones de la Etapa 5 escritos.
> **Base:** `especificacion_centro_comercial_v4.md` (sección 5, contrato de la sección 6, operación de la sección 7 e invariantes de la sección 10), `docs/etapa4-plan.md`, `CONTRIBUTING.md` y el estado real del repositorio al 26/10/2026.

## 0. Qué existe hoy y qué falta

Ya existen y se reutilizan:

- Catálogo público en `src/services/catalogo.js`: locales en `activo` o `en_plazo`, productos activos, variantes activas y serializadores snake_case. Hoy no filtra por stock ni tiene búsqueda full-text.
- `ESTADOS_LOCAL_VENTA` en `src/domain/estados.js` como única lista de estados que pueden vender.
- `Local.promedioCalificacion` y `Local.totalCalificaciones`, ambos en cero y sin tabla de calificaciones que los alimente.
- `Producto` y `ProductoVariante`; el precio y el stock viven en la variante. `Producto` todavía no tiene campos de calificación.
- `CategoriaGlobal` con `padreId`, `rubroId` y jerarquía; `Local.rubroId`.
- Sesión con roles (`comprador`, `vendedor`, `admin`), CSRF, paginación estándar (`leerPaginacion`, máximo 100), rate limiting, idempotencia para pedidos/pagos, alertas operativas y jobs con advisory lock.
- `Usuario.emailVerificado` y el flujo de verificación por correo.
- Jobs existentes en `src/jobs/index.js`; `notificaciones_por_lotes` y `reconstruir_promedios` ya están listados como pendientes, sin función ni clave.
- PostgreSQL 16.10 local. Las extensiones `unaccent` y `pg_trgm` están disponibles pero no instaladas; `pgcrypto` tampoco está instalada.

Falta para la Etapa 5:

1. Búsqueda full-text en español con `unaccent` envuelto en una función `IMMUTABLE`, vectores de producto/local/categoría, índices GIN, filtros, orden y límite para anónimos.
2. Tabla y rutas de seguidores, con seguir/dejar de seguir idempotente, listado y contador.
3. Tabla de eventos pendientes (outbox), tabla de notificaciones, job por lotes, rutas de campana y retención de leídas.
4. Calificaciones de local y producto con compra verificada, edición limitada, agregados transaccionales y listados públicos.
5. Reportes de abuso y moderación del admin, con ocultamiento que excluye del promedio.
6. Job de reconstrucción de promedios que corrige y alerta diferencias.
7. Contrato OpenAPI, pruebas de reglas, concurrencia e idempotencia, y documentación operativa.

No se implementa nada de la Etapa 6: la home, las recomendaciones, la publicidad y la tabla `vistas_producto` quedan fuera. El diseño de `vistas_producto` se deja escrito en este plan para no improvisarlo después.

---

## 1. Principios de esta etapa

1. **La búsqueda es un lector del catálogo, no una fuente de verdad.** No escribe stock, precios ni estados. Solo muestra productos de locales que pueden vender, productos activos y variantes activas con stock.
2. **La búsqueda no promete lo que el checkout no puede cumplir.** Un producto sin stock no aparece. La variante sin stock puede mostrarse como no disponible, pero el producto solo entra al resultado si al menos una variante activa tiene stock.
3. **La privacidad del inventario se mantiene.** La búsqueda nunca expone la cantidad exacta cuando hay más de cinco unidades; reutiliza la regla de `unidades_restantes` de la sección 4.14.
4. **Seguir es una relación social, no financiera.** La PK compuesta `(usuario_id, local_id)` hace que seguir dos veces sea la misma fila. No hay notificación por seguir.
5. **Las notificaciones son dentro de la web.** No se envían correos de notificaciones; solo se usan los correos existentes de verificación y restablecimiento. Aun así, la regla de negocio exige que el destinatario tenga `email_verificado = true`.
6. **Las notificaciones son asíncronas, pero no se pierden.** El hecho que las origina y el evento de outbox se escriben en la misma transacción. El job las crea después, por lotes, y la clave única + `(evento_id, usuario_id)` permiten reintentar sin duplicar.
7. **El correo no verificado no recibe notificaciones.** Si el destinatario no está verificado o está inactivo, el evento se marca procesado con cero notificaciones; no se guarda una notificación pendiente de verificación.
8. **Una calificación es una compra verificada.** El comprador debe ser el dueño del pedido, el sub-pedido debe estar entregado y la calificación de producto debe corresponder a una línea de ese sub-pedido.
9. **El vendedor no califica su propio local.** Se compara `local.usuario_id` con el usuario de la sesión; el admin tampoco crea calificaciones, solo modera.
10. **Los agregados se actualizan en la misma transacción, con lock de la fila del local o del producto.** El job de reconstrucción es una red de seguridad, no el camino normal.
11. **Lo oculto no suma.** `promedio_calificacion` y `total_calificaciones` excluyen las calificaciones con `oculta = true`.
12. **Nada financiero se toca.** Esta etapa no crea movimientos de ledger, no modifica saldos y no cambia las reglas de stock. Cualquier cambio que roce esas áreas debe volver a la Etapa 4.
13. **El contrato va primero.** `openapi.yaml` se actualiza antes de implementar cada sub-etapa. Las pruebas y el código siguen al contrato.
14. **Nada se implementa hasta que este plan esté aprobado.** Los valores, rutas y decisiones pendientes de la sección 12 requieren confirmación explícita.

---

## 2. Tablas, columnas, constraints y triggers

### 2.1 Búsqueda full-text

Migración `etapa5a_busqueda_fts`:

- Instalar la extensión `unaccent` (y solo si se decide usarla, `pg_trgm`; este plan no la necesita).
- Crear una función envoltorio `IMMUTABLE` porque `unaccent()` nativa es `STABLE` y PostgreSQL no la acepta en columnas generadas ni índices:

```sql
CREATE EXTENSION IF NOT EXISTS unaccent;

CREATE OR REPLACE FUNCTION public.ccv_unaccent(text)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
  SELECT public.unaccent('public.unaccent', $1)
$$;
```

> El nombre `public.unaccent` del diccionario se califica para no depender del `search_path`. Si el hosting instala la extensión en otro esquema, la migración debe ajustar el nombre y se prueba en una base limpia antes de desplegar.

Columnas generadas:

| Tabla | Columna | Expresión | Índice |
|---|---|---|---|
| `producto` | `busqueda` | `setweight(to_tsvector('spanish', ccv_unaccent(coalesce(nombre, ''))), 'A') || setweight(to_tsvector('spanish', ccv_unaccent(coalesce(descripcion, ''))), 'B')` | GIN |
| `local` | `busqueda` | `setweight(to_tsvector('spanish', ccv_unaccent(nombre)), 'A')` | GIN |
| `categoria_global` | `busqueda` | `setweight(to_tsvector('spanish', ccv_unaccent(nombre)), 'A')` | GIN |

- Las columnas son `tsvector` generadas y almacenadas (`GENERATED ALWAYS AS (...) STORED`). Se recalculan solas cuando cambia el nombre o la descripción.
- En Prisma, `busqueda` se marca como `Unsupported("tsvector")?` solo si la introspección lo exige; el servicio de búsqueda usará SQL parametrizado, no el filtro de Prisma.
- Índices adicionales para filtros:
  - `producto_variante (producto_id, precio) WHERE activo AND stock > 0`, para el `EXISTS` de stock y el rango de precio.
  - `producto (categoria_global_id, activo)`, si el plan existente no lo cubre.
  - `local (estado, rubro_id)` ya existe; se conserva.
  - `local (estado, promedio_calificacion DESC)` si el orden por calificación lo justifica en las pruebas de rendimiento.
- La migración no reescribe filas: las columnas generadas se calculan al agregarlas. Se ejecuta `ANALYZE` de las tres tablas al final.
- No se instala `pg_trgm`. La búsqueda es full-text; la tolerancia a errores de tipeo y las sugerencias quedan para una etapa posterior.

### 2.2 Seguidores

Tabla `seguidor_local` (nueva):

- `usuario_id` (FK a `usuario`, `ON DELETE CASCADE`), `local_id` (FK a `local`, `ON DELETE CASCADE`), `creado_en` (`timestamptz`, default `now()`).
- PK compuesta `(usuario_id, local_id)`. Es la garantía de idempotencia: seguir dos veces no crea dos filas.
- Índice `(local_id, creado_en DESC, usuario_id)` para el contador y la expansión de notificaciones.
- No se agrega `local.total_seguidores` en la propuesta base. El contador se calcula con `COUNT(*)` sobre este índice y se expone en la API; así no hay deriva ni job de reparación. La decisión queda abierta en la sección 12.
- El servicio impide seguir el local propio comparando `local.usuario_id` con el usuario autenticado. La base no puede hacer esa comparación con un CHECK de una sola fila; se prueba en la capa de servicio y en la ruta.

### 2.3 Notificaciones y outbox

Enums nuevos:

- `tipo_notificacion`: `pedido_estado`, `reembolso_completado`, `disputa_resuelta`, `producto_nuevo`, `pedido_nuevo`, `disputa_abierta`, `liquidacion_pagada`, `deuda_cerca_limite`, `local_en_plazo`.
- `estado_evento_notificacion`: `pendiente`, `procesado`, `fallido`.

Tabla `evento_notificacion` (outbox):

- `id` serial PK.
- `clave` `varchar(255)` UNIQUE NOT NULL: identifica el hecho, no el destinatario. Ejemplos: `pedido_estado:{historial_id}`, `reembolso_completado:{id}`, `disputa_abierta:{id}`, `pedido_nuevo:{sub_pedido_id}`, `producto_nuevo:{producto_id}`, `deuda_cerca_limite:{local_id}:{YYYY-MM-DD}`, `local_en_plazo:{local_id}:{fecha_limite}`.
- `tipo` `tipo_notificacion` NOT NULL.
- `usuario_id` nullable (destinatario directo, cuando se conoce).
- `local_id` nullable (local involucrado).
- `payload` `jsonb` NOT NULL default `'{}'`: IDs y datos mínimos; nunca el texto final de la notificación.
- `estado` `estado_evento_notificacion` default `pendiente`.
- `intentos` int default 0, CHECK `intentos >= 0`.
- `ultimo_error` text nullable.
- `creado_en` timestamptz default `now()`, `procesado_en` nullable.
- Índices: `(estado, id)`, `(tipo, creado_en)`, `(local_id, estado)`.

Tabla `notificacion` (nueva):

- `id` serial PK.
- `evento_id` FK a `evento_notificacion` (`ON DELETE RESTRICT`).
- `usuario_id` FK a `usuario` (`ON DELETE CASCADE`).
- `tipo` `tipo_notificacion` NOT NULL.
- `titulo` `varchar(200)` NOT NULL; `mensaje` text NOT NULL.
- `datos` `jsonb` nullable: IDs de pedido, sub-pedido, local, producto, etc., para que el frontend arme el enlace.
- `leida_en` timestamptz nullable; `creada_en` timestamptz default `now()`.
- UNIQUE `(evento_id, usuario_id)`: un evento no crea dos veces la misma notificación para el mismo usuario.
- Índices: `(usuario_id, creada_en DESC, id DESC)` para el listado; índice parcial `(usuario_id) WHERE leida_en IS NULL` para el contador; `(leida_en) WHERE leida_en IS NOT NULL` para la retención.
- No se borran eventos ni notificaciones no leídas. La única retención es la de notificaciones leídas de la sección 5.4.

Captura de eventos:

- Se prefiere el patrón **outbox con triggers** para los hechos inmutables. El trigger solo inserta `(clave, tipo, usuario_id, local_id, payload)` con `ON CONFLICT (clave) DO NOTHING`; no arma textos ni decide plantillas.
- Trigger sobre `historial_estado_sub_pedido` después de insertar: evento `pedido_estado` para el comprador. Cada fila de historial es un hecho único, por eso la clave usa `historial.id`, no solo `(sub_pedido_id, estado_nuevo)` (un sub-pedido puede volver a un estado anterior tras una disputa).
- Trigger sobre `reembolso` al insertar o al pasar a `completado`: evento `reembolso_completado`.
- Trigger sobre `disputa` al insertar: `disputa_abierta` para el vendedor; al resolver: `disputa_resuelta` para el comprador.
- Trigger sobre `liquidacion` al pasar a `pagada`: `liquidacion_pagada` para el vendedor.
- Trigger sobre `producto` al insertar un producto activo en un local que puede vender: `producto_nuevo`; el job expande a los seguidores.
- `pedido_nuevo`: en efectivo, al insertar el sub-pedido dentro de un pedido con `metodo_pago = 'efectivo'`; en digital, al pasar el pago a `aprobado`. La clave `pedido_nuevo:{sub_pedido_id}` hace que ambos caminos no dupliquen.
- Las advertencias de deuda (`deuda_cerca_limite`, `local_en_plazo`) se emiten desde `recalcularEstadoLocal()` con el mismo helper de outbox, en la misma transacción. El trigger no tendría que leer configuración ni comparar estados anteriores para estos dos casos.
- Si un trigger falla, la transacción del hecho falla; no se acepta un hecho sin evento. Es la misma lógica de atomicidad que ya usan las alertas.

> **Decisión pendiente:** la alternativa es emitir todos los eventos desde servicios Node, sin triggers. La recomendación es la mezcla anterior (triggers para hechos de estado, servicio para advertencias de deuda) porque ningún camino nuevo puede olvidar el evento. La sección 12 lo deja explícito.

### 2.4 Calificaciones

Columnas nuevas en `producto`:

- `promedio_calificacion` `double precision` NOT NULL default 0.
- `total_calificaciones` integer NOT NULL default 0.
- CHECK `promedio_calificacion BETWEEN 0 AND 5` y `total_calificaciones >= 0`.

`local` ya tiene las dos columnas; se agregan los mismos CHECK y se documenta que ahora significan **calificaciones visibles**, no históricas.

Tabla `calificacion_local` (nueva):

- `id` serial PK.
- `sub_pedido_id` int NOT NULL UNIQUE, FK a `sub_pedido` (`ON DELETE RESTRICT`): una calificación de local por sub-pedido.
- `usuario_id` int NOT NULL, FK a `usuario`.
- `local_id` int NOT NULL, FK a `local`.
- `estrellas` int NOT NULL, CHECK `estrellas BETWEEN 1 AND 5`.
- `comentario` `varchar(500)` nullable; CHECK `comentario IS NULL OR char_length(comentario) <= 500`.
- `oculta` boolean NOT NULL default false.
- `oculta_en` timestamptz nullable; `oculta_por` int nullable FK a `usuario`; `motivo_ocultamiento` `varchar(500)` nullable.
- `creada_en` timestamptz default `now()`; `actualizada_en` timestamptz actualizado por la aplicación.
- CHECK de ocultamiento coherente: si `oculta = true`, `oculta_en IS NOT NULL` y `oculta_por IS NOT NULL`.
- Índices: `(local_id, oculta, creada_en DESC)` y `(usuario_id, creada_en DESC)`.

Tabla `calificacion_producto` (nueva):

- Misma forma general, con:
  - `detalle_id` int NOT NULL UNIQUE, FK a `detalle_producto`: una calificación por línea de pedido.
  - `sub_pedido_id` int NOT NULL, FK a `sub_pedido`, para consultas y validaciones.
  - `producto_id` int NOT NULL, FK a `producto`.
  - `usuario_id`, `local_id` (redundante controlado), `estrellas`, `comentario`, campos de ocultamiento y fechas.
- CHECK `estrellas`, comentario y ocultamiento iguales a `calificacion_local`.
- Índices: `(producto_id, oculta, creada_en DESC)` y `(usuario_id, creada_en DESC)`.

Reglas de integridad de calificaciones:

- El `usuario_id` debe ser el dueño del pedido (`pedido.usuario_id`), no solo un usuario con rol comprador.
- `calificacion_local.local_id` debe ser `sub_pedido.local_id`.
- `calificacion_producto.detalle_id` debe pertenecer al `sub_pedido_id`, y `producto_id` debe ser el producto de la variante del detalle. Se valida en el servicio y con un trigger de defensa; un UPDATE no puede cambiar esas columnas.
- No se permite calificar si el sub-pedido no tiene `fecha_entrega` o está `cancelado`, `reembolsado` o `expirado`. La elegibilidad exacta se define en 6.1.
- El trigger de actualización impide cambiar `sub_pedido_id`, `usuario_id`, `local_id`, `producto_id`, `detalle_id` y `creada_en`. El contenido (`estrellas`, `comentario`) solo se puede cambiar dentro de los 7 días y por el autor; el admin solo puede cambiar los campos de ocultamiento.
- No hay DELETE de calificaciones. Ocultar no borra; el reporte y la calificación quedan para auditoría.

### 2.5 Reportes de abuso

Tabla `reporte` (nueva, nombre de la especificación):

- `id` serial PK.
- `usuario_id` int NOT NULL, FK a `usuario` (quien reporta).
- `calificacion_local_id` int nullable, FK a `calificacion_local`.
- `calificacion_producto_id` int nullable, FK a `calificacion_producto`.
- `motivo` `varchar(500)` NOT NULL, CHECK longitud entre 3 y 500.
- `estado` `estado_reporte` (`pendiente`, `resuelta`, `descartada`) default `pendiente`.
- `resuelto_por` int nullable FK a `usuario`; `resolucion` `varchar(500)` nullable; `creado_en` timestamptz default `now()`; `resuelto_en` timestamptz nullable.
- CHECK: exactamente uno de los dos destinos es no nulo.
- UNIQUE parcial `(usuario_id, calificacion_local_id) WHERE calificacion_local_id IS NOT NULL` y `(usuario_id, calificacion_producto_id) WHERE calificacion_producto_id IS NOT NULL`: un reporte por usuario y calificación.
- Índices `(estado, creado_en)` y `(calificacion_local_id)`, `(calificacion_producto_id)`.
- No se borran reportes. Un reporte resuelto conserva su resolución y auditoría.

### 2.6 `vistas_producto` (solo diseño, Etapa 6)

No se crea en la Etapa 5. El diseño que se deja preparado es:

- `vistas_producto`: `id bigserial` PK, `producto_id` FK, `usuario_id` nullable FK, `sesion_anonima` `varchar(64)` nullable, `visto_en` timestamptz, `periodo_hora` timestamptz.
- CHECK: exactamente uno de `usuario_id` o `sesion_anonima`.
- UNIQUE parcial `(producto_id, usuario_id, periodo_hora) WHERE usuario_id IS NOT NULL` y `(producto_id, sesion_anonima, periodo_hora) WHERE usuario_id IS NULL AND sesion_anonima IS NOT NULL`.
- Índices `(producto_id, visto_en DESC)` y `(usuario_id, visto_en DESC)`.
- Retención de 90 días mediante job de la Etapa 6; no se toca en la Etapa 5.
- La sesión anónima será un identificador aleatorio de cookie, no una IP ni un dato personal.

---

## 3. Búsqueda

### 3.1 Ruta y visibilidad

Ruta pública:

`GET /api/v1/busqueda/productos`

No exige sesión. La sesión, si existe, solo sirve para excluirla del límite de anónimos.

El SQL base exige simultáneamente:

- `producto.activo = true`.
- `producto.local.estado IN ('activo', 'en_plazo')`.
- Al menos una `producto_variante` con `activo = true` y `stock > 0` (`EXISTS`).
- Si se filtra por categoría, que el producto pertenezca a la categoría elegida (o a su subárbol, según la decisión pendiente).
- Si se filtra por local o rubro, que correspondan al local.
- Si se filtra por precio, que exista una variante activa con stock dentro del rango. El `precio_desde` y `precio_hasta` que se devuelven se calculan sobre todas las variantes activas con stock, no solo sobre la que cayó en el rango.

El producto se busca por la combinación de los tres vectores:

- `producto.busqueda` (nombre con peso A, descripción con peso B).
- `local.busqueda` (nombre del local con peso B).
- `categoria_global.busqueda` (nombre de la categoría con peso C).

La consulta usa `websearch_to_tsquery('spanish', public.ccv_unaccent($q))`. El filtro es:

```sql
(p.busqueda @@ q
 OR l.busqueda @@ q
 OR c.busqueda @@ q)
```

El ranking suma los vectores con sus pesos:

```sql
ts_rank_cd(
  p.busqueda
  || setweight(l.busqueda, 'B')
  || setweight(c.busqueda, 'C'),
  q
)
```

Así se puede buscar por producto, por nombre del local o por categoría y el producto sigue apareciendo. Los productos encontrados por nombre de local o categoría quedan por debajo de una coincidencia directa de producto.

### 3.2 Parámetros, filtros y orden

| Parámetro | Tipo y regla | Efecto |
|---|---|---|
| `q` | Texto opcional, recortado, máximo 120 caracteres; si queda vacío se ignoran los filtros de texto | Búsqueda full-text sin acentos y sin distinguir mayúsculas |
| `categoria_global_id` | Entero positivo | Filtra por categoría; recomendación: incluye descendientes con CTE recursiva |
| `rubro_id` | Entero positivo | Filtra por `local.rubro_id` |
| `precio_min` | Entero en pesos, >= 0 | Precio de variante activa con stock |
| `precio_max` | Entero en pesos, >= 0 y >= `precio_min` | Precio de variante activa con stock |
| `calificacion_min` | Número entre 0 y 5 | Promedio visible del local (decisión pendiente) |
| `local_id` | Entero positivo | Restringe a un local |
| `solo_con_stock` | Booleano, default `true` | **Regla de visibilidad, no filtro opcional:** si llega `false`, responde 400 `stock_obligatorio`; no se promete catálogo sin stock |
| `orden` | `relevancia`, `precio_asc`, `precio_desc`, `calificacion`, `recientes` | Orden del resultado |
| `pagina` | Entero >= 1, default 1 | Paginación estándar |
| `por_pagina` | Entero 1..100, default 20 | Paginación estándar |

Reglas adicionales:

- Si no hay `q` y no hay filtros, el endpoint devuelve el catálogo visible con orden `recientes`; no es un error.
- Si hay `q`, el orden por defecto es `relevancia`; si no hay `q`, el orden por defecto es `recientes`.
- `relevancia`: `ts_rank_cd` descendente, luego `local.promedio_calificacion` descendente y `producto.id` descendente.
- `precio_asc` y `precio_desc`: usan el precio mínimo de las variantes activas con stock, con desempate por `producto.id`.
- `calificacion`: `local.promedio_calificacion` descendente, luego `local.total_calificaciones` descendente, luego `producto.id`.
- `recientes`: `producto.creado_en` descendente y `producto.id` descendente.
- La categoría se resuelve con una CTE recursiva y `UNION` (no `UNION ALL`) para tolerar ciclos accidentales en la jerarquía.
- El orden se arma con una lista blanca de fragmentos SQL; nunca se interpola el valor de `orden` ni `q` en el SQL.
- El conteo total se hace con la misma condición de visibilidad, sin las columnas de ranking.

Respuesta:

```json
{
  "datos": [
    {
      "id": 1,
      "nombre": "Café de altura",
      "descripcion": "Grano tostado",
      "fotos": [],
      "categoria_global_id": 3,
      "local_id": 7,
      "precio_desde": 18000,
      "precio_hasta": 24000,
      "local": {
        "id": 7,
        "nombre": "Café Central",
        "logo_url": null,
        "promedio_calificacion": 4.8,
        "total_calificaciones": 40
      },
      "categoria": { "id": 3, "nombre": "Cafés", "padre_id": 1 },
      "variantes": []
    }
  ],
  "paginacion": { "pagina": 1, "por_pagina": 20, "total": 1, "paginas": 1 }
}
```

- `precio_desde` y `precio_hasta` son enteros en pesos.
- Las variantes que se incluyan respetan la regla pública de stock: `disponible` y, solo si quedan cinco o menos, `unidades_restantes`.
- El promedio y el total que aparecen aquí son los del local; las calificaciones del producto se agregan en la sub-etapa 5e y no son necesarias para el filtro de esta sub-etapa.
- No se expone el puntaje de relevancia ni datos internos de la consulta.

### 3.3 Límite de peticiones para anónimos

- Nuevo limitador `limiteBusquedaAnonima`: 60 peticiones por minuto por IP, con el código de error existente `demasiadas_peticiones`.
- Se aplica solo a `GET /api/v1/busqueda/productos`; si `req.usuario` existe, no cuenta.
- El limitador general de 300 por 15 minutos sigue aplicando por fuera; el de búsqueda es más estricto para el tráfico sin sesión.
- Se implementa con la fábrica `crearLimitador` y un envoltorio que salta la cuenta cuando hay sesión. Las pruebas usan una instancia con `omitirEnPruebas: false` y verifican que un usuario autenticado no se bloquea.
- La respuesta 429 no revela detalles internos, igual que los limitadores actuales.

### 3.4 Rendimiento e índices

- Los `@@` deben poder resolverse con los índices GIN; se verifica con `EXPLAIN` en una base de prueba con suficientes filas y se documenta el plan.
- El `EXISTS` de stock usa el índice parcial de `producto_variante`.
- El filtro por categoría usa `categoria_global.padre_id` y el índice de producto por categoría.
- La consulta no hace `SELECT *`; trae solo las columnas necesarias y las variantes con un `LATERAL`/subconsulta acotada.
- Si el plan degrada con el tiempo, se puede materializar un vector combinado por producto en una etapa posterior; no se hace ahora porque complica la actualización cuando cambia el local o la categoría.

---

## 4. Seguidores

### 4.1 Reglas

- Solo un usuario autenticado puede seguir o dejar de seguir.
- Solo se puede seguir un local que exista y esté en `ESTADOS_LOCAL_VENTA`. Un local bloqueado, suspendido o pendiente responde 404 para no revelar catálogos que no puede vender.
- El dueño del local no puede seguirlo. Responde 409 `no_puedes_seguir_tu_local`.
- `POST /locales/{id}/seguir` es idempotente: si ya existe la fila responde 200 con `creado: false`; si no existía, `creado: true`.
- `DELETE /locales/{id}/seguir` es idempotente: si no había fila responde 200 con `eliminado: false`; si había, `eliminado: true`.
- La lista de seguidos es solo del usuario autenticado. Incluye locales que después hayan quedado bloqueados o suspendidos, para que el usuario pueda dejar de seguirlos; el resumen incluye `estado`. No incluye locales eliminados (no hay borrado de locales).
- El contador `total_seguidores` se calcula con `COUNT(*)` y se devuelve en el detalle público del local, en la lista de seguidos y en la respuesta de seguir/dejar de seguir. No se agrega columna en la propuesta base.

### 4.2 Listado

`GET /api/v1/locales-seguidos?pagina=&por_pagina=`

- Orden por `seguidor_local.creado_en` descendente, luego `local.nombre`.
- Paginación estándar, máximo 100.
- Cada elemento incluye el resumen público del local, `estado`, `total_seguidores`, `siguiendo_desde` y, si el local sigue siendo visible, `promedio_calificacion` y `total_calificaciones`.
- No permite consultar los seguidos de otro usuario: no hay `usuario_id` en la ruta.

### 4.3 Concurrencia

- La PK compuesta y `INSERT ... ON CONFLICT DO NOTHING` garantizan una sola fila ante clics repetidos o peticiones simultáneas.
- `DELETE ... WHERE usuario_id = ? AND local_id = ?` no falla si no hay fila.
- El contador calculado siempre coincide con la tabla; no hay incrementos que puedan perderse.
- La expansión de `producto_nuevo` lee los seguidores en el momento de procesar el evento; si alguien sigue después, no recibe ese producto retroactivamente.

---

## 5. Notificaciones

### 5.1 Tipos y destinatarios

| Tipo | Hecho que lo origina | Destinatario | Clave |
|---|---|---|---|
| `pedido_estado` | Cada fila nueva de `historial_estado_sub_pedido` | Comprador dueño del pedido | `pedido_estado:{historial_id}` |
| `reembolso_completado` | Reembolso insertado o actualizado a `completado` | Comprador dueño del pedido | `reembolso_completado:{reembolso_id}` |
| `disputa_resuelta` | Disputa pasa a resuelta | Comprador que la abrió | `disputa_resuelta:{disputa_id}` |
| `producto_nuevo` | Producto activo creado en local que puede vender | Seguidores verificados del local | `producto_nuevo:{producto_id}` |
| `pedido_nuevo` | Efectivo: sub-pedido creado; digital: pago aprobado | Vendedor dueño del local | `pedido_nuevo:{sub_pedido_id}` |
| `disputa_abierta` | Disputa insertada | Vendedor dueño del local | `disputa_abierta:{disputa_id}` |
| `liquidacion_pagada` | Liquidación pasa a `pagada` | Vendedor dueño del local | `liquidacion_pagada:{liquidacion_id}` |
| `deuda_cerca_limite` | Deuda >= umbral y aún no bloqueado; máximo una por local y día | Vendedor dueño del local | `deuda_cerca_limite:{local_id}:{YYYY-MM-DD}` |
| `local_en_plazo` | Local entra a `en_plazo` | Vendedor dueño del local | `local_en_plazo:{local_id}:{fecha_limite}` |

- El trabajador arma títulos y mensajes en español a partir del tipo y el payload; los triggers no guardan textos.
- Si el pedido tiene varios sub-pedidos, el comprador recibe un aviso por cada transición de sub-pedido; es el nivel que el usuario necesita para seguir su compra.
- `producto_nuevo` se expande a los seguidores en el momento del job. Si el local tiene 10 000 seguidores, se insertan por lotes internos y se conserva la idempotencia por `(evento_id, usuario_id)`.
- La regla no filtra por actor: si se inserta una fila de historial nuevo, se emite `pedido_estado`. Un mismo hecho puede convivir con un aviso específico (por ejemplo, un reembolso) y cada uno conserva su clave; no se intenta deduplicar entre tipos distintos.

### 5.2 Captura y transacción

- El hecho y el evento viven en la misma transacción. Si el evento no se puede insertar, la operación que lo originó falla y se revierte; no se acepta una entrega, un reembolso o una disputa sin su evento.
- Las claves son estables y se insertan con `ON CONFLICT (clave) DO NOTHING`.
- El payload mínimo incluye los IDs y el estado anterior/nuevo cuando aplica. El trabajador consulta la base para completar nombres y montos; si el dato ya cambió, el aviso refleja el estado actual y conserva los IDs para el enlace.
- Los triggers no se ejecutan para filas históricas de migraciones anteriores; solo para hechos nuevos.

### 5.3 Job por lotes

Script: `npm run job:notificaciones`.

Algoritmo:

1. Toma el advisory lock (clave `41009`). Si está ocupado, termina con código 0.
2. Lee hasta 200 IDs de eventos `pendiente` ordenados por `id`. Para cada uno, en su propia transacción corta, vuelve a bloquear la fila con `SELECT ... FOR UPDATE SKIP LOCKED`, verifica que siga `pendiente` y la procesa. Así un fallo no bloquea el lote y dos workers no se pisan.
3. Resuelve destinatarios:
   - Si `evento.usuario_id` existe, ese usuario.
   - Si el tipo es `producto_nuevo`, todos los `seguidor_local` del `local_id`.
   - Si no, el usuario dueño del pedido o del local que indique el payload.
4. Filtra `usuario.activo = true` y `usuario.email_verificado = true`. Los omitidos no generan fila.
5. Inserta notificaciones con `createMany({ skipDuplicates: true })` en lotes de 500. El UNIQUE `(evento_id, usuario_id)` absorbe reintentos y carreras.
6. Marca el evento `procesado`, `procesado_en = now()`, y guarda `notificaciones_creadas`/`omitidos` en el resultado del job (no en columnas nuevas si no hacen falta; puede ir en logs y en el JSON final).
7. Si falla un evento, incrementa `intentos` y guarda `ultimo_error`. A los 5 intentos lo marca `fallido` y abre una alerta `notificacion_fallida` con clave `notificacion_evento:{id}`. El job sigue con los demás.
8. Al final borra notificaciones leídas con `leida_en < now() - interval '90 days'`, en lotes de 1000.

Propiedades:

- Dos instancias no procesan el mismo evento a la vez: advisory lock + `SKIP LOCKED` + estado `pendiente`.
- Un fallo después de insertar algunas notificaciones no duplica: el reintento usa el mismo evento y el UNIQUE.
- Un evento sin destinatarios verificados se marca procesado; no queda en un bucle.
- El job no envía correos ni llama a proveedores externos.
- El lote es acotado para no mantener transacciones largas ni bloquear la tabla.

### 5.4 Retención

- Se borran solo notificaciones con `leida_en` no nulo y anterior a 90 días.
- Las no leídas no se borran nunca por este job.
- La retención se ejecuta en el mismo `job:notificaciones` para no agregar otro cron; se documenta en `docs/jobs.md`.
- La tabla `notificacion` no es financiera; esta retención es la excepción de revisión normal del invariante 11.

### 5.5 Advertencias de deuda

- `local_en_plazo`: se emite cuando `recalcularEstadoLocal()` deja el local en `en_plazo` y el estado anterior no era `en_plazo`. La clave usa la `fecha_limite_pago` para que un nuevo plazo genere un aviso nuevo.
- `deuda_cerca_limite`: se emite cuando `saldo_deuda > 0` y `saldo_deuda >= 0.80 * limite_deuda` (umbral pendiente de aprobación). La clave incluye el día UTC para no repetir el aviso en cada recálculo.
- No se emiten advertencias para locales `pendiente_aprobacion` ni `suspendido`; el vendedor suspendido ya tiene un estado visible y no se le envía spam.
- Si `limite_deuda` es 0 o no está configurado, no se calcula el umbral y no se emite `deuda_cerca_limite`; se registra en logs.

---

## 6. Calificaciones

### 6.1 Elegibilidad

- Solo el comprador dueño del pedido puede calificar.
- El sub-pedido debe tener `fecha_entrega` no nula y estar en un estado de compra cumplida. La propuesta base:
  - `entregado`: permitido.
  - `reembolsado_parcial` con `fecha_entrega` no nula: permitido, porque hubo entrega.
  - `en_disputa`: no permitido hasta que la disputa se resuelva.
  - `cancelado`, `reembolsado` completo, `expirado`: no permitido.
- Una calificación de local por sub-pedido, UNIQUE.
- Una calificación de producto por cada `detalle_producto` (línea), UNIQUE.
- El vendedor no puede calificar su propio local. Si el usuario es comprador y dueño del mismo local, se rechaza.
- Una calificación de producto no requiere que el producto siga activo; la compra ya existió. El listado público sí puede quedar oculto si el producto ya no es visible.
- El admin no crea ni edita estrellas/comentarios; solo oculta o muestra.

### 6.2 Creación y edición

Rutas de escritura con `PUT` para que sean idempotentes:

- `PUT /api/v1/sub-pedidos/{id}/calificacion-local` con `{ "estrellas": 5, "comentario": "..." }`.
- `PUT /api/v1/sub-pedidos/{id}/detalles/{detalleId}/calificacion` con el mismo cuerpo.

Reglas:

- `estrellas` es entero entre 1 y 5; no se aceptan decimales.
- `comentario` es opcional; se recorta; máximo 500 caracteres; vacío se guarda como `null`.
- Si no existe calificación, se crea y responde 201.
- Si existe y está dentro de los 7 días desde `creada_en`, se actualiza y responde 200.
- Si existe y ya pasaron 7 días, responde 409 `calificacion_cerrada`.
- Si el sub-pedido no es elegible, responde 409 `compra_no_verificada`; si no es del usuario, 404 para no revelar pedidos ajenos.
- El `PUT` repetido con el mismo cuerpo no duplica: actualiza la misma fila.
- La ventana de edición se cuenta desde la creación de la calificación (recomendación; decisión pendiente en la sección 12).
- El admin puede ocultar/mostrar sin respetar la ventana de 7 días; eso no cambia estrellas ni comentario.

Transacción de escritura:

1. Leer el sub-pedido, el pedido y el detalle con las relaciones necesarias.
2. Validar propiedad, entrega, local propio y ventana.
3. Bloquear la fila del local o producto con `SELECT ... FOR UPDATE` (siempre el destino antes que la calificación, para un orden de locks estable).
4. Insertar o actualizar la calificación.
5. Recalcular el agregado visible y actualizar `local` o `producto` en la misma transacción.
6. Commit.

### 6.3 Agregados

Para local y producto:

```text
promedio_calificacion = round(avg(estrellas) FILTER (WHERE oculta = false), 2)
total_calificaciones  = count(*) FILTER (WHERE oculta = false)
```

- Si no hay calificaciones visibles, ambos quedan en 0.
- El promedio se guarda como `double precision` con dos decimales; el redondeo se hace en SQL (`ROUND(...::numeric, 2)::float8`) y se prueba con casos 4.666... y 4.333....
- `total_calificaciones` cuenta solo visibles; ocultar una calificación reduce el total. Es el número que se muestra en el catálogo.
- La actualización se hace con lock de la fila destino. Dos creaciones simultáneas se serializan y la segunda recalcula incluyendo a la primera.
- No se usan triggers para los agregados: la regla de negocio exige el lock y la transacción del servicio. El job de reconstrucción es la red de seguridad.

### 6.4 Listados públicos

- `GET /api/v1/locales/{id}/calificaciones?pagina=&por_pagina=`
- `GET /api/v1/productos/{id}/calificaciones?pagina=&por_pagina=`

Reglas:

- Solo devuelven calificaciones `oculta = false`.
- El local o producto debe seguir siendo visible para el público; si no, 404.
- Orden por `creada_en` descendente, luego `id` descendente.
- Cada elemento incluye `id`, `estrellas`, `comentario`, `creada_en`, `editada` (si `actualizada_en > creada_en`) y el nombre visible del autor. No incluye email, teléfono ni `usuario_id`.
- La respuesta incluye `resumen: { promedio_calificacion, total_calificaciones }` calculado de la tabla de calificaciones o de las columnas agregadas; ambos deben coincidir.
- Si no hay calificaciones, `datos` vacío y resumen en 0.
- No se permite ordenar por “más útil” ni responder; eso no está en el alcance.

### 6.5 Reportes y moderación

Rutas de reporte:

- `POST /api/v1/calificaciones-local/{id}/reportes` con `{ "motivo": "..." }`.
- `POST /api/v1/calificaciones-producto/{id}/reportes` con el mismo cuerpo.

Reglas:

- Requiere sesión.
- No se puede reportar la propia calificación.
- El motivo tiene entre 3 y 500 caracteres.
- UNIQUE por usuario y calificación: el segundo intento responde 409 `reporte_duplicado`.
- Cualquier usuario autenticado que pueda ver la calificación puede reportarla; el admin no necesita reportar.

Rutas de admin:

- `GET /api/v1/admin/reportes-calificaciones?estado=&pagina=&por_pagina=`
- `POST /api/v1/admin/reportes-calificaciones/{id}/resolver` con `{ "accion": "ocultar" | "descartar", "motivo": "..." }`.
- `PATCH /api/v1/admin/calificaciones-local/{id}` con `{ "oculta": true | false, "motivo": "..." }`.
- `PATCH /api/v1/admin/calificaciones-producto/{id}` con el mismo cuerpo.

Reglas de moderación:

- Resolver un reporte es idempotente en el sentido de que solo se puede resolver una vez; el segundo intento responde 409 `reporte_ya_resuelto`.
- `ocultar` actualiza la calificación (`oculta = true`, `oculta_en`, `oculta_por`, `motivo_ocultamiento`), recalcula el agregado en la misma transacción y deja el reporte `resuelta`.
- `descartar` deja la calificación visible y el reporte `descartada`.
- La ruta directa de admin permite ocultar o volver a mostrar sin un reporte; siempre exige motivo y recalcula.
- Toda acción escribe `auditoria_admin` con `origen = admin`, `accion = ocultar_calificacion | mostrar_calificacion | resolver_reporte_calificacion`, objeto y detalle.
- Ocultar no borra la calificación ni el reporte. El autor no recibe una notificación automática en esta etapa.
- Si se oculta la última calificación visible, el promedio y el total quedan en 0.

### 6.6 Job de reconstrucción de promedios

Script: `npm run job:reconstruir-promedios`.

Algoritmo:

1. Toma el advisory lock (clave `41010`). Si está ocupado, termina con código 0.
2. Recorre locales y productos en lotes (por ejemplo, 100 por lote).
3. Para cada fila, calcula el promedio y el total visibles desde las calificaciones.
4. Compara con las columnas agregadas. Si difieren, bloquea la fila con `FOR UPDATE`, vuelve a calcular y actualiza.
5. Si corrigió, abre o actualiza una alerta con clave estable `promedios:local:{id}` o `promedios:producto:{id}`, tipo `promedio_inconsistente`, severidad `media`, y detalle con `antes`, `despues`, `promedio_anterior`, `promedio_nuevo`, `total_anterior`, `total_nuevo`.
6. Si no hay diferencias, no crea alerta.
7. Devuelve `{ revisados, corregidos, alertas }`.

- El job es correctivo, a diferencia de la conciliación financiera (que solo alerta). Corregir un promedio no mueve dinero ni stock.
- Es idempotente: una segunda corrida no encuentra diferencia y no duplica la alerta.
- La alerta se reutiliza por clave; si fue resuelta y la diferencia reaparece, se reabre conservando `creada_en`.
- La ejecución recomendada es diaria y separada de `job:todos` (decisión pendiente en la sección 12).

---

## 7. Jobs y operación

| Script | Clave | Frecuencia recomendada | Qué hace |
|---|---:|---|---|
| `job:notificaciones` | `41009` | Cada 5 a 10 minutos; última en `job:todos` | Procesa el outbox, crea notificaciones y borra leídas de más de 90 días |
| `job:reconstruir-promedios` | `41010` | Diaria, cron separado | Recalcula agregados de local/producto, corrige y alerta |

Cambios de infraestructura:

- Agregar `CLAVES_JOBS.notificaciones = 41009` y `CLAVES_JOBS.reconstruir_promedios = 41010` en `src/jobs/ejecutarJob.js`.
- Agregar `src/jobs/notificaciones.js`, `src/jobs/reconstruirPromedios.js`, `scripts/job-notificaciones.js` y `scripts/job-reconstruir-promedios.js`.
- Activar los descriptores de `src/jobs/index.js` y definir su orden. `notificaciones` va al final de `JOBS_EN_ORDEN` para procesar también los eventos que generen los demás jobs de la misma corrida.
- Si se aprueba que promedios no corra en `job:todos`, agregar a los descriptores un campo `incluirEnTodos` (default `true`) y filtrar en `JOBS_EN_ORDEN`. `notificaciones` queda con `true`; `reconstruir_promedios` con `false`.
- Agregar los comandos a `package.json`.
- Actualizar `docs/jobs.md` con claves, scripts, frecuencias, retención, alertas de eventos fallidos y la nota de que un único cron con `job:todos` debe correr cada 5 a 10 minutos.
- El job de notificaciones no depende de Wompi, ni de correo, ni de servicios externos. El de promedios tampoco.
- Un fallo de un evento no tumba el job completo; se registra y se reintenta. Un fallo de un lote de promedios se registra y el job sigue con el siguiente.

---

## 8. Invariantes y pruebas

### 8.1 Reglas y cobertura

| Regla | Riesgo que cubre | Pruebas obligatorias |
|---|---|---|
| Visibilidad del catálogo | Mostrar productos sin stock, de locales bloqueados o inactivos | Producto sin stock no aparece; local `bloqueado`, `suspendido` o `pendiente_aprobacion` no aparece; producto inactivo no aparece; variante inactiva no cuenta como stock |
| Búsqueda sin acentos y pesos | No encontrar “café” al buscar “cafe” o perder coincidencias de nombre | `cafe` encuentra `Café`; `Café` encuentra `cafe`; coincidencia de nombre pesa más que descripción; búsqueda por local y categoría devuelve el producto |
| Filtros y orden | Resultados fuera de rango o sin stock | Categoría (subárbol y exacta según decisión), rubro, precio mínimo/máximo, calificación mínima, local; orden por relevancia, precio, calificación y recientes; desempates estables |
| Paginación y límite anónimo | Scraping o respuestas gigantes | `por_pagina` máximo 100; página inválida se normaliza; 429 después de 60/min para anónimo; usuario autenticado no se bloquea |
| Seguir idempotente | Dos filas o contador inflado | Seguir dos veces deja una fila y `creado: false`; dejar de seguir dos veces deja cero; contador correcto; concurrencia de 10 follows deja una fila |
| Local propio | Vendedor sigue su local | 409; no se crea fila; la lista propia no lo incluye |
| Lista de seguidos | Ver locales ajenos | Solo el usuario autenticado ve su lista; paginación y orden; local bloqueado se puede dejar de seguir |
| Outbox atómico | Evento perdido si falla la operación | Insertar/actualizar el hecho y el evento en la misma transacción; un fallo revierte ambos; clave repetida no duplica |
| Notificaciones idempotentes | Dos avisos por el mismo hecho | Job dos veces deja una notificación; dos instancias no procesan el mismo evento; reintento después de fallo parcial no duplica |
| Solo verificados | Avisar a correo sin verificar | Usuario no verificado o inactivo no recibe fila; evento queda procesado; al verificar después no se crea retroactiva |
| Retención | Borrar no leídas o conservar leídas para siempre | Leída de 91 días se borra; leída de 89 días se conserva; no leída de 91 días se conserva |
| Calificación verificada | Calificar sin comprar o pedido ajeno | Solo dueño del pedido; solo entregado; producto solo de una línea del sub-pedido; vendedor no califica su local; admin no crea |
| Una calificación por recurso | Duplicados por doble clic | UNIQUE de local por sub-pedido y de producto por `detalle_id`; dos PUT concurrentes no crean dos filas |
| Edición de 7 días | Cambiar una calificación vieja | Editar en día 6 funciona; en día 8 responde 409; `PUT` repetido no duplica; identidad no se puede cambiar |
| Agregados transaccionales | Promedio o total desactualizado | Crear, editar, ocultar y mostrar recalculan en la misma transacción; dos creaciones concurrentes dejan el promedio correcto; oculta no suma; última oculta deja 0/0 |
| Reportes | Reportes duplicados o moderación sin auditoría | Un reporte por usuario/calificación; no se reporta la propia; admin resuelve una vez; ocultar recalcula; mostrar recalcula; auditoría escrita |
| Reconstrucción | Deriva de agregados | Job corrige local y producto; alerta con la misma clave; segunda corrida no duplica; dos instancias respetan el lock |
| OpenAPI y contrato | Frontend desalineado | Cada ruta nueva y cada campo nuevo están en `openapi.yaml` antes del código |

### 8.2 Pruebas de concurrencia e idempotencia obligatorias

- 10 peticiones simultáneas de seguir del mismo usuario al mismo local: una fila y contador 1.
- Seguir y dejar de seguir en paralelo: el estado final coincide con la última operación confirmada y el contador no queda negativo.
- Dos `PUT` simultáneos de la misma calificación de local: una fila y agregado correcto.
- Dos creaciones simultáneas de calificación de producto para la misma línea: una fila; la otra recibe 409 o actualiza, nunca duplica.
- Crear/editar calificación mientras el admin oculta: el lock del destino serializa y el agregado final excluye lo oculto.
- Dos jobs de notificaciones a la vez: solo uno procesa cada evento; no hay notificaciones duplicadas.
- Job de notificaciones ejecutado dos veces sobre el mismo evento: una sola notificación por usuario.
- Producto nuevo con varios seguidores: una notificación por seguidor y ninguna para no verificados; reintento no duplica.
- Dos jobs de reconstrucción de promedios a la vez: el advisory lock deja correr uno; la segunda corrida no duplica alertas.
- Dos resoluciones del mismo reporte: solo una cambia el estado; la otra recibe 409.
- Dos jobs de notificaciones y un evento creado por un job de la misma corrida de `job:todos`: el evento se procesa al final, no se pierde.

### 8.3 Archivos de prueba propuestos

- `tests/etapa5/busqueda.test.js`
- `tests/etapa5/busqueda.fts.test.js`
- `tests/etapa5/seguidores.test.js`
- `tests/etapa5/notificaciones.test.js`
- `tests/etapa5/notificaciones.job.test.js`
- `tests/etapa5/calificaciones.test.js`
- `tests/etapa5/calificaciones.reportes.test.js`
- `tests/etapa5/jobPromedios.test.js`
- `tests/limites.test.js` (se amplía para el limitador de búsqueda anónima)
- `tests/helpers/datos.js` (helpers para calificaciones, eventos y seguidores)

Se reutilizan `tests/helpers/http.js`, `tests/helpers/base.js` y `tests/helpers/datos.js`. Las pruebas de calificaciones deben ejecutarse contra PostgreSQL real porque los locks, UNIQUE parciales y agregados son parte de la regla. Las de búsqueda también, por `unaccent`, GIN y SQL crudo.

### 8.4 Pruebas de regresión

- `npm.cmd run verificar` debe seguir en verde, incluidas las 402 pruebas actuales.
- No cambia ningún test financiero de la Etapa 4.
- Las pruebas nuevas no dependen de datos globales de otras pruebas; cada una crea su catálogo y sus usuarios.
- La búsqueda no debe alterar el catálogo existente; solo lectura.

---

## 9. Rutas nuevas y permisos

Todas bajo `/api/v1`, JSON snake_case, paginación estándar y máximo 100. OpenAPI se actualiza antes de cada sub-etapa.

### 9.1 Públicas

| Método | Ruta | Permiso | Qué hace |
|---|---|---|---|
| GET | `/busqueda/productos` | Público, con límite para anónimos | Búsqueda full-text y filtros |
| GET | `/locales/{id}/calificaciones` | Público | Calificaciones visibles del local |
| GET | `/productos/{id}/calificaciones` | Público | Calificaciones visibles del producto |
| GET | `/locales/{id}` | Público; sesión opcional | Se amplía con `total_seguidores` y, si hay sesión, `siguiendo` |

### 9.2 Autenticadas

| Método | Ruta | Permiso | Qué hace |
|---|---|---|---|
| POST | `/locales/{id}/seguir` | Sesión; no dueño | Sigue un local; idempotente |
| DELETE | `/locales/{id}/seguir` | Sesión; no dueño | Deja de seguir; idempotente |
| GET | `/locales-seguidos` | Sesión | Lista paginada de locales seguidos |
| GET | `/notificaciones` | Sesión | Notificaciones propias paginadas |
| GET | `/notificaciones/no-leidas` | Sesión | Contador de no leídas |
| POST | `/notificaciones/{id}/leer` | Sesión; dueño | Marca una como leída; idempotente |
| POST | `/notificaciones/leer-todas` | Sesión | Marca todas las propias; idempotente |
| PUT | `/sub-pedidos/{id}/calificacion-local` | Comprador dueño; compra entregada | Crea o edita la calificación del local |
| PUT | `/sub-pedidos/{id}/detalles/{detalleId}/calificacion` | Comprador dueño; compra entregada | Crea o edita la calificación de la línea |
| POST | `/calificaciones-local/{id}/reportes` | Sesión; no autor | Reporta una calificación de local |
| POST | `/calificaciones-producto/{id}/reportes` | Sesión; no autor | Reporta una calificación de producto |

### 9.3 Admin

| Método | Ruta | Permiso | Qué hace |
|---|---|---|---|
| GET | `/admin/reportes-calificaciones` | Admin | Lista paginada de reportes; filtro por estado |
| POST | `/admin/reportes-calificaciones/{id}/resolver` | Admin | Oculta o descarta; audita y recalcula |
| PATCH | `/admin/calificaciones-local/{id}` | Admin | Oculta o muestra una calificación de local |
| PATCH | `/admin/calificaciones-producto/{id}` | Admin | Oculta o muestra una calificación de producto |

Reglas de permisos:

- Las rutas de notificaciones solo devuelven filas del usuario autenticado. El admin no puede leer notificaciones ajenas por estas rutas.
- Las rutas de calificación no revelan si un pedido ajeno existe: responden 404.
- El vendedor no puede crear calificaciones de su local, aunque tenga rol comprador.
- Las rutas públicas de calificaciones no muestran ocultas.
- Todas las mutaciones requieren CSRF, como el resto de la API. No se exige `Idempotency-Key` en Etapa 5 porque ninguna ruta crea pedidos, pagos ni movimientos de dinero; la idempotencia se resuelve con PK/UNIQUE y `PUT`.
- Los reportes y el ocultamiento exigen `motivo` y escriben `auditoria_admin`.

---

## 10. Casos de borde, idempotencia y concurrencia

| Caso | Qué puede pasar | Control |
|---|---|---|
| Doble clic en seguir | Dos filas o dos incrementos | PK `(usuario_id, local_id)` + `ON CONFLICT DO NOTHING` + contador calculado |
| Seguir y dejar de seguir a la vez | Estado final incierto | Operaciones de fila con locks naturales; la respuesta devuelve el estado y el contador leídos en la misma transacción |
| Vendedor sigue su local | Contador y relación inválida | Comparación `local.usuario_id` en el servicio; 409 |
| Local deja de vender después de seguido | Lista con local no visible | La lista incluye el estado; el detalle público 404; se puede dejar de seguir |
| Búsqueda con `%` o comillas | SQL roto o inyección | Parámetros Prisma + `websearch_to_tsquery`; nunca concatenar `q` |
| Búsqueda con categoría padre | Productos de subcategorías no aparecen | CTE recursiva con `UNION`; decisión pendiente |
| Producto se agota mientras se busca | Resultado obsoleto | El checkout vuelve a validar stock; la búsqueda es de lectura |
| `q` con solo stopwords | Vector de consulta vacío | Devuelve vacío; no se cae ni hace scan completo |
| Producto sin variantes activas | División por cero o precio nulo | `EXISTS` de stock lo excluye; `precio_desde` no se calcula |
| Cambio de nombre/descripción | Vector viejo | Columna generada se recalcula sola; prueba de actualización |
| `unaccent` no instalado | Migración falla | Se verifica en base limpia y se documenta el permiso de extensión |
| Evento duplicado | Dos notificaciones | UNIQUE de `clave` y `(evento_id, usuario_id)` |
| Job cae después de crear la mitad de un fan-out | Notificaciones faltantes o duplicadas | Evento sigue `pendiente` hasta el commit; reintento con `skipDuplicates` crea las faltantes |
| Usuario no verificado | Notificación prohibida | Filtro en el job; evento procesado con omitidos |
| Notificación leída hace 91 días | Basura acumulada | Borrado por lote; no toca no leídas |
| Evento falla 5 veces | Cola atascada | Estado `fallido` + alerta operativa; no bloquea el resto |
| Calificación duplicada | Dos filas | UNIQUE por sub-pedido/detalle; `PUT` reutiliza la existente |
| Dos calificaciones simultáneas | Promedio incorrecto | Lock del local/producto y recálculo dentro de la transacción |
| Admin oculta mientras el autor edita | Promedio con la calificación oculta | Lock del destino; el agregado final se recalcula con `oculta` actual |
| Se oculta la última calificación | Promedio 1..5 con total 0 | Fórmula devuelve 0/0 y CHECK lo permite |
| Se intenta editar en día 8 | Regla de 7 días evadida | Servicio + trigger de defensa; 409 |
| Sub-pedido en disputa | Calificación prematura | No elegible hasta resolver; decisión pendiente para parciales |
| Producto desactivado | Listado público 404 pero calificación existente | La calificación se conserva; el listado público respeta visibilidad |
| Reporte del propio autor | Abuso del sistema | 409/403; no se crea |
| Dos reportes del mismo usuario | Spam | UNIQUE parcial por usuario y calificación |
| Dos admin resuelven el mismo reporte | Doble ocultamiento/auditoría | `UPDATE ... WHERE estado = 'pendiente'`; segunda 409 |
| Rebuild y servicio a la vez | Promedio pisado | Ambos bloquean la fila destino; el último recálculo es correcto |
| Rebuild corrige y alerta | Alerta duplicada cada día | Clave estable y upsert de alerta |
| Job de promedios en `job:todos` | Trabajo pesado cada 5 minutos | Decisión pendiente; recomendación cron diario separado |

---

## 11. Sub-etapas y orden

Cada sub-etapa termina con OpenAPI actualizado, migración nueva (si aplica), pruebas, `npm.cmd run verificar` en verde, commit pequeño en `dev` y espera de aprobación. No se avanza sin la anterior aprobada. No se implementa en `main`.

### 5a — Búsqueda full-text y filtros

- Migración: extensión `unaccent`, función `ccv_unaccent`, columnas generadas, índices GIN e índices de filtros.
- Servicio SQL de búsqueda con visibilidad, filtros, orden, paginación y `precio_desde`/`precio_hasta`.
- Ruta pública `GET /busqueda/productos`, validación de query y serializer de resultado.
- Limitador `limiteBusquedaAnonima` (60/min) y pruebas del límite.
- Pruebas de acentos, vectores, filtros, stock, locales no vendibles, orden, paginación y EXPLAIN.
- No incluye seguidores, notificaciones ni calificaciones.

### 5b — Seguidores

- Migración `seguidor_local`.
- Rutas `POST/DELETE /locales/{id}/seguir` y `GET /locales-seguidos`.
- Contador calculado y ampliación del detalle de local con `total_seguidores` y `siguiendo`.
- Pruebas de idempotencia, local propio, permisos, paginación y concurrencia.
- No emite notificaciones todavía; deja la base para `producto_nuevo`.

### 5c — Outbox y notificaciones del comprador

- Migración de enums, `evento_notificacion`, `notificacion`, triggers e índices.
- Helper de outbox y trigger de historial de sub-pedido, reembolso completado, disputa resuelta y producto nuevo.
- Job `notificaciones` (clave 41009), script, descriptor, `docs/jobs.md` y retención.
- Rutas de lista, contador, marcar una y marcar todas.
- Pruebas de solo verificados, idempotencia, fan-out de producto nuevo, dos instancias y retención.
- Los avisos de vendedor llegan en 5d.

### 5d — Notificaciones del vendedor y advertencias de deuda

- Triggers/servicio para `pedido_nuevo` (efectivo y digital), `disputa_abierta`, `liquidacion_pagada`.
- Emisión de `deuda_cerca_limite` y `local_en_plazo` desde `recalcularEstadoLocal`, con umbral y claves únicas.
- Pruebas de cada tipo, destinatario, no duplicados, no verificados y rate de avisos.
- Ajuste de `job:todos` para que notificaciones corra al final.

### 5e — Calificaciones, compra verificada y agregados

- Migración de `calificacion_local`, `calificacion_producto`, columnas de producto, checks, índices y triggers de defensa.
- Servicio de creación/edición con elegibilidad, ventana de 7 días y locks.
- Cálculo transaccional de agregados de local y producto.
- Rutas `PUT` de local y producto, listados públicos y ampliación de serializers.
- Pruebas de compra verificada, vendedor propio, UNIQUE, 7 días, ocultas y concurrencia.
- No incluye reportes ni job de reconstrucción.

### 5f — Reportes y moderación

- Migración de `reporte` y enum `estado_reporte`.
- Rutas de reporte de calificaciones y rutas de admin.
- Ocultar/mostrar con recálculo, auditoría y resolución de reportes.
- Pruebas de duplicados, autor, permisos, auditoría y concurrencia.
- Listados públicos excluyen ocultas.

### 5g — Job de reconstrucción de promedios

- `src/jobs/reconstruirPromedios.js`, script, clave 41010, descriptor y documentación.
- Corrección de locales y productos, alerta deduplicada y resultado del job.
- Pruebas de deriva provocada, dos corridas, dos instancias y alerta.
- Decisión de si entra o no en `job:todos`; recomendación: cron diario separado.

### 5h — Cierre de la etapa

- OpenAPI completo y revisado.
- `docs/jobs.md` actualizado.
- Pruebas de regresión de Etapa 4 y 5, `npm.cmd run verificar` en verde.
- Revisión manual de contratos, paginación, errores y límites.
- Prueba de EXPLAIN de búsqueda con datos representativos.
- Commit final de documentación y espera de aprobación. No se inicia la Etapa 6.

Orden elegido: búsqueda primero porque es independiente y valida las extensiones; seguidores antes de notificaciones porque `producto_nuevo` los necesita; outbox y comprador antes del vendedor porque comparten job y tablas; calificaciones después de notificaciones para no mezclar dos migraciones grandes; reportes después de calificaciones; y la reconstrucción al final, cuando ya existen datos y agregados que reparar.

---

## 12. Decisiones pendientes y recomendaciones

### 12.1 Decisiones ya fijadas por el pedido

Estas no se reabren salvo que el usuario lo pida:

- Full-text en español con `unaccent` envuelto en una función `IMMUTABLE`.
- Vectores de producto (nombre/descripción), local y categoría global, con GIN.
- Filtros por categoría global, rubro, precio, calificación, local y stock; orden por relevancia, precio, calificación y recientes.
- Solo productos activos de locales `activo`/`en_plazo` y con stock visible.
- Seguir/dejar de seguir idempotente, lista de seguidos, bloqueo de seguir el propio local y contador.
- Notificaciones por job de outbox, solo para correo verificado, con los tipos iniciales indicados, lista paginada, contador, marcar una/todas y borrar leídas a los 90 días.
- Calificaciones de local por sub-pedido y de producto por línea; 1–5 estrellas, comentario opcional máximo 500; edición 7 días; compra verificada; vendedor no califica su local; agregados transaccionales; job de reconstrucción que corrige y alerta; reporte y ocultamiento admin; promedio excluye ocultas.
- Fuera de alcance: home/publicidad, migración de `vistas_producto`, respuestas del vendedor y subida de fotos.

### 12.2 Pendientes que requieren respuesta del usuario

1. **Categoría global: exacta o subárbol.**
   - Recomendación: **subárbol**. Si el usuario elige “Restaurantes”, espera ver también “Comida rápida” y “Postres” dentro de esa rama. Se implementa con CTE recursiva y `UNION`.
   - Si se elige exacta, el filtro por categorías padre será más pobre y el frontend tendrá que mandar la hoja.

2. **`calificacion_min`: sobre el local o sobre el producto.**
   - Recomendación: **sobre el local** (`local.promedio_calificacion`). Es el dato que ya existe, tiene más volumen y representa la reputación del vendedor; el producto recién empieza y muchos resultados quedarían fuera.
   - Si se quiere filtrar por producto, se agrega `calificacion_producto_min` en la Etapa 5e, después de que existan las columnas de producto. No se mezcla con el filtro actual.

3. **Contador de seguidores: calculado o columna.**
   - Recomendación: **calculado** con `COUNT(*)` sobre `seguidor_local`, expuesto como `total_seguidores`. Evita una columna que se desincronice y no requiere job de reparación.
   - Si el volumen lo justifica, se puede denormalizar después con un trigger o un job, pero no en la primera versión.

4. **Captura de eventos: triggers/outbox o servicios.**
   - Recomendación: **outbox con triggers para los hechos inmutables** (historial de pedido, reembolso, disputa, liquidación, producto, pedido nuevo) **y helper de servicio para las advertencias de deuda**. Garantiza que ninguna ruta nueva olvide el evento y que el evento sea atómico con el hecho.
   - Alternativa: todos los eventos desde servicios Node. Es más fácil de leer, pero el riesgo de olvidar un camino (jobs, cancelaciones, webhooks) es real.

5. **¿El job de promedios entra en `job:todos`?**
   - Recomendación: **no**. `notificaciones` sí debe correr cada 5–10 minutos y estar en `job:todos`; `reconstruir_promedios` puede ser diario y no necesita competir con la operación normal.
   - Si se usa un único cron, se puede aceptar que corra cada 5–10 minutos porque es idempotente y no mueve dinero, pero se documenta el costo. La propuesta es agregar `incluirEnTodos: false` para promedios.

6. **Ventana de calificación en disputas y reembolsos parciales.**
   - Recomendación: permitir calificar cuando `fecha_entrega` existe y el sub-pedido está `entregado` o `reembolsado_parcial`; **no** permitir mientras esté `en_disputa` ni si el reembolso es total. Editar durante 7 días desde la creación de la calificación.
   - Si el usuario prefiere que la ventana de 7 días cuente desde la entrega, cambia la regla y las pruebas; hay que decidirlo antes de 5e.

7. **Umbral de “deuda cerca del límite”.**
   - Recomendación: **80% de `limite_deuda`**, una sola notificación por local y día UTC, y solo si el local no está suspendido. El valor exacto es una decisión de negocio; el plan usa 80% como valor inicial.
   - También se puede optar por avisar solo al cruzar el umbral, no una vez por día; la recomendación es una vez por día mientras siga por encima, para no spamear.

8. **“Solo con stock”: filtro opcional o regla dura.**
   - Recomendación: **regla dura**. El parámetro `solo_con_stock` se acepta por compatibilidad de contrato, pero `false` responde 400; no se promete un catálogo que el checkout no puede cumplir.

### 12.3 Decisiones que tomo por defecto (salvo que digas lo contrario)

- Ruta de búsqueda: `GET /api/v1/busqueda/productos`.
- Rutas de seguidos y notificaciones en la raíz de `/api/v1`, no bajo `/comprador`, porque también las usa un vendedor que sigue otros locales.
- Calificaciones con `PUT` upsert; no `POST` + `PATCH`.
- Edición de calificación: 7 días desde `calificada_en` (creación), no desde la entrega.
- Comentario vacío se guarda como `null`; no se permiten imágenes en la calificación.
- Notificación de producto nuevo: solo a seguidores verificados al momento de procesar el evento; no hay retroactivos.
- Notificación de nuevo pedido: efectivo al crear el sub-pedido, digital al aprobarse el pago.
- Notificación de deuda: 80% del límite y una por día; `local_en_plazo` por cada fecha límite.
- Lote de notificaciones: 200 eventos por corrida, 500 destinatarios por lote interno.
- Retención de leídas: 90 días desde `leida_en`; las no leídas no se borran.
- Respuesta de listas: `{ datos, paginacion }`; contador de no leídas en ruta separada.
- Búsqueda ordenada por defecto: relevancia si hay `q`; recientes si no.
- El autor de una calificación se muestra con su nombre visible, nunca email ni id de usuario.
- No se toca `main`; todo va a `dev` en commits pequeños.

### 12.4 Pendientes previos al despliegue (heredados)

- Sigue vigente el pendiente de `npm audit` de la Etapa 4: no ejecutar `npm audit fix`; evaluar la migración mayor de Prisma por separado antes de desplegar.
- La extensión `unaccent` debe estar permitida para el rol de migraciones en producción. Si el hosting no lo permite, se debe provisionar antes de la sub-etapa 5a; no hay un fallback aceptable con `lower()` porque no quita acentos.
- Las notificaciones no requieren proveedor de correo; si más adelante se agregan correos, se retoma la decisión de proveedor y límites.

---

## 13. Criterios de aceptación de la etapa

1. Buscar `cafe`, `café` y `CAFÉ` devuelve los mismos productos; la búsqueda por nombre de local y categoría también funciona.
2. Los filtros de categoría, rubro, precio, calificación, local y stock devuelven solo productos visibles; ningún local bloqueado, suspendido o pendiente aparece.
3. El orden por relevancia, precio ascendente/descendente, calificación y recientes es estable y paginado; `por_pagina` nunca supera 100.
4. El anónimo recibe 429 después del límite configurado; un usuario autenticado no se ve afectado por ese límite.
5. Seguir y dejar de seguir son idempotentes; el contador coincide siempre con las filas; no se puede seguir el local propio.
6. El job de notificaciones procesa el outbox, no duplica, no notifica a no verificados y borra solo leídas de más de 90 días.
7. Las notificaciones de comprador y vendedor de los tipos iniciales se generan en los hechos correctos y solo para los destinatarios correctos.
8. Solo un comprador con sub-pedido entregado puede calificar; hay una calificación de local por sub-pedido y una por línea; el vendedor no califica su local.
9. La edición funciona dentro de 7 días y falla después; los agregados se actualizan en la misma transacción y excluyen ocultas.
10. Reportar es único por usuario/calificación; el admin puede ocultar/mostrar con auditoría; el promedio cambia de inmediato.
11. El job de promedios corrige una deriva provocada, alerta una sola vez y no duplica en dos corridas.
12. `openapi.yaml` y `docs/jobs.md` están actualizados; `npm.cmd run verificar` pasa con las pruebas nuevas y las 402 existentes.
13. No hay cambios en ledger, saldos, stock ni jobs financieros de la Etapa 4.
14. No se creó la tabla `vistas_producto`, no se implementó la home ni publicidad, no hay respuestas del vendedor ni subida de fotos.

---

## 14. Fuera de alcance de esta etapa

- Home dinámica, bloques de recomendaciones, más vendidos y publicidad: Etapa 6.
- Migración, escritura o lectura real de `vistas_producto`: solo queda el diseño de 2.6. La Etapa 6 decidirá el job de retención de 90 días.
- Respuestas del vendedor a calificaciones y fotos en calificaciones.
- Notificaciones por correo, push, SMS o WhatsApp; las notificaciones de esta etapa son solo dentro de la web.
- Búsqueda difusa con `pg_trgm`, autocompletado, sugerencias, sinónimos o búsqueda por voz.
- Ranking por ventas, publicidad o personalización; eso pertenece a la home de la Etapa 6.
- Panel de administración de métricas de búsqueda o de notificaciones; solo se agregan las rutas de moderación de calificaciones y las alertas operativas existentes.
- Cambios en las reglas de dinero, stock, pedidos, pagos, reembolsos, disputas o liquidaciones.
- Borrado de calificaciones o reportes; se conservan para auditoría.
