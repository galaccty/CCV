-- =============================================================================
-- ETAPA 2 - UN REEMBOLSO PENDIENTE BLOQUEA LA LIBERACION DE SALDO
-- =============================================================================
-- Esta migracion es NUEVA. No se edito ninguna migracion ya aplicada.
--
-- El job de liberacion de la Etapa 4 todavia no existe. Esta restriccion deja
-- la regla del invariante 6 en la base, no solo en la consulta de elegibilidad:
-- si algo intenta llenar `sub_pedido.saldo_liberado_en` mientras el sub_pedido
-- tiene un reembolso en estado `pendiente`, la transaccion falla.
--
-- El trigger es diferido para que una misma transaccion pueda insertar el
-- reembolso y luego intentar liberar: al COMMIT se evalua el estado final.
-- =============================================================================

CREATE OR REPLACE FUNCTION ccv_prohibir_liberacion_con_reembolso_pendiente()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM reembolso
     WHERE sub_pedido_id = NEW.id
       AND estado = 'pendiente'
  ) THEN
    RAISE EXCEPTION 'sub_pedido_con_reembolso_pendiente'
      USING ERRCODE = '23514',
            HINT = 'Un reembolso pendiente bloquea la liberacion de saldo.';
  END IF;

  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER ccv_sub_pedido_liberacion_sin_reembolso_pendiente
AFTER UPDATE OF saldo_liberado_en ON sub_pedido
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (NEW.saldo_liberado_en IS NOT NULL AND OLD.saldo_liberado_en IS NULL)
EXECUTE FUNCTION ccv_prohibir_liberacion_con_reembolso_pendiente();
