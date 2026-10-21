# Centro Comercial Virtual — Backend

Backend del marketplace multi-vendedor. Node.js + Express + PostgreSQL.

**Estado: Etapa 3b (backend) implementada y verificada en modo de pruebas.**
Incluye el corte vertical de la Etapa 2 y, encima, rubros/categorías globales,
varios locales por vendedor, variantes, catálogo público, carrito multi-local,
cotización de envío, direcciones del comprador, ajuste de stock por diferencia,
envío por distancia y pedido mínimo por local. El frontend de la Etapa 3 se hará
en otro repositorio.

El proveedor de Wompi es falso por defecto: no hace llamadas HTTP y permite
probar checkout, pago, webhook, stock y ledger completos. La integración real
espera las llaves de sandbox. Mientras tanto, si un pago real no puede
confirmarse por stock, el reembolso queda `pendiente`, el pedido pasa a
`reembolso_pendiente` y el dinero se devuelve manualmente desde el panel de
Wompi.

La especificación completa vive en
[`especificacion_centro_comercial_v4.md`](./especificacion_centro_comercial_v4.md).
Ese archivo manda sobre cualquier otra cosa.

---

## 1. Qué necesitas

| Herramienta | Estado |
|---|---|
| Node.js 20.11 o superior | Instalada (v24.21.0) |
| PostgreSQL 16.10 | **Instalada** en `C:\Users\anturi\pgsql` |
| Git 2.55.0 | **Instalada** en `C:\Users\anturi\git` |

### Sobre PostgreSQL

Está instalada **sin permisos de administrador**: se bajaron los binarios
oficiales y se inicializó una base en `C:\Users\anturi\pgdata`. Por eso no
quedó como servicio de Windows y hay que arrancarla a mano:

```bash
npm run db:estado     # ver si está corriendo
npm run db:iniciar    # arrancarla
npm run db:parar      # pararla
```

Las rutas están en `PGBIN`, `PGDATA` y `PGLOG`, dentro del `.env`. Si algún día
movés la instalación, cambias esas líneas y nada más.

> **El log está fuera de la carpeta de datos a propósito.** Si estuviera dentro,
> abrirlo para ver qué pasa le bloquea el archivo al servidor por el bloqueo de
> archivos de Windows. El log está en `C:\Users\anturi\pgdata-server.log`
> (lo controla `PGLOG` en el `.env`).

### Si la base queda en "starting up"

No adivines: el log dice qué pasó. En PowerShell:

```powershell
Get-Content C:\Users\anturi\pgdata-server.log -Tail 40
```

Qué buscar, en orden:

| Línea en el log | Qué significa |
|---|---|
| `database system was interrupted; last known up at ...` | La base se cerró de golpe (corte de luz, Ctrl+C, o se mató el proceso). Está haciendo recuperación con el WAL. |
| `redo done at ...` y después `database system is ready to accept connections` | La recuperación terminó bien. No hay nada que hacer. |
| `could not open file "./server.log": sharing violation` | El log estaba dentro de `PGDATA` y otro programa lo tenía abierto. Por eso ahora vive fuera. |
| `terminated by exception 0xC000013A` | El proceso recibió Ctrl+C o se cerró la consola que lo contenía. |

La recuperación normal tarda segundos. Si después de un minuto sigue en
`starting up`, o el log se queda repitiendo `sharing violation`:

```bash
npm run db:parar
npm run db:iniciar
```

Si `db:parar` dice que no hay servidor pero el puerto 5432 sigue ocupado, hay un
proceso `postgres.exe` colgado: cerralo desde el Administrador de tareas y
volvé a arrancar. **Nunca borres `C:\Users\anturi\pgdata`**: ahí están tus datos.

> **Qué pasó la vez que se trabó.** Fueron dos cosas juntas, no una: la base
> había recibido un cierre brusco (`0xC000013A`) y estaba recuperando, y encima
> el log estaba dentro de `PGDATA`, así que al leerlo con `Get-Content` Windows
> le bloqueó el archivo al servidor. Mover el log afuera elimina la segunda;
> la primera se resuelve sola con la recuperación. Por eso el README pide mirar
> el log antes de suponer la causa.

Hay dos bases:

- **`ccv`** — tu desarrollo. Acá va `npm run db:migrate` y `npm run seed`.
- **`ccv_test`** — la usan las pruebas. Las pruebas cambian el nombre de la
  base automáticamente: **nunca tocan tu base de desarrollo**. Además,
  `npm test` **recrea `ccv_test` desde cero** antes de correr (script
  `scripts/recrear-base-pruebas.js`: borra la base, la crea de nuevo y aplica
  las migraciones). Así no se acumulan usuarios ni pedidos de corridas viejas
  y los triggers de protección quedan activos durante toda la prueba.

