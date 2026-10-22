-- =============================================================================
-- ETAPA 4b - PAGOS DE LA DEUDA DE COMISION
-- =============================================================================
-- Un pago de deuda nace pendiente (reportado por el vendedor) o confirmado
-- (registrado directamente por un admin). Solo un pago confirmado se aplica
-- al ledger, una sola vez. El UNIQUE parcial sobre ledger.pago_deuda_id es la
-- ultima barrera contra una doble confirmacion.
-- =============================================================================

CREATE TYPE "metodo_pago_deuda" AS ENUM ('transferencia', 'efectivo', 'manual');
CREATE TYPE "estado_pago_deuda" AS ENUM ('pendiente', 'confirmado', 'rechazado');

CREATE TABLE "pago_deuda" (
  "id"                 SERIAL PRIMARY KEY,
  "local_id"           INTEGER NOT NULL,
  "monto"              BIGINT NOT NULL,
  "metodo"             "metodo_pago_deuda" NOT NULL,
  "referencia"         VARCHAR(255) NOT NULL,
  "comprobante_url"    TEXT,
  "estado"             "estado_pago_deuda" NOT NULL DEFAULT 'pendiente',
  "reportado_por"      INTEGER,
  "confirmado_por"     INTEGER,
  "fecha_reporte"      TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  "fecha_confirmacion" TIMESTAMPTZ(3),
  "motivo_rechazo"     TEXT,

  CONSTRAINT "pago_deuda_local_id_fkey"
    FOREIGN KEY ("local_id") REFERENCES "local"("id") ON DELETE RESTRICT,
  CONSTRAINT "pago_deuda_reportado_por_fkey"
    FOREIGN KEY ("reportado_por") REFERENCES "usuario"("id") ON DELETE RESTRICT,
  CONSTRAINT "pago_deuda_confirmado_por_fkey"
    FOREIGN KEY ("confirmado_por") REFERENCES "usuario"("id") ON DELETE RESTRICT,
  CONSTRAINT "pago_deuda_monto_positivo" CHECK ("monto" > 0),
  CONSTRAINT "pago_deuda_confirmacion_completa" CHECK (
    "estado" <> 'confirmado'
    OR ("fecha_confirmacion" IS NOT NULL AND "confirmado_por" IS NOT NULL)
  )
);

CREATE UNIQUE INDEX "pago_deuda_referencia_key" ON "pago_deuda"("referencia");
CREATE INDEX "pago_deuda_local_id_fecha_reporte_idx"
  ON "pago_deuda"("local_id", "fecha_reporte");
CREATE INDEX "pago_deuda_estado_idx" ON "pago_deuda"("estado");
CREATE INDEX "pago_deuda_reportado_por_idx" ON "pago_deuda"("reportado_por");
CREATE INDEX "pago_deuda_confirmado_por_idx" ON "pago_deuda"("confirmado_por");

-- -----------------------------------------------------------------------------
-- Ledger: el cobro de deuda queda enlazado al pago que lo origino.
-- -----------------------------------------------------------------------------
ALTER TABLE "ledger" ADD COLUMN "pago_deuda_id" INTEGER;

ALTER TABLE "ledger"
  ADD CONSTRAINT "ledger_pago_deuda_id_fkey"
  FOREIGN KEY ("pago_deuda_id") REFERENCES "pago_deuda"("id") ON DELETE RESTRICT;

CREATE INDEX "ledger_pago_deuda_id_idx" ON "ledger"("pago_deuda_id");

-- Un pago de deuda produce como maximo un cobro_deuda. La condicion parcial
-- deja convivir los movimientos que no son cobros de deuda y los cobros
-- historicos que todavia no tienen pago_deuda_id.
CREATE UNIQUE INDEX "ledger_un_cobro_por_pago_deuda"
  ON "ledger"("pago_deuda_id")
  WHERE "tipo" = 'cobro_deuda' AND "pago_deuda_id" IS NOT NULL;

-- -----------------------------------------------------------------------------
-- Protecciones del pago de deuda
-- -----------------------------------------------------------------------------
CREATE FUNCTION ccv_pago_deuda_protegido()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'los pagos de deuda no se borran (invariante 11)'
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- Los datos que identifican el pago no se reescriben.
  IF NEW."local_id" IS DISTINCT FROM OLD."local_id"
     OR NEW."monto" IS DISTINCT FROM OLD."monto"
     OR NEW."metodo" IS DISTINCT FROM OLD."metodo"
     OR NEW."referencia" IS DISTINCT FROM OLD."referencia"
     OR NEW."reportado_por" IS DISTINCT FROM OLD."reportado_por"
     OR NEW."fecha_reporte" IS DISTINCT FROM OLD."fecha_reporte"
  THEN
    RAISE EXCEPTION
      'los datos originales de un pago de deuda no se modifican'
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- Un pago confirmado o rechazado es terminal: no se vuelve a confirmar.
  IF OLD."estado" <> 'pendiente' AND NEW."estado" IS DISTINCT FROM OLD."estado" THEN
    RAISE EXCEPTION
      'un pago de deuda solo se confirma una vez (invariante 11)'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW."estado" = 'confirmado'
     AND (NEW."fecha_confirmacion" IS NULL OR NEW."confirmado_por" IS NULL)
  THEN
    RAISE EXCEPTION
      'un pago confirmado necesita confirmado_por y fecha_confirmacion'
      USING ERRCODE = 'not_null_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER ccv_pago_deuda_protegido
BEFORE UPDATE OR DELETE ON "pago_deuda"
FOR EACH ROW EXECUTE FUNCTION ccv_pago_deuda_protegido();
