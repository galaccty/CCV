# Plan de la Etapa 4 — dinero entre la plataforma y los locales

> **Estado:** propuesta revisada el 22/10/2026 con las decisiones del usuario. No hay código de la Etapa 4 escrito.
> **Base:** `especificacion_centro_comercial_v4.md` (secciones 4.4, 4.6 a 4.10 y 4.13), `CONTRIBUTING.md` y el estado real del repositorio al 22/10/2026.

## 0. Qué existe hoy y qué falta

Ya existen y se reutilizan:

- `registrarMovimiento()` en `src/services/ledger.js`: único punto que escribe `ledger` y `cuenta_local` en la misma transacción. Los saldos tienen CHECK de no negativos.
- `venta`, `comision`, `pago_recibido`, `reembolso`, `pago_a_local` y `cobro_deuda` como tipos del ledger. Hoy `venta` no suma a `saldo_por_pagar` (el dinero queda retenido hasta la Etapa 4) y `pago_a_local`/`cobro_deuda` todavía no se usan.
- `subPedidosElegiblesParaLiberar()`: consulta base que ya exige `entregado`, `fecha_entrega + dias_retencion <= ahora`, `saldo_liberado_en` nulo y ningún reembolso pendiente. No escribe saldos.
- Trigger que impide llenar `saldo_liberado_en` con un reembolso pendiente.
- Checkout multi-local, pago digital, webhook, stock atómico, reembolso total por fallo de stock y máquina de estados de pedido/sub-pedido.
- `local.estado` y `cuenta_local`, pero sin la máquina de estados por deuda ni liquidaciones.

Falta para la Etapa 4:

1. Liberar saldo retenido a `saldo_por_pagar` y bloquear la liberación por disputa/reembolso.
2. Crear liquidaciones por lote, con estados, referencia de pago y asientos en el ledger.
3. Compensar deuda solo dentro de la liquidación y solo con saldo liberado.
4. Disputas, evidencia, congelación, resolución y reembolsos por línea.
5. `recalcular_estado_local()` y el job diario de bloqueo.
6. Pedidos en efectivo: pago pendiente, descuento de stock al aceptar, comisión como deuda al entregar y pago de esa deuda.
7. Jobs de auto-entrega, cancelación de efectivo sin aceptar, expiración digital, conciliación e integridad.
8. Paneles de vendedor y admin para cuenta, movimientos, liquidaciones, disputas y deuda.

---

## 1. Principios de dinero que guían todo el plan

1. **El ledger sigue siendo la fuente de verdad.** Ningún servicio nuevo escribe `cuenta_local` directamente. Todo movimiento nuevo se hace con `registrarMovimiento()` dentro de `withTransaccion()`.
2. **El saldo del vendedor se mueve en hechos distintos:**
   - Pago aprobado: se registra la venta y la comisión, pero **no** se acredita al vendedor.
   - Entrega + retención vencida + sin disputa + sin reembolso pendiente: `liberacion` acredita `saldo_por_pagar` por `subtotal_productos + costo_envio - comision`.
   - Liquidación: `cobro_deuda` y `pago_a_local` descuentan en la preparación; una falla en `en_proceso` se revierte con `reversa_cobro_deuda` y `reversa_pago_a_local`.
3. **El envío se acredita al vendedor.** `costo_envio` forma parte de `liberacion`, igual que en efectivo, porque el vendedor asume el flete. La comisión se calcula solo sobre `subtotal_productos`. Un reembolso de envío se descuenta del saldo del vendedor.
4. **Los snapshots no se tocan.** La comisión objetivo y los reembolsos se derivan de `sub_pedido`, `detalle_producto`, `config_snapshot` y `reembolso_linea`; nunca se reescribe `sub_pedido.comision`.
5. **El cliente nunca manda montos.** Para disputas y reembolsos manda líneas y cantidades; el backend calcula el monto con los precios congelados.
6. **Idempotencia y bloqueo pesimista** en todo lo que mueve dinero: una fila de `sub_pedido`, una de `cuenta_local`, una de `liquidacion`, una de `disputa` o una de `reembolso` se bloquea con `SELECT ... FOR UPDATE` o se actualiza con `UPDATE ... WHERE estado = ...`.
7. **Nada financiero se borra.** Tablas nuevas sin DELETE; el ledger sigue sin UPDATE ni DELETE.

---

## 2. Tablas, columnas, constraints y triggers

### 2.1 `ledger`: tipos y columnas nuevas

Se agregan valores al enum `tipo_movimiento`:

| Tipo nuevo | Efecto en saldos | Cuándo |
|---|---|---|
| `liberacion` | `+ saldo_por_pagar` | Job de liberación, una vez por `sub_pedido`: `subtotal_productos + costo_envio - comision` |
| `congelacion` | `- saldo_por_pagar`, `+ saldo_congelado` | Reembolso/disputa digital que congela saldo ya liberado |
| `descongelacion` | `+ saldo_por_pagar`, `- saldo_congelado` | Reembolso fallido o disputa a favor del vendedor |
| `deuda_reembolso` | `+ saldo_deuda` | Reembolso en efectivo que vence sin pagarse, o resto de un reembolso digital que supera el saldo disponible después de un payout |
| `reversa_pago_a_local` | `+ saldo_por_pagar` | Falla una liquidación en `en_proceso`; deshace el `pago_a_local` |
| `reversa_cobro_deuda` | `+ saldo_deuda` | Falla una liquidación en `en_proceso`; deshace el `cobro_deuda` |

Además, se ajustan los efectos de tipos existentes:

- `comision`: sin `local_id` sigue siendo ingreso de la plataforma. Con `local_id` (venta en efectivo) suma a `saldo_deuda`.
- `reversa_comision`: sin `local_id` reduce ingreso de la plataforma. Con `local_id` acredita `saldo_por_pagar` si la comisión se cobró digitalmente, o descuenta `saldo_deuda` si se cobró en efectivo.
- `reembolso`: si `desde_congelado = true`, descuenta `saldo_congelado`; si no, descuenta `saldo_por_pagar`. Con `local_id` nulo es solo registro de plataforma.
- `ajuste_redondeo`: permite crédito o débito explícito de un peso, con `direccion` (`credito`/`debito`) y cuenta destino. Se usa solo para residuos de comisión/reembolso y queda auditado.
- `pago_a_local` y `cobro_deuda` conservan su efecto actual (descuentan `saldo_por_pagar` y `saldo_deuda`).

Columnas nuevas en `ledger`:

- `disputa_id` (nullable, FK a `disputa`). **Diferida a la 4c**, cuando se cree la tabla `disputa`, junto con su UNIQUE parcial. En la 4a no se crea.
- `pago_deuda_id` (nullable, FK a `pago_deuda`). **Diferida a la 4b**, cuando se cree la tabla `pago_deuda`, junto con su UNIQUE parcial. En la 4a no se crea.
- `liquidacion_id` **no** se agrega al ledger: el ledger es inmutable y una liquidación se crea después. Para cumplir la spec sin romper el invariante 11 se usa la tabla `liquidacion_movimiento` (ver 2.5), decisión aprobada. No se permite ningún UPDATE del ledger.

> Decisión de implementación (22/10/2026): no se agregan FKs a tablas que todavía no existen. `pago_deuda_id` viaja con `pago_deuda` en la 4b y `disputa_id` con `disputa` en la 4c; cada una conserva el UNIQUE parcial que le corresponde.

Constraints e índices:

- `UNIQUE (sub_pedido_id) WHERE tipo = 'liberacion'` → impide liberar dos veces el mismo sub-pedido.
- `UNIQUE (reembolso_id) WHERE tipo = 'reembolso' AND local_id IS NOT NULL` → impide aplicar dos veces el mismo reembolso al saldo del vendedor.
- `UNIQUE (reembolso_id) WHERE tipo = 'deuda_reembolso'` → impide registrar dos veces la misma deuda por reembolso.
- `UNIQUE (disputa_id, tipo) WHERE tipo IN ('congelacion','descongelacion')` → una congelación y una descongelación por disputa.
- `UNIQUE (pago_deuda_id) WHERE tipo = 'cobro_deuda'` → un solo cobro por pago de deuda.
- `UNIQUE (sub_pedido_id) WHERE tipo = 'comision' AND local_id IS NOT NULL` → una sola comisión de venta en efectivo por sub-pedido.
- CHECK ya existente de `monto >= 0`; los movimientos nuevos se emiten siempre con monto > 0.
- FK con `ON DELETE RESTRICT` a las tablas nuevas.
- Se mantiene el trigger `ccv_ledger_no_modificar`.

