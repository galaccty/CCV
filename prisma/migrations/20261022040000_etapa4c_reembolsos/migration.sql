-- =============================================================================
-- ETAPA 4c-2a - REEMBOLSOS POR LINEA
-- =============================================================================
-- El monto de un reembolso lo calcula SIEMPRE el backend con los precios
-- congelados de detalle_producto. La base hace la ultima defensa:
--
--   1. reembolso.monto = suma(reembolso_linea.monto) + reembolso.monto_envio.
--   2. Las lineas pertenecen al mismo sub-pedido del reembolso.
--   3. La suma de cantidades reembolsadas por detalle (pendientes o
--      completadas) no supera la cantidad original.
--   4. La suma de reembolsos del sub-pedido no supera su total.
--   5. El envio solo se incluye si el sub-pedido no tiene fecha de entrega.
--
-- Los triggers son diferidos: reembolso y lineas se insertan en la misma
-- transaccion y la validacion corre al hacer COMMIT.
-- =============================================================================

ALTER TABLE "reembolso"
  ADD COLUMN "disputa_id" INTEGER,
  ADD COLUMN "fecha_limite" TIMESTAMPTZ(3),
  ADD COLUMN "monto_envio" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "incluye_envio" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "desde_congelado" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "registrado_por" INTEGER,
  ADD COLUMN "completado_en" TIMESTAMPTZ(3);

ALTER TABLE "reembolso"
  ADD CONSTRAINT "reembolso_disputa_id_fkey"
    FOREIGN KEY ("disputa_id") REFERENCES "disputa"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "reembolso_registrado_por_fkey"
    FOREIGN KEY ("registrado_por") REFERENCES "usuario"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "reembolso_monto_envio_valido"
    CHECK ("monto_envio" >= 0 AND "monto_envio" <= "monto");

-- Un solo reembolso por disputa. El indice es parcial para que los reembolsos
-- normales (disputa_id NULL) no compitan entre si.
CREATE UNIQUE INDEX "reembolso_disputa_id_key"
  ON "reembolso" ("disputa_id")
  WHERE "disputa_id" IS NOT NULL;

CREATE INDEX "reembolso_registrado_por_idx"
  ON "reembolso" ("registrado_por");

CREATE TABLE "reembolso_linea" (
  "id"           SERIAL PRIMARY KEY,
  "reembolso_id" INTEGER NOT NULL,
  "detalle_id"   INTEGER NOT NULL,
  "cantidad"     INTEGER NOT NULL,
  "monto"        BIGINT NOT NULL,

  CONSTRAINT "reembolso_linea_reembolso_id_fkey"
    FOREIGN KEY ("reembolso_id") REFERENCES "reembolso"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "reembolso_linea_detalle_id_fkey"
    FOREIGN KEY ("detalle_id") REFERENCES "detalle_producto"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "reembolso_linea_cantidad_positiva" CHECK ("cantidad" > 0),
  CONSTRAINT "reembolso_linea_monto_no_negativo" CHECK ("monto" >= 0)
);

CREATE UNIQUE INDEX "reembolso_linea_reembolso_id_detalle_id_key"
  ON "reembolso_linea" ("reembolso_id", "detalle_id");

CREATE INDEX "reembolso_linea_detalle_id_idx"
  ON "reembolso_linea" ("detalle_id");

-- -----------------------------------------------------------------------------
-- Backfill de reembolsos historicos.
-- Los reembolsos totales por fallo de stock son los unicos que existian antes
-- de esta migracion: se reconstruyen sus lineas con los snapshots del pedido.
-- Un reembolso parcial historico recibe una linea con la primera unidad; el
-- backend nuevo siempre crea lineas y cantidades explicitas.
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  r RECORD;
  d RECORD;
BEGIN
  FOR r IN
    SELECT re.*, s.total AS sub_total, s.costo_envio, s.subtotal_productos
      FROM "reembolso" re
      JOIN "sub_pedido" s ON s.id = re.sub_pedido_id
     WHERE NOT EXISTS (
       SELECT 1 FROM "reembolso_linea" rl WHERE rl.reembolso_id = re.id
     )
  LOOP
    IF r.monto = r.sub_total AND r.monto >= r.subtotal_productos THEN
      UPDATE "reembolso"
         SET "monto_envio" = r.costo_envio,
             "incluye_envio" = (r.costo_envio > 0)
       WHERE id = r.id;

      INSERT INTO "reembolso_linea" ("reembolso_id", "detalle_id", "cantidad", "monto")
      SELECT r.id, d.id, d.cantidad, d.cantidad * d.precio_unitario
        FROM "detalle_producto" d
       WHERE d.sub_pedido_id = r.sub_pedido_id
       ORDER BY d.id;
    ELSE
      SELECT d.* INTO d
        FROM "detalle_producto" d
       WHERE d.sub_pedido_id = r.sub_pedido_id
       ORDER BY d.id
       LIMIT 1;

      IF FOUND THEN
        INSERT INTO "reembolso_linea" ("reembolso_id", "detalle_id", "cantidad", "monto")
        VALUES (r.id, d.id, 1, r.monto);
      END IF;
    END IF;
  END LOOP;
END;
$$;

-- -----------------------------------------------------------------------------
-- Inmutabilidad de las lineas: el reembolso se corrige con otro reembolso,
-- nunca reescribiendo el detalle de lo que ya se devolvio.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ccv_reembolso_linea_inmutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'reembolso_linea %: las lineas de un reembolso no se modifican ni se borran',
    OLD.id
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER ccv_reembolso_linea_no_modificar
BEFORE UPDATE OR DELETE ON "reembolso_linea"
FOR EACH ROW EXECUTE FUNCTION ccv_reembolso_linea_inmutable();

