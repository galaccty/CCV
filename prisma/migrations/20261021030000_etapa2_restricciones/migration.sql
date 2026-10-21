-- =============================================================================
-- ETAPA 2 - RESTRICCIONES DE INTEGRIDAD
-- =============================================================================
-- Esta migracion NO crea tablas: agrega los CHECK y los triggers diferidos que
-- hacen cumplir las reglas de la seccion 4.13 de la especificacion.
--
-- Por que diferidos: al crear un pedido primero se inserta `pedido` (con su
-- total) y despues sus `sub_pedido`. Un CHECK normal fallaria en el primer
-- INSERT. Un CONSTRAINT TRIGGER DEFERRABLE se evalua recien al COMMIT, cuando
-- la transaccion ya dejo el estado final.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Corregir el nombre de una columna que quedo en camelCase
-- -----------------------------------------------------------------------------
-- La migracion anterior (ya aplicada, no se edita) genero "estadoAnterior".
-- La regla del proyecto es snake_case en la base. Se renombra aca.
ALTER TABLE "historial_estado_sub_pedido"
  RENAME COLUMN "estadoAnterior" TO "estado_anterior";

-- -----------------------------------------------------------------------------
-- 2. Un pedido no se borra: su pago tampoco puede quedar huerfano
-- -----------------------------------------------------------------------------
ALTER TABLE "pago" DROP CONSTRAINT "pago_pedido_id_fkey";
ALTER TABLE "pago"
  ADD CONSTRAINT "pago_pedido_id_fkey"
  FOREIGN KEY ("pedido_id") REFERENCES "pedido"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- -----------------------------------------------------------------------------
-- 3. CHECK de una sola fila
-- -----------------------------------------------------------------------------
ALTER TABLE "producto_variante"
  ADD CONSTRAINT "producto_variante_precio_no_negativo" CHECK ("precio" >= 0),
  ADD CONSTRAINT "producto_variante_stock_no_negativo" CHECK ("stock" >= 0);

ALTER TABLE "detalle_producto"
  ADD CONSTRAINT "detalle_cantidad_positiva" CHECK ("cantidad" > 0),
  ADD CONSTRAINT "detalle_precio_no_negativo" CHECK ("precio_unitario" >= 0);

ALTER TABLE "pedido"
  ADD CONSTRAINT "pedido_total_no_negativo" CHECK ("total" >= 0);

ALTER TABLE "sub_pedido"
  ADD CONSTRAINT "sub_pedido_montos_no_negativos" CHECK (
    "subtotal_productos" >= 0 AND
    "costo_envio" >= 0 AND
    "comision" >= 0 AND
    "total" >= 0
  );

ALTER TABLE "pago"
  ADD CONSTRAINT "pago_monto_positivo" CHECK ("monto" > 0),
  ADD CONSTRAINT "pago_reembolsado_valido" CHECK (
    "monto_reembolsado" >= 0 AND "monto_reembolsado" <= "monto"
  );

ALTER TABLE "reembolso"
  ADD CONSTRAINT "reembolso_monto_positivo" CHECK ("monto" > 0);

ALTER TABLE "ledger"
  ADD CONSTRAINT "ledger_monto_no_negativo" CHECK ("monto" >= 0);

ALTER TABLE "cuenta_local"
  ADD CONSTRAINT "cuenta_saldos_no_negativos" CHECK (
    "saldo_deuda" >= 0 AND
    "saldo_por_pagar" >= 0 AND
    "saldo_congelado" >= 0
  );

-- -----------------------------------------------------------------------------
-- 4. pedido.total = suma(sub_pedido.total)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ccv_verificar_total_pedido()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_pedido_id integer;
  v_total integer;
  v_suma integer;
