# Centro Comercial Virtual - Especificación V4 (consolidada)

Documento único. Reemplaza V1, V2, V2.1, V2.2, V3 y V3.1. Implementar solo desde este texto.

## 1. Decisiones ya tomadas

- Marketplace tipo centro comercial digital con locales independientes de cualquier rubro. Cada vendedor arma su local.
- Primero web con React (Vite). App móvil en el futuro, reutilizando el backend.
- Dos repositorios: frontend (React) y backend (Node.js + Express). PostgreSQL. GitHub, ramas `main` y `dev`.
- Ingresos: comisión del 5% sobre el valor de los productos (nunca sobre el envío) y espacios publicitarios pagos por tiempo limitado.
- Pagos con Wompi, recaudo centralizado y pago por lotes a cada vendedor (sujeto a la compuerta legal).
- Efectivo: el vendedor cobra todo y la comisión se acumula como deuda con la plataforma. Al superar un límite recibe un plazo; si vence sin pagar, el local se bloquea.
- Envío: lo paga el comprador aparte, calculado por distancia (Haversine + tarifa por km). Entregan apps tipo Rappi o repartidores; el vendedor actualiza el estado.
- Carrito multi-local con un solo pago, dividido en sub_pedidos por local.
- Seguir locales con notificaciones en la web. Calificaciones de locales y productos.
- Home con 4 bloques: más vendidos globales, banners de locales, espacios publicitarios, recomendados por categoría.
- Atributos de producto libres (JSONB).

## 2. Compuertas y decisiones pendientes

**Compuerta legal** (bloquea salir a producción, no bloquea construir):

- Abogado y contador deben validar el modelo de recaudo centralizado: responsabilidad frente al consumidor, facturación electrónica, retenciones e impuestos sobre comisiones. No afirmar en los términos que la plataforma "no responde" hasta tener esa respuesta.
- Llevar al abogado, tal cual: (a) en pagos en efectivo la plataforma solo media y el comprador no tiene protección de fondos; (b) quién paga el retorno de un producto ya despachado; (c) la política de reembolsos por línea; (d) el mínimo de días de retención.
- Decisión de diseño abierta en paralelo: recaudo centralizado vs pago dividido. Se cierra a más tardar al final de la Etapa 3. El ledger y la tabla `pago` soportan ambos.

**Economía:** con las tarifas vigentes de Wompi, medir el costo por método de pago y definir pedido mínimo, comisión mínima por sub_pedido y si hay cargo fijo por pedido.

**Otras decisiones (antes de la Etapa 3):** árbol de categorías globales y rubros iniciales; si se filtra por subcategorías libres del local (si sí, deben ser globales); valores iniciales de `limite_deuda`, `plazo_dias`, `dias_auto_entrega`, `dias_retencion`, `tarifa_base_envio`, `tarifa_por_km`.

**Propuestas incorporadas al diseño:** variantes de producto desde el inicio; un usuario puede ser comprador y vendedor a la vez.

## 3. Modelo de datos

Todos los montos en pesos, como enteros.