### 2.2 `cuenta_local` y `local`

No se agregan saldos nuevos. Se refuerza:

- Trigger `ccv_cuenta_local_por_local`: al insertar un `local`, crea su fila en `cuenta_local` (y backfill en la migración). Así nunca hay un local sin cuenta.
- `fecha_limite_pago` sigue siendo `DATE`.
- Trigger `ccv_cuenta_saldos_no_negativos` ya existe.
- Trigger `ccv_estado_local_solo_sistema`: rechaza cambiar `local.estado` a `en_plazo` o `bloqueado`, o salir de ellos, si la transacción no marcó el contexto `ccv.estado_local_sistema = '1'`. Se marca con `set_config('ccv.estado_local_sistema', '1', true)`; el tercer argumento `true` hace que el ajuste sea **local a la transacción** y no se filtre a otra consulta que reutilice la misma conexión del pool. Solo `recalcular_estado_local()` y el job diario lo marcan. El admin puede seguir aprobando (`pendiente_aprobacion -> activo`) o suspendiendo (`suspendido`), pero no puede poner `en_plazo`, `bloqueado` ni desbloquear.
- `recalcular_estado_local()` bloquea la fila del local con `FOR UPDATE` y es la única función que decide los estados de deuda.

### 2.3 `disputa` y `disputa_evidencia`

`disputa` (nueva):

- `id`, `sub_pedido_id` (FK, UNIQUE: una disputa por sub-pedido), `usuario_id` (comprador que la abre), `tipo` (`digital`/`efectivo`), `motivo` (texto), `estado` (`abierta`/`resuelta_comprador`/`resuelta_vendedor`), `monto_reclamado` (bigint), `monto_congelado` (bigint, 0 en efectivo), `fecha_apertura`, `fecha_resolucion`, `resuelto_por` (FK usuario), `resolucion` (texto), `estado_sub_pedido_anterior` (para restaurar si gana el vendedor).
- CHECK: `monto_reclamado > 0`, `monto_congelado >= 0`, `monto_congelado <= monto_reclamado`.
- Trigger: al insertar, el sub-pedido debe estar `enviado` o `entregado`, con `saldo_liberado_en` nulo, y se pasa a `en_disputa` en la misma transacción. Si ya hay una disputa, la UNIQUE lo impide.
- Trigger: una disputa resuelta no cambia de estado ni de montos; solo se agregan evidencias antes de resolver.
- Trigger de no borrado.

`disputa_evidencia` (nueva):

- `id`, `disputa_id`, `usuario_id`, `lado` (`comprador`/`vendedor`/`admin`), `tipo` (`texto`/`url`), `contenido`, `creado_en`.
- CHECK: texto no vacío; URL solo `https://`; tamaño máximo validado en API.
- Trigger: no se agrega evidencia a una disputa ya resuelta; no se borra.
- En esta etapa la evidencia es texto o URL. La subida binaria queda detrás de la decisión de almacenamiento (bucket S3) que sigue pendiente en la spec; el endpoint acepta la URL firmada o el texto y no inventa un proveedor.

### 2.4 `reembolso` y `reembolso_linea`

`reembolso` ya existe. Se agregan:

- `disputa_id` (nullable, FK, UNIQUE parcial: un reembolso por disputa).
- `fecha_limite` (nullable, para efectivo).
- `monto_envio` (bigint default 0): parte del reembolso que corresponde a envío.
- `incluye_envio` (boolean default false).
- `desde_congelado` (boolean default false): el reembolso se paga contra `saldo_congelado` en vez de `saldo_por_pagar`.
- `registrado_por` (FK usuario nullable).
- `completado_en` (timestamptz nullable).

`reembolso_linea` (nueva):

- `id`, `reembolso_id`, `detalle_id`, `cantidad`, `monto`.
- UNIQUE `(reembolso_id, detalle_id)`.
- CHECK `cantidad > 0`, `monto >= 0`.
- Trigger diferido: la suma de cantidades reembolsadas por `detalle_id` (contando todos los reembolsos completados/pendientes) no supera la cantidad original; la suma de `monto` de las líneas más `monto_envio` es igual a `reembolso.monto`; y la suma de reembolsos del sub-pedido no supera su `total`.
- Trigger existente de `pago.monto_reembolsado` se mantiene.

Reglas de monto:

- Reembolso de producto: `monto = suma(cantidad * precio_unitario)` de las líneas elegidas.
- Reembolso de envío: solo si no hubo entrega o si el admin marca producto defectuoso; `monto_envio = costo_envio`. **El envío reembolsado se descuenta del saldo del vendedor**, porque el vendedor ya lo había recibido dentro de `liberacion`.
- Reembolso total por fallo de stock (Etapa 2) sigue usando `sub.total` y crea sus líneas con el total de cada detalle; se adapta para que el trigger de líneas siga cuadrando.

### 2.5 `liquidacion` y `liquidacion_movimiento`

`liquidacion` (nueva, una por local y por lote):

- `id`, `local_id` (FK), `estado` (`borrador`/`en_proceso`/`pagada`/`fallida`/`cancelada`), `fecha_creacion`, `fecha_preparacion`, `fecha_pago`, `monto_liberado`, `monto_reembolsado`, `monto_compensado`, `total_pagado`, `referencia_payout` (UNIQUE nullable), `metodo_pago` (`transferencia`/`manual`), `comprobante_url`, `creado_por`, `preparado_por`, `pagado_por`, `motivo_fallo`.
- CHECK: montos >= 0; `monto_liberado - monto_reembolsado - monto_compensado = total_pagado`; si `estado IN ('en_proceso','pagada')` los montos quedan fijados; si `estado = 'pagada'` entonces `referencia_payout` y `fecha_pago` no son nulos; si `estado = 'fallida'` entonces `motivo_fallo` no es nulo y `fecha_pago` es nula.
- `total_pagado` es el dinero que sale de la plataforma hacia el local (`pago_a_local`); `monto_compensado` es deuda del local que se descuenta y no se transfiere. `monto_reembolsado` solo incluye reembolsos aplicados contra saldo liberado en este lote; el exceso que ya quedó como deuda no se descuenta acá.
- UNIQUE parcial `(local_id) WHERE estado IN ('borrador','en_proceso')` → no puede haber dos liquidaciones abiertas del mismo local.
- Trigger de no borrado y de transiciones: `borrador -> en_proceso`, `en_proceso -> pagada`, `en_proceso -> fallida`, `borrador -> cancelada`. Cualquier otra transición se rechaza. Una liquidación `pagada` es inmutable; una `fallida` o `cancelada` no vuelve a abrirse.
- **Preparar** (`borrador -> en_proceso`): bloquea `cuenta_local` con `FOR UPDATE`, revalida saldo y reembolsos/disputas, fija los montos, escribe `cobro_deuda` (si compensa) y `pago_a_local`, enlaza los movimientos y deja `fecha_preparacion`. A partir de acá el dinero ya está debitado del saldo del local. Si la cuenta bancaria del vendedor ya está modelada (9.2), guarda un snapshot de la cuenta destino.
- **Confirmar** (`en_proceso -> pagada`): solo guarda `referencia_payout`, `comprobante_url`, `fecha_pago` y `pagado_por`. No escribe ledger.
- **Marcar fallida** (`en_proceso -> fallida`): escribe `reversa_cobro_deuda` y `reversa_pago_a_local` por los mismos montos, enlaza las reversas con su movimiento original y deja `motivo_fallo`. El saldo del local vuelve al estado previo a la preparación.
- **Cancelar** (`borrador -> cancelada`): no mueve dinero ni escribe ledger.