-- -----------------------------------------------------------------------------
-- Validacion diferida de montos, pertenencia y cantidades.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ccv_verificar_reembolso_completo()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_sub_ids integer[];
  v_sub_pedido_id integer;
  v_total_subpedido bigint;
  v_fecha_entrega timestamptz;
  v_estado_subpedido "estado_sub_pedido";
  v_reembolso RECORD;
  v_suma_lineas bigint;
  v_suma_reembolsos bigint;
BEGIN
  IF TG_TABLE_NAME = 'reembolso' THEN
    IF TG_OP = 'DELETE' THEN
      v_sub_ids := ARRAY[OLD.sub_pedido_id];
    ELSIF TG_OP = 'UPDATE' THEN
      v_sub_ids := ARRAY[OLD.sub_pedido_id, NEW.sub_pedido_id];
    ELSE
      v_sub_ids := ARRAY[NEW.sub_pedido_id];
    END IF;
  ELSE
    IF TG_OP = 'DELETE' THEN
      SELECT array_agg(r.sub_pedido_id)
        INTO v_sub_ids
        FROM "reembolso" r
       WHERE r.id = OLD.reembolso_id;
    ELSIF TG_OP = 'UPDATE' THEN
      SELECT array_agg(DISTINCT r.sub_pedido_id)
        INTO v_sub_ids
        FROM "reembolso" r
       WHERE r.id IN (OLD.reembolso_id, NEW.reembolso_id);
    ELSE
      SELECT array_agg(r.sub_pedido_id)
        INTO v_sub_ids
        FROM "reembolso" r
       WHERE r.id = NEW.reembolso_id;
    END IF;
  END IF;

  IF v_sub_ids IS NULL THEN
    RETURN NULL;
  END IF;

  FOREACH v_sub_pedido_id IN ARRAY v_sub_ids LOOP
    IF v_sub_pedido_id IS NULL THEN
      CONTINUE;
    END IF;

    SELECT s.total, s.fecha_entrega, s.estado
      INTO v_total_subpedido, v_fecha_entrega, v_estado_subpedido
      FROM "sub_pedido" s
     WHERE s.id = v_sub_pedido_id;

    IF NOT FOUND THEN
      CONTINUE;
    END IF;

    FOR v_reembolso IN
      SELECT re.*
        FROM "reembolso" re
       WHERE re.sub_pedido_id = v_sub_pedido_id
       ORDER BY re.id
    LOOP
      IF v_reembolso.monto_envio < 0 OR v_reembolso.monto_envio > v_reembolso.monto THEN
        RAISE EXCEPTION
          'reembolso %: monto_envio % no puede superar el monto %',
          v_reembolso.id, v_reembolso.monto_envio, v_reembolso.monto
          USING ERRCODE = 'check_violation';
      END IF;

      IF v_reembolso.incluye_envio
         AND (v_fecha_entrega IS NOT NULL OR v_estado_subpedido = 'entregado') THEN
        RAISE EXCEPTION
          'reembolso %: no puede incluir envio porque el sub_pedido % ya fue entregado',
          v_reembolso.id, v_sub_pedido_id
          USING ERRCODE = 'check_violation';
      END IF;

      SELECT COALESCE(SUM(rl.monto), 0)
        INTO v_suma_lineas
        FROM "reembolso_linea" rl
       WHERE rl.reembolso_id = v_reembolso.id;

      IF v_suma_lineas <> v_reembolso.monto - v_reembolso.monto_envio THEN
        RAISE EXCEPTION
          'reembolso %: la suma de lineas (%) mas el envio (%) no coincide con el monto (%)',
          v_reembolso.id, v_suma_lineas, v_reembolso.monto_envio, v_reembolso.monto
          USING ERRCODE = 'check_violation';
      END IF;

      IF EXISTS (
        SELECT 1
          FROM "reembolso_linea" rl
          JOIN "detalle_producto" d ON d.id = rl.detalle_id
         WHERE rl.reembolso_id = v_reembolso.id
           AND d.sub_pedido_id <> v_sub_pedido_id
      ) THEN
        RAISE EXCEPTION
          'reembolso %: una linea no pertenece al sub_pedido %',
          v_reembolso.id, v_sub_pedido_id
          USING ERRCODE = 'check_violation';
      END IF;
    END LOOP;

    IF EXISTS (
      SELECT 1
        FROM "detalle_producto" d
       WHERE d.sub_pedido_id = v_sub_pedido_id
         AND COALESCE((
           SELECT SUM(rl.cantidad)
             FROM "reembolso_linea" rl
             JOIN "reembolso" re ON re.id = rl.reembolso_id
            WHERE rl.detalle_id = d.id
              AND re.estado IN ('pendiente', 'completado')
         ), 0) > d.cantidad
    ) THEN
      RAISE EXCEPTION
        'sub_pedido %: la cantidad reembolsada de una linea supera su cantidad original',
        v_sub_pedido_id
        USING ERRCODE = 'check_violation';
    END IF;

    SELECT COALESCE(SUM(re.monto), 0)
      INTO v_suma_reembolsos
      FROM "reembolso" re
     WHERE re.sub_pedido_id = v_sub_pedido_id;

    IF v_suma_reembolsos > v_total_subpedido THEN
      RAISE EXCEPTION
        'sub_pedido %: la suma de reembolsos (%) supera el total del sub_pedido (%)',
        v_sub_pedido_id, v_suma_reembolsos, v_total_subpedido
        USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER ccv_reembolso_completo
AFTER INSERT OR UPDATE OR DELETE ON "reembolso"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION ccv_verificar_reembolso_completo();

CREATE CONSTRAINT TRIGGER ccv_reembolso_linea_completo
AFTER INSERT OR UPDATE OR DELETE ON "reembolso_linea"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION ccv_verificar_reembolso_completo();