- **usuario**: id, nombre, email, email_verificado, password_hash (bcrypt), acepto_terminos, fecha_aceptacion.
- **usuario_rol**: usuario_id, rol (comprador / vendedor / admin).
- **token_verificacion**: usuario_id, tipo (verificar_email / reset_password), token_hash, expira, usado.
- **direccion**: id, usuario_id, texto, latitud, longitud.
- **rubro**: id, nombre (lista corta que administra el admin).
- **local**: id, usuario_id, rubro_id, nombre, logo_url, banner_fondo_url, latitud, longitud, estado (pendiente_aprobacion / activo / en_plazo / bloqueado / suspendido), promedio_calificacion, total_calificaciones. Todo local nuevo nace en pendiente_aprobacion.
- **categoria_global**: id, nombre, padre_id, rubro_id opcional (la administra el admin).
- **subcategoria_local**: id, local_id, nombre (libre).
- **producto**: id, local_id, categoria_global_id, subcategoria_local_id opcional, nombre, descripcion, fotos, atributos (JSONB), activo. No se borra, se desactiva.
- **producto_variante**: id, producto_id, atributos (JSONB), precio, stock, activo. Un producto simple tiene una sola variante.
- **carrito** y **carrito_item**: usuario_id, variante_id, cantidad.
- **pedido**: id, usuario_id, direccion (copia congelada de texto y coordenadas), total, metodo_pago, estado, config_snapshot (JSONB, ver 4.2).
- **historial_estado_pedido**: pedido_id, estado_anterior, estado_nuevo, fecha.
- **sub_pedido**: id, pedido_id, local_id, nombre_local (congelado), subtotal_productos, costo_envio, comision, total, estado, evidencia_envio, entrega_confirmada_por (comprador / vendedor / sistema), fecha_entrega, saldo_liberado_en (nullable), notas_entrega. Los campos subtotal_productos, costo_envio, comision y total son snapshots inmutables: nunca se modifican.
- **historial_estado_sub_pedido**: sub_pedido_id, estado_anterior, estado_nuevo, cambiado_por, fecha.
- **detalle_producto**: sub_pedido_id, variante_id, nombre_producto (congelado), atributos_elegidos, cantidad, precio_unitario.
- **pago**: id, tipo_pago (pedido / publicidad), pedido_id nullable, espacio_publicitario_id nullable, referencia (UNIQUE, generada por el backend con un identificador aleatorio, nunca derivada de local_id ni de la hora), id_transaccion_wompi nullable, metodo_pago (tarjeta / pse / nequi / efectivo / manual ...), monto, monto_reembolsado, estado (pendiente / aprobado / rechazado / reembolsado / reembolsado_parcial), fecha_creacion, fecha_actualizacion. Todo pedido tiene exactamente un pago; todo anuncio pagado tiene un pago.
- **evento_webhook**: id, referencia, payload, procesado, resultado (ok / ignorado / referencia_desconocida / firma_invalida), fecha. Se guarda todo evento recibido de Wompi.
- **idempotencia**: clave, usuario_id, ruta, estado (en_proceso / completada), codigo_http, respuesta_json, fecha, expira. UNIQUE (usuario_id, ruta, clave).
- **ledger** (solo se agregan filas): id, local_id NULLABLE, sub_pedido_id, pago_id, reembolso_id, liquidacion_id, tipo (venta / comision / reversa_comision / pago_recibido / cobro_deuda / pago_a_local / reembolso / ingreso_publicidad / ajuste / ajuste_redondeo), monto, fecha. Las filas sin local_id son ingresos de la plataforma y nunca suman al saldo_por_pagar de un local.
- **cuenta_local**: local_id, saldo_deuda, saldo_por_pagar, saldo_congelado, fecha_limite_pago (nullable, una sola por local). Son saldos derivados del ledger.
- **liquidacion**: id, fecha, estado, total_pagado, referencia_payout. Agrupa los movimientos incluidos en cada pago por lote.
- **disputa**: id, sub_pedido_id, usuario_id, tipo (digital / efectivo), motivo, estado (abierta / resuelta_comprador / resuelta_vendedor), monto_congelado (0 o NULL en efectivo), fecha_apertura, fecha_resolucion.
- **reembolso**: id, pago_id, sub_pedido_id, disputa_id nullable, tipo (digital / efectivo), monto, estado (pendiente / completado / incumplido / fallido), motivo, fecha_limite (para efectivo), fecha.
- **reembolso_linea**: reembolso_id, detalle_id, cantidad, monto.
- **seguidores**, **notificaciones**, **calificaciones_local**, **calificaciones_producto**, **vistas_producto** (usuario_id o sesion_anonima; una sola fila por usuario o sesión, producto y hora; retención de 90 días), **reporte**.
- **espacio_publicitario**: local_id, imagen_url, texto, link, dominio_destino, estado (pendiente_aprobacion / aprobado / rechazado / vencido), fecha_inicio, fecha_fin, precio.
- **auditoria_admin**: origen (admin / sistema), admin_id nullable, accion, objeto, objeto_id, fecha.
- **configuracion** (clave, valor, tipo: entero / numero / texto / booleano): porcentaje_comision, comision_minima, pedido_minimo, tarifa_base_envio, tarifa_por_km, dias_retencion, limite_deuda, plazo_dias, dias_auto_entrega, minutos_expiracion_pago, horas_aceptacion.

## 4. Reglas de negocio

### 4.1 Checkout, pago y webhook