BEGIN
  IF TG_TABLE_NAME = 'pedido' THEN
    v_pedido_id := NEW.id;
  ELSE
    v_pedido_id := COALESCE(NEW.pedido_id, OLD.pedido_id);
  END IF;

  SELECT total INTO v_total FROM pedido WHERE id = v_pedido_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT COALESCE(SUM(total), 0)
    INTO v_suma
    FROM sub_pedido
   WHERE pedido_id = v_pedido_id;

  IF v_total <> v_suma THEN
    RAISE EXCEPTION
      'pedido %: total % no coincide con la suma de sus sub_pedidos (%)',
      v_pedido_id, v_total, v_suma
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER ccv_pedido_total_suma
AFTER INSERT OR UPDATE OR DELETE ON "sub_pedido"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION ccv_verificar_total_pedido();

CREATE CONSTRAINT TRIGGER ccv_pedido_total_propio
AFTER INSERT OR UPDATE ON "pedido"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION ccv_verificar_total_pedido();

-- -----------------------------------------------------------------------------
-- 5. pago.monto_reembolsado = suma(reembolsos completados)
--    y suma(reembolsos) <= pago.monto
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ccv_verificar_reembolsos_pago()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_pago_id integer;
  v_monto integer;
  v_reembolsado integer;
  v_completados integer;
  v_suma_total integer;
BEGIN
  IF TG_TABLE_NAME = 'pago' THEN
    v_pago_id := NEW.id;
  ELSE
    v_pago_id := COALESCE(NEW.pago_id, OLD.pago_id);
  END IF;

  SELECT monto, monto_reembolsado
    INTO v_monto, v_reembolsado
    FROM pago
   WHERE id = v_pago_id;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT
    COALESCE(SUM(monto) FILTER (WHERE estado = 'completado'), 0),
    COALESCE(SUM(monto), 0)
    INTO v_completados, v_suma_total
    FROM reembolso
   WHERE pago_id = v_pago_id;

  IF v_reembolsado <> v_completados THEN
    RAISE EXCEPTION
      'pago %: monto_reembolsado % no coincide con los reembolsos completados %',
      v_pago_id, v_reembolsado, v_completados
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_suma_total > v_monto THEN
    RAISE EXCEPTION
      'pago %: la suma de reembolsos (%) supera el monto del pago (%)',
      v_pago_id, v_suma_total, v_monto
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER ccv_pago_reembolsos
AFTER INSERT OR UPDATE OR DELETE ON "reembolso"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION ccv_verificar_reembolsos_pago();

CREATE CONSTRAINT TRIGGER ccv_pago_monto_reembolsado
AFTER INSERT OR UPDATE ON "pago"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION ccv_verificar_reembolsos_pago();

-- -----------------------------------------------------------------------------
-- 6. categoria_global.rubro_id nulo o igual al rubro del local del producto
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ccv_verificar_categoria_producto()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_rubro_local integer;
  v_rubro_categoria integer;
BEGIN
  SELECT l.rubro_id, c.rubro_id
    INTO v_rubro_local, v_rubro_categoria
    FROM producto p
    JOIN local l ON l.id = p.local_id
    JOIN categoria_global c ON c.id = p.categoria_global_id
   WHERE p.id = NEW.id;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF v_rubro_categoria IS NOT NULL AND v_rubro_categoria <> v_rubro_local THEN
    RAISE EXCEPTION
      'producto %: la categoria es del rubro % pero el local es del rubro %',
      NEW.id, v_rubro_categoria, v_rubro_local
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER ccv_producto_categoria_rubro
AFTER INSERT OR UPDATE ON "producto"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION ccv_verificar_categoria_producto();

-- Si el local cambia de rubro, sus productos no pueden quedar inconsistentes.
CREATE OR REPLACE FUNCTION ccv_verificar_rubro_del_local()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_producto integer;
BEGIN
  SELECT p.id
    INTO v_producto
    FROM producto p
    JOIN categoria_global c ON c.id = p.categoria_global_id
   WHERE p.local_id = NEW.id
     AND c.rubro_id IS NOT NULL
     AND c.rubro_id <> NEW.rubro_id
   LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION
      'local %: el producto % tiene una categoria de otro rubro',
      NEW.id, v_producto
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER ccv_local_rubro_productos
AFTER UPDATE OF rubro_id ON "local"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION ccv_verificar_rubro_del_local();

