-- =============================================================================
-- ETAPA 4F-2 - ALERTAS OPERATIVAS Y PAGO EXPIRADO
-- =============================================================================
-- 1. `estado_pago` gana el valor `expirado` para que el job de expiracion no
--    tenga que mentir con `rechazado`. Un pago expirado significa que el
--    checkout vencio sin aprobacion; si Wompi lo aprueba despues, se trata
--    como pago tardio y se reembolsa.
--
-- 2. `alerta` es una cola operativa para el admin. No mueve dinero y no
--    reemplaza la auditoria. La clave estable evita duplicar la misma
--    diferencia en cada corrida de conciliacion o integridad.
-- =============================================================================

ALTER TYPE "estado_pago" ADD VALUE 'expirado' BEFORE 'aprobado';

CREATE TYPE "estado_alerta" AS ENUM ('abierta', 'resuelta');
CREATE TYPE "severidad_alerta" AS ENUM ('baja', 'media', 'alta');

CREATE TABLE "alerta" (
  "id"                  SERIAL NOT NULL,
  "clave"               VARCHAR(255) NOT NULL,
  "tipo"                VARCHAR(80) NOT NULL,
  "severidad"           "severidad_alerta" NOT NULL DEFAULT 'media',
  "estado"              "estado_alerta" NOT NULL DEFAULT 'abierta',
  "titulo"              VARCHAR(200) NOT NULL,
  "detalle"             JSONB,
  "local_id"            INTEGER,
  "pedido_id"           INTEGER,
  "pago_id"             INTEGER,
  "reembolso_id"        INTEGER,
  "sub_pedido_id"       INTEGER,
  "creada_en"           TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "actualizada_en"      TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "ultima_deteccion_en" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resuelta_en"         TIMESTAMPTZ(3),
  "resuelta_por"        INTEGER,
  "nota_resolucion"     TEXT,

  CONSTRAINT "alerta_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "alerta_clave_key" ON "alerta"("clave");
CREATE INDEX "alerta_estado_tipo_idx" ON "alerta"("estado", "tipo");
CREATE INDEX "alerta_local_id_estado_idx" ON "alerta"("local_id", "estado");
CREATE INDEX "alerta_creada_en_idx" ON "alerta"("creada_en");