1. **Checkout** (`POST /api/v1/pedidos`, con `Idempotency-Key`): se valida que haya stock (solo se verifica, no se descuenta) y se avisa al comprador antes de mandarlo a pagar. El backend calcula todos los montos y crea `pedido`, `sub_pedidos` y `detalle_producto` con `config_snapshot`. Los montos quedan congelados; un cambio de precio posterior no afecta ese pedido.
2. **Pago digital:** el pedido nace en `pendiente_pago`. Se crea la fila en `pago` (pendiente) con su referencia y se envía a Wompi.
3. **Webhook:** (a) verifica la firma o el secreto de eventos de Wompi según la documentación vigente; (b) guarda el evento en `evento_webhook`; (c) si la referencia no existe en `pago`, no se descarta en silencio: se registra como `referencia_desconocida` y se alerta al admin (puede ser un pago tardío de un pedido ya expirado, que exige reembolso manual); (d) confirma el estado de la transacción consultando la API de Wompi antes de aprobar.
4. **Confirmación**, en DOS transacciones distintas (no implementarlo en una sola: si el descuento de stock falla dentro de una transacción, esta se aborta entera y el pago nunca queda aprobado en la base):
   - **Transacción A (camino feliz):** descontar el stock de todas las variantes del pedido, marcar el pago aprobado, registrar en el ledger, actualizar saldos y pasar el pedido a `en_proceso`. Si el stock de cualquier variante no alcanza (o la variante fue desactivada), la transacción A se aborta completa y no queda nada a medias.
   - **Transacción B (camino de fallo por stock):** marcar el pago aprobado, registrar `pago_recibido` y el reembolso total en el ledger, crear el reembolso total automático, cancelar TODOS los sub_pedidos del pedido (no solo el que falló, para que el pedido quede coherente como `cancelado`) y notificar al comprador.
   - La orden de reembolso a Wompi se ejecuta DESPUÉS del commit, mediante un proceso con reintentos; nunca se llama a la API de Wompi dentro de una transacción de base de datos. Mientras tanto el reembolso queda en estado `pendiente`.
   - **Seguimiento obligatorio de reembolsos:** todo reembolso `pendiente` con más de una hora genera alerta al admin. Tras N reintentos fallidos (parámetro, PROPUESTA 5) el reembolso pasa a `fallido` con alerta de nivel alto; ese cambio lo escribe el proceso de reintentos. El panel de admin incluye un botón de reintento manual, que registra `auditoria_admin`.
5. **Regla del handler:** si el pago ya está aprobado con sus efectos, se ignora; si existe pero no está aprobado, se retoma el procesamiento.
6. **Pago manual** (publicidad): el admin crea la fila en `pago` con `tipo_pago = publicidad`, `metodo_pago = manual`, estado aprobado, sin `id_transaccion_wompi`, y queda en `auditoria_admin`. La conciliación contra Wompi excluye `metodo_pago = manual` y `efectivo`.

7. **Respuestas HTTP del webhook** (para no perder pagos en silencio):
   - Responder 200 solo DESPUÉS de procesar el evento o de registrar su resultado. Si se responde 200 y luego falla, Wompi no reintenta y ese pago se pierde.
   - 5xx en fallos transitorios (timeout de la API de Wompi, base de datos caída): Wompi reintenta y la regla del paso 5 retoma el procesamiento.
   - 200 con el resultado guardado en `evento_webhook` para los casos no transitorios `ok`, `ignorado` y `referencia_desconocida` (este último además genera alerta).
   - `firma_invalida`: responder 401 y registrar el evento. Si una firma legítima falla por un secreto mal configurado, el reintento de Wompi permite recuperar el evento una vez corregido.

### 4.2 Configuración: qué se congela

- **Se congelan** en `pedido.config_snapshot` al crear el pedido: porcentaje_comision, comision_minima, tarifa_base_envio, tarifa_por_km, pedido_minimo, dias_retencion.
- **Se leen en vivo:** limite_deuda, plazo_dias, dias_auto_entrega, minutos_expiracion_pago, horas_aceptacion.
- Criterio: si el valor decide sobre una relación económica con alguien que ya pagó, se congela; si decide la política interna de cobranza u operación, se lee en vivo.
- `dias_retencion` tiene un mínimo duro (PROPUESTA: 3 días, a confirmar con el abogado).
- Todo cambio de configuración queda en `auditoria_admin`. Si cambia `limite_deuda`, se recalcula el estado de los locales (ver 4.7).

### 4.3 Estados y entrega

