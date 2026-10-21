-- CreateEnum
CREATE TYPE "estado_local" AS ENUM ('pendiente_aprobacion', 'activo', 'en_plazo', 'bloqueado', 'suspendido');

-- CreateEnum
CREATE TYPE "estado_pedido" AS ENUM ('pendiente_pago', 'en_proceso', 'completado', 'cancelado', 'reembolsado', 'expirado');

-- CreateEnum
CREATE TYPE "estado_sub_pedido" AS ENUM ('pendiente', 'preparando', 'enviado', 'entregado', 'en_disputa', 'cancelado', 'reembolsado', 'reembolsado_parcial');

-- CreateEnum
CREATE TYPE "entrega_confirmada_por" AS ENUM ('comprador', 'vendedor', 'sistema');

-- CreateEnum
CREATE TYPE "metodo_pago" AS ENUM ('tarjeta', 'pse', 'nequi', 'efectivo', 'manual');

-- CreateEnum
CREATE TYPE "tipo_pago" AS ENUM ('pedido', 'publicidad');

-- CreateEnum
CREATE TYPE "estado_pago" AS ENUM ('pendiente', 'aprobado', 'rechazado', 'reembolsado', 'reembolsado_parcial');

-- CreateEnum
CREATE TYPE "resultado_webhook" AS ENUM ('ok', 'ignorado', 'referencia_desconocida', 'firma_invalida');

-- CreateEnum
CREATE TYPE "estado_idempotencia" AS ENUM ('en_proceso', 'completada');

-- CreateEnum
CREATE TYPE "tipo_reembolso" AS ENUM ('digital', 'efectivo');

-- CreateEnum
CREATE TYPE "estado_reembolso" AS ENUM ('pendiente', 'completado', 'incumplido', 'fallido');

-- CreateEnum
CREATE TYPE "tipo_movimiento" AS ENUM ('venta', 'comision', 'reversa_comision', 'pago_recibido', 'cobro_deuda', 'pago_a_local', 'reembolso', 'ingreso_publicidad', 'ajuste', 'ajuste_redondeo');

