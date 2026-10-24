-- =============================================================================
-- ETAPA 4d - LIBERACION DE SALDO
-- =============================================================================
-- El job recorre los sub-pedidos con retencion vencida. El indice parcial
-- acompana la consulta por fecha de entrega sin cargar los ya liberados.
--
-- Ademas de los triggers de reembolso pendiente ya existentes, la base
-- rechaza llenar `saldo_liberado_en` mientras haya una disputa abierta. El
-- servicio bloquea el sub-pedido antes de escribir, pero esta restriccion es
-- la ultima defensa si otro camino intenta liberar dinero disputado.
-- =============================================================================

CREATE INDEX "sub_pedido_liberacion_candidatos_idx"
  ON "sub_pedido" ("fecha_entrega", "id")
  WHERE "saldo_liberado_en" IS NULL;

CREATE OR REPLACE FUNCTION ccv_prohibir_liberacion_con_disputa_abierta()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM disputa
     WHERE sub_pedido_id = NEW.id
       AND estado = 'abierta'
  ) THEN
    RAISE EXCEPTION 'sub_pedido_con_disputa_abierta'
      USING ERRCODE = '23514',
            HINT = 'Una disputa abierta bloquea la liberacion de saldo.';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER ccv_sub_pedido_liberacion_sin_disputa_abierta
BEFORE UPDATE OF saldo_liberado_en ON sub_pedido
FOR EACH ROW
WHEN (NEW.saldo_liberado_en IS NOT NULL AND OLD.saldo_liberado_en IS NULL)
EXECUTE FUNCTION ccv_prohibir_liberacion_con_disputa_abierta();