- `sub_pedido.estado`: pendiente, preparando, enviado, entregado, en_disputa, cancelado, reembolsado, reembolsado_parcial.
- **Terminales:** entregado, cancelado, reembolsado, reembolsado_parcial. `en_disputa` no es terminal.
- Para marcar `enviado` el vendedor debe adjuntar evidencia (código de seguimiento, foto o referencia del domiciliario).
- Si pasan `dias_auto_entrega` desde `enviado` sin confirmación, el sistema marca `entregado` con `entrega_confirmada_por = sistema` y notifica al comprador. Esto solo inicia el reloj de retención; no libera dinero.
- Se puede abrir una disputa mientras dure la retención, aunque el sub_pedido ya esté entregado; en ese caso pasa a `en_disputa`. El estado `entregado` (incluso confirmado por el sistema) permite calificar.
- **pedido.estado** se deriva de los sub_pedidos, con una excepción: `expirado` es un estado explícito y terminal (pedido digital que venció sin pago) que escribe únicamente el job de expiración. La función de derivación debe devolverlo sin tocarlo si lo encuentra y nunca sobrescribirlo (mismo patrón que los estados de local que solo mueve el sistema). `pendiente_pago` solo para pagos digitales aún no aprobados. Luego: `en_proceso` si algún sub_pedido no es terminal; `completado` si todos son terminales y al menos uno es entregado o reembolsado_parcial; `cancelado` si todos son cancelado; `reembolsado` en los demás casos terminales (ninguno entregado y al menos uno reembolsado).
- "El pedido terminó" y "el dinero se movió" son hechos distintos: lo segundo se guarda en `sub_pedido.saldo_liberado_en`.

### 4.4 Efectivo

- Solo en pedidos de un único local. Los pedidos con varios locales exigen pago digital.
- El pedido en efectivo nace directamente en `en_proceso`, con el sub_pedido en `pendiente` y su fila en `pago` (`metodo_pago = efectivo`, estado pendiente). No toca el stock.
- El vendedor acepta el pedido (pasa a `preparando`) y en ese momento se descuenta el stock de forma atómica. Si ya no hay stock o la variante fue desactivada, no puede aceptarlo: el sub_pedido se cancela y se notifica al comprador.
- Si el vendedor no acepta dentro de `horas_aceptacion`, un job cancela el sub_pedido (sin haber tocado stock).
- PROPUESTA: código de cierre de entrega como evidencia del cobro.
- Al marcarse `entregado`, el pago pasa a aprobado y la comisión se suma a `saldo_deuda` con su registro en el ledger.

### 4.5 Stock

- No hay reservas. El descuento es atómico y condicionado: `UPDATE producto_variante SET stock = stock - n WHERE id = X AND stock >= n AND activo = true`; si no afecta filas, falla.
- Pago digital: se descuenta al confirmar el pago (4.1.4). Efectivo: al aceptar el vendedor (4.4).
- Al cancelar un sub_pedido cuyo stock ya se descontó, el stock se devuelve.

### 4.6 Ledger, saldos y liquidaciones

- El ledger es la fuente de verdad. Los saldos de `cuenta_local` se actualizan en la misma transacción que cada movimiento, mediante un único servicio. Un job nocturno recalcula los saldos desde el ledger y alerta si no coinciden.
- **Liberación de saldo:** un job libera a `saldo_por_pagar` los sub_pedidos entregados con `saldo_liberado_en` nulo, sin disputa abierta, sin reembolso pendiente y con `fecha_entrega + dias_retencion` (del snapshot) <= ahora, y llena `saldo_liberado_en`.
- Una liquidación no incluye saldo de sub_pedidos con un reembolso pendiente; se incluye cuando ese reembolso quede `completado` o `fallido`.
- **Pagos por lotes:** cada lote es una `liquidacion` que referencia los movimientos del ledger incluidos.
- **Compensación de deuda:** solo durante la liquidación, nunca de forma continua. Solo puede tomar saldo liberado (`saldo_liberado_en` no nulo y sin disputa abierta); el saldo retenido o congelado no se toca. Si no alcanza, se compensa lo disponible y el resto sigue como `saldo_deuda`; `limite_deuda` se evalúa siempre sobre el `saldo_deuda` neto después de compensar.
- **Conciliación:** test y job que comparan la suma de pagos aprobados por Wompi en el ledger con el reporte de Wompi.

### 4.7 Deuda y estado del local

Una sola función, `recalcular_estado_local(local)`, que se ejecuta después de cada evento que cambia `saldo_deuda`, `limite_deuda` o el estado de un reembolso en efectivo (venta en efectivo, pago de deuda, compensación, cambio de configuración, reembolso incumplido o pagado):

