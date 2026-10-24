-- =============================================================================
-- ETAPA 4c-2b - DEVOLUCION DE STOCK POR LINEA
-- =============================================================================
-- La resolucion de una disputa sin entrega devuelve todo el stock y la
-- confirmacion de producto recibido devuelve solo las lineas aprobadas. Esta
-- tabla es la prueba de idempotencia: UNIQUE (sub_pedido_id, detalle_id) y una
-- fila inmutable por linea. El stock se mueve en la misma transaccion que crea
-- la fila, siempre a traves de src/services/stock.js.
-- =============================================================================

CREATE TYPE "origen_devolucion_stock" AS ENUM (
  'disputa_sin_entrega',
  'producto_recibido'
);

CREATE TABLE "devolucion_stock" (
  "id"             SERIAL PRIMARY KEY,
  "sub_pedido_id"  INTEGER NOT NULL,
  "detalle_id"     INTEGER NOT NULL,
  "cantidad"       INTEGER NOT NULL,
  "origen"         "origen_devolucion_stock" NOT NULL,
  "registrado_por" INTEGER,
  "creado_en"      TIMESTAMPTZ(3) NOT NULL DEFAULT NOW(),

  CONSTRAINT "devolucion_stock_cantidad_positiva"
    CHECK ("cantidad" > 0),

  CONSTRAINT "devolucion_stock_sub_pedido_id_fkey"
    FOREIGN KEY ("sub_pedido_id") REFERENCES "sub_pedido"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,

  CONSTRAINT "devolucion_stock_detalle_id_fkey"
    FOREIGN KEY ("detalle_id") REFERENCES "detalle_producto"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,

  CONSTRAINT "devolucion_stock_registrado_por_fkey"
    FOREIGN KEY ("registrado_por") REFERENCES "usuario"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "devolucion_stock_sub_pedido_id_detalle_id_key"
  ON "devolucion_stock" ("sub_pedido_id", "detalle_id");

CREATE INDEX "devolucion_stock_detalle_id_idx"
  ON "devolucion_stock" ("detalle_id");

CREATE INDEX "devolucion_stock_registrado_por_idx"
  ON "devolucion_stock" ("registrado_por");

-- El detalle debe pertenecer al sub-pedido y la devolucion no puede superar
-- las unidades compradas en esa linea. La validacion de que solo se devuelve
-- despues de una resolucion a favor del comprador queda en el servicio.
CREATE FUNCTION ccv_devolucion_stock_valida() RETURNS trigger AS $$
DECLARE
  detalle_sub_pedido_id INTEGER;
  detalle_cantidad      INTEGER;
BEGIN
  SELECT "sub_pedido_id", "cantidad"
    INTO detalle_sub_pedido_id, detalle_cantidad
    FROM "detalle_producto"
   WHERE "id" = NEW."detalle_id";

  IF NOT FOUND THEN
    RAISE EXCEPTION 'detalle_no_pertenece';
  END IF;

  IF detalle_sub_pedido_id <> NEW."sub_pedido_id" THEN
    RAISE EXCEPTION 'detalle_no_pertenece';
  END IF;

  IF NEW."cantidad" > detalle_cantidad THEN
    RAISE EXCEPTION 'cantidad_excede_linea';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ccv_devolucion_stock_valida
BEFORE INSERT ON "devolucion_stock"
FOR EACH ROW EXECUTE FUNCTION ccv_devolucion_stock_valida();

-- La devolucion de stock es un hecho consumado: igual que las filas
-- financieras, no se actualiza ni se borra.
CREATE FUNCTION ccv_devolucion_stock_inmutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'devolucion_stock_inmutable';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ccv_devolucion_stock_inmutable
BEFORE UPDATE OR DELETE ON "devolucion_stock"
FOR EACH ROW EXECUTE FUNCTION ccv_devolucion_stock_inmutable();

-- El job de reembolsos en efectivo vencidos busca por estado, tipo y fecha.
CREATE INDEX "reembolso_efectivo_pendiente_vencimiento_idx"
  ON "reembolso" ("fecha_limite")
  WHERE "tipo" = 'efectivo' AND "estado" = 'pendiente';
