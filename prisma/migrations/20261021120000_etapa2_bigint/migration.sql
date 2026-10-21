-- =============================================================================
-- ETAPA 2 - DINERO EN BIGINT
-- =============================================================================
-- INTEGER llega hasta 2.147.483.647. En pesos colombianos eso es alcanzable
-- para saldos acumulados de un local y para la suma del ledger. BIGINT llega
-- a 9.223.372.036.854.775.807, que es inalcanzable para este negocio.
--
-- Esta migracion NO edita las anteriores: solo cambia el tipo de las columnas
-- de dinero y vuelve a crear las dos funciones plpgsql que guardaban montos en
-- variables integer. Los CHECK existentes siguen valiendo porque comparan
-- contra constantes y entre columnas del mismo tipo.
-- =============================================================================

ALTER TABLE "producto_variante"
  ALTER COLUMN "precio" TYPE BIGINT;

ALTER TABLE "detalle_producto"
  ALTER COLUMN "precio_unitario" TYPE BIGINT;

ALTER TABLE "pedido"
  ALTER COLUMN "total" TYPE BIGINT;

ALTER TABLE "sub_pedido"
  ALTER COLUMN "subtotal_productos" TYPE BIGINT,
  ALTER COLUMN "costo_envio" TYPE BIGINT,
  ALTER COLUMN "comision" TYPE BIGINT,
  ALTER COLUMN "total" TYPE BIGINT;

ALTER TABLE "pago"
  ALTER COLUMN "monto" TYPE BIGINT,
  ALTER COLUMN "monto_reembolsado" TYPE BIGINT;

ALTER TABLE "reembolso"
  ALTER COLUMN "monto" TYPE BIGINT;

ALTER TABLE "ledger"
  ALTER COLUMN "monto" TYPE BIGINT;

ALTER TABLE "cuenta_local"
  ALTER COLUMN "saldo_deuda" TYPE BIGINT,
  ALTER COLUMN "saldo_por_pagar" TYPE BIGINT,
  ALTER COLUMN "saldo_congelado" TYPE BIGINT;

-- -----------------------------------------------------------------------------
-- pedido.total = suma(sub_pedido.total), ahora con bigint
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ccv_verificar_total_pedido()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_pedido_id integer;
  v_total bigint;
  v_suma bigint;
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

-- -----------------------------------------------------------------------------
-- pago.monto_reembolsado = suma(reembolsos completados) y tope del pago,
-- ahora con bigint
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ccv_verificar_reembolsos_pago()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_pago_id integer;
  v_monto bigint;
  v_reembolsado bigint;
  v_completados bigint;
  v_suma_total bigint;
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