```
si estado in (suspendido, pendiente_aprobacion): no hacer nada   # solo los mueve el admin
si estado = bloqueado:
    si saldo_deuda <= 0 y no hay reembolsos en efectivo incumplidos: estado = activo, fecha_limite_pago = null
    en otro caso: no hacer nada
en otro caso:
    # primero la obligacion por reembolso en efectivo; no depende de limite_deuda
    si hay reembolsos en efectivo incumplidos sin pagar:
        estado = en_plazo, fecha_limite_pago = min(existente, hoy + plazo_dias)
    sino si saldo_deuda <= 0:
        estado = activo, fecha_limite_pago = null
    sino si saldo_deuda > limite_deuda:
        estado = en_plazo, fecha_limite_pago = min(existente, hoy + plazo_dias)
    sino:
        estado = activo, fecha_limite_pago = null
```

- Un reembolso en efectivo "incumplido" es el que venció sin que el vendedor reembolsara y cuyo monto sigue sin cubrirse. Cuando un pago de deuda o una compensación cubre ese monto, el reembolso pasa a `completado`.
- Job diario: locales `en_plazo` con `fecha_limite_pago` vencida y (`saldo_deuda > 0` o reembolsos incumplidos sin pagar) pasan a `bloqueado`. Todo cambio automático registra `auditoria_admin` con `origen = sistema`.
- Esta función reemplaza cualquier otra regla dispersa sobre estados del local, y es el lugar único donde se prueba esa máquina de estados.

### 4.8 Disputas

- Alcance: los productos del sub_pedido; el costo_envio solo se disputa si no hubo entrega.
- **Digital:** se congela en `saldo_congelado` el monto disputado, hasta el saldo disponible.
- **Efectivo:** no se congela nada. Si se resuelve a favor del comprador, el vendedor debe reembolsar antes de `reembolso.fecha_limite`. Si vence sin reembolso, el reembolso pasa a `incumplido`, el monto se suma a `saldo_deuda` y se ejecuta `recalcular_estado_local`, que lo deja en `en_plazo` con su fecha; si ese plazo también vence sin pagar, pasa a `bloqueado`.
- En efectivo la plataforma solo media; esto debe estar escrito literalmente en los términos.

### 4.9 Reembolsos y comisión

- Se reembolsan líneas de `detalle_producto`, por unidades enteras (nunca fracciones), mediante `reembolso` y `reembolso_linea`.
- El costo_envio no se reembolsa, salvo producto defectuoso o entrega no realizada.
- Los campos snapshot de `sub_pedido` nunca se modifican. El reembolso vive en `reembolso`, `reembolso_linea` y el ledger; el neto actual es siempre derivado.
- **Comisión tras un reembolso:** `subtotal_restante = subtotal_productos - reembolsado_acumulado`; `comision_objetivo = 0` si no queda nada, de lo contrario `max(redondear(subtotal_restante * porcentaje_snapshot), comision_minima_snapshot)`; `reversa = comision_neta_actual - comision_objetivo`, registrada en el ledger como `reversa_comision`. Si aun así aparece una diferencia de pesos, va a `ajuste_redondeo`.
- `sub_pedido` pasa a `reembolsado_parcial` o `reembolsado` según lo reembolsado.
- `pago.monto_reembolsado` suma solo los reembolsos en estado `completado`. `pago.estado` se deriva de él: 0 es aprobado; entre 0 y monto es reembolsado_parcial; igual o mayor es reembolsado. `reembolso.estado` es el ciclo de vida de cada operación (pendiente, completado, incumplido, fallido).
- Un reembolso `pendiente` no cuenta en `monto_reembolsado`, pero el pedido muestra un indicador visible de "devolución en curso" (se calcula: existe un reembolso pendiente) y el saldo del vendedor correspondiente no se libera ni se liquida hasta que el reembolso quede `completado` o `fallido`. Verificar en la documentación de Wompi cómo se ejecutan los reembolsos.

### 4.10 Cancelaciones

PROPUESTA: el comprador cancela solo en `pendiente`; en `preparando` solo si el vendedor acepta; en `enviado` no se cancela, se abre una disputa. Al cancelar se devuelve el stock descontado y, si fue digital, se reembolsa el sub_pedido. Se implementa en la Etapa 4; antes no se muestra el botón.

### 4.11 Envío y redondeo

- Envío: Haversine entre local y dirección, tarifa base + tarifa por km; cada sub_pedido tiene su propio costo de envío.
- Comisión sobre el `subtotal_productos` del sub_pedido (no por línea), redondeada al peso. Test con varias líneas y residuos. La misma regla explícita para el envío y para repartir un pago entre locales. Todo se calcula en el backend.

### 4.12 Publicidad

