-- =============================================================================
-- ETAPA 2 - ESTADO INICIAL DEL SUB-PEDIDO Y REEMBOLSO PENDIENTE
-- =============================================================================
-- Esta migracion es NUEVA. No se edito ninguna migracion ya aplicada.
--
-- 1. El estado inicial del sub-pedido se llama `por_aceptar` en la interfaz y
--    en el contrato. Se renombra el valor del enum; no se borra ni se recrea
--    la columna, para no perder el historial existente.
--
-- 2. Un pago aprobado cuyo stock no alcanzo puede quedar con un reembolso
--    manual pendiente. El pedido necesita un estado explicito para que el
--    comprador y el admin vean que la devolucion esta en curso, sin afirmar
--    que el dinero ya se devolvio.
-- =============================================================================

ALTER TYPE "estado_sub_pedido"
  RENAME VALUE 'pendiente' TO 'por_aceptar';

ALTER TYPE "estado_pedido"
  ADD VALUE IF NOT EXISTS 'reembolso_pendiente';
