-- =============================================================================
-- ETAPA 4e - CUENTA BANCARIA Y LIQUIDACIONES
-- =============================================================================
-- La cuenta bancaria vive en `local`. El numero de cuenta y el documento del
-- titular NO tienen columna en claro: la aplicacion los cifra con AES-256-GCM
-- antes de escribir y los descifra solo para el admin en el detalle de una
-- liquidacion. La liquidacion guarda un snapshot de esos mismos valores
-- cifrados al preparar el pago.
--
-- Una liquidacion abierta (borrador o en_proceso) bloquea la creacion de otra
-- para el mismo local. Los montos quedan fijados al preparar y una liquidacion
-- pagada es completamente inmutable. Nada de esta etapa se puede borrar.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Cuenta bancaria del vendedor
-- -----------------------------------------------------------------------------
CREATE TYPE "tipo_cuenta_bancaria" AS ENUM ('ahorros', 'corriente');

ALTER TABLE "local"
  ADD COLUMN "banco" VARCHAR(100),
  ADD COLUMN "tipo_cuenta_bancaria" "tipo_cuenta_bancaria",
  ADD COLUMN "numero_cuenta_cifrado" TEXT,
  ADD COLUMN "titular_cuenta" VARCHAR(160),
  ADD COLUMN "documento_titular_cifrado" TEXT;

-- -----------------------------------------------------------------------------
-- 2. Liquidaciones
-- -----------------------------------------------------------------------------
CREATE TYPE "estado_liquidacion" AS ENUM (
  'borrador',
  'en_proceso',
  'pagada',
  'fallida',
  'cancelada'
);
CREATE TYPE "metodo_pago_liquidacion" AS ENUM ('transferencia', 'manual');
CREATE TYPE "rol_liquidacion_movimiento" AS ENUM (
  'liberacion',
  'reembolso',
  'compensacion',
  'pago',
  'reversa_cobro_deuda',
  'reversa_pago_a_local'
);

CREATE TABLE "liquidacion" (
  "id"                              SERIAL PRIMARY KEY,
  "local_id"                        INTEGER NOT NULL,
  "estado"                          "estado_liquidacion" NOT NULL DEFAULT 'borrador',
  "fecha_creacion"                  TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  "fecha_preparacion"               TIMESTAMPTZ(3),
  "fecha_pago"                      TIMESTAMPTZ(3),
  "monto_liberado"                  BIGINT NOT NULL DEFAULT 0,
  "monto_reembolsado"               BIGINT NOT NULL DEFAULT 0,
  "monto_compensado"                BIGINT NOT NULL DEFAULT 0,
  "total_pagado"                    BIGINT NOT NULL DEFAULT 0,
  "referencia_payout"               VARCHAR(255),
  "metodo_pago"                     "metodo_pago_liquidacion" NOT NULL DEFAULT 'transferencia',
  "comprobante_url"                 TEXT,
  "creado_por"                      INTEGER NOT NULL,
  "preparado_por"                   INTEGER,
  "pagado_por"                      INTEGER,
  "motivo_fallo"                    TEXT,
  "banco_destino"                   VARCHAR(100),
  "tipo_cuenta_destino"             "tipo_cuenta_bancaria",
  "numero_cuenta_destino_cifrado"   TEXT,
  "titular_destino"                 VARCHAR(160),
  "documento_titular_destino_cifrado" TEXT,

  CONSTRAINT "liquidacion_local_id_fkey"
    FOREIGN KEY ("local_id") REFERENCES "local"("id") ON DELETE RESTRICT,
  CONSTRAINT "liquidacion_creado_por_fkey"
    FOREIGN KEY ("creado_por") REFERENCES "usuario"("id") ON DELETE RESTRICT,
  CONSTRAINT "liquidacion_preparado_por_fkey"
    FOREIGN KEY ("preparado_por") REFERENCES "usuario"("id") ON DELETE RESTRICT,
  CONSTRAINT "liquidacion_pagado_por_fkey"
    FOREIGN KEY ("pagado_por") REFERENCES "usuario"("id") ON DELETE RESTRICT,

  CONSTRAINT "liquidacion_montos_no_negativos" CHECK (
    "monto_liberado" >= 0
    AND "monto_reembolsado" >= 0
    AND "monto_compensado" >= 0
    AND "total_pagado" >= 0
  ),
  CONSTRAINT "liquidacion_total_cuadra" CHECK (
    "monto_liberado" - "monto_reembolsado" - "monto_compensado" = "total_pagado"
  ),
  CONSTRAINT "liquidacion_preparada_completa" CHECK (
    "estado" NOT IN ('en_proceso', 'pagada')
    OR (
      "fecha_preparacion" IS NOT NULL
      AND "preparado_por" IS NOT NULL
      AND "banco_destino" IS NOT NULL
      AND "tipo_cuenta_destino" IS NOT NULL
      AND "numero_cuenta_destino_cifrado" IS NOT NULL
      AND "titular_destino" IS NOT NULL
      AND "documento_titular_destino_cifrado" IS NOT NULL
    )
  ),
  CONSTRAINT "liquidacion_pagada_completa" CHECK (
    "estado" <> 'pagada'
    OR (
      "referencia_payout" IS NOT NULL
      AND "fecha_pago" IS NOT NULL
      AND "pagado_por" IS NOT NULL
    )
  ),
  CONSTRAINT "liquidacion_fallida_completa" CHECK (
    "estado" <> 'fallida'
    OR ("motivo_fallo" IS NOT NULL AND "fecha_pago" IS NULL)
  )
);