`liquidacion_movimiento` (nueva):

- `liquidacion_id`, `ledger_id`, `rol` (`liberacion`, `reembolso`, `compensacion`, `pago`, `reversa_cobro_deuda`, `reversa_pago_a_local`), `ledger_origen_id` (nullable, FK al movimiento que revierte), PK compuesta `(liquidacion_id, ledger_id)`.
- UNIQUE parcial `(liquidacion_id, rol) WHERE rol IN ('compensacion','pago','reversa_cobro_deuda','reversa_pago_a_local')` → una preparación y una reversa por liquidación.
- UNIQUE `(ledger_origen_id) WHERE rol IN ('reversa_cobro_deuda','reversa_pago_a_local')` → un movimiento original se revierte una sola vez.
- FKs con `ON DELETE RESTRICT`.
- Permite decir exactamente qué movimientos del ledger entraron en el lote sin modificar el ledger. Reemplaza la columna `ledger.liquidacion_id` de la spec para no violar el invariante 11 (decisión aprobada).
- Los roles `liberacion` y `reembolso` documentan qué movimientos previos cubre el lote. Si la liquidación falla, esos movimientos siguen siendo válidos y se pueden volver a enlazar en otra liquidación; solo cuentan como liquidados cuando la liquidación está `pagada`.

### 2.6 `pago_deuda` (pago de la deuda de comisión en efectivo)

- `id`, `local_id`, `monto`, `metodo` (`transferencia`/`efectivo`/`manual`), `referencia` (UNIQUE), `comprobante_url`, `estado` (`pendiente`/`confirmado`/`rechazado`), `reportado_por`, `confirmado_por`, `fecha_reporte`, `fecha_confirmacion`, `motivo_rechazo`.
- CHECK: `monto > 0`.
- Trigger: solo se confirma una vez, con `UPDATE ... WHERE estado = 'pendiente'`; no se borra.
- Al confirmar: `cobro_deuda` + `recalcular_estado_local()` en la misma transacción.
- Si el admin recibe el dinero directamente, puede crear el pago ya `confirmado` en una sola transacción (misma idempotencia).

### 2.7 `configuracion`

Se agregan claves (con seed y validación de tipo):

- `dias_reembolso_efectivo` (entero, valor inicial 5, configurable por el admin): plazo para que el vendedor reembolse en efectivo antes de `incumplido`.
- `intentos_maximos_reembolso` (entero, propuesta: 5): reintentos antes de `fallido` y alerta alta.
- `monto_minimo_liquidacion` (entero, valor inicial 0, configurable por el admin): si se quiere evitar pagar lotes diminutos.
- `dias_retencion` ya existe y se lee del snapshot del pedido, no de la configuración viva.

`limite_deuda` y `plazo_dias` se leen en vivo. Al cambiarlos, un servicio de administración recalcula todos los locales afectados y registra `auditoria_admin`.

---

## 3. Movimientos del ledger y asientos de ejemplo

Todos los asientos se ejecutan con `registrarMovimiento()` dentro de una transacción. Los montos son pesos enteros.

### 3.1 Venta digital base

Pedido: subtotal productos 30.000, envío 2.000, comisión 2.000 (mínimo), total 32.000. La comisión se calcula solo sobre productos; el envío se acredita al vendedor.

| Momento | Asiento | Local | Saldos después |
|---|---|---|---|
| Pago aprobado | `venta` 30.000 | sí | `saldo_por_pagar` 0; fila informativa |
| Pago aprobado | `comision` 2.000 | no | ingreso de plataforma |
| Pago aprobado | `pago_recibido` 32.000 | no | dinero recibido |
| Liberación | `liberacion` 30.000 | sí | `saldo_por_pagar` 30.000 (`30.000 + 2.000 - 2.000`) |
| Preparar liquidación con deuda 5.000 | `cobro_deuda` 5.000 | sí | `saldo_deuda` 0 |
| Preparar liquidación | `pago_a_local` 25.000 | sí | `saldo_por_pagar` 0; payout 25.000 |

La liquidación queda: `monto_liberado` 30.000, `monto_reembolsado` 0, `monto_compensado` 5.000, `total_pagado` 25.000.

### 3.2 Reembolso digital antes de liberar

Se reembolsan 10.000 de producto antes de que venza la retención. La comisión original es 2.000 (mínimo). Si un ajuste posterior deja la comisión objetivo en 1.000, se revierte la diferencia.

| Momento | Asiento | Local | Efecto |
|---|---|---|---|
| Reembolso completado | `reembolso` 10.000 | no | plataforma devuelve al comprador |
| Liberación | `liberacion` 30.000 | sí | acredita productos + envío - comisión original |
| Liberación | `reembolso` 10.000 | sí | descuenta la parte del vendedor; queda 20.000 |
| Si la comisión objetivo baja a 1.000 | `reversa_comision` 1.000 | sí | acredita 1.000; queda 21.000 |

Si el reembolso también incluye el envío de 2.000, el asiento local es `reembolso` 12.000 y el saldo queda en 18.000 (19.000 con la reversa de comisión). El envío reembolsado siempre lo asume el vendedor.

Así el ledger muestra el bruto y todos los descuentos, sin recalcular snapshots.

### 3.3 Reembolso digital después de liberar

El saldo ya está en 30.000. Al completarse el reembolso de 10.000:

- `reembolso` 10.000 con `local_id` → `saldo_por_pagar` 20.000.
- Si la comisión objetivo baja, `reversa_comision` con `local_id` → acredita la diferencia.
- Si el reembolso queda pendiente, primero `congelacion` 10.000: `saldo_por_pagar` 20.000 y `saldo_congelado` 10.000; al completarse, `reembolso` desde congelado; al fallar, `descongelacion` devuelve 10.000.

**Reembolso después de un payout.** El vendedor ya cobró y el saldo disponible es menor que el reembolso. Se descuenta todo lo disponible de `saldo_por_pagar` y el resto pasa a `saldo_deuda`; después se llama a `recalcular_estado_local()`. Ejemplo: saldo disponible 5.000 y reembolso de 10.000. El asiento de plataforma `reembolso` 10.000 sin `local_id` se registra igual; la tabla muestra solo los asientos del vendedor.

| Asiento | Local | Efecto |
|---|---|---|
| `reembolso` 5.000 | sí | `saldo_por_pagar` 5.000 -> 0 |
| `deuda_reembolso` 5.000 | sí | `saldo_deuda` +5.000 |

Si el saldo disponible fuera 0, se registra un solo `deuda_reembolso` por 10.000. La reversa de comisión posterior a un payout se netea contra el reembolso: si después de la reversa el vendedor sigue debiendo, se descuenta el saldo disponible y el resto va a `deuda_reembolso`; si la reversa deja un neto a favor del vendedor, se acredita `saldo_por_pagar`.

### 3.4 Venta en efectivo

Pedido: subtotal 30.000, envío 2.000, comisión 2.000, total 32.000. El vendedor cobra 32.000 en efectivo, así que retiene productos y envío; solo debe la comisión.

| Momento | Asiento | Local | Efecto |
|---|---|---|---|
| Entrega | `venta` 30.000 | sí | registro de la venta |
| Entrega | `comision` 2.000 | sí | `saldo_deuda` 2.000 |
| Pago de deuda | `cobro_deuda` 2.000 | sí | `saldo_deuda` 0 |

No se registra `pago_recibido` de plataforma: el dinero lo recibió el vendedor, no la plataforma. El `pago` del pedido queda `aprobado` con `metodo_pago = efectivo`.

### 3.5 Reembolso en efectivo incumplido

Si el vendedor debe devolver 10.000 de producto (12.000 si el reembolso incluye el envío) y no lo hace antes de `fecha_limite`:

- `deuda_reembolso` 10.000 (o 12.000) con `local_id` → `saldo_deuda` +10.000 (o +12.000).
- `recalcular_estado_local()` deja el local en `en_plazo` (o `bloqueado` si ya venció).
- Cuando el vendedor paga, `cobro_deuda` 10.000 → deuda -10.000 y se recalcula.