> **Si la base está apagada, las pruebas fallan.** No se saltan solas: el error
> dice `Levantala con: npm run db:iniciar`. Es a propósito, porque las pruebas
> que más importan (dinero, stock, pedidos) son justo las que necesitan base y
> antes quedaban en verde sin haberse ejecutado. Para correr solo las que no
> necesitan base existe `PERMITIR_SALTAR_BD=1`, que **se ignora en CI**.

Si preferís una base en la nube (Supabase o Neon dan una gratis), poné esa
`DATABASE_URL` en el `.env` y creá la base `_test` a mano.

### Sobre Git

Instalada. Está en la sección [10. Git](#10-git).

---

## 2. Ponerlo a funcionar

Abre la terminal **dentro de esta carpeta** y ve en orden.

### Paso 1 — Instalar las dependencias

```bash
npm install
```

### Paso 2 — Arrancar la base de datos

```bash
npm run db:iniciar
```

Debería terminar diciendo que el servidor está en ejecución. Si dice que ya
está corriendo, mejor: seguí.

### Paso 3 — Crear el archivo de configuración

```bash
copy .env.example .env
```

> En macOS o Linux: `cp .env.example .env`

El `.env` que ya tenés tiene los valores correctos para esta instalación. Si
lo recreás desde el ejemplo, poné:

- `DATABASE_URL="postgresql://postgres:postgres@localhost:5432/ccv?schema=public"`
- `PGBIN="C:/Users/anturi/pgsql/pgsql/bin"`
- `PGDATA="C:/Users/anturi/pgdata"`

Para generar un `SESSION_SECRET` nuevo:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

### Paso 4 — Crear las tablas

```bash
npm run db:migrate
```

Aplica todas las migraciones en orden, desde las cinco tablas de la Etapa 1
hasta el carrito y los índices de catálogo de la Etapa 3.

> **Regla del proyecto:** una migración ya aplicada nunca se edita. Si algo está
> mal, se agrega una migración nueva. Para desarrollo, `npm run db:dev` te
> pregunta el nombre de la nueva.

### Paso 5 — Cargar la configuración inicial

```bash
npm run seed
```

Carga las once claves de la tabla `configuracion` con **valores de ejemplo** y
la taxonomía inicial de la Etapa 3: 8 rubros y 16 categorías globales (raíces e
hijas). Los rubros son Ropa y accesorios, Calzado, Tecnología, Comida y bebidas,
Perfumería y belleza, Hogar, Arte y manualidades y Mascotas. Vas a ver la lista
al terminar. Los valores de configuración se cambian
cuando tengas los números reales de Wompi y la respuesta del abogado. La semilla
es idempotente: se puede volver a correr sin duplicar filas.

### Paso 6 — Crear el primer administrador

Antes de esto, poné `ADMIN_EMAIL` y `ADMIN_PASSWORD` en tu `.env`.

```bash
npm run crear-admin
```

No existe registro público de administradores a propósito: se crean desde acá.

### Paso 7 — Arrancar el servidor

```bash
npm run dev
```

Deberías ver algo así:

```
[INFO]: proveedor de correo activo
[INFO]: base de datos conectada
[INFO]: servidor escuchando
[INFO]: puerto: 3000
```

Abrí `http://localhost:3000/api/v1/salud` en el navegador. Si pone
`"estado": "ok"`, todo está funcionando.

### Paso 8 — Probar el registro

```bash
curl -X POST http://localhost:3000/api/v1/auth/registro ^
  -H "Content-Type: application/json" ^
  -H "X-CSRF-Token: TEMPORAL" ^
  -d "{\"nombre\":\"Ana\",\"email\":\"ana@ejemplo.com\",\"contrasena\":\"MiContrasena123\",\"acepto_terminos\":true}"
```

Ojo: el token CSRF hay que sacarlo antes de
`GET http://localhost:3000/api/v1/csrf`. Es más fácil probarlo desde el
frontend; si estás en el navegador, la forma es:

1. Abrí `http://localhost:3000/api/v1/csrf` y copiá el `token`.
2. Usá ese valor en la cabecera `X-CSRF-Token`.

Si prefieres no pelearte con `curl` desde Windows, el archivo
`scripts/probar-registro.js` hace el flujo completo. Lo vas a encontrar al
final de este README.

---

## 3. El correo sale por consola

No hay proveedor de correo todavía, porque la especificación lo deja como
decisión pendiente (sección 2).

Mientras tanto, `MAIL_DRIVER=consola` imprime el mensaje completo en la
terminal donde corre el servidor, con el enlace de verificación listo para
copiar y pegar en el navegador.

Cuando elijas proveedor (Resend, Postmark o SES):

1. Agregás un archivo en `src/mail/` con un objeto que tenga
   `{ nombre, enviar(correo) }`.
2. Cambiás `MAIL_DRIVER` en el `.env` por el nombre de tu proveedor.
3. Cargás `MAIL_PROVEEDOR_API_KEY`.

Ningún otro archivo del proyecto cambia.

---

## 4. Probarlo en el navegador con las cookies

El backend usa cookie `httpOnly`, así que `fetch` a pelo desde la consola del
navegador no va a autenticarte. La forma fácil es con un archivo HTML servido
desde el mismo origen.

Ya viene una ruta que ayuda: `GET /api/v1/csrf` devuelve el token y también
pone la cookie. El flujo del frontend va a ser:

1. `GET /api/v1/csrf` → guardás `token` y la cookie se queda sola.
2. `POST /api/v1/auth/registro` con la cabecera `X-CSRF-Token: <token>`.
3. Para iniciar sesión: `POST /api/v1/auth/login` con la misma cabecera.
4. Para saber quién está conectado: `GET /api/v1/auth/yo`.

Cuando exista el frontend, esto lo resuelve la librería de peticiones.

---

## 5. Comandos

| Comando | Qué hace |
|---|---|
| `npm run dev` | Arranca el servidor con recarga automática |
| `npm start` | Arranca el servidor normal |
| `npm test` | Todas las pruebas |
| `npm run test:invariantes` | Solo las pruebas de invariantes |
| `npm run verificar` | Lo que corre CI: guardianes + pruebas |
| `npm run check:invariantes` | Los guardianes estáticos (invariantes 1, 4 y 7) |
| `npm run db:iniciar` | Arranca PostgreSQL |
| `npm run db:parar` | Detiene PostgreSQL |
| `npm run db:estado` | Dice si PostgreSQL está corriendo |
| `npm run db:migrate` | Aplica las migraciones |
| `npm run db:dev` | Crea una migración nueva en desarrollo |
| `npm run db:studio` | Abre el panel visual de la base de datos |
| `npm run db:reset` | **Borra** la base y la vuelve a crear. Cuidado. |
| `npm run db:test:reset` | Lo mismo, pero sobre la base de pruebas |
| `npm run seed` | Carga la configuración y la taxonomía inicial |
| `npm run crear-admin` | Crea o actualiza el administrador del `.env` |
| `npm run probar-registro` | Hace un registro completo de punta a punta |

### 5.1 Rutas de la Etapa 3b

Todas van bajo `/api/v1`. El contrato completo está en `openapi.yaml`.

| Método | Ruta | Quién |
|---|---|---|
| GET | `/rubros` | público |
| GET | `/categorias-globales?rubro_id=&padre_id=` | público |
| GET | `/locales?rubro_id=&categoria_global_id=&pagina=&por_pagina=` | público |
| GET | `/locales/{id}` | público |
| GET | `/locales/{id}/productos?categoria_global_id=&subcategoria_local_id=` | público |
| GET | `/productos/{id}` | público |
| GET | `/carrito` | comprador con sesión |
| POST | `/carrito/cotizar` | comprador con sesión |
| DELETE | `/carrito` | comprador con sesión |
| PUT | `/carrito/items/{variante_id}` | comprador con sesión |
| DELETE | `/carrito/items/{variante_id}` | comprador con sesión |
| GET / POST | `/direcciones` | comprador con sesión |
| PATCH / DELETE | `/direcciones/{id}` | comprador dueño |
| PATCH | `/direcciones/{id}/principal` | comprador dueño |
| GET / POST | `/vendedor/locales` | vendedor |
| PATCH | `/vendedor/locales/{id}` | vendedor dueño |
| POST | `/vendedor/locales/{id}/subcategorias` | vendedor dueño |
| PATCH | `/vendedor/subcategorias/{id}` | vendedor dueño |
| GET / POST | `/vendedor/productos` | vendedor |
| PATCH | `/vendedor/productos/{id}` | vendedor dueño |
| POST | `/vendedor/productos/{id}/variantes` | vendedor dueño |
| PATCH | `/vendedor/variantes/{id}` | vendedor dueño |
| PATCH | `/vendedor/variantes/{id}/stock` | vendedor dueño |
| GET | `/admin/locales?estado=` | admin |
| PATCH | `/admin/locales/{id}/estado` | admin |
| POST | `/admin/rubros` | admin |
| PATCH | `/admin/rubros/{id}` | admin |
| POST | `/admin/categorias-globales` | admin |
| PATCH | `/admin/categorias-globales/{id}` | admin |

El checkout sigue siendo `POST /pedidos`: agrupa los ítems por local, crea un
`sub_pedido` por local y un solo pago por el total. El mínimo se valida contra
el subtotal de productos de cada local, sin envío.

La cotización `POST /carrito/cotizar` usa el carrito guardado y devuelve por
local subtotal, envío, mínimo, faltante y total. Es solo lectura: no crea pedido
ni toca stock. El detalle público `GET /productos/{id}` devuelve `disponible`
(hay/no hay) en vez de la cantidad exacta de inventario.

Las direcciones guardan `latitud` y `longitud` calculadas por el frontend. El
backend no geocodifica: solo valida un rango aproximado de Colombia. Cualquier
proveedor de geocodificación se decidirá en una etapa posterior. La primera
dirección queda como principal; el índice único parcial impide dos principales.

CORS usa `CORS_ORIGINS` (por defecto `http://localhost:5173`) y responde con
`Access-Control-Allow-Credentials: true` solo a ese origen exacto. No se debe
usar `*`: la cookie de sesión y el token CSRF viajan con credenciales.

---

## 6. Cómo está armado

```
backend/
├── prisma/
│   ├── schema.prisma          los modelos de datos
│   └── migrations/            SQL versionado; nunca se edita lo aplicado
├── src/
│   ├── app.js                 construye la app de Express
│   ├── server.js              la arranca
│   ├── config/                lectura y validación del .env
│   ├── lib/                   prisma, logger, errores, cripto, transacción
│   ├── mail/                  interfaz del correo + proveedor de prueba
│   ├── middlewares/           sesión, CSRF, CORS, rate limit
│   ├── routes/v1/             las rutas, bajo /api/v1
│   ├── services/              la lógica de negocio
│   └── jobs/                  registro de tareas programadas
├── scripts/
│   ├── seed.js                configuración y taxonomía inicial
│   └── crear-admin.js         primer administrador
├── checks/                    guardianes de invariantes que corren en CI
├── tests/
│   ├── invariantes/           invariante_01 ... invariante_12
│   └── helpers/               utilidades para pruebas
└── .github/
    ├── pull_request_template.md
    └── workflows/ci.yml
```

Las decisiones que importan:

- **La cookie de sesión no usa tabla.** Es un valor firmado con HMAC que lleva
  el id del usuario y su vencimiento. El rol y el estado `activo` se leen
  **siempre** de la base, por eso desactivar un usuario o cambiarle el rol
  surte efecto de inmediato. La contrapartida es que cerrar sesión borra la
  cookie pero no invalida el token hasta que expira. Si más adelante querés
  revocación inmediata, se agrega una tabla `sesion` en una migración nueva.
- **El proveedor de correo es intercambiable** detrás de una interfaz.
- **Los guardianes de CI protegen el ledger, el stock y Wompi**, además de las
  pruebas de invariantes. Se ejecutan antes de la suite completa y bloquean el
  merge si aparece una escritura por fuera de los módulos autorizados.

---

## 7. Los invariantes y las pruebas

La sección 10 de la especificación define doce invariantes. Cada uno tiene un
archivo de prueba en `tests/invariantes/`.

**Estado en la Etapa 3b:**

| # | Invariante | Estado |
|---|---|---|
| 1 | El ledger es la fuente de verdad | activo (solo `services/ledger.js` escribe saldos) |
| 2 | `pago.referencia` es UNIQUE | activo (UNIQUE + alerta de referencia desconocida) |
| 3 | El webhook responde 200 solo después | activo (200 después de procesar; 5xx si es transitorio) |
| 4 | Wompi nunca dentro de una transacción | activo (3 capas) |
| 5 | Los snapshots no se modifican | activo (triggers de la Etapa 2) |
| 6 | Entregado ≠ dinero movido | parcial (reembolso pendiente bloquea elegibilidad y trigger; faltan job y disputas de la Etapa 4) |
| 7 | Stock solo por el módulo de stock | activo (módulo único, concurrencia, stock inicial y ajuste por diferencia) |
| 8 | La deuda se compensa solo en liquidación | pendiente, Etapa 4 |
| 9 | El estado del local solo lo cambia `recalcular_estado_local` | pendiente, Etapa 4 |
| 10 | Idempotency-Key en los POST que crean | activo (pedido y pago) |
| 11 | Nada financiero se borra | parcial (productos se desactivan; falta la retención de la Etapa 6) |
| 12 | Los montos se calculan en el backend | activo (checkout, incluso con varios locales) |

"pendiente" no es "borrado": cada archivo tiene el motivo y la etapa escritos en
el comentario, y `tests/invariantes/indice.test.js` falla si alguien borra
alguno.

`npm test` muestra el resumen completo. Las pruebas que necesitan base de datos
**fallan** con un mensaje claro si no hay conexión; solo se saltan si se define
`PERMITIR_SALTAR_BD=1`, y esa variable se ignora en CI.

---

## 8. Sobre las pruebas

Las pruebas corren contra la base real (`ccv_test`), no contra simulacros.

`npm run verificar` (guardianes + cobertura de pruebas + tests) da así al
terminar la Etapa 3b:

```
Invariantes estaticos: OK (1, 4 y 7 sin violaciones).
tests 214 · pass 202 · fail 0 · skipped 12
```

Las 12 que se saltan son **todas invariantes que todavía no aplican**, y cada
una dice en pantalla por qué y en qué etapa se activa:

- 3 del invariante 6 (el job y las disputas llegan en la Etapa 4).
- 4 del invariante 8 (liquidaciones de la Etapa 4).
- 4 del invariante 9 (máquina de estados del local, Etapa 4).
- 1 del invariante 11 (retención de datos, Etapa 6).

Cero se saltan por falta de base. `pretest` **recrea** `ccv_test` desde cero,
aplica todas las migraciones y siembra la configuración base. No se usa
`TRUNCATE` ni se desactivan triggers.

Si PostgreSQL no está corriendo, las pruebas de base fallan con un mensaje que
explica cómo levantarlo (`npm run db:iniciar`). Solo se saltan si se define
`PERMITIR_SALTAR_BD=1` fuera de CI; en CI esa variable se ignora.

---

## 9. Qué falta

La Etapa 3b quedó implementada en el backend con el **proveedor Wompi falso**.
Todavía no está hecho, a propósito:

- **Frontend de la Etapa 3:** va en otro repositorio. Este backend ya expone el
  contrato y las rutas que necesita.
- **Geocodificación:** las coordenadas las calcula el frontend. No hay proveedor
  de geocodificación en el backend; si se necesita, se decide y documenta antes
  de implementarlo.
- **Wompi real:** cargar `WOMPI_PUB_KEY`, `WOMPI_PRV_KEY`, `WOMPI_EVENTS_KEY` y
  `WOMPI_INTEGRITY_KEY`, poner `WOMPI_PROVEEDOR="real"` y probar el sandbox.
  La API de Reembolsos V2 (`POST /v1/refunds`) ya está identificada en la
  documentación, pero no se integra hasta confirmar su contrato y los métodos de
  pago cubiertos. Por eso, en modo real, la transacción B deja el reembolso en
  `pendiente` y alerta al admin; no marca dinero devuelto sin que haya salido.
- **Búsqueda full-text** y home dinámica: Etapa 5.
- **Etapa 4:** efectivo, saldos, liquidaciones, disputas, ejecución automática de
  reembolsos, paneles y liberación del saldo retenido.
- **Etapas 5 a 7:** notificaciones, calificaciones, home dinámica, hosting.

Y siguen abiertas las decisiones de la sección 2 de la especificación:
proveedor de correo, almacenamiento de archivos, dominio, y los valores reales
de la comisión y los plazos.

---

## 10. Git

**Ya está instalado.** Es MinGit 2.55.0 en `C:\Users\anturi\git`, agregado al
PATH de tu usuario. La diferencia con el instalador completo es que no incluye
la terminal Git Bash, pero todos los comandos (`git init`, `add`, `commit`,
`branch`, `push`, `pull`, `log`, `diff`) funcionan igual desde PowerShell.

El repositorio ya está inicializado, con las ramas `main` y `dev` y la Etapa 1
commiteada. Estás en `dev`, que es la rama de trabajo (la especificación dice
que `dev` es el borrador y `main` la producción).

### Cuando tengas el repositorio en GitHub

```bash
git remote add origin https://github.com/TU_USUARIO/TU_REPO.git
git push -u origin main
git push -u origin dev
```

### El flujo de trabajo

```bash
git status              # qué cambió
git add .               # preparar todo
git commit -m "qué hice"  # guardar
git push                # subir la rama actual
```

Cuando `dev` esté listo y probado, se mezcla en `main`:

```bash
git checkout main
git merge dev
git push
```

`.env`, `node_modules` y `generated/` ya están en `.gitignore`. Para
confirmarlo cuando quieras:

```bash
git check-ignore -v .env
```

Y antes de commitear, un vistazo rápido:

```bash
git status
```

Si `.env` apareciera en la lista, algo se rompió en el `.gitignore`.