CREATE UNIQUE INDEX "liquidacion_referencia_payout_key"
  ON "liquidacion"("referencia_payout");

-- Solo una liquidacion abierta por local. Al confirmar o fallar, el indice
-- deja crear la siguiente.
CREATE UNIQUE INDEX "liquidacion_una_abierta_por_local"
  ON "liquidacion"("local_id")
  WHERE "estado" IN ('borrador', 'en_proceso');

CREATE INDEX "liquidacion_local_id_fecha_creacion_idx"
  ON "liquidacion"("local_id", "fecha_creacion");
CREATE INDEX "liquidacion_estado_idx" ON "liquidacion"("estado");
CREATE INDEX "liquidacion_creado_por_idx" ON "liquidacion"("creado_por");
CREATE INDEX "liquidacion_preparado_por_idx" ON "liquidacion"("preparado_por");
CREATE INDEX "liquidacion_pagado_por_idx" ON "liquidacion"("pagado_por");

-- -----------------------------------------------------------------------------
-- 3. Movimientos que componen cada lote
-- -----------------------------------------------------------------------------
-- El ledger sigue siendo inmutable. Esta tabla enlaza los movimientos que
-- cubre la liquidacion y las reversas con su movimiento original.
CREATE TABLE "liquidacion_movimiento" (
  "liquidacion_id"  INTEGER NOT NULL,
  "ledger_id"       INTEGER NOT NULL,
  "rol"             "rol_liquidacion_movimiento" NOT NULL,
  "ledger_origen_id" INTEGER,

  PRIMARY KEY ("liquidacion_id", "ledger_id"),

  CONSTRAINT "liquidacion_movimiento_liquidacion_id_fkey"
    FOREIGN KEY ("liquidacion_id") REFERENCES "liquidacion"("id") ON DELETE RESTRICT,
  CONSTRAINT "liquidacion_movimiento_ledger_id_fkey"
    FOREIGN KEY ("ledger_id") REFERENCES "ledger"("id") ON DELETE RESTRICT,
  CONSTRAINT "liquidacion_movimiento_ledger_origen_id_fkey"
    FOREIGN KEY ("ledger_origen_id") REFERENCES "ledger"("id") ON DELETE RESTRICT,

  CONSTRAINT "liquidacion_movimiento_origen_reversa" CHECK (
    ("rol" IN ('reversa_cobro_deuda', 'reversa_pago_a_local'))
    = ("ledger_origen_id" IS NOT NULL)
  )
);

CREATE INDEX "liquidacion_movimiento_ledger_id_idx"
  ON "liquidacion_movimiento"("ledger_id");
CREATE INDEX "liquidacion_movimiento_ledger_origen_id_idx"
  ON "liquidacion_movimiento"("ledger_origen_id");
CREATE INDEX "liquidacion_movimiento_rol_idx"
  ON "liquidacion_movimiento"("rol");

CREATE UNIQUE INDEX "liquidacion_movimiento_un_rol_operativo"
  ON "liquidacion_movimiento"("liquidacion_id", "rol")
  WHERE "rol" IN ('compensacion', 'pago', 'reversa_cobro_deuda', 'reversa_pago_a_local');

CREATE UNIQUE INDEX "liquidacion_movimiento_una_reversa_por_origen"
  ON "liquidacion_movimiento"("ledger_origen_id")
  WHERE "rol" IN ('reversa_cobro_deuda', 'reversa_pago_a_local');

