-- =============================================================================
-- ETAPA 4c-1 - DISPUTAS Y EVIDENCIA
-- =============================================================================
-- Esta mitad solo registra la disputa y su evidencia. NO congela saldo, NO
-- resuelve y NO escribe movimientos de dinero. El estado del sub-pedido pasa a
-- `en_disputa` en la misma transaccion del INSERT, y una disputa resuelta queda
-- inmutable para que la resolucion de 4c-2 no pueda reescribirse.
-- =============================================================================

CREATE TYPE "tipo_disputa" AS ENUM ('digital', 'efectivo');
CREATE TYPE "estado_disputa" AS ENUM ('abierta', 'resuelta_comprador', 'resuelta_vendedor');
CREATE TYPE "lado_evidencia" AS ENUM ('comprador', 'vendedor', 'admin');
CREATE TYPE "tipo_evidencia" AS ENUM ('texto', 'url');

CREATE TABLE "disputa" (
  "id"                        SERIAL PRIMARY KEY,
  "sub_pedido_id"             INTEGER NOT NULL,
  "usuario_id"                INTEGER NOT NULL,
  "tipo"                      "tipo_disputa" NOT NULL,
  "motivo"                    TEXT NOT NULL,
  "estado"                    "estado_disputa" NOT NULL DEFAULT 'abierta',
  "monto_reclamado"           BIGINT NOT NULL,
  "monto_congelado"           BIGINT NOT NULL DEFAULT 0,
  "fecha_apertura"            TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  "fecha_resolucion"          TIMESTAMPTZ(3),
  "resuelto_por"              INTEGER,
  "resolucion"                TEXT,
  "estado_sub_pedido_anterior" "estado_sub_pedido" NOT NULL,

  CONSTRAINT "disputa_sub_pedido_id_fkey"
    FOREIGN KEY ("sub_pedido_id") REFERENCES "sub_pedido"("id") ON DELETE RESTRICT,
  CONSTRAINT "disputa_usuario_id_fkey"
    FOREIGN KEY ("usuario_id") REFERENCES "usuario"("id") ON DELETE RESTRICT,
  CONSTRAINT "disputa_resuelto_por_fkey"
    FOREIGN KEY ("resuelto_por") REFERENCES "usuario"("id") ON DELETE RESTRICT,
  CONSTRAINT "disputa_motivo_no_vacio" CHECK (btrim("motivo") <> ''),
  CONSTRAINT "disputa_monto_reclamado_positivo" CHECK ("monto_reclamado" > 0),
  CONSTRAINT "disputa_monto_congelado_valido" CHECK (
    "monto_congelado" >= 0 AND "monto_congelado" <= "monto_reclamado"
  ),
  CONSTRAINT "disputa_estado_anterior_valido" CHECK (
    "estado_sub_pedido_anterior" IN ('enviado', 'entregado')
  ),
  CONSTRAINT "disputa_resolucion_completa" CHECK (
    ("estado" = 'abierta'
      AND "fecha_resolucion" IS NULL
      AND "resuelto_por" IS NULL
      AND "resolucion" IS NULL)
    OR
    ("estado" <> 'abierta'
      AND "fecha_resolucion" IS NOT NULL
      AND "resuelto_por" IS NOT NULL
      AND "resolucion" IS NOT NULL
      AND btrim("resolucion") <> '')
  )
);

-- Una sola disputa por sub-pedido. Es la ultima barrera contra dos aperturas
-- simultaneas, ademas del FOR UPDATE del trigger.
CREATE UNIQUE INDEX "disputa_sub_pedido_id_key" ON "disputa"("sub_pedido_id");
CREATE INDEX "disputa_usuario_id_idx" ON "disputa"("usuario_id");
CREATE INDEX "disputa_estado_fecha_apertura_idx" ON "disputa"("estado", "fecha_apertura");

CREATE TABLE "disputa_evidencia" (
  "id"          SERIAL PRIMARY KEY,
  "disputa_id"  INTEGER NOT NULL,
  "usuario_id"  INTEGER NOT NULL,
  "lado"        "lado_evidencia" NOT NULL,
  "tipo"        "tipo_evidencia" NOT NULL,
  "contenido"   TEXT NOT NULL,
  "creado_en"   TIMESTAMPTZ(3) NOT NULL DEFAULT now(),

  CONSTRAINT "disputa_evidencia_disputa_id_fkey"
    FOREIGN KEY ("disputa_id") REFERENCES "disputa"("id") ON DELETE RESTRICT,
  CONSTRAINT "disputa_evidencia_usuario_id_fkey"
    FOREIGN KEY ("usuario_id") REFERENCES "usuario"("id") ON DELETE RESTRICT,
  CONSTRAINT "disputa_evidencia_contenido_no_vacio"
    CHECK (btrim("contenido") <> ''),
  CONSTRAINT "disputa_evidencia_url_https"
    CHECK ("tipo" <> 'url' OR ("contenido" LIKE 'https://%' AND length("contenido") > 8))
);

CREATE INDEX "disputa_evidencia_disputa_id_creado_en_idx"
  ON "disputa_evidencia"("disputa_id", "creado_en");
