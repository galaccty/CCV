# Jobs operativos

Los jobs son scripts independientes de corta duración. No hay un planificador
dentro del proceso HTTP: en producción los debe lanzar un cron externo, una
tarea del hosting o una instancia siempre activa. Las capas gratuitas que
duermen la instancia no sirven para esto.

Todos los comandos se ejecutan desde la raíz del backend, con el `DATABASE_URL`
de producción y los mismos secretos que la API.

## Reglas comunes

- Cada job abre una conexión propia y toma un **advisory lock** de PostgreSQL
  con `pg_try_advisory_lock`. Si otra instancia ya lo tiene, imprime
  `{ "ejecutado": false, "motivo": "ocupado" }`, no toca nada y termina con
  código 0. Eso no es un fallo: significa que el trabajo ya se está haciendo.
- Las claves numéricas viven en un solo lugar, `src/jobs/ejecutarJob.js`
  (`CLAVES_JOBS`). No se deben reutilizar entre jobs.
- Los jobs son idempotentes. Se pueden reintentar después de un fallo; las
  transiciones usan `UPDATE ... WHERE estado = ...`, los locks de fila y los
  índices únicos del ledger para no duplicar dinero.
- Un error inesperado del job hace que el proceso termine con código 1. En
  `job:todos` el error se informa y la cadena continúa con los siguientes jobs;
  al final, `job:todos` también termina con código 1.
- Las fechas y los cortes se manejan en UTC. Un job diario se debe programar
  después de medianoche UTC, no en la medianoche local.
- Los jobs de conciliación e integridad **solo generan alertas**. Nunca
  corrigen saldos, totales ni estados financieros. La reparación es una
  investigación manual y auditada.
- Después de un fallo, revisar los logs del proceso y la tabla de alertas del
  panel admin (`GET /api/v1/admin/alertas`). Reintentar es seguro.

## Tabla de jobs

| Job | Qué hace | Frecuencia recomendada | Comando | Clave del candado |
|---|---|---|---|---|
| `auto_entrega` | Pasa a `entregado` los sub-pedidos `enviado` con `dias_auto_entrega` vencidos, sin disputa abierta. Usa `entrega_confirmada_por = sistema`. En efectivo registra la venta y la comisión como deuda una sola vez. No libera saldo. | Cada hora | `npm run job:auto-entregar` | `41008` |
| `expirar_pagos` | Pasa a `expirado` los pagos digitales (`tarjeta`, `pse`, `nequi`) pendientes con `minutos_expiracion_pago` vencidos y deja el pedido y sus sub-pedidos en `cancelado`. No hay stock descontado que devolver en digital. Si Wompi aprueba después, el webhook toma el camino de reembolso manual y deja alerta. | Cada 5 minutos | `npm run job:expirar-pagos` | `41004` |
| `cancelar_efectivo_sin_aceptar` | Cancela los sub-pedidos en efectivo que siguen `por_aceptar` después de `horas_aceptacion`. No toca stock porque en efectivo nunca se descontó al crear. | Cada hora | `npm run job:cancelar-efectivo-sin-aceptar` | `41003` |
| `reembolsos_efectivo_vencidos` | Marca `incumplido` el reembolso en efectivo vencido, registra una sola `deuda_reembolso` y recalcula el estado del local. | Diaria, 00:15 UTC | `npm run job:reembolsos-efectivo-vencidos` | `41007` |
| `liberacion_saldo` | Libera el saldo de sub-pedidos entregados que cumplieron `dias_retencion`, sin disputa abierta ni reembolso pendiente. Incluye reembolsos y reversas de comisión que correspondan. | Cada hora | `npm run job:liberar-saldos` | `41001` |
| `bloqueo_deuda` | Pasa a `bloqueado` los locales con deuda vencida. Antes de decidir **siempre** llama a `recalcularEstadoLocal()`: un local que acaba de pagar no se bloquea. No toca `suspendido` ni `pendiente_aprobacion`. | Diaria, 00:30 UTC | `npm run job:bloquear-locales-vencidos` | `41002` |
| `conciliacion_nocturna` | Reconstruye desde el ledger los tres saldos de cada `cuenta_local` y crea una alerta `conciliacion_saldo` si hay diferencias. Solo lee y alerta. | Diaria, 02:00 UTC | `npm run job:conciliar` | `41005` |
| `verificacion_integridad` | Compara `pago.monto_reembolsado` con los reembolsos completados, `pedido.total` con sus sub-pedidos, busca saldos negativos, `en_disputa` sin disputa abierta y pedidos `en_proceso` sin actividad por 7 días. Solo lee y alerta. | Diaria, 03:00 UTC | `npm run job:integridad` | `41006` |

