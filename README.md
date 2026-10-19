# Centro Comercial Virtual — Backend

Backend del marketplace multi-vendedor. Node.js + Express + PostgreSQL.

**Estado: Etapa 1 terminada.** La Etapa 2 (corte vertical con pagos) **no** está
implementada. Antes de avanzar, lee la sección [Qué falta](#qué-falta).

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

Las rutas están en `PGBIN` y `PGDATA`, dentro del `.env`. Si algún día movés
la instalación, cambias esas dos líneas y nada más.

Hay dos bases:

- **`ccv`** — tu desarrollo. Acá va `npm run db:migrate` y `npm run seed`.
- **`ccv_test`** — la usan las pruebas. Las pruebas cambian el nombre de la
  base automáticamente: **nunca tocan tu base de desarrollo**, así que podés
  correr `npm test` sin miedo de llenarla de usuarios falsos.

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

Aplica `prisma/migrations/20261018000000_etapa1_inicial/migration.sql`, que crea
las cinco tablas de la Etapa 1.

> **Regla del proyecto:** una migración ya aplicada nunca se edita. Si algo está
> mal, se agrega una migración nueva. Para desarrollo, `npm run db:dev` te
> pregunta el nombre de la nueva.

### Paso 5 — Cargar la configuración inicial

```bash
npm run seed
```

Carga las once claves de la tabla `configuracion` con **valores de ejemplo**.
Vas a ver la lista al terminar. Los cambias cuando tengas los números reales
de Wompi y la respuesta del abogado.

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
| `npm run seed` | Carga la configuración inicial |
| `npm run crear-admin` | Crea o actualiza el administrador del `.env` |
| `npm run probar-registro` | Hace un registro completo de punta a punta |

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
│   ├── middlewares/           sesión, CSRF, rate limit
│   ├── routes/v1/             las rutas, bajo /api/v1
│   ├── services/              la lógica de negocio
│   └── jobs/                  registro de tareas programadas
├── scripts/
│   ├── seed.js                configuración inicial
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
- **Los guardianes de CI ya están instalados**, aunque las tablas que protegen
  todavía no existan. Fue a propósito: llegaron antes de que hubiera código que
  pudiera romperlos.

---

## 7. Los invariantes y las pruebas

La sección 10 de la especificación define doce invariantes. Cada uno tiene un
archivo de prueba en `tests/invariantes/`.

**Estado en la Etapa 1:**

| # | Invariante | Estado |
|---|---|---|
| 1 | El ledger es la fuente de verdad | activo (guardián) |
| 2 | `pago.referencia` es UNIQUE | pendiente, Etapa 2 |
| 3 | El webhook responde 200 solo después | pendiente, Etapa 2 |
| 4 | Wompi nunca dentro de una transacción | activo (3 capas) |
| 5 | Los snapshots no se modifican | pendiente, Etapa 2 |
| 6 | Entregado ≠ dinero movido | pendiente, Etapa 4 |
| 7 | Stock solo por el módulo de stock | activo (guardián) |
| 8 | La deuda se compensa solo en liquidación | pendiente, Etapa 4 |
| 9 | El estado del local solo lo cambia `recalcular_estado_local` | pendiente, Etapa 4 |
| 10 | Idempotency-Key en los POST que crean | pendiente, Etapa 2 |
| 11 | Nada financiero se borra | parcial (`auditoria_admin`) |
| 12 | Los montos se calculan en el backend | pendiente, Etapa 3 |

"pendiente" no es "borrado": cada archivo tiene el motivo y la etapa written en
el comentario, y `tests/invariantes/indice.test.js` falla si alguien borra
alguno.

`npm test` muestra el resumen completo. Las pruebas que necesitan base de datos
se saltan solas si no hay conexión, y lo dicen.

---

## 8. Sobre las pruebas

Las pruebas corren contra la base real (`ccv_test`), no contra simulacros.

`npm test` da así:

```
tests 94 · pass 63 · fail 0 · skipped 31
```

Las 31 que se saltan son **todas invariantes que todavía no aplican**, y cada
una dice en pantalla por qué y en qué etapa se activa. Cero se saltan por
falta de base.

Si no tenés PostgreSQL corriendo, `npm test` sigue funcionando: corre lo que
no necesita base y salta el resto diciendo a qué base apuntaba.

Detalle que costó encontrar: los archivos de prueba corren **en paralelo**, y
cada cliente de Prisma abre su propio pool de conexiones. Si los 16 archivos
crearan uno, se agotarían las del servidor y los que sí usan la base fallarían
al conectarse. Por eso el cliente de Prisma vive únicamente en
`tests/helpers/base.js`, que solo importan los dos archivos que lo necesitan.

---

## 9. Qué falta

Nada de esto está implementado, a propósito:

- **Etapa 2:** pagos, webhook de Wompi, carrito, pedidos, sub-pedidos, ledger.
- **Etapa 3:** locales, productos, variantes, categorías, búsqueda.
- **Etapa 4:** efectivo, saldos, liquidaciones, disputas, reembolsos, paneles.
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