El reembolso en efectivo no mueve `saldo_por_pagar` porque la plataforma nunca tuvo ese dinero.

### 3.6 Redondeo

Si `subtotal_restante * porcentaje` da un residuo de 1 peso frente a la comisión objetivo, se registra `ajuste_redondeo` por 1 peso con dirección explícita y referencia al sub-pedido. La suma de `comision` + `reversa_comision` + `ajuste_redondeo` debe cuadrar con la comisión objetivo. Se prueba con varias líneas y residuos.

---

## 4. Reglas de negocio

### 4.1 Liberación de saldo

Job `liberar_saldos` (script `npm run job:liberar-saldos`; frecuencia sugerida: cada hora, la programación se decide al desplegar). Cada job es un script independiente que abre su propia conexión, intenta `pg_try_advisory_lock(<clave fija por job>)` y sale sin hacer nada si otra instancia ya lo tiene. El candado se libera al cerrar la conexión.

1. En una transacción, selecciona un lote acotado de `sub_pedido` con:
   - estado `entregado` o `reembolsado_parcial`;
   - `saldo_liberado_en IS NULL`;
   - `fecha_entrega + dias_retencion` (del `config_snapshot`) `<= ahora`;
   - sin `disputa` abierta;
   - sin `reembolso` pendiente;
   - local `suspendido` o `pendiente_aprobacion`: **sí se libera**. Suspender no borra la obligación de pagar; el admin decide después si incluye ese saldo en una liquidación (ver 4.2).
2. Bloquea cada fila con `SELECT ... FOR UPDATE SKIP LOCKED` para que dos instancias no procesen la misma.
3. Calcula:
   - `liberacion = subtotal_productos + costo_envio - comision_original` (snapshot). El envío se acredita al vendedor; la comisión solo se calcula sobre productos.
   - reembolsos completados que aún no tengan asiento local: `reembolso` con `local_id`, incluida la parte de envío.
   - si la comisión objetivo es menor que la original: `reversa_comision` con `local_id` por la diferencia.
   - `ajuste_redondeo` si queda un peso.
4. Ejecuta `registrarMovimiento()` para cada asiento y actualiza `saldo_liberado_en = ahora` con `UPDATE ... WHERE saldo_liberado_en IS NULL`.
5. Si el neto es cero (todo reembolsado), marca `saldo_liberado_en` sin asiento; no hay dinero que mover.
6. Commit. El trigger de la base vuelve a verificar que no haya reembolso pendiente ni disputa abierta.

El job es idempotente: la UNIQUE de `liberacion` por `sub_pedido` y el `UPDATE` condicionado impiden duplicados.

### 4.2 Liquidaciones

Flujo:

1. `POST /admin/liquidaciones` crea una `liquidacion` en `borrador` para un local y un período. Bloquea `cuenta_local`; calcula una vista previa de `monto_liberado`, `monto_reembolsado`, deuda disponible y `total_pagado`; no mueve el ledger todavía. Si el local está `suspendido`, el admin debe confirmar explícitamente que quiere liquidarlo (`confirmar_local_suspendido = true`); si no, 409. Exige `Idempotency-Key`.
2. El admin revisa el detalle (`GET /admin/liquidaciones/{id}`) y ejecuta **preparar pago**: `POST /admin/liquidaciones/{id}/preparar`. En esa transacción:
   - vuelve a bloquear `cuenta_local` con `FOR UPDATE` y valida que el saldo siga alcanzando y que no haya reembolsos/disputas nuevas; si algo cambió, 409 y hay que recrear el borrador;
   - fija `monto_liberado`, `monto_reembolsado`, `monto_compensado` y `total_pagado`;
   - registra `cobro_deuda` por la deuda compensada (si hay);
   - registra `pago_a_local` por el resto;
   - enlaza los movimientos en `liquidacion_movimiento` con rol `compensacion` y `pago`;
   - pasa a `en_proceso` con `fecha_preparacion` y `preparado_por`.
   - Exige `Idempotency-Key`; un segundo preparar devuelve 409 y no duplica asientos.
3. **Confirmar pago**: `POST /admin/liquidaciones/{id}/confirmar` con `referencia_payout` y comprobante. Solo permite `en_proceso -> pagada`, guarda `fecha_pago` y `pagado_por`, y **no escribe ledger**. Exige `Idempotency-Key`.
4. **Marcar fallida**: `POST /admin/liquidaciones/{id}/fallar` con `motivo_fallo` solo permite `en_proceso -> fallida`. En la misma transacción escribe `reversa_cobro_deuda` y `reversa_pago_a_local` por los mismos montos de la preparación, las enlaza en `liquidacion_movimiento` con `ledger_origen_id` y deja el saldo como estaba antes de preparar. Si la reversa falla, toda la transacción vuelve atrás y la liquidación sigue `en_proceso`.
5. **Cancelar**: `POST /admin/liquidaciones/{id}/cancelar` solo desde `borrador`; no mueve dinero ni escribe ledger, solo pasa a `cancelada`.
6. Una liquidación `pagada` es inmutable. Si se descubre un error, se corrige con un asiento nuevo (`ajuste` auditado), nunca editando la liquidación.

Estados: `borrador -> en_proceso -> pagada`, `borrador -> en_proceso -> fallida`, `borrador -> cancelada`. `pagada`, `fallida` y `cancelada` son terminales. Una liquidación `en_proceso` bloquea la creación de otra para el mismo local hasta que se confirme o se marque fallida.

### 4.3 Compensación de deuda

- Solo ocurre dentro de la transacción de **preparación** de una liquidación (`cobro_deuda`).
- Solo toma `saldo_por_pagar` ya liberado. El saldo retenido, congelado o con reembolso pendiente no se toca.
- `compensado = min(saldo_deuda, saldo_por_pagar_disponible)`.
- Si no alcanza, se compensa lo disponible y el resto sigue como `saldo_deuda`; `limite_deuda` se evalúa sobre el neto después de compensar.
- Después de la compensación se llama a `recalcular_estado_local()` en la misma transacción.
- Nunca hay compensación continua: ningún job, webhook o entrega toca `saldo_deuda` para descontarlo. La deuda solo baja por (a) compensación en la preparación de una liquidación o (b) confirmación de un `pago_deuda`. Solo suma deuda (`comision` efectivo, `deuda_reembolso`).

### 4.4 Disputas

Apertura:

- Comprador dueño del pedido, sub-pedido en `enviado` o `entregado`, `saldo_liberado_en` nulo (ventana de retención).
- Una sola disputa por sub-pedido (UNIQUE).
- Pasa el sub-pedido a `en_disputa` en la misma transacción y guarda el estado anterior.
- Digital: `monto_congelado = min(monto_reclamado, saldo disponible)`. Si el sub-pedido aún no se liberó, no hay asiento de congelación; el job de liberación lo omite. Si ya se liberó (caso admin), se crea `congelacion`.
- Efectivo: `monto_congelado = 0`; no se congela nada.

Evidencia:

- Comprador y vendedor del sub-pedido pueden agregar textos/URLs mientras la disputa esté abierta.
- El admin ve todo y puede agregar evidencia interna.
- No se borra evidencia.

Resolución del admin (`POST /admin/disputas/{id}/resolver`):

- A favor del vendedor:
  - `disputa.estado = resuelta_vendedor`.
  - Si había congelación, `descongelacion` devuelve el monto a `saldo_por_pagar`.
  - El sub-pedido vuelve a `entregado` o `enviado` (según `estado_sub_pedido_anterior`).
  - El reloj de retención sigue corriendo desde `fecha_entrega`; si ya venció, el próximo job libera.
- A favor del comprador:
  - `disputa.estado = resuelta_comprador`.
  - Se crea un `reembolso` por las líneas aprobadas (el admin manda líneas/cantidades; el backend calcula montos). Si corresponde devolver el envío, se suma `monto_envio` y también se descuenta del saldo del vendedor.
  - Digital: si hay saldo liberado, se congela lo reclamado hasta que el reembolso se complete o falle; si no se liberó, el job de liberación no libera ese sub-pedido. Si el saldo ya se pagó al vendedor, el reembolso descuenta lo disponible de `saldo_por_pagar` y el resto pasa a `saldo_deuda` (asientos `reembolso` + `deuda_reembolso`, ver 3.3).
  - Efectivo: el vendedor debe reembolsar antes de `fecha_limite`; no se congela nada.
  - El sub-pedido pasa a `reembolsado` o `reembolsado_parcial` cuando el reembolso se completa; mientras está pendiente sigue `en_disputa`.
  - Si el reembolso falla, se alerta al admin y se reintenta; no se marca completado sin confirmación.

