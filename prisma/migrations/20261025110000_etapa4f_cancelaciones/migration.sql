-- =============================================================================
-- ETAPA 4f-1 - CANCELACION DE SUB-PEDIDOS
-- =============================================================================
-- La cancelacion devuelve el stock que ya se habia descontado. Se agrega un
-- origen propio para distinguirla de las devoluciones por disputa y mantener
-- la trazabilidad de por que volvio cada unidad.
-- =============================================================================

ALTER TYPE "origen_devolucion_stock" ADD VALUE 'cancelacion';