CREATE INDEX "disputa_evidencia_usuario_id_idx" ON "disputa_evidencia"("usuario_id");

-- -----------------------------------------------------------------------------
-- Ledger: la congelacion/descongelacion de 4c-2 quedara enlazada a la disputa.
-- -----------------------------------------------------------------------------
ALTER TABLE "ledger" ADD COLUMN "disputa_id" INTEGER;

ALTER TABLE "ledger"
  ADD CONSTRAINT "ledger_disputa_id_fkey"
  FOREIGN KEY ("disputa_id") REFERENCES "disputa"("id") ON DELETE RESTRICT;

CREATE INDEX "ledger_disputa_id_idx" ON "ledger"("disputa_id");

CREATE UNIQUE INDEX "ledger_congelacion_descongelacion_por_disputa"
  ON "ledger"("disputa_id", "tipo")
  WHERE "tipo" IN ('congelacion', 'descongelacion') AND "disputa_id" IS NOT NULL;

-- -----------------------------------------------------------------------------
-- Apertura: valida, bloquea el sub-pedido y lo pasa a en_disputa.
-- -----------------------------------------------------------------------------
CREATE FUNCTION ccv_disputa_abrir()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_estado       "estado_sub_pedido";
  v_liberado_en  TIMESTAMPTZ(3);
  v_metodo_pago  "metodo_pago";
  v_comprador_id INTEGER;
  v_actualizados INTEGER;
BEGIN
  SELECT s."estado", s."saldo_liberado_en", p."metodo_pago", p."usuario_id"
    INTO v_estado, v_liberado_en, v_metodo_pago, v_comprador_id
    FROM "sub_pedido" s
    JOIN "pedido" p ON p."id" = s."pedido_id"
   WHERE s."id" = NEW."sub_pedido_id"
     FOR UPDATE OF s;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'sub_pedido_no_encontrado'
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF NEW."usuario_id" <> v_comprador_id THEN
    RAISE EXCEPTION 'solo el comprador del pedido puede abrir la disputa'
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_estado NOT IN ('enviado', 'entregado') THEN
    RAISE EXCEPTION 'sub_pedido_no_disputable'
      USING ERRCODE = 'check_violation',
            HINT = 'Solo se disputa un sub-pedido enviado o entregado.';
  END IF;

  IF v_liberado_en IS NOT NULL THEN
    RAISE EXCEPTION 'sub_pedido_saldo_liberado'
      USING ERRCODE = 'check_violation',
            HINT = 'La ventana de retencion ya cerro: el saldo fue liberado.';
  END IF;

  IF NEW."tipo" = 'efectivo' AND v_metodo_pago <> 'efectivo' THEN
    RAISE EXCEPTION 'disputa_tipo_no_coincide'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."tipo" = 'digital' AND v_metodo_pago = 'efectivo' THEN
    RAISE EXCEPTION 'disputa_tipo_no_coincide'
      USING ERRCODE = 'check_violation';
  END IF;

  -- El estado anterior lo decide la base, no el cliente ni el servicio.
  NEW."estado_sub_pedido_anterior" := v_estado;

  UPDATE "sub_pedido"
     SET "estado" = 'en_disputa',
         "actualizado_en" = now()
   WHERE "id" = NEW."sub_pedido_id"
     AND "estado" = v_estado;

  GET DIAGNOSTICS v_actualizados = ROW_COUNT;
  IF v_actualizados = 0 THEN
    RAISE EXCEPTION 'sub_pedido_no_disputable'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER ccv_disputa_abrir
BEFORE INSERT ON "disputa"
FOR EACH ROW EXECUTE FUNCTION ccv_disputa_abrir();

-- -----------------------------------------------------------------------------
-- Una disputa resuelta es inmutable y no se borra.
-- -----------------------------------------------------------------------------
CREATE FUNCTION ccv_disputa_protegida()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'las disputas no se borran (invariante 11)'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD."estado" <> 'abierta' THEN
    RAISE EXCEPTION 'una disputa resuelta no se modifica (invariante 11)'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER ccv_disputa_protegida
BEFORE UPDATE OR DELETE ON "disputa"
FOR EACH ROW EXECUTE FUNCTION ccv_disputa_protegida();

-- -----------------------------------------------------------------------------
-- La evidencia no se agrega a una disputa cerrada, no se edita ni se borra.
-- -----------------------------------------------------------------------------
CREATE FUNCTION ccv_disputa_evidencia_protegida()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_estado "estado_disputa";
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT "estado"
      INTO v_estado
      FROM "disputa"
     WHERE "id" = NEW."disputa_id"
       FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'disputa_no_encontrada'
        USING ERRCODE = 'foreign_key_violation';
    END IF;

    IF v_estado <> 'abierta' THEN
      RAISE EXCEPTION 'disputa_cerrada'
        USING ERRCODE = 'check_violation',
              HINT = 'No se agrega evidencia a una disputa resuelta.';
    END IF;

    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'la evidencia de una disputa no se modifica ni se borra (invariante 11)'
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER ccv_disputa_evidencia_protegida
BEFORE INSERT OR UPDATE OR DELETE ON "disputa_evidencia"
FOR EACH ROW EXECUTE FUNCTION ccv_disputa_evidencia_protegida();
