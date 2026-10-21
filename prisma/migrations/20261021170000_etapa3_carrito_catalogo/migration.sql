-- =============================================================================
-- ETAPA 3 - CARRITO MULTI-LOCAL E INDICES DE CATALOGO
-- =============================================================================
-- Los locales, rubros, categorias, productos y variantes ya existen desde la
-- Etapa 2. Esta migracion solo agrega el carrito guardado y los indices que
-- usan las rutas publicas de catalogo.
--
-- Regla del proyecto: esta es una migracion NUEVA; ninguna anterior se edita.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Carrito: uno por usuario
-- -----------------------------------------------------------------------------
CREATE TABLE "carrito" (
    "id" SERIAL NOT NULL,
    "usuario_id" INTEGER NOT NULL,
    "creado_en" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actualizado_en" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "carrito_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "carrito_usuario_id_key" ON "carrito"("usuario_id");

-- -----------------------------------------------------------------------------
-- 2. Items: una fila por variante, cantidad acotada
-- -----------------------------------------------------------------------------
CREATE TABLE "carrito_item" (
    "id" SERIAL NOT NULL,
    "carrito_id" INTEGER NOT NULL,
    "variante_id" INTEGER NOT NULL,
    "cantidad" INTEGER NOT NULL,
    "creado_en" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actualizado_en" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "carrito_item_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "carrito_item_cantidad_valida" CHECK ("cantidad" >= 1 AND "cantidad" <= 999)
);

CREATE UNIQUE INDEX "carrito_item_carrito_id_variante_id_key"
    ON "carrito_item"("carrito_id", "variante_id");

CREATE INDEX "carrito_item_variante_id_idx" ON "carrito_item"("variante_id");

-- -----------------------------------------------------------------------------
-- 3. Llaves foraneas
-- -----------------------------------------------------------------------------
ALTER TABLE "carrito"
    ADD CONSTRAINT "carrito_usuario_id_fkey"
    FOREIGN KEY ("usuario_id") REFERENCES "usuario"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "carrito_item"
    ADD CONSTRAINT "carrito_item_carrito_id_fkey"
    FOREIGN KEY ("carrito_id") REFERENCES "carrito"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "carrito_item"
    ADD CONSTRAINT "carrito_item_variante_id_fkey"
    FOREIGN KEY ("variante_id") REFERENCES "producto_variante"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- -----------------------------------------------------------------------------
-- 4. Indices de catalogo
-- -----------------------------------------------------------------------------
CREATE INDEX "local_estado_rubro_id_idx" ON "local"("estado", "rubro_id");

CREATE INDEX "producto_local_id_activo_categoria_global_id_idx"
    ON "producto"("local_id", "activo", "categoria_global_id");