- El anuncio nace en `pendiente_aprobacion` y solo se muestra tras aprobación del admin. Se valida https y el banner muestra visible el dominio de destino ("Patrocinado - ejemplo.com"); el admin puede rechazarlo.
- El ingreso se registra en el ledger como `ingreso_publicidad`, sin `local_id`.

### 4.13 Restricciones de integridad

Un CHECK de Postgres solo ve una fila. Estas reglas se hacen cumplir en la capa transaccional (servicio único que bloquea con `SELECT ... FOR UPDATE` las filas de pago y pedido), o con constraint triggers diferidos, y además un job nocturno las verifica y alerta:

- pedido.total = suma de sub_pedido.total
- suma de reembolsos de un pago <= pago.monto
- suma de reembolsos de una línea <= su monto original
- pago.monto_reembolsado = suma de reembolsos en estado completado del pago
- al crear un producto, categoria_global.rubro_id es nulo o igual a local.rubro_id

Debe existir un test explícito que intente violar cada una.

## 5. Búsqueda, notificaciones y home

- **Búsqueda:** PostgreSQL full-text en español. `unaccent()` es STABLE y Postgres no la acepta en índices ni columnas generadas: crear antes una función envoltorio IMMUTABLE. El tsvector del producto cubre nombre y descripción; local y categoria_global necesitan su propio vector o un trigger. Índice GIN. Filtros por categoría global, rubro, precio, calificación, local y stock.
- **Notificaciones:** se crean en un job en segundo plano por lotes. Requiere email verificado.
- **Home:** visible sin login; recomendaciones personalizadas solo con sesión. Más vendidos: ventana móvil de 30 días. Debe funcionar con pocos datos: ocultar secciones vacías, sembrar locales y productos de ejemplo y mostrar destacados mientras no haya ventas.

## 6. Contrato de API

- Prefijo de versión en todas las rutas: `/api/v1/...`
- Formato de error único: `{ "error": { "codigo": "...", "mensaje": "..." } }`. El frontend reacciona al código, nunca al texto.
- Listas paginadas desde el primer endpoint (`?pagina=`, `?por_pagina=`, con máximo definido); la respuesta incluye total y página actual.
- JSON con nombres de campo en snake_case, igual que la base de datos; fechas en ISO 8601 UTC; dinero siempre como entero en pesos.
- **Idempotencia:** los POST que crean pedido o pago exigen `Idempotency-Key`, almacenada en la tabla `idempotencia` (vigencia sugerida: 24 horas). Si llega una clave repetida con la primera solicitud aún en proceso, el servidor responde 409 con código `solicitud_en_proceso` y el cliente consulta; si ya terminó, devuelve la misma respuesta guardada.
- La especificación OpenAPI vive en el repositorio del backend y es la fuente de verdad; el frontend se valida contra ella o genera sus tipos de ella. Se documenta cada grupo de rutas antes de implementarlo.

## 7. Seguridad, operación, hosting y pruebas