-- -----------------------------------------------------------------------------
-- 4. La liquidacion no se borra y sus estados no se reabren
-- -----------------------------------------------------------------------------
CREATE FUNCTION ccv_liquidacion_protegida()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'las liquidaciones no se borran (invariante 11)'
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- La identidad y el origen del lote no se reescriben nunca.
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."local_id" IS DISTINCT FROM OLD."local_id"
     OR NEW."creado_por" IS DISTINCT FROM OLD."creado_por"
     OR NEW."fecha_creacion" IS DISTINCT FROM OLD."fecha_creacion"
  THEN
    RAISE EXCEPTION
      'el origen de una liquidacion no se modifica'
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- Los estados terminales ya no aceptan ningun cambio. La unica forma de
  -- corregir un pago equivocado es un asiento de ajuste auditado.
  IF OLD."estado" IN ('pagada', 'fallida', 'cancelada') THEN
    RAISE EXCEPTION
      'una liquidacion terminal es inmutable (invariante 11)'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW."estado" IS DISTINCT FROM OLD."estado" THEN
    IF NOT (
      (OLD."estado" = 'borrador' AND NEW."estado" IN ('en_proceso', 'cancelada'))
      OR (OLD."estado" = 'en_proceso' AND NEW."estado" IN ('pagada', 'fallida'))
    ) THEN
      RAISE EXCEPTION
        'transicion de liquidacion no permitida: % -> %',
        OLD."estado", NEW."estado"
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;

  -- Al preparar se fijan los montos y el snapshot. Confirmar o fallar no los
  -- puede mover.
  IF OLD."estado" IN ('en_proceso', 'pagada') AND (
       NEW."monto_liberado" IS DISTINCT FROM OLD."monto_liberado"
    OR NEW."monto_reembolsado" IS DISTINCT FROM OLD."monto_reembolsado"
    OR NEW."monto_compensado" IS DISTINCT FROM OLD."monto_compensado"
    OR NEW."total_pagado" IS DISTINCT FROM OLD."total_pagado"
    OR NEW."banco_destino" IS DISTINCT FROM OLD."banco_destino"
    OR NEW."tipo_cuenta_destino" IS DISTINCT FROM OLD."tipo_cuenta_destino"
    OR NEW."numero_cuenta_destino_cifrado" IS DISTINCT FROM OLD."numero_cuenta_destino_cifrado"
    OR NEW."titular_destino" IS DISTINCT FROM OLD."titular_destino"
    OR NEW."documento_titular_destino_cifrado" IS DISTINCT FROM OLD."documento_titular_destino_cifrado"
    OR NEW."fecha_preparacion" IS DISTINCT FROM OLD."fecha_preparacion"
    OR NEW."preparado_por" IS DISTINCT FROM OLD."preparado_por"
  ) THEN
    RAISE EXCEPTION
      'los montos y el snapshot de una liquidacion preparada son inmutables'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER ccv_liquidacion_protegida
BEFORE UPDATE OR DELETE ON "liquidacion"
FOR EACH ROW EXECUTE FUNCTION ccv_liquidacion_protegida();

CREATE FUNCTION ccv_liquidacion_movimiento_inmutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'los enlaces de movimientos de una liquidacion no se modifican ni se borran (invariante 11)'
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER ccv_liquidacion_movimiento_inmutable
BEFORE UPDATE OR DELETE ON "liquidacion_movimiento"
FOR EACH ROW EXECUTE FUNCTION ccv_liquidacion_movimiento_inmutable();

-- Una liquidacion terminal tampoco acepta movimientos nuevos: su composicion
-- queda cerrada. Al preparar se permiten porque la liquidacion esta en_proceso;
-- fallar agrega las reversas antes de pasar a fallida.
CREATE FUNCTION ccv_liquidacion_movimiento_solo_abierta()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  estado_actual "estado_liquidacion";
BEGIN
  SELECT "estado" INTO estado_actual
    FROM "liquidacion"
   WHERE "id" = NEW."liquidacion_id";

  IF estado_actual IN ('pagada', 'fallida', 'cancelada') THEN
    RAISE EXCEPTION
      'una liquidacion terminal no acepta movimientos nuevos (invariante 11)'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER ccv_liquidacion_movimiento_solo_abierta
BEFORE INSERT ON "liquidacion_movimiento"
FOR EACH ROW EXECUTE FUNCTION ccv_liquidacion_movimiento_solo_abierta();