-- -----------------------------------------------------------------------------
-- 7. Lo financiero no se borra y el ledger no se modifica (invariante 11)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ccv_prohibir_borrado_financiero()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'no se puede borrar %: lo financiero no se borra (invariante 11)',
    TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER ccv_pedido_no_borrar
BEFORE DELETE ON "pedido"
FOR EACH ROW EXECUTE FUNCTION ccv_prohibir_borrado_financiero();

CREATE TRIGGER ccv_pago_no_borrar
BEFORE DELETE ON "pago"
FOR EACH ROW EXECUTE FUNCTION ccv_prohibir_borrado_financiero();

CREATE TRIGGER ccv_reembolso_no_borrar
BEFORE DELETE ON "reembolso"
FOR EACH ROW EXECUTE FUNCTION ccv_prohibir_borrado_financiero();

CREATE OR REPLACE FUNCTION ccv_ledger_inmutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'el ledger es inmutable: no se actualiza ni se borra (invariante 11)'
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER ccv_ledger_no_modificar
BEFORE UPDATE OR DELETE ON "ledger"
FOR EACH ROW EXECUTE FUNCTION ccv_ledger_inmutable();

-- -----------------------------------------------------------------------------
-- 8. Invariante 5: los snapshots no cambian despues de crear la fila
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ccv_sub_pedido_snapshot_inmutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.pedido_id IS DISTINCT FROM OLD.pedido_id
     OR NEW.local_id IS DISTINCT FROM OLD.local_id
     OR NEW.nombre_local IS DISTINCT FROM OLD.nombre_local
     OR NEW.subtotal_productos IS DISTINCT FROM OLD.subtotal_productos
     OR NEW.costo_envio IS DISTINCT FROM OLD.costo_envio
     OR NEW.comision IS DISTINCT FROM OLD.comision
     OR NEW.total IS DISTINCT FROM OLD.total
  THEN
    RAISE EXCEPTION
      'sub_pedido %: los montos y el nombre del local son snapshots y no se modifican',
      OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER ccv_sub_pedido_snapshot
BEFORE UPDATE ON "sub_pedido"
FOR EACH ROW EXECUTE FUNCTION ccv_sub_pedido_snapshot_inmutable();

CREATE OR REPLACE FUNCTION ccv_pedido_snapshot_inmutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.usuario_id IS DISTINCT FROM OLD.usuario_id
     OR NEW.direccion_texto IS DISTINCT FROM OLD.direccion_texto
     OR NEW.direccion_latitud IS DISTINCT FROM OLD.direccion_latitud
     OR NEW.direccion_longitud IS DISTINCT FROM OLD.direccion_longitud
     OR NEW.metodo_pago IS DISTINCT FROM OLD.metodo_pago
     OR NEW.total IS DISTINCT FROM OLD.total
     OR NEW.config_snapshot IS DISTINCT FROM OLD.config_snapshot
  THEN
    RAISE EXCEPTION
      'pedido %: la direccion, el metodo de pago, el total y config_snapshot son snapshots y no se modifican',
      OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER ccv_pedido_snapshot
BEFORE UPDATE ON "pedido"
FOR EACH ROW EXECUTE FUNCTION ccv_pedido_snapshot_inmutable();

CREATE OR REPLACE FUNCTION ccv_detalle_inmutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'detalle_producto %: las lineas del pedido son snapshots y no se modifican ni se borran',
    OLD.id
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER ccv_detalle_no_modificar
BEFORE UPDATE OR DELETE ON "detalle_producto"
FOR EACH ROW EXECUTE FUNCTION ccv_detalle_inmutable();

-- -----------------------------------------------------------------------------
-- 9. Invariante 11: sub_pedido tampoco se borra
-- -----------------------------------------------------------------------------
CREATE TRIGGER ccv_sub_pedido_no_borrar
BEFORE DELETE ON "sub_pedido"
FOR EACH ROW EXECUTE FUNCTION ccv_prohibir_borrado_financiero();