- bcrypt, rate limiting, HTTPS, ORM, variables de entorno fuera del repositorio. Nunca guardar datos de tarjeta.
- Sesión: cookie httpOnly con protección anti-CSRF. Para acciones de admin, token de vida corta o versión de token que se invalide al cambiar el rol.
- **Dominios:** dominio propio para todo desde el principio, incluido el ambiente de pruebas: `app.tudominio.co` (frontend) y `api.tudominio.co` (backend). Con el mismo dominio registrable la cookie usa `SameSite=Lax` y `Domain=.tudominio.co`.
- El primer administrador se crea con un script de arranque (seed) que usa variables de entorno.
- Verificación de email y CAPTCHA en el registro de vendedores. Moderación obligatoria con `auditoria_admin`.
- **Almacenamiento de archivos** (logo_url, banner_fondo_url, fotos de producto y evidencia_envio): bucket propio compatible con S3, con rutas por usuario o local, límite de tamaño, formatos permitidos validados por el contenido real del archivo (no solo por la extensión) y nombres generados por el sistema (nunca el nombre original). Los archivos de `evidencia_envio` tienen acceso restringido, mediante URLs firmadas de corta duración, y solo los ven el vendedor, el comprador del pedido y el admin, porque son evidencia en una disputa. Si se usa un CDN, su dominio se agrega al Content-Security-Policy. Como la evidencia es requisito para marcar `enviado`, el flujo de subida debe tener manejo de errores y reintentos, para que un fallo no bloquee la entrega del vendedor.
- **Correo transaccional:** un proveedor (por ejemplo Resend, Postmark o SES) enviando desde un dominio propio con SPF, DKIM y DMARC configurados. Solo se envían correos de verificación de email y de restablecimiento de contraseña; las notificaciones son dentro de la web. Límite de envíos por usuario y expiración de los tokens (`token_verificacion`).
- Logs estructurados y seguimiento de errores desde la Etapa 1. Backups automáticos de PostgreSQL con prueba periódica de restauración.
- **Migraciones:** una migración ya aplicada nunca se edita; se agrega una nueva.
- **Jobs:** liberación de saldo, bloqueo por deuda, notificaciones por lotes, conciliación nocturna y verificación de integridad, reconstrucción de promedios de calificación, retiro de anuncios vencidos, cancelación de pedidos en efectivo sin aceptar (`horas_aceptacion`) y expiración de pedidos digitales sin pago. Requieren servidor siempre activo o un programador externo, porque muchas capas gratuitas duermen las instancias. Decidirlo antes de la Etapa 4.
- **Expiración de pedidos digitales** (tras `minutos_expiracion_pago`): antes de dar por expirado un pedido, se consulta a Wompi el estado de su referencia (verificar en la documentación que exista una consulta por referencia). Si el pago fue aprobado, se procesa como un webhook; si sigue pendiente, se pospone; si no existe o fue rechazado, el pedido pasa a estado `expirado` y se excluye de los reportes y de la vista del comprador. No se borra de inmediato: una limpieza física se hace pasados 90 días. Por corrida, el job procesa un lote acotado y espacia las llamadas a Wompi para respetar su límite de peticiones.
- Los pedidos en efectivo cancelados se conservan siempre (borrado suave), porque tienen historia.
- **Retención de `evento_webhook`:** 90 días. Guardar solo los campos necesarios del payload y verificar que nunca incluya datos de tarjeta.
- **Pruebas automáticas:** comisión, envío, redondeo y reembolsos con comisión; flujo completo checkout -> pago -> webhook -> en_proceso; webhook repetido, falso, tardío y a medias; doble clic con la misma Idempotency-Key; stock sin condiciones de carrera; liberación de saldo en la fecha correcta; conciliación de saldos con el ledger; estados mixtos del pedido; `recalcular_estado_local`; cada restricción de la sección 4.13.
- Habeas Data (Ley 1581 de 2012), términos y política de devoluciones redactados con un abogado.

## 8. Plan de desarrollo

- **Etapa 0** (en paralelo, bloqueante solo para producción): consulta legal y contable, economía por método de pago, decisiones pendientes de la sección 2.
- **Etapa 1:** repositorios, backend base, migraciones, autenticación con roles, verificación de email (con el proveedor de correo y el dominio propio ya definidos), almacenamiento de archivos (bucket, reglas de subida y acceso restringido para evidencias), logs y errores.
- **Etapa 2** (corte vertical, con Wompi en sandbox): un local aprobado, un producto con una variante, un pedido, un pago (con `pedido_id` nullable y `tipo_pago` desde el inicio), un cambio de estado, con webhook seguro e idempotente, ledger, stock atómico, `evento_webhook`, `idempotencia` y las pruebas de la sección 7. Incluye el frontend mínimo para probarlo de punta a punta: pantalla de checkout y un panel de vendedor básico para aceptar y cambiar el estado del pedido. Primero se escriben las rutas y el contrato OpenAPI, después los componentes. Debe funcionar completo antes de agregar nada.
- **Etapa 2.5** (antes de vender): onboarding real con Wompi en producción y habilitación de facturación electrónica.
- **Etapa 3:** múltiples locales, categorías globales y rubros, variantes, carrito multi-local, envío por distancia, pedido mínimo. Frontend: vista de un local con sus productos y variantes (para probar el modelo híbrido de categorías), carrito multi-local y una home básica.
- **Etapa 4:** efectivo, saldos, liquidaciones, disputas, reembolsos, cancelaciones, jobs, paneles de vendedor y admin completos.
- **Etapa 5:** búsqueda, seguidores, notificaciones, calificaciones, con sus pantallas (buscador, campana, formularios de calificación).
- **Etapa 6:** home dinámica con sus cuatro bloques y publicidad.
- **Etapa 7:** hosting definitivo, dominio, documentos legales, pruebas finales.

## 9. Identidad visual (pendiente)

Nombre, logo, colores, tipografía y wireframes de las demás pantallas.

## 10. Invariantes del proyecto (checklist para cada pull request)