Stock en disputas:

- Si **no hubo entrega** (`fecha_entrega` nula) y el comprador gana: se cancela el sub-pedido, se reembolsa el total (incluido envío) y se devuelve el stock con `devolverStock()` en la misma transacción, porque el vendedor conserva el producto.
- Si **sí hubo entrega** y el comprador gana: el stock **no** se devuelve automáticamente. El producto puede estar en manos del comprador. Se devuelve solo cuando el admin registra "producto recibido" en una acción explícita, que llama a `devolverStock()` por línea y es idempotente. Sin esa acción, el stock queda como vendido.
- Un reembolso parcial no devuelve stock automáticamente.

### 4.5 Estados del local por deuda

`recalcular_estado_local(localId, tx)` implementa exactamente la sección 4.7:

- `suspendido` y `pendiente_aprobacion`: no se tocan.
- `bloqueado`: solo vuelve a `activo` si `saldo_deuda <= 0` y no hay reembolsos en efectivo incumplidos; en ese caso limpia `fecha_limite_pago`.
- En los demás casos:
  - si hay reembolsos en efectivo incumplidos: `en_plazo`, `fecha_limite_pago = min(existente, hoy + plazo_dias)`;
  - si `saldo_deuda <= 0`: `activo`, limpia fecha;
  - si `saldo_deuda > limite_deuda`: `en_plazo`, fecha mínima;
  - si no: `activo`, limpia fecha.

Se llama después de: venta en efectivo entregada, pago de deuda confirmado, compensación en la preparación de una liquidación, reversa de una liquidación fallida, cambio de `limite_deuda`/`plazo_dias`, reembolso en efectivo incumplido/completado y resolución de disputa en efectivo.

La función marca el contexto con `set_config('ccv.estado_local_sistema', '1', true)`. El `true` es obligatorio: el ajuste dura solo esa transacción y no queda pegado a la conexión del pool. Se prueba explícitamente que después de `recalcular_estado_local()` la misma conexión, en una transacción nueva, ya no puede cambiar el estado a `en_plazo`/`bloqueado` sin volver a marcar el contexto.

Job diario `bloquear_locales_vencidos` (script `npm run job:bloquear-locales-vencidos`, con el mismo candado advisory):

- Busca `en_plazo` con `fecha_limite_pago < hoy` y (`saldo_deuda > 0` o reembolsos incumplidos).
- Pasa a `bloqueado` con `auditoria_admin` origen `sistema`.
- Antes de bloquear, llama a `recalcular_estado_local()` para no bloquear un local que ya saldó. El job no escribe `local.estado` directamente: usa la función.
- Un local `bloqueado` sigue pagando liquidaciones y sigue debiendo; solo deja de vender.

### 4.6 Pedidos en efectivo

Nacimiento:

- `POST /pedidos` con `metodo_pago = efectivo`: un solo local (ya validado), pedido en `en_proceso`, sub-pedido `por_aceptar`, `pago` con `metodo_pago = efectivo`, estado `pendiente`, `monto = pedido.total`, referencia `CCV-EF-<aleatorio>` única, sin `id_transaccion_wompi`.
- No se descuenta stock al crear.

Aceptación:

- El vendedor acepta (`por_aceptar -> preparando`) en una transacción:
  - descuenta stock con `descontarStock()` por cada línea;
  - si falla, no cambia el estado, cancela el sub-pedido y el pedido, marca el pago `rechazado` y notifica al comprador;
  - si funciona, guarda el historial.
- El job `cancelar_efectivo_sin_aceptar` (`npm run job:cancelar-efectivo-sin-aceptar`, con advisory lock) cancela los `por_aceptar` con `horas_aceptacion` vencidas; no toca stock porque nunca se descontó.

Entrega:

- `enviado -> entregado` (comprador, vendedor o sistema) en una transacción:
  - `pago.estado = aprobado`;
  - `venta` (informativo) y `comision` con `local_id` (suma a `saldo_deuda`);
  - `recalcular_estado_local()`.
- Si el sub-pedido se cancela después de aceptar, se devuelve stock y no se genera deuda de comisión (no hubo entrega).
- Si se reembolsa después de entregar, se revierte la comisión (`reversa_comision`) y se ajusta la deuda o el saldo según corresponda.

Pago de la deuda:

- El vendedor reporta un pago (`POST /vendedor/deuda/pagos`) con monto, método, referencia y comprobante; queda `pendiente`.
- El admin lo confirma (`POST /admin/pagos-deuda/{id}/confirmar`) o registra directamente un pago confirmado.
- Al confirmar: `cobro_deuda` + `recalcular_estado_local()` en la misma transacción.
- Se permiten pagos parciales; la deuda restante sigue el ciclo de estado.

### 4.7 Cancelaciones (4.10)

- Comprador cancela solo en `por_aceptar`; en `preparando` solo si el vendedor acepta; en `enviado` no se cancela, se abre disputa.
- Al cancelar:
  - si el stock ya se descontó (digital pagado o efectivo aceptado), se devuelve con `devolverStock()`;
  - si fue digital, se crea el reembolso correspondiente;
  - si fue efectivo y no se entregó, no hay deuda de comisión;
  - se actualiza el pedido derivado y se audita.
- La cancelación es idempotente por transición de estado condicionada.
- **Requisito para la 4f:** toda cancelación de un pedido en efectivo que ya
  fue aceptado (`preparando` o `enviado`) debe quedar en `auditoria_admin` con
  el motivo, el actor y el estado anterior, y debe existir un listado de admin
  para revisarlas. Es el punto donde se puede fugar la comisión del efectivo:
  el vendedor ya aceptó el pedido y no debe poder cancelarlo sin dejar rastro.

### 4.8 Jobs

Todos los jobs son scripts independientes, se ejecutan con `npm run job:<nombre>` y toman un candado advisory de PostgreSQL (`pg_try_advisory_lock`) antes de trabajar. Si no obtienen el candado, salen con código 0 sin tocar nada. La programación (cron externo, tarea del hosting o instancia siempre activa) se decide al desplegar; el código no asume ninguna.

| Script | Qué hace |
|---|---|
| `job:liberar-saldos` | Libera saldo de sub-pedidos elegibles |
| `job:cancelar-efectivo-sin-aceptar` | Cancela efectivo vencido en `por_aceptar` |
| `job:reembolsos-vencidos` | Marca incumplidos los reembolsos en efectivo vencidos y registra deuda |
| `job:auto-entregar` | Pasa a `entregado` los sub-pedidos con auto-entrega vencida |
| `job:expirar-pagos` | Expira pagos digitales pendientes y libera stock |
| `job:bloquear-locales-vencidos` | Bloquea locales con deuda vencida |
| `job:conciliar` | Compara `cuenta_local` contra la suma del ledger |
| `job:integridad` | Verifica totales, reembolsos y saldos |

---

## 5. Invariantes y pruebas

