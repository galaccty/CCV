-- =============================================================================
-- ETAPA 4 - PASO 0: REACTIVACION DE UN LOCAL SUSPENDIDO
-- =============================================================================
-- Un local suspendido no puede volver a activo con un UPDATE directo. La
-- reactivacion pasa por recalcular_estado_local(), que decide activo, en_plazo
-- o bloqueado segun la deuda real. Para no perder el estado de deuda que el
-- local tenia antes de la suspension, se guarda en
-- local.estado_previo_suspension.
-- =============================================================================

ALTER TABLE "local"
  ADD COLUMN "estado_previo_suspension" "estado_local";

-- El admin puede aprobar (pendiente_aprobacion -> activo) y suspender
-- (cualquier estado -> suspendido). Ya no puede reactivar a mano: ni
-- suspendido -> activo, ni bloqueado -> activo. El contexto de sistema lo pone
-- recalcular_estado_local() dentro de su propia transaccion.
CREATE OR REPLACE FUNCTION ccv_estado_local_solo_sistema()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_contexto text;
BEGIN
  IF NEW."estado" IS DISTINCT FROM OLD."estado" THEN
    v_contexto := current_setting('ccv.estado_local_sistema', true);

    IF COALESCE(v_contexto, '') <> '1' THEN
      IF NEW."estado" IN ('en_plazo', 'bloqueado')
         OR (
           NEW."estado" = 'activo'
           AND OLD."estado" IN ('en_plazo', 'bloqueado', 'suspendido')
         )
      THEN
        RAISE EXCEPTION
          'el estado de deuda del local solo lo cambia recalcular_estado_local() (invariante 9)'
          USING ERRCODE = 'restrict_violation';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS ccv_estado_local_solo_sistema ON "local";

CREATE TRIGGER ccv_estado_local_solo_sistema
BEFORE UPDATE OF "estado" ON "local"
FOR EACH ROW EXECUTE FUNCTION ccv_estado_local_solo_sistema();
