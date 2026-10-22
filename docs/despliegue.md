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
- Los jobs (liberación de saldo, bloqueo por deuda, conciliación, expiración de
  pagos, etc.) necesitan una instancia siempre activa o un programador externo.
  Las capas gratuitas que duermen la instancia no sirven para esto.
- Definir y sembrar la configuración real (`limite_deuda`, `plazo_dias`,
  `dias_retencion`, comisión, envío, etc.) antes de abrir ventas.

## 4. Secretos

- `SESSION_SECRET` distinto del de desarrollo y generado con aleatoriedad.
- Claves de Wompi, correo y almacenamiento solo en variables de entorno. Nunca
  en el repositorio ni en archivos `.env` versionados.