| Invariante | Riesgo que cubre | Pruebas nuevas |
|---|---|---|
| 1. Ledger fuente de verdad | Escribir saldos por fuera de `registrarMovimiento` | Guardián estático ampliado a los tipos nuevos; prueba de que cada asiento actualiza el saldo en la misma transacción; prueba de que `registrarMovimiento` fuera de `withTransaccion` falla |
| 5. Snapshots inmutables | Recalcular comisión reescribiendo `sub_pedido` | Reembolso parcial no cambia `subtotal_productos`, `comision` ni `total`; la comisión objetivo se deriva |
| 6. Entregado ≠ dinero movido | Liberar antes de tiempo, con disputa o con reembolso pendiente | Día 4 no libera, día 5 sí; disputa abierta bloquea; reembolso pendiente bloquea; reembolso fallido desbloquea; job repetido no duplica; reembolsado_parcial libera el neto; `liberacion` incluye `costo_envio` y un reembolso de envío lo descuenta |
| 7. Stock atómico | Descontar en efectivo sin condición; devolver dos veces | Aceptar efectivo con stock 0 falla y cancela; dos aceptaciones simultáneas dejan un solo descuento; cancelar devuelve una sola vez; disputa con entrega no devuelve stock automáticamente; "producto recibido" devuelve una sola vez |
| 8. Deuda solo en liquidación | Compensar al entregar o con saldo retenido | Venta efectivo sube deuda sin tocar payable; liquidación con saldo retenido no compensa; deuda 100/saldo 40 deja deuda 60; `limite_deuda` se evalúa sobre el neto; no hay compensación automática fuera de la preparación de una liquidación; el único otro camino que baja deuda es un `pago_deuda` confirmado; una liquidación fallida repone la deuda con `reversa_cobro_deuda` |
| 9. Estado del local solo por la función/job | Admin desbloquea o pone en_plazo a mano | Todas las ramas de `recalcular_estado_local`; volver a activo limpia fecha; suspendido/pendiente no se tocan; job bloquea vencidos; trigger rechaza UPDATE directo a `en_plazo`/`bloqueado`; admin no puede desbloquear; `set_config(..., true)` no se filtra a otra transacción ni a otra conexión del pool |
| 10. Idempotencia | Doble clic en liquidación, pago de deuda, disputa | Misma `Idempotency-Key` devuelve la misma respuesta; clave nueva sobre recurso ya procesado da 409; reintento no duplica asientos; preparar/confirmar/fallar dos veces no duplica movimientos |
| 11. Nada financiero se borra | DELETE de liquidación/disputa/evidencia/pago deuda | Triggers de no borrado; liquidación pagada inmutable; fallida conserva sus reversas; ledger sin UPDATE/DELETE; auditoría solo agrega |
| 12. Montos en el backend | Cliente manda monto de reembolso o liquidación | El backend ignora montos del cliente; cálculo con precios congelados; totales de liquidación calculados; prueba con varias líneas y redondeo |
| 4.13 restricciones | Totales y reembolsos inconsistentes | `pedido.total = suma(sub.total)` sigue; suma de reembolsos <= pago.monto; suma por línea <= cantidad original; `pago.monto_reembolsado` = completados; `liquidacion.total_pagado = monto_liberado - monto_reembolsado - monto_compensado`; `liquidacion_movimiento` cuadra con los asientos; saldos no negativos |

Archivos de prueba propuestos:

- `tests/etapa4/ledger.test.js`
- `tests/etapa4/estadoLocal.test.js`
- `tests/etapa4/efectivo.test.js`
- `tests/etapa4/disputas.test.js`
- `tests/etapa4/liberacion.test.js`
- `tests/etapa4/liquidaciones.test.js`
- `tests/etapa4/jobs.test.js`
- `tests/etapa4/integridad.test.js`

Se actualizan `tests/invariantes/invariante_06...`, `invariante_08...`, `invariante_09...` y `invariante_11...` para quitar los `pendiente` que correspondan. El índice de invariantes debe seguir pasando.

Pruebas de concurrencia obligatorias:

- Dos jobs de liberación a la vez (el advisory lock deja correr uno solo).
- Dos `POST /admin/liquidaciones` a la vez para el mismo local.
- Dos `POST /preparar` con la misma liquidación.
- `POST /confirmar` y `POST /fallar` compitiendo por la misma liquidación `en_proceso`.
- Dos confirmaciones del mismo `pago_deuda`.
- Dos aperturas de disputa del mismo sub-pedido.
- Dos resoluciones de la misma disputa.
- Reembolso que se completa mientras se intenta preparar una liquidación.

---

## 6. Rutas nuevas y permisos

Todas bajo `/api/v1`, JSON snake_case, montos enteros, paginación estándar. Se documentan en `openapi.yaml` antes de implementar cada sub-etapa.

### Comprador

| Método | Ruta | Permiso | Qué hace |
|---|---|---|---|
| POST | `/sub-pedidos/{id}/disputas` | comprador dueño | Abre disputa; body: motivo, líneas/cantidades reclamadas, evidencia inicial |
| GET | `/disputas/{id}` | comprador dueño, vendedor del local, admin | Detalle y evidencia |
| POST | `/disputas/{id}/evidencia` | comprador/vendedor participante | Agrega texto o URL |
| POST | `/sub-pedidos/{id}/cancelar` | comprador/vendedor según 4.10 | Cancela y devuelve stock/reembolso |

### Vendedor

| Método | Ruta | Permiso | Qué hace |
|---|---|---|---|
| GET | `/vendedor/cuenta?local_id=` | vendedor dueño | Saldos, deuda, estado, fecha límite |
| GET | `/vendedor/movimientos?local_id=&pagina=` | vendedor dueño | Ledger del local |
| GET | `/vendedor/liquidaciones` | vendedor dueño | Lista sus liquidaciones |
| GET | `/vendedor/liquidaciones/{id}` | vendedor dueño | Detalle y movimientos |
| GET | `/vendedor/disputas?estado=` | vendedor dueño | Disputas de sus locales |
| POST | `/vendedor/disputas/{id}/evidencia` | vendedor dueño | Evidencia |
| POST | `/vendedor/deuda/pagos` | vendedor dueño | Reporta pago de deuda con referencia/comprobante; queda pendiente |
| GET | `/vendedor/deuda/pagos` | vendedor dueño | Historial de pagos de deuda |

### Admin

| Método | Ruta | Permiso | Qué hace |
|---|---|---|---|
| GET | `/admin/locales/{id}/cuenta` | admin | Saldos y estado |
| GET | `/admin/locales/{id}/movimientos` | admin | Ledger |
| POST | `/admin/liquidaciones` | admin | Crea lote en borrador; si el local está suspendido exige confirmación explícita; `Idempotency-Key` |
| GET | `/admin/liquidaciones?local_id=&estado=` | admin | Lista |
| GET | `/admin/liquidaciones/{id}` | admin | Detalle |
| POST | `/admin/liquidaciones/{id}/preparar` | admin | Fija montos y escribe `cobro_deuda`/`pago_a_local`; pasa a `en_proceso`; `Idempotency-Key` |
| POST | `/admin/liquidaciones/{id}/confirmar` | admin | Guarda referencia de payout y pasa a `pagada`; no escribe ledger; `Idempotency-Key` |
| POST | `/admin/liquidaciones/{id}/fallar` | admin | Desde `en_proceso`, escribe reversas y pasa a `fallida`; `Idempotency-Key` |
| POST | `/admin/liquidaciones/{id}/cancelar` | admin | Cancela un borrador sin mover dinero |
| GET | `/admin/disputas?estado=` | admin | Lista |
| GET | `/admin/disputas/{id}` | admin | Detalle |
| POST | `/admin/disputas/{id}/resolver` | admin | Resuelve a favor de comprador/vendedor; `Idempotency-Key` |
| POST | `/admin/disputas/{id}/producto-recibido` | admin | Devuelve stock de una disputa con entrega, por línea e idempotente |
| POST | `/admin/reembolsos/{id}/completar` | admin | Confirma reembolso manual/Wompi; `Idempotency-Key` |
| POST | `/admin/reembolsos/{id}/fallar` | admin | Marca fallido y alerta |
| POST | `/admin/pagos-deuda/{id}/confirmar` | admin | Confirma pago de deuda; `Idempotency-Key` |
| POST | `/admin/locales/{id}/pagos-deuda` | admin | Registra pago recibido directamente; `Idempotency-Key` |
| GET | `/admin/configuracion` | admin | Lee claves |
| PATCH | `/admin/configuracion` | admin | Cambia claves permitidas, audita y recalcula locales si aplica |

Reglas de permisos:

- El vendedor solo ve locales cuyo `local.usuario_id` es suyo.
- El comprador solo ve pedidos/disputas propios.
- El admin ve todo, pero no puede cambiar estados de deuda a mano (solo `activo`/`suspendido` y con las validaciones actuales).
- Los POST que crean pagos/liquidaciones/deuda exigen `Idempotency-Key`.

