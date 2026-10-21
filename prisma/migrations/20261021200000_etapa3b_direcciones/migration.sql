-- Direcciones del comprador. Las coordenadas llegan desde el frontend; el
-- backend solo valida el rango aproximado de Colombia.
CREATE TABLE "direccion" (
    "id" SERIAL NOT NULL,
    "usuario_id" INTEGER NOT NULL,
    "texto" TEXT NOT NULL,
    "latitud" DOUBLE PRECISION NOT NULL,
    "longitud" DOUBLE PRECISION NOT NULL,
    "principal" BOOLEAN NOT NULL DEFAULT false,
    "creado_en" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actualizado_en" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "direccion_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "direccion_texto_valido" CHECK (char_length(btrim("texto")) >= 5),
    CONSTRAINT "direccion_latitud_colombia" CHECK ("latitud" >= -5 AND "latitud" <= 14),
    CONSTRAINT "direccion_longitud_colombia" CHECK ("longitud" >= -83 AND "longitud" <= -66)
);

CREATE INDEX "direccion_usuario_id_idx" ON "direccion"("usuario_id");

-- Un usuario no puede tener dos direcciones principales al mismo tiempo.
CREATE UNIQUE INDEX "direccion_principal_por_usuario"
    ON "direccion"("usuario_id")
    WHERE "principal" = true;

ALTER TABLE "direccion"
    ADD CONSTRAINT "direccion_usuario_id_fkey"
    FOREIGN KEY ("usuario_id") REFERENCES "usuario"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
