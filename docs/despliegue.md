# Despliegue a producción

Checklist de lo que no se puede dejar para después. La fuente de verdad sigue
siendo `especificacion_centro_comercial_v4.md`; esto es la parte operativa.

## 1. `trust proxy` y límites por IP

Los límites de peticiones (`express-rate-limit`) usan `req.ip`. Si la app corre
detrás de un proxy, un balanceador o un CDN y Express no confía en ese salto,
`req.ip` es la IP del proxy: **todos los visitantes comparten el mismo cubo** y
el límite bloquea a todo el mundo junto (o, al revés, un atacante puede evadir
el límite si se confía en cabeceras que no vienen de un proxy propio).

En el código ya está configurado:

```js
// src/app.js
app.set('trust proxy', 1);
```

Ese `1` significa "confío en exactamente un salto de proxy delante de la app".
En producción hay que **verificar que ese número coincida con la topología
real**:

| Montaje | Valor correcto |
|---|---|
| App expuesta directamente, sin proxy | `false` (no confiar en `X-Forwarded-For`) |
| Un proxy propio (Railway, Render, Nginx) | `1` |
| CDN + balanceador + app | `2` (o la cantidad real de saltos) |
| Varios proxies de una red propia | La subred o las IPs de esos proxies, no un número suelto |

Reglas:

- **Nunca usar `app.set('trust proxy', true)`**: confía en cualquier
  `X-Forwarded-For` que mande el cliente y permite falsificar la IP para evadir
  los límites.
- Si el proxy no envía `X-Forwarded-For`, `trust proxy` no sirve de nada:
  configurarlo en el proxy.
- Confirmar en los logs (`campo ip`) que la IP registrada es la del visitante y
  no la del proxy.
- Probar el límite después de desplegar. Por ejemplo, dos clientes distintos
  deben tener cubos distintos; el mismo cliente debe recibir `429` al pasar el
  límite.
- Si se cambia de hosting o se agrega un CDN, revisar este valor otra vez. Es
  parte del checklist de cada despliegue.

## 2. Cookies, HTTPS y CORS

- `NODE_ENV=production`.
- `SESSION_COOKIE_SECURE=true` y HTTPS obligatorio.
- `CORS_ORIGINS` con el origen exacto del frontend. No se permite `*` con
  credenciales.
- El frontend y la API deben compartir el dominio registrable para que la
  cookie `SameSite=Lax` viaje (por ejemplo `app.tudominio.co` y
  `api.tudominio.co`).

## 3. Base de datos y jobs

- Aplicar migraciones con `npm run db:migrate` (nunca editar una migración ya
  aplicada).
- Backup automático de PostgreSQL y prueba periódica de restauración.
- Los jobs necesitan una instancia siempre activa o un programador externo.
  Las capas gratuitas que duermen la instancia no sirven para esto. El detalle
  de cada job, su frecuencia, comando, candado y qué hacer si falla está en
  [`docs/jobs.md`](./jobs.md).
- Programar el cron en UTC. Una configuración de referencia para producción:

  ```cron
  */5 * * * *  cd /app && npm run job:expirar-pagos
  0 * * * *    cd /app && npm run job:auto-entregar
  0 * * * *    cd /app && npm run job:cancelar-efectivo-sin-aceptar
  0 * * * *    cd /app && npm run job:liberar-saldos
  15 0 * * *   cd /app && npm run job:reembolsos-efectivo-vencidos
  30 0 * * *   cd /app && npm run job:bloquear-locales-vencidos
  0 2 * * *    cd /app && npm run job:conciliar
  0 3 * * *    cd /app && npm run job:integridad
  ```

  `npm run job:todos` ejecuta los ocho en orden para una corrida manual, pero no
  reemplaza las frecuencias cortas de expiración de pagos y auto-entrega.
- Cada job toma su advisory lock: si el cron solapa dos ejecuciones, una se
  omite sin tocar datos. Un error del job sale con código 1; revisar los logs y
  la cola de alertas del panel admin antes de reintentar.
- Los jobs de conciliación e integridad solo alertan. Nunca corrigen saldos,
  totales ni estados financieros.
- Definir y sembrar la configuración real (`limite_deuda`, `plazo_dias`,
  `dias_retencion`, comisión, envío, etc.) antes de abrir ventas. Los cambios de
  `limite_deuda` o `plazo_dias` desde el panel recalculan todos los locales en
  una transacción y quedan auditados.

## 4. Secretos

- `SESSION_SECRET` distinto del de desarrollo y generado con aleatoriedad.
- Claves de Wompi, correo y almacenamiento solo en variables de entorno. Nunca
  en el repositorio ni en archivos `.env` versionados.

## 5. Cifrado de datos bancarios

- `CUENTA_BANCARIA_ENCRYPTION_KEY` debe ser base64 de exactamente 32 bytes
  aleatorios. Generarla con:

  ```bash
  node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
  ```

- La clave cifra con AES-256-GCM el numero de cuenta y el documento del titular
  del local, y el snapshot de esos datos en cada liquidacion. Nunca se guarda
  en la base ni se escribe en logs.
- Cada valor cifrado guarda la version de la clave en el sobre:

  ```text
  v1.<version_clave>.<iv>.<tag>.<ciphertext>
  ```

  `CUENTA_BANCARIA_KEY_VERSION` (por defecto `1`) identifica la clave activa.
  Cambiarla sin rotar los datos existentes los vuelve ilegibles.
- **Perder la clave significa perder los numeros de cuenta y documentos.** No
  se pueden reconstruir desde la base, los respaldos de la base ni el codigo:
  el ciphertext sin la clave es inutil. Esto afecta tanto la cuenta del local
  como los snapshots ya copiados a liquidaciones.
- Guardar la clave en el gestor de secretos del hosting, con acceso restringido.
  Mantener ademas un respaldo fuera del servidor, en un gestor de secretos
  distinto o en custodia offline con al menos dos responsables. Un respaldo
  solo en el mismo servidor no protege contra la perdida del servidor. No
  reutilizar `SESSION_SECRET`.
- **Rotacion futura (aun no implementada):** el identificador de version ya se
  almacena en cada valor. La rotacion debera leer con la version anterior,
  escribir con la nueva, recifrar tanto los datos de `local` como los snapshots
  de liquidaciones, y conservar la clave anterior hasta que no quede ninguna
  fila con esa version. No cambiar `CUENTA_BANCARIA_KEY_VERSION` hasta que la
  migracion de recifrado haya terminado y este verificada.
- El admin solo ve el numero y el documento completos en el detalle de una
  liquidacion. Cada una de esas consultas queda registrada en
  `auditoria_admin` con el actor, la fecha y el `liquidacion_id`. Las listas, el
  vendedor y los logs reciben valores enmascarados.
- Antes de desplegar, verificar que la base no contenga numeros de cuenta o
  documentos en columnas de texto plano. Esos datos solo viven en
  `numero_cuenta_cifrado`, `documento_titular_cifrado` y en las columnas
  cifradas del snapshot de la liquidacion.