---

## 7. Casos de borde, idempotencia y bloqueos

| Caso | Qué puede pasar | Control |
|---|---|---|
| Doble clic en preparar liquidación | Dos `pago_a_local` y dos débitos | UNIQUE de liquidación abierta + `UPDATE ... WHERE estado='borrador'` + `Idempotency-Key` + lock de `cuenta_local` |
| Doble clic en confirmar pago | Dos pagos o referencia duplicada | `UPDATE ... WHERE estado='en_proceso'` + `Idempotency-Key` + `referencia_payout` UNIQUE |
| Dos liquidaciones a la vez para el mismo local | Se paga dos veces el mismo saldo | UNIQUE parcial `(local_id) WHERE estado IN ('borrador','en_proceso')` + `SELECT ... FOR UPDATE` de `cuenta_local` |
| Job de liberación corre dos veces | Dos `liberacion` y saldo duplicado | Advisory lock del script + `SKIP LOCKED` + UNIQUE `(sub_pedido_id) WHERE tipo='liberacion'` + `UPDATE ... WHERE saldo_liberado_en IS NULL` |
| Disputa se abre mientras el job libera | Se libera dinero disputado | Ambos bloquean `sub_pedido` con `FOR UPDATE`; el trigger de liberación verifica disputa abierta |
| Reembolso se completa mientras se prepara una liquidación | Se paga saldo que ya no corresponde | `congelacion` al quedar pendiente; la preparación bloquea `cuenta_local` y revalida; si no alcanza, 409 |
| Reembolso se completa dos veces | `pago.monto_reembolsado` y ledger duplicados | `UPDATE reembolso WHERE estado='pendiente'` + UNIQUE `(reembolso_id) WHERE tipo='reembolso' AND local_id IS NOT NULL` |
| Pago de deuda se confirma dos veces | Deuda baja dos veces | `UPDATE pago_deuda WHERE estado='pendiente'` + UNIQUE `(pago_deuda_id) WHERE tipo='cobro_deuda'` |
| Deuda se compensa fuera de liquidación | El local evade el bloqueo | Invariante 8: ninguna compensación automática fuera de la preparación; el `pago_deuda` confirmado es un pago explícito y auditado; prueba estática y de integración |
| Payout falla después de preparar | Dinero debitado sin pago, deuda compensada sin transferencia | `POST /fallar` escribe `reversa_pago_a_local` y `reversa_cobro_deuda` en la misma transacción y deja `fallida`; si la reversa falla, todo vuelve atrás y queda `en_proceso` |
| Se pierde la confirmación después de preparar | Liquidación `en_proceso` bloquea nuevas liquidaciones del local | El admin puede confirmar con la referencia real o marcar fallida y reversar; no se crea otra liquidación mientras esté `en_proceso` |
| El payout rebota después de confirmar | `pagada` es terminal y el ledger ya debitó | Se corrige con un asiento de ajuste auditado que reponga el saldo y, si corresponde, registre deuda; nunca se edita la liquidación |
| Reembolso después de payout | El vendedor ya recibió dinero que debe devolver | `reembolso` descuenta `saldo_por_pagar` disponible y el resto se registra como `deuda_reembolso`; luego `recalcular_estado_local()` |
| Comisión revertida después de payout | La comisión se devuelve o se netea contra un reembolso | Se netea contra el reembolso; el neto a favor del comprador se descuenta del saldo disponible y el resto pasa a `saldo_deuda`. Si el neto queda a favor del vendedor, se acredita `saldo_por_pagar` |
| Reembolso de envío | El vendedor ya cobró el flete | El `reembolso` local incluye `monto_envio` y descuenta del saldo del vendedor |
| Efectivo aceptado con stock insuficiente | Venta sin producto | `descontarStock()` atómico; si falla, cancela y no genera deuda |
| Efectivo entregado dos veces | Comisión duplicada | Transición condicionada `enviado -> entregado` + UNIQUE de `comision` con `local_id` por sub-pedido |
| Reembolso en efectivo vence | Deuda no registrada | Job condicionado `pendiente + fecha_limite < ahora`; `deuda_reembolso` único; recalc |
| Local bloqueado con ventas pendientes | ¿Se pueden entregar? | Sí: el bloqueo impide vender, no cumplir pedidos existentes; la entrega sigue y genera deuda |
| Zona horaria | Fecha límite un día antes/después | Todo en UTC; `fecha_limite_pago` DATE se compara con el día UTC |
| Redondeo de comisión | Diferencias de 1 peso | BigInt + `ajuste_redondeo` explícito y prueba con varias líneas |

---

## 8. Sub-etapas y orden

Cada sub-etapa termina con OpenAPI actualizado, migración nueva, pruebas, `npm run verificar` en verde y commit pequeño en `dev`. No se avanza a la siguiente sin la anterior aprobada.

### 4a — Fundaciones: ledger, cuentas y estado del local

- Migración 1: valores nuevos del enum de ledger (`liberacion`, `congelacion`, `descongelacion`, `deuda_reembolso`, `reversa_pago_a_local`, `reversa_cobro_deuda`), en un archivo separado porque PostgreSQL no deja usar un valor nuevo en la misma transacción.
- Migración 2: `cuenta_local` por local; trigger de estado de local; claves de configuración e índices únicos parciales del ledger. Las columnas `pago_deuda_id` y `disputa_id` se difieren a la 4b y 4c, respectivamente, porque sus tablas todavía no existen.
- `registrarMovimiento()` con los efectos nuevos y pruebas unitarias, incluida la fórmula con envío.
- Helper `src/jobs/ejecutarJob.js` con `pg_try_advisory_lock` y cierre garantizado de la conexión.
- `recalcular_estado_local()` y pruebas de todas las ramas, incluida la prueba de que `set_config(..., true)` no se filtra entre transacciones ni entre conexiones del pool.
- Guardián estático del invariante 1 ampliado.
- **No hay rutas nuevas todavía**, salvo las de lectura de cuenta si se quieren probar.

### 4b — Pedidos en efectivo y deuda de comisión

- Checkout efectivo: pedido `en_proceso`, pago pendiente, sin stock.
- Aceptar con descuento atómico; cancelar si no hay stock.
- Entregar: pago aprobado, `venta` + `comision` a deuda, recalc.
- Job `npm run job:cancelar-efectivo-sin-aceptar` con advisory lock.
- Rutas de cuenta/movimientos del vendedor y admin.
- Pruebas de efectivo, stock y estado.

### 4c — Disputas, evidencia y reembolsos

- Migración: `disputa`, `disputa_evidencia`, columnas de `reembolso`, `reembolso_linea`, triggers.
- Abrir disputa, evidencia, congelación/descongelación.
- Resolución y reembolsos por línea; comisión objetivo/reversa; reembolso digital y efectivo; envío reembolsado contra el saldo del vendedor.
- Reembolso posterior a payout: saldo disponible + `deuda_reembolso` por el resto.
- Job de reembolsos vencidos/incumplidos con advisory lock.
- Rutas de comprador, vendedor y admin, incluida "producto recibido".
- Pruebas de invariantes 6 (parte), 9 (parte), 11 y 4.13.

### 4d — Liberación de saldo

- Job `npm run job:liberar-saldos` con advisory lock, `SKIP LOCKED`, `liberacion` (`subtotal_productos + costo_envio - comision`), reembolsos pendientes y disputas.
- Trigger de retención y disputa; UNIQUE de liberación.
- Pruebas de fecha, reembolso, envío, disputa, parcial y concurrencia.
- Invariante 6 completo.

### 4e — Liquidaciones y compensación

- Migración: `liquidacion`, `liquidacion_movimiento`, índices y triggers.
- Crear borrador, preparar (`en_proceso`, asientos), confirmar (`pagada`, sin ledger), fallar (`fallida`, reversas), cancelar (`borrador`, sin dinero).
- Compensación de deuda solo en la preparación.
- Rutas de admin y vendedor.
- Pruebas de invariante 8, de totales y de reversas.

