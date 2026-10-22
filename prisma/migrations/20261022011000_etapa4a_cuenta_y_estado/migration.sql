-- =============================================================================
-- ETAPA 4a - CUENTA POR LOCAL, ESTADO DEL LOCAL Y CONFIGURACION
-- =============================================================================
-- Esta migracion NO crea las tablas `disputa` ni `pago_deuda`. Por eso las
-- columnas ledger.disputa_id y ledger.pago_deuda_id se difieren a la 4c y 4b,
-- respectivamente, cuando existan sus tablas y sus UNIQUE parciales.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Todo local tiene su cuenta, aunque todavia no haya movido dinero.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ccv_crear_cuenta_local()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO "cuenta_local" ("local_id", "actualizado_en")
  VALUES (NEW.id, now())
  ON CONFLICT ("local_id") DO NOTHING;

  RETURN NEW;
END;
$$;

CREATE TRIGGER ccv_cuenta_local_por_local
AFTER INSERT ON "local"
FOR EACH ROW EXECUTE FUNCTION ccv_crear_cuenta_local();

-- Backfill: los locales que ya existian antes de esta migracion.
INSERT INTO "cuenta_local" ("local_id", "actualizado_en")
SELECT l."id", now()
  FROM "local" l
ON CONFLICT ("local_id") DO NOTHING;

-- -----------------------------------------------------------------------------
-- 2. El estado de deuda solo lo cambia recalcular_estado_local() o el job.
-- -----------------------------------------------------------------------------
-- El admin puede aprobar (pendiente_aprobacion -> activo) y suspender
-- (cualquier estado -> suspendido). No puede poner en_plazo/bloqueado ni
-- desbloquear (bloqueado -> activo). El contexto se marca con
-- set_config('ccv.estado_local_sistema', '1', true): el tercer argumento hace
-- que el ajuste dure solo la transaccion y no quede pegado a la conexion.
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
         OR (OLD."estado" IN ('en_plazo', 'bloqueado') AND NEW."estado" = 'activo')
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

CREATE TRIGGER ccv_estado_local_solo_sistema
BEFORE UPDATE OF "estado" ON "local"
FOR EACH ROW EXECUTE FUNCTION ccv_estado_local_solo_sistema();

-- -----------------------------------------------------------------------------
-- 3. Un movimiento unico para cada hecho que no debe duplicarse.
-- -----------------------------------------------------------------------------
CREATE UNIQUE INDEX "ledger_liberacion_por_sub_pedido"
  ON "ledger" ("sub_pedido_id")
  WHERE "tipo" = 'liberacion';

CREATE UNIQUE INDEX "ledger_reembolso_local_por_reembolso"
  ON "ledger" ("reembolso_id")
  WHERE "tipo" = 'reembolso' AND "local_id" IS NOT NULL;

CREATE UNIQUE INDEX "ledger_deuda_reembolso_por_reembolso"
  ON "ledger" ("reembolso_id")
  WHERE "tipo" = 'deuda_reembolso';

CREATE UNIQUE INDEX "ledger_comision_efectivo_por_sub_pedido"
  ON "ledger" ("sub_pedido_id")
  WHERE "tipo" = 'comision' AND "local_id" IS NOT NULL;

-- -----------------------------------------------------------------------------
-- 4. Claves de configuracion de la Etapa 4.
-- -----------------------------------------------------------------------------
INSERT INTO "configuracion" ("clave", "valor", "tipo", "descripcion", "actualizado_en")
VALUES
  ('dias_reembolso_efectivo', '5', 'entero',
   'Dias que el vendedor tiene para reembolsar en efectivo antes de incumplir.', now()),
  ('intentos_maximos_reembolso', '5', 'entero',
   'Intentos antes de marcar un reembolso como fallido y alertar.', now()),
  ('monto_minimo_liquidacion', '0', 'entero',
   'Monto minimo de una liquidacion; 0 permite lotes de cualquier tamano.', now())
ON CONFLICT ("clave") DO NOTHING;
