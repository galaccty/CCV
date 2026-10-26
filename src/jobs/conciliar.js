import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { abrirAlerta } from '../services/alertas.js';

/**
 * JOB: CONCILIACION CUENTA_LOCAL vs LEDGER (Etapa 4f-2)
 * =====================================================
 * Reconstruye, solo con SELECT, los tres saldos que deberia tener cada
 * `cuenta_local` a partir del ledger y compara. NO corrige nada: si hay una
 * diferencia crea/actualiza una alerta para que una persona investigue.
 *
 * La reconstruccion replica los efectos documentados de `registrarMovimiento`:
 * comision de efectivo (+deuda), deuda de reembolso (+deuda), cobros y sus
 * reversas, liberacion, reembolso local, congelacion/descongelacion, pagos a
 * locales, ajustes y las compensaciones que tambien tocan `saldo_por_pagar`
 * (`liquidacion_movimiento`).
 *
 * Las dos inferencias heredadas del ledger actual son conservadoras:
 *   - `reversa_comision`: se mira si existe la comision de efectivo original.
 *   - `ajuste_redondeo`: los ajustes productivos son debitos de un reembolso;
 *     si esta asociado a un reembolso efectivo va a deuda, si no a por pagar.
 */

const CONSULTA = `
  WITH cuentas AS (
    SELECT "local_id",
           "saldo_deuda",
           "saldo_por_pagar",
           "saldo_congelado"
      FROM "cuenta_local"
  ),
  reconstruido AS (
    SELECT m."local_id",
           SUM(
             CASE
               WHEN m."tipo" = 'comision' THEN m."monto"
               WHEN m."tipo" = 'deuda_reembolso' THEN m."monto"
               WHEN m."tipo" = 'cobro_deuda' THEN -m."monto"
               WHEN m."tipo" = 'reversa_cobro_deuda' THEN m."monto"
               WHEN m."tipo" = 'reversa_comision'
                    AND EXISTS (
                      SELECT 1
                        FROM "ledger" mc
                       WHERE mc."sub_pedido_id" = m."sub_pedido_id"
                         AND mc."local_id" = m."local_id"
                         AND mc."tipo" = 'comision'
                    ) THEN -m."monto"
               WHEN m."tipo" = 'ajuste_redondeo'
                    AND r."tipo" = 'efectivo' THEN -m."monto"
               ELSE 0
             END
           )::bigint AS "deuda_ledger",
           SUM(
             CASE
               WHEN m."tipo" = 'liberacion' THEN m."monto"
               WHEN m."tipo" = 'reversa_comision'
                    AND NOT EXISTS (
                      SELECT 1
                        FROM "ledger" mc
                       WHERE mc."sub_pedido_id" = m."sub_pedido_id"
                         AND mc."local_id" = m."local_id"
                         AND mc."tipo" = 'comision'
                    ) THEN m."monto"
               WHEN m."tipo" = 'reembolso' THEN -m."monto"
               WHEN m."tipo" = 'congelacion' THEN -m."monto"
               WHEN m."tipo" = 'descongelacion' THEN m."monto"
               WHEN m."tipo" = 'pago_a_local' THEN -m."monto"
               WHEN m."tipo" = 'reversa_pago_a_local' THEN m."monto"
               WHEN m."tipo" = 'cobro_deuda'
                    AND EXISTS (
                      SELECT 1
                        FROM "liquidacion_movimiento" lm
                       WHERE lm."ledger_id" = m."id"
                    ) THEN -m."monto"
               WHEN m."tipo" = 'reversa_cobro_deuda'
                    AND EXISTS (
                      SELECT 1
                        FROM "liquidacion_movimiento" lm
                       WHERE lm."ledger_id" = m."id"
                    ) THEN m."monto"
               WHEN m."tipo" = 'ajuste_redondeo'
                    AND (r."tipo" IS NULL OR r."tipo" <> 'efectivo')
                    THEN -m."monto"
               ELSE 0
             END
           )::bigint AS "por_pagar_ledger",
           SUM(
             CASE
               WHEN m."tipo" = 'congelacion' THEN m."monto"
               WHEN m."tipo" = 'descongelacion' THEN -m."monto"
               ELSE 0
             END
           )::bigint AS "congelado_ledger"
      FROM "ledger" m
      LEFT JOIN "reembolso" r ON r."id" = m."reembolso_id"
     WHERE m."local_id" IS NOT NULL
     GROUP BY m."local_id"
  )
  SELECT c."local_id",
         c."saldo_deuda",
         c."saldo_por_pagar",
         c."saldo_congelado",
         COALESCE(r."deuda_ledger", 0)::bigint AS "deuda_ledger",
         COALESCE(r."por_pagar_ledger", 0)::bigint AS "por_pagar_ledger",
         COALESCE(r."congelado_ledger", 0)::bigint AS "congelado_ledger"
    FROM cuentas c
    LEFT JOIN reconstruido r ON r."local_id" = c."local_id"
   ORDER BY c."local_id"
`;

function diferencia(cuenta, ledger, campo) {
  if (cuenta === ledger) return null;

  return {
    campo,
    cuenta: cuenta.toString(),
    ledger: ledger.toString(),
    diferencia: (cuenta - ledger).toString(),
  };
}

export async function conciliar({ localIds = null } = {}) {
  const filas = await prisma.$queryRawUnsafe(CONSULTA);
  const filtro = localIds ? new Set(localIds) : null;
  const revisadas = filtro
    ? filas.filter((fila) => filtro.has(fila.local_id))
    : filas;

  let conDiferencias = 0;
  let alertas = 0;

  for (const fila of revisadas) {
    const diferencias = [
      diferencia(fila.saldo_deuda, fila.deuda_ledger, 'saldo_deuda'),
      diferencia(
        fila.saldo_por_pagar,
        fila.por_pagar_ledger,
        'saldo_por_pagar',
      ),
      diferencia(
        fila.saldo_congelado,
        fila.congelado_ledger,
        'saldo_congelado',
      ),
    ].filter(Boolean);

    if (diferencias.length === 0) continue;

    conDiferencias += 1;

    try {
      await abrirAlerta({
        clave: `conciliacion:local:${fila.local_id}`,
        tipo: 'conciliacion_saldo',
        severidad: 'alta',
        titulo: 'Diferencia entre cuenta_local y el ledger',
        detalle: {
          local_id: fila.local_id,
          diferencias,
          detectado_en: new Date().toISOString(),
        },
        localId: fila.local_id,
      });
      alertas += 1;
    } catch (err) {
      logger.error(
        { err, localId: fila.local_id },
        'no se pudo registrar la alerta de conciliacion',
      );
    }
  }

  return {
    revisados: revisadas.length,
    con_diferencias: conDiferencias,
    alertas,
  };
}
