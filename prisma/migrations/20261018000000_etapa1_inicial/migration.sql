-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "rol" AS ENUM ('comprador', 'vendedor', 'admin');

-- CreateEnum
CREATE TYPE "tipo_token" AS ENUM ('verificar_email', 'reset_password');

-- CreateEnum
CREATE TYPE "tipo_valor" AS ENUM ('entero', 'numero', 'texto', 'booleano');

-- CreateEnum
CREATE TYPE "origen_admin" AS ENUM ('admin', 'sistema');

-- CreateTable
CREATE TABLE "usuario" (
    "id" SERIAL NOT NULL,
    "nombre" VARCHAR(120) NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "email_verificado" BOOLEAN NOT NULL DEFAULT false,
    "password_hash" VARCHAR(255) NOT NULL,
    "acepto_terminos" BOOLEAN NOT NULL,
    "fecha_aceptacion" TIMESTAMPTZ(3) NOT NULL,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "creado_en" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actualizado_en" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "usuario_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usuario_rol" (
    "usuario_id" INTEGER NOT NULL,
    "rol" "rol" NOT NULL,
    "creado_en" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usuario_rol_pkey" PRIMARY KEY ("usuario_id","rol")
);

-- CreateTable
CREATE TABLE "token_verificacion" (
    "id" SERIAL NOT NULL,
    "usuario_id" INTEGER NOT NULL,
    "tipo" "tipo_token" NOT NULL,
    "token_hash" VARCHAR(255) NOT NULL,
    "expira" TIMESTAMPTZ(3) NOT NULL,
    "usado" BOOLEAN NOT NULL DEFAULT false,
    "creado_en" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "token_verificacion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "configuracion" (
    "clave" VARCHAR(80) NOT NULL,
    "valor" TEXT NOT NULL,
    "tipo" "tipo_valor" NOT NULL,
    "descripcion" VARCHAR(300),
    "actualizado_en" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "configuracion_pkey" PRIMARY KEY ("clave")
);

-- CreateTable
CREATE TABLE "auditoria_admin" (
    "id" SERIAL NOT NULL,
    "origen" "origen_admin" NOT NULL,
    "admin_id" INTEGER,
    "accion" VARCHAR(80) NOT NULL,
    "objeto" VARCHAR(80) NOT NULL,
    "objeto_id" VARCHAR(80),
    "detalle" JSONB,
    "fecha" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auditoria_admin_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "usuario_email_key" ON "usuario"("email");

-- CreateIndex
CREATE INDEX "usuario_rol_rol_idx" ON "usuario_rol"("rol");

-- CreateIndex
CREATE UNIQUE INDEX "token_verificacion_token_hash_key" ON "token_verificacion"("token_hash");

-- CreateIndex
CREATE INDEX "token_verificacion_usuario_id_tipo_idx" ON "token_verificacion"("usuario_id", "tipo");

-- CreateIndex
CREATE INDEX "token_verificacion_expira_idx" ON "token_verificacion"("expira");

-- CreateIndex
CREATE INDEX "auditoria_admin_objeto_objeto_id_idx" ON "auditoria_admin"("objeto", "objeto_id");

-- CreateIndex
CREATE INDEX "auditoria_admin_fecha_idx" ON "auditoria_admin"("fecha");

-- AddForeignKey
ALTER TABLE "usuario_rol" ADD CONSTRAINT "usuario_rol_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuario"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "token_verificacion" ADD CONSTRAINT "token_verificacion_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuario"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auditoria_admin" ADD CONSTRAINT "auditoria_admin_admin_id_fkey" FOREIGN KEY ("admin_id") REFERENCES "usuario"("id") ON DELETE SET NULL ON UPDATE CASCADE;
