-- Una sola reversa de comision por reembolso en cada lado del ledger.
-- La de plataforma (local_id NULL) reduce el ingreso neto; la local (local_id
-- NOT NULL) acredita al vendedor digital o reduce su deuda en efectivo.
CREATE UNIQUE INDEX "ledger_reversa_comision_plataforma_por_reembolso"
  ON "ledger" ("reembolso_id")
  WHERE "tipo" = 'reversa_comision'
    AND "local_id" IS NULL
    AND "reembolso_id" IS NOT NULL;

CREATE UNIQUE INDEX "ledger_reversa_comision_local_por_reembolso"
  ON "ledger" ("reembolso_id")
  WHERE "tipo" = 'reversa_comision'
    AND "local_id" IS NOT NULL
    AND "reembolso_id" IS NOT NULL;
