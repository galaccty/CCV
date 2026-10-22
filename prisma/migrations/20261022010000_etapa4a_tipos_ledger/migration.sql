-- =============================================================================
-- ETAPA 4a - TIPOS NUEVOS DEL LEDGER
-- =============================================================================
-- PostgreSQL no permite usar un valor recien agregado a un enum en la misma
-- transaccion. Por eso los valores viven en esta migracion y los indices que
-- los usan viven en la migracion siguiente.
-- =============================================================================

ALTER TYPE "tipo_movimiento" ADD VALUE IF NOT EXISTS 'liberacion';
ALTER TYPE "tipo_movimiento" ADD VALUE IF NOT EXISTS 'congelacion';
ALTER TYPE "tipo_movimiento" ADD VALUE IF NOT EXISTS 'descongelacion';
ALTER TYPE "tipo_movimiento" ADD VALUE IF NOT EXISTS 'deuda_reembolso';
ALTER TYPE "tipo_movimiento" ADD VALUE IF NOT EXISTS 'reversa_pago_a_local';
ALTER TYPE "tipo_movimiento" ADD VALUE IF NOT EXISTS 'reversa_cobro_deuda';
