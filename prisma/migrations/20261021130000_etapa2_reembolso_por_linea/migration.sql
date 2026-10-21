-- =============================================================================
-- ETAPA 2 - RESTRICCIONES QUE FALTABAN
-- =============================================================================
-- Esta migracion es NUEVA. No se edito ninguna migracion ya aplicada.
--
-- 1. Seccion 4.13: "la suma de reembolsos de una linea <= su monto original".
--    El trigger de la migracion anterior protege el total del pago, pero no
--    el total de cada sub_pedido. Se agrega un trigger diferido sobre
--    reembolso y sobre sub_pedido.
--
-- 2. Invariante 11: la cuenta de un local es financiera y tampoco se borra.
--    Se reutiliza la funcion ccv_prohibir_borrado_financiero() ya existente.
--
-- Las variables de dinero son bigint para acompanar la migracion BIGINT.
-- =============================================================================

CREATE OR REPLACE FUNCTION ccv_verificar_reembolso_por_linea()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_sub_pedido_id integer;
  v_total bigint;
  v_reembolsado bigint;
BEGIN
  IF TG_TABLE_NAME = 'reembolso' THEN
    IF TG_OP = 'DELETE' THEN
      v_sub_pedido_id := OLD.sub_pedido_id;
    ELSE
      v_sub_pedido_id := NEW.sub_pedido_id;
    END IF;
  ELSE
    v_sub_pedido_id := NEW.id;
  END IF;

  SELECT total
    INTO v_total
    FROM sub_pedido
   WHERE id = v_sub_pedido_id;

  -- Si la linea ya no existe, el trigger de borrado financiero se encarga.
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT COALESCE(SUM(monto), 0)
    INTO v_reembolsado
    FROM reembolso
   WHERE sub_pedido_id = v_sub_pedido_id;

  IF v_reembolsado > v_total THEN
    RAISE EXCEPTION
      'sub_pedido %: la suma de reembolsos (%) supera su total original (%)',
      v_sub_pedido_id,
      v_reembolsado,
      v_total
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER ccv_reembolso_por_linea
AFTER INSERT OR UPDATE OR DELETE ON "reembolso"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION ccv_verificar_reembolso_por_linea();

CREATE CONSTRAINT TRIGGER ccv_sub_pedido_reembolsos
AFTER INSERT OR UPDATE ON "sub_pedido"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION ccv_verificar_reembolso_por_linea();

-- -----------------------------------------------------------------------------
-- La cuenta del local no se borra (invariante 11)
-- -----------------------------------------------------------------------------
CREATE TRIGGER ccv_cuenta_local_no_borrar
BEFORE DELETE ON "cuenta_local"
FOR EACH ROW EXECUTE FUNCTION ccv_prohibir_borrado_financiero();