## Qué hacer si un job falla

| Job | Acción |
|---|---|
| `auto_entrega` | Revisar `auto_entrega_error` y el historial del sub-pedido. Corregir la causa (pago, historial o disputa) y reintentar. No marcar `entregado` a mano. |
| `expirar_pagos` | Revisar `expirar_pago_error`. Si Wompi ya aprobó, el webhook tiene prioridad; no forzar `expirado`. Reintentar el job es seguro. |
| `cancelar_efectivo_sin_aceptar` | Revisar el sub-pedido y los logs. Si sigue `por_aceptar` y el plazo venció, reintentar; no cancelar ni tocar stock a mano. |
| `reembolsos_efectivo_vencidos` | Revisar el reembolso y la deuda del local. Reintentar solo si sigue pendiente y vencido; no editar `monto_reembolsado` ni saldos. |
| `liberacion_saldo` | Revisar los logs y la alerta asociada. Reintentar es seguro; el índice único impide liberar dos veces. No asentar movimientos a mano. |
| `bloqueo_deuda` | Revisar la cuenta y la fecha del local. Corregir la causa y reintentar. No desbloquear ni cambiar el estado a mano. |
| `conciliacion_nocturna` | Abrir la alerta `conciliacion_saldo`, comparar contra el ledger y escalar a ingeniería. El job no corrige nada. |
| `verificacion_integridad` | Abrir la alerta de integridad correspondiente e investigar el pedido, pago o saldo. No corregir datos financieros a mano. |
| `job:todos` | Revisar el JSON de salida para saber qué pasos fallaron y si alguno estaba `ocupado`; luego seguir la acción del job concreto. El comando sale con código 1 si hubo error. |

## `job:todos`

`npm run job:todos` ejecuta los ocho jobs activos en este orden:

1. `auto_entrega` (`41008`)
2. `expirar_pagos` (`41004`)
3. `cancelar_efectivo_sin_aceptar` (`41003`)
4. `reembolsos_efectivo_vencidos` (`41007`)
5. `liberacion_saldo` (`41001`)
6. `bloqueo_deuda` (`41002`)
7. `conciliacion_nocturna` (`41005`)
8. `verificacion_integridad` (`41006`)

Cada paso toma su propio candado. Se puede usar para una corrida manual de
diagnóstico o como única entrada si no se quiere configurar un cron por job.
**Si se usa un único cron con `job:todos`, debe ejecutarse cada 5 a 10 minutos:**
la expiración de pagos y la auto-entrega no pueden esperar a una corrida diaria.
El resultado se imprime como JSON.

## Alertas que generan los jobs y webhooks

| Tipo | Origen | Qué revisar |
|---|---|---|
| `reembolso_pendiente_manual` | Webhook tardío de un pago expirado o pedido cancelado | Devolver el dinero desde Wompi y completar/fallar el reembolso desde el panel. |
| `reembolso_fallido` | Intento de reembolso fallido | Revisar el motivo y reintentar o escalar. |
| `conciliacion_saldo` | `job:conciliar` | Comparar la cuenta contra el ledger; no editar saldos a mano. |
| `integridad_pago_reembolsado` | `job:integridad` | `pago.monto_reembolsado` no coincide con los reembolsos completados. |
| `integridad_total_pedido` | `job:integridad` | El total del pedido no coincide con la suma de sus sub-pedidos. |
| `integridad_saldo_negativo` | `job:integridad` | Algún saldo de `cuenta_local` quedó negativo. |
| `integridad_disputa_abierta` | `job:integridad` | Un sub-pedido está `en_disputa` sin disputa abierta. |
| `integridad_pedido_estancado` | `job:integridad` | Pedido `en_proceso` sin actividad por 7 días. |
| `auto_entrega_error` / `expirar_pago_error` | Fallo transitorio del job | Revisar el log y reintentar; no se debe corregir el estado a mano. |

Las alertas tienen una clave estable. Una corrida repetida actualiza
`ultima_deteccion_en` y no duplica filas. Si el admin resuelve una alerta y la
causa vuelve a aparecer, la misma alerta se reabre.

## Comprobaciones después de desplegar

1. Ejecutar una vez cada job con un lote controlado y revisar el JSON de salida.
2. Confirmar que `job:conciliar` e `job:integridad` no reportan diferencias
   inesperadas.
3. Verificar que no queden alertas `abierta` de alta severidad sin responsable.
4. Revisar que el cron use UTC y que tenga acceso al `PATH` de Node/npm del
   servidor.
5. Confirmar que el proceso tenga una sola `DATABASE_URL` de producción y que
   las migraciones ya estén aplicadas con `npm run db:migrate`.