Son las reglas cuyo incumplimiento cuesta dinero. Sirven como README del repositorio de backend y como lista de revisión.

1. **El ledger es la fuente de verdad.** Todo movimiento de dinero pasa por un único `registrar_movimiento()` que actualiza los saldos en la misma transacción. Nadie asigna un saldo directamente.
2. **`pago.referencia` es UNIQUE.** Un webhook con referencia desconocida se registra y se alerta; nunca se descarta en silencio.
3. **El webhook responde 200 solo después de procesar** o de registrar su resultado. Ante un fallo transitorio responde 5xx para que Wompi reintente.
4. **El procesamiento de un pago aprobado es atómico:** el camino feliz ocurre en una transacción (A) y el camino de fallo por stock en otra (B). Nunca se llama a la API de Wompi dentro de una transacción de base de datos.
5. **Los snapshots de `sub_pedido` nunca se modifican.** El neto se deriva.
6. **"Entregado" y "el dinero se movió" son hechos distintos.** El saldo con disputa abierta, retención vigente o reembolso pendiente no se libera ni se liquida.
7. **El stock se descuenta siempre** con `UPDATE ... WHERE stock >= n AND activo = true`; si no afecta filas, la operación falla. La única otra escritura de stock es devolverlo al cancelar un sub_pedido cuyo stock ya se había descontado.
8. **La deuda se compensa solo en liquidación y solo con saldo liberado.**
9. **El estado de un local por deuda solo lo cambian** `recalcular_estado_local()` y el job diario de bloqueo, siempre a través del mismo servicio.
10. **Todo POST que crea pedido o pago exige `Idempotency-Key`.**
11. **Nada financiero se borra.** Los productos se desactivan; el ledger y la auditoría son solo de agregar filas.
    - *Revisión normal (no bloquea):* los eventos de webhook, las vistas y los pedidos expirados tienen retención definida.
12. **Todo monto que aparece en pantalla se calcula en el backend.**

**Criterio:** un invariante es bloqueante si el cambio puede mover dinero o cambiar si el dinero se mueve. Todos los anteriores lo son; la única parte de revisión normal es la de retenciones del invariante 11.

**Verificación automática (CI).** La plantilla de pull request es documentación; lo que hace cumplir los invariantes es CI, que corre en cada push:

- **Invariante 1:** un chequeo que falla el build si aparece una escritura a las columnas de saldo de `cuenta_local` fuera del servicio del ledger.
- **Invariante 7:** un chequeo que exige que toda escritura a `producto_variante.stock` pase por el módulo de stock (solo hay dos: el descuento y la devolución por cancelación).
- **Cómo se escriben estos chequeos:** buscan el nombre de la tabla y de la columna (`cuenta_local`, `saldo_deuda`, `saldo_por_pagar`, `saldo_congelado`, `producto_variante`, `stock`) cerca de cualquier asignación o sentencia de escritura, no el método del ORM, para que también atrapen SQL escrito a mano. Usan una lista blanca de archivos permitidos (el servicio del ledger y el módulo de stock). Cuando fallan, imprimen qué invariante se rompió y en qué archivo y línea, no un error genérico; así quien necesite una excepción sabe cuál está pidiendo.
- **Cuándo se introducen:** los guardianes entran junto con la corrección de cualquier violación existente, en el mismo commit, para que nunca nazcan en rojo. En este proyecto todavía no hay código, así que se agregan desde la Etapa 1, antes de que exista la primera escritura de saldos o de stock.
- **Invariante 4**, en tres capas: (a) una regla de lint que prohíbe importar el cliente HTTP de Wompi fuera del módulo `wompi`; (b) un guardián en ejecución: el envoltorio de transacciones registra en un contexto (por ejemplo AsyncLocalStorage en Node) que hay una transacción abierta, y el cliente de Wompi lanza un error si lo encuentra, también en pruebas; (c) una prueba de integración que usa el envoltorio real de transacciones, llama al cliente de Wompi dentro y espera ese error específico. No se mockea la transacción.
- **Todos los invariantes:** cada uno tiene al menos un archivo de pruebas llamado `invariante_NN_<descripcion>.test.ts`, de `invariante_01_...` a `invariante_12_...`. Un paso de CI verifica que existan los doce y falla listando los que faltan. Para los invariantes 1 y 7, ese archivo ejecuta el chequeo estático. Las pruebas bloquean el merge si fallan.

Este es el archivo fuente de los invariantes. `CONTRIBUTING.md` y la plantilla de pull request son copias para consulta rápida; si divergen, manda esta sección.