-- CreateTable
CREATE TABLE "rubro" (
    "id" SERIAL NOT NULL,
    "nombre" VARCHAR(120) NOT NULL,

    CONSTRAINT "rubro_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "local" (
    "id" SERIAL NOT NULL,
    "usuario_id" INTEGER NOT NULL,
    "rubro_id" INTEGER NOT NULL,
    "nombre" VARCHAR(160) NOT NULL,
    "logo_url" TEXT,
    "banner_fondo_url" TEXT,
    "latitud" DOUBLE PRECISION NOT NULL,
    "longitud" DOUBLE PRECISION NOT NULL,
    "estado" "estado_local" NOT NULL DEFAULT 'pendiente_aprobacion',
    "promedio_calificacion" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "total_calificaciones" INTEGER NOT NULL DEFAULT 0,
    "creado_en" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actualizado_en" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "local_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "categoria_global" (
    "id" SERIAL NOT NULL,
    "nombre" VARCHAR(120) NOT NULL,
    "padre_id" INTEGER,
    "rubro_id" INTEGER,

    CONSTRAINT "categoria_global_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subcategoria_local" (
    "id" SERIAL NOT NULL,
    "local_id" INTEGER NOT NULL,
    "nombre" VARCHAR(120) NOT NULL,

    CONSTRAINT "subcategoria_local_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "producto" (
    "id" SERIAL NOT NULL,
    "local_id" INTEGER NOT NULL,
    "categoria_global_id" INTEGER NOT NULL,
    "subcategoria_local_id" INTEGER,
    "nombre" VARCHAR(200) NOT NULL,
    "descripcion" TEXT,
    "fotos" JSONB,
    "atributos" JSONB,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "creado_en" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actualizado_en" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "producto_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "producto_variante" (
    "id" SERIAL NOT NULL,
    "producto_id" INTEGER NOT NULL,
    "atributos" JSONB,
    "precio" INTEGER NOT NULL,
    "stock" INTEGER NOT NULL DEFAULT 0,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "creado_en" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actualizado_en" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "producto_variante_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pedido" (
    "id" SERIAL NOT NULL,
    "usuario_id" INTEGER NOT NULL,
    "direccion_texto" TEXT NOT NULL,
    "direccion_latitud" DOUBLE PRECISION NOT NULL,
    "direccion_longitud" DOUBLE PRECISION NOT NULL,
    "total" INTEGER NOT NULL,
    "metodo_pago" "metodo_pago" NOT NULL,
    "estado" "estado_pedido" NOT NULL DEFAULT 'pendiente_pago',
    "config_snapshot" JSONB NOT NULL,
    "creado_en" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actualizado_en" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pedido_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sub_pedido" (
    "id" SERIAL NOT NULL,
    "pedido_id" INTEGER NOT NULL,
    "local_id" INTEGER NOT NULL,
    "nombre_local" VARCHAR(160) NOT NULL,
    "subtotal_productos" INTEGER NOT NULL,
    "costo_envio" INTEGER NOT NULL,
    "comision" INTEGER NOT NULL,
    "total" INTEGER NOT NULL,
    "estado" "estado_sub_pedido" NOT NULL DEFAULT 'pendiente',
    "evidencia_envio" TEXT,
    "entrega_confirmada_por" "entrega_confirmada_por",
    "fecha_entrega" TIMESTAMPTZ(3),
    "saldo_liberado_en" TIMESTAMPTZ(3),
    "notas_entrega" TEXT,
    "creado_en" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actualizado_en" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "sub_pedido_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "detalle_producto" (
    "id" SERIAL NOT NULL,
    "sub_pedido_id" INTEGER NOT NULL,
    "variante_id" INTEGER NOT NULL,
    "nombre_producto" VARCHAR(200) NOT NULL,
    "atributos_elegidos" JSONB,
    "cantidad" INTEGER NOT NULL,
    "precio_unitario" INTEGER NOT NULL,

    CONSTRAINT "detalle_producto_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "historial_estado_sub_pedido" (
    "id" SERIAL NOT NULL,
    "sub_pedido_id" INTEGER NOT NULL,
    "estadoAnterior" "estado_sub_pedido",
    "estado_nuevo" "estado_sub_pedido" NOT NULL,
    "cambiado_por" INTEGER,
    "fecha" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "historial_estado_sub_pedido_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pago" (
    "id" SERIAL NOT NULL,
    "tipo_pago" "tipo_pago" NOT NULL DEFAULT 'pedido',
    "pedido_id" INTEGER,
    "referencia" VARCHAR(255) NOT NULL,
    "id_transaccion_wompi" VARCHAR(120),
    "metodo_pago" "metodo_pago" NOT NULL,
    "monto" INTEGER NOT NULL,
    "monto_reembolsado" INTEGER NOT NULL DEFAULT 0,
    "estado" "estado_pago" NOT NULL DEFAULT 'pendiente',
    "fecha_creacion" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "fecha_actualizacion" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pago_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "evento_webhook" (
    "id" SERIAL NOT NULL,
    "referencia" VARCHAR(255),
    "payload" JSONB NOT NULL,
    "procesado" BOOLEAN NOT NULL DEFAULT false,
    "resultado" "resultado_webhook",
    "fecha" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "evento_webhook_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotencia" (
    "id" SERIAL NOT NULL,
    "clave" VARCHAR(255) NOT NULL,
    "usuario_id" INTEGER NOT NULL,
    "ruta" VARCHAR(255) NOT NULL,
    "estado" "estado_idempotencia" NOT NULL DEFAULT 'en_proceso',
    "codigo_http" INTEGER,
    "respuesta_json" JSONB,
    "fecha" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expira" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "idempotencia_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reembolso" (
    "id" SERIAL NOT NULL,
    "pago_id" INTEGER NOT NULL,
    "sub_pedido_id" INTEGER NOT NULL,
    "tipo" "tipo_reembolso" NOT NULL DEFAULT 'digital',
    "monto" INTEGER NOT NULL,
    "estado" "estado_reembolso" NOT NULL DEFAULT 'pendiente',
    "motivo" VARCHAR(200) NOT NULL,
    "fecha" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actualizado_en" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "reembolso_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger" (
    "id" SERIAL NOT NULL,
    "local_id" INTEGER,
    "sub_pedido_id" INTEGER,
    "pago_id" INTEGER,
    "reembolso_id" INTEGER,
    "tipo" "tipo_movimiento" NOT NULL,
    "monto" INTEGER NOT NULL,
    "fecha" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cuenta_local" (
    "local_id" INTEGER NOT NULL,
    "saldo_deuda" INTEGER NOT NULL DEFAULT 0,
    "saldo_por_pagar" INTEGER NOT NULL DEFAULT 0,
    "saldo_congelado" INTEGER NOT NULL DEFAULT 0,
    "fecha_limite_pago" DATE,
    "actualizado_en" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "cuenta_local_pkey" PRIMARY KEY ("local_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "rubro_nombre_key" ON "rubro"("nombre");

-- CreateIndex
CREATE INDEX "local_usuario_id_idx" ON "local"("usuario_id");

-- CreateIndex
CREATE INDEX "local_rubro_id_idx" ON "local"("rubro_id");

-- CreateIndex
CREATE INDEX "local_estado_idx" ON "local"("estado");

-- CreateIndex
CREATE INDEX "categoria_global_padre_id_idx" ON "categoria_global"("padre_id");

-- CreateIndex
CREATE INDEX "categoria_global_rubro_id_idx" ON "categoria_global"("rubro_id");

-- CreateIndex
CREATE UNIQUE INDEX "subcategoria_local_local_id_nombre_key" ON "subcategoria_local"("local_id", "nombre");

-- CreateIndex
CREATE INDEX "producto_local_id_activo_idx" ON "producto"("local_id", "activo");

-- CreateIndex
CREATE INDEX "producto_categoria_global_id_idx" ON "producto"("categoria_global_id");

-- CreateIndex
CREATE INDEX "producto_variante_producto_id_activo_idx" ON "producto_variante"("producto_id", "activo");

-- CreateIndex
CREATE INDEX "pedido_usuario_id_creado_en_idx" ON "pedido"("usuario_id", "creado_en");

-- CreateIndex
CREATE INDEX "pedido_estado_idx" ON "pedido"("estado");

-- CreateIndex
CREATE INDEX "sub_pedido_pedido_id_idx" ON "sub_pedido"("pedido_id");

-- CreateIndex
CREATE INDEX "sub_pedido_local_id_estado_idx" ON "sub_pedido"("local_id", "estado");

-- CreateIndex
CREATE INDEX "detalle_producto_variante_id_idx" ON "detalle_producto"("variante_id");

-- CreateIndex
CREATE UNIQUE INDEX "detalle_producto_sub_pedido_id_variante_id_key" ON "detalle_producto"("sub_pedido_id", "variante_id");

-- CreateIndex
CREATE INDEX "historial_estado_sub_pedido_sub_pedido_id_fecha_idx" ON "historial_estado_sub_pedido"("sub_pedido_id", "fecha");

-- CreateIndex
CREATE UNIQUE INDEX "pago_referencia_key" ON "pago"("referencia");

-- CreateIndex
CREATE UNIQUE INDEX "pago_id_transaccion_wompi_key" ON "pago"("id_transaccion_wompi");

-- CreateIndex
CREATE INDEX "pago_estado_idx" ON "pago"("estado");

-- CreateIndex
CREATE UNIQUE INDEX "pago_pedido_id_key" ON "pago"("pedido_id");

-- CreateIndex
CREATE INDEX "evento_webhook_referencia_idx" ON "evento_webhook"("referencia");

-- CreateIndex
CREATE INDEX "evento_webhook_fecha_idx" ON "evento_webhook"("fecha");

-- CreateIndex
CREATE INDEX "idempotencia_expira_idx" ON "idempotencia"("expira");

-- CreateIndex
CREATE UNIQUE INDEX "idempotencia_usuario_id_ruta_clave_key" ON "idempotencia"("usuario_id", "ruta", "clave");

-- CreateIndex
CREATE INDEX "reembolso_pago_id_idx" ON "reembolso"("pago_id");

-- CreateIndex
CREATE INDEX "reembolso_sub_pedido_id_idx" ON "reembolso"("sub_pedido_id");

-- CreateIndex
CREATE INDEX "reembolso_estado_idx" ON "reembolso"("estado");

-- CreateIndex
CREATE INDEX "ledger_local_id_fecha_idx" ON "ledger"("local_id", "fecha");

-- CreateIndex
CREATE INDEX "ledger_pago_id_idx" ON "ledger"("pago_id");

-- CreateIndex
CREATE INDEX "ledger_sub_pedido_id_idx" ON "ledger"("sub_pedido_id");

-- CreateIndex
CREATE INDEX "ledger_reembolso_id_idx" ON "ledger"("reembolso_id");

-- AddForeignKey
ALTER TABLE "local" ADD CONSTRAINT "local_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuario"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "local" ADD CONSTRAINT "local_rubro_id_fkey" FOREIGN KEY ("rubro_id") REFERENCES "rubro"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "categoria_global" ADD CONSTRAINT "categoria_global_padre_id_fkey" FOREIGN KEY ("padre_id") REFERENCES "categoria_global"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "categoria_global" ADD CONSTRAINT "categoria_global_rubro_id_fkey" FOREIGN KEY ("rubro_id") REFERENCES "rubro"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subcategoria_local" ADD CONSTRAINT "subcategoria_local_local_id_fkey" FOREIGN KEY ("local_id") REFERENCES "local"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "producto" ADD CONSTRAINT "producto_local_id_fkey" FOREIGN KEY ("local_id") REFERENCES "local"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "producto" ADD CONSTRAINT "producto_categoria_global_id_fkey" FOREIGN KEY ("categoria_global_id") REFERENCES "categoria_global"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "producto" ADD CONSTRAINT "producto_subcategoria_local_id_fkey" FOREIGN KEY ("subcategoria_local_id") REFERENCES "subcategoria_local"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "producto_variante" ADD CONSTRAINT "producto_variante_producto_id_fkey" FOREIGN KEY ("producto_id") REFERENCES "producto"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pedido" ADD CONSTRAINT "pedido_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuario"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sub_pedido" ADD CONSTRAINT "sub_pedido_pedido_id_fkey" FOREIGN KEY ("pedido_id") REFERENCES "pedido"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sub_pedido" ADD CONSTRAINT "sub_pedido_local_id_fkey" FOREIGN KEY ("local_id") REFERENCES "local"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "detalle_producto" ADD CONSTRAINT "detalle_producto_sub_pedido_id_fkey" FOREIGN KEY ("sub_pedido_id") REFERENCES "sub_pedido"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "detalle_producto" ADD CONSTRAINT "detalle_producto_variante_id_fkey" FOREIGN KEY ("variante_id") REFERENCES "producto_variante"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "historial_estado_sub_pedido" ADD CONSTRAINT "historial_estado_sub_pedido_sub_pedido_id_fkey" FOREIGN KEY ("sub_pedido_id") REFERENCES "sub_pedido"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "historial_estado_sub_pedido" ADD CONSTRAINT "historial_estado_sub_pedido_cambiado_por_fkey" FOREIGN KEY ("cambiado_por") REFERENCES "usuario"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pago" ADD CONSTRAINT "pago_pedido_id_fkey" FOREIGN KEY ("pedido_id") REFERENCES "pedido"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "idempotencia" ADD CONSTRAINT "idempotencia_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuario"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reembolso" ADD CONSTRAINT "reembolso_pago_id_fkey" FOREIGN KEY ("pago_id") REFERENCES "pago"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reembolso" ADD CONSTRAINT "reembolso_sub_pedido_id_fkey" FOREIGN KEY ("sub_pedido_id") REFERENCES "sub_pedido"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger" ADD CONSTRAINT "ledger_local_id_fkey" FOREIGN KEY ("local_id") REFERENCES "local"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger" ADD CONSTRAINT "ledger_sub_pedido_id_fkey" FOREIGN KEY ("sub_pedido_id") REFERENCES "sub_pedido"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger" ADD CONSTRAINT "ledger_pago_id_fkey" FOREIGN KEY ("pago_id") REFERENCES "pago"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger" ADD CONSTRAINT "ledger_reembolso_id_fkey" FOREIGN KEY ("reembolso_id") REFERENCES "reembolso"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cuenta_local" ADD CONSTRAINT "cuenta_local_local_id_fkey" FOREIGN KEY ("local_id") REFERENCES "local"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