### 4f — Cancelaciones, jobs y paneles de cierre

- Cancelación 4.10 con devolución de stock y reembolso.
- **Auditoría de cancelaciones de efectivo aceptado:** las cancelaciones de
  pedidos en efectivo que ya pasaron por aceptación (`preparando` o `enviado`)
  se registran en `auditoria_admin` con motivo, actor y estado anterior. El
  panel de admin debe tener un listado para revisarlas. Es la fuga de comisión
  del efectivo y por eso no puede ser una cancelación silenciosa.
- Jobs como scripts `npm run job:...`: auto-entrega, expiración digital, conciliación, integridad, bloqueo diario; todos con advisory lock.
- Panel admin de configuración, conciliación y alertas.
- Pruebas de invariante 11 (retención), 4.13 completo y jobs (incluido que dos ejecuciones simultáneas no duplican).
- Documentación operativa de jobs y despliegue.

Orden elegido: primero las fundaciones, luego efectivo, luego disputas/reembolsos, luego liberación, luego liquidaciones y al final jobs/paneles. La razón es que la liberación necesita que las disputas y reembolsos ya existan para no liberar dinero bloqueado; la liquidación necesita saldo liberado; y los paneles necesitan todos los datos.

---

## 9. Decisiones cerradas y pendientes

### 9.1 Decisiones aprobadas

1. **Tipos nuevos del ledger** (`liberacion`, `congelacion`, `descongelacion`, `deuda_reembolso`, `reversa_pago_a_local`, `reversa_cobro_deuda`) y efectos de `comision`/`reversa_comision` con `local_id`. Aprobado.
2. **`liquidacion_movimiento` en vez de `ledger.liquidacion_id`**. El ledger sigue inmutable. Aprobado.
3. **Fórmula del saldo del vendedor:** `subtotal_productos + costo_envio - comision`. La comisión se calcula solo sobre productos y el envío se acredita al vendedor, igual que en efectivo. Los reembolsos de envío salen de su saldo. Aprobado.
4. **Stock en disputas con entrega:** no se devuelve automáticamente; solo con la acción explícita "producto recibido". Aprobado.
5. **Una sola disputa por sub-pedido** (UNIQUE). Aprobado.
6. **Estados de liquidación** `borrador/en_proceso/pagada/fallida/cancelada`, con preparación y confirmación separadas y reversa explícita al fallar. Aprobado.
7. **Pago de deuda:** se implementan las dos vías, el vendedor reporta y el admin confirma, o el admin registra un pago ya confirmado. Aprobado.
8. **Parámetros:** `dias_reembolso_efectivo = 5` y `monto_minimo_liquidacion = 0`, ambos configurables por el admin. Aprobado.
9. **Locales suspendidos:** se les libera el saldo; al crear la liquidación el admin decide explícitamente si los incluye (`confirmar_local_suspendido`). Aprobado.
10. **Reversa de comisión después de un payout:** se netea contra el reembolso pendiente. Si el neto sigue a favor del comprador, descuenta `saldo_por_pagar` disponible y el resto pasa a `saldo_deuda`; si queda a favor del vendedor, se acredita `saldo_por_pagar`. Aprobado.
11. **Jobs:** scripts independientes `npm run job:<nombre>` con candado advisory de PostgreSQL. La programación (cron externo, tarea del hosting o instancia siempre activa) se decide al desplegar. Aprobado.

### 9.2 Decisiones pendientes (no bloquean 4a)

1. **Comisión de Wompi.** Hoy `pago_recibido` registra el monto bruto y Wompi deposita el neto menos su comisión. La conciliación contra el ledger va a mostrar una diferencia igual a esa comisión. Falta decidir si se registra como gasto de plataforma (un tipo `comision_pasarela` o una tabla de gastos) o si la conciliación trabaja con bruto y neto por separado. Mientras no se decida, la conciliación reporta la diferencia y no la fuerza contra `cuenta_local`. No afecta el saldo del vendedor.
2. **Cuenta bancaria del vendedor.** No existe todavía dónde guardar banco, tipo de cuenta, número, titular y documento. Hay que elegir entre campos en `local`, una tabla `cuenta_bancaria_local` con historial, o un token del proveedor de payout. Al definirla, la liquidación debe guardar un snapshot de la cuenta destino al preparar el pago para no transferir a una cuenta cambiada después.

### 9.3 Decisiones que tomo por defecto (salvo que digas lo contrario)

- Montos enteros en pesos y BigInt; fechas UTC.
- Todo movimiento pasa por `registrarMovimiento()`; nada escribe saldos directamente.
- El backend calcula todos los montos; el cliente manda líneas/cantidades, nunca precios.
- Una liquidación abierta (`borrador` o `en_proceso`) por local; un pago de deuda confirmado una vez; una liberación por sub-pedido.
- Bloqueos con `SELECT ... FOR UPDATE`/`SKIP LOCKED` y `UPDATE ... WHERE estado`.
- OpenAPI se actualiza antes de cada ruta.
- `limite_deuda` se compara con `>` (como dice la spec), no con `>=`.
- La evidencia de disputa es texto/URL HTTPS; la subida de archivos espera la decisión de almacenamiento.
- En producción los reembolsos digitales siguen siendo manuales desde Wompi hasta confirmar la API de Reembolsos V2; el proveedor falso cubre las pruebas.
- No se toca `main`; todo va a `dev` en commits pequeños.

### 9.4 Pendientes previos al despliegue

- **`npm audit` (3 vulnerabilidades altas).** Al 22/10/2026, `npm audit --omit=dev`
  reporta 3 vulnerabilidades altas en la cadena de Prisma:
  `deepmerge-ts <8.0.0` (GHSA-ggr8-5vv4-36mx, agotamiento de pila al fusionar
  grafos recursivos), `@prisma/config` (afectado a traves de `deepmerge-ts`) y
  `prisma` (afectado a traves de `@prisma/config`). El arreglo disponible es
  `prisma@7.10.1`, un salto de version mayor; no se aplica en esta etapa.
  Antes de desplegar hay que evaluar y probar esa migracion de Prisma por
  separado. **No ejecutar `npm audit fix`**: puede cambiar la version mayor y
  romper migraciones, el cliente generado o los scripts de base de datos.

---

## 10. Criterios de aceptación de la etapa

- `npm run verificar` en verde, con los invariantes 6, 8 y 9 activos (sin `pendiente`).
- Prueba manual con Wompi falso:
  1. Pedido digital multi-local con envío -> pago -> entrega -> job de liberación (saldo = productos + envío - comisión) -> preparar liquidación con deuda compensada -> confirmar pago.
  2. Pedido digital -> preparar liquidación -> marcar fallida -> verificar reversas y que la deuda vuelve.
  3. Pedido en efectivo -> aceptar con stock -> entregar -> deuda -> pago de deuda -> local activo.
  4. Disputa digital -> congelación -> resolución comprador -> reembolso -> ledger y saldo correctos; si ya hubo payout, saldo disponible + deuda por el resto.
  5. Disputa efectivo -> incumplimiento -> deuda -> bloqueo -> pago -> reactivación.
- Conciliación nocturna sin diferencias entre `cuenta_local` y la suma del ledger. La comisión de Wompi se reporta como diferencia pendiente de decisión (9.2), no se fuerza contra el saldo del local.
- Los jobs corren como `npm run job:...`, toman su advisory lock y dos ejecuciones simultáneas no duplican trabajo.
- Ningún endpoint nuevo acepta montos calculados por el cliente.
- `openapi.yaml` actualizado y probado contra las rutas.
- `docs/despliegue.md` con la operación de jobs, trust proxy y respaldos.

---

## 11. Fuera de alcance de esta etapa

- Subida binaria de evidencias a S3 (depende de la decisión de almacenamiento).
- Payout automático a cuentas bancarias (no hay proveedor elegido).
- Búsqueda, notificaciones, calificaciones y home (Etapas 5 y 6).
- Retención y limpieza de `evento_webhook` (Etapa 6), salvo lo que ya existe.
- Edición de migraciones aplicadas.
