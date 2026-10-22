import { prisma } from '../lib/prisma.js';
import { aBigInt, restar, sumar } from '../lib/dinero.js';

/**
 * Monto que se acredita al vendedor cuando vence la retencion.
 *
 * Formula aprobada: subtotal_productos + costo_envio - comision. El envio se
 * acredita al vendedor porque el asume el flete; la comision solo se calcula
 * sobre los productos. Si el neto da cero no se escribe asiento.
 */
export function calcularMontoLiberacion({ subtotalProductos, costoEnvio, comision }) {
  const bruto = sumar(
    aBigInt(subtotalProductos, 'subtotal_productos'),
    aBigInt(costoEnvio, 'costo_envio'),
  );
  return restar(bruto, aBigInt(comision, 'comision'));
}

/**
 * LIBERACION DE SALDO - CONSULTA BASE
 * ==================================
 * El job de liberacion de la Etapa 4 no existe todavia. Esta consulta deja
 * escrita la regla que ese job debera usar y permite probar desde ahora la
 * parte del invariante 6 que ya se puede cumplir:
 *
 *   un sub_pedido con un reembolso pendiente NO es elegible para liberar saldo.
 *
 * Tambien exige que el sub_pedido este entregado, que hayan pasado los dias de
 * retencion del snapshot del pedido y que `saldo_liberado_en` siga nulo. Las
 * disputas y la escritura del saldo siguen siendo parte de la Etapa 4.
 */
export async function subPedidosElegiblesParaLiberar({ ahora = new Date() } = {}) {
  const candidatos = await prisma.subPedido.findMany({
    where: {
      estado: 'entregado',
      saldoLiberadoEn: null,
      fechaEntrega: { not: null },
    },
    select: {
      id: true,
      fechaEntrega: true,
      pedido: { select: { configSnapshot: true } },
      reembolsos: {
        where: { estado: 'pendiente' },
        select: { id: true },
      },
    },
  });

  return candidatos
    .filter((sub) => {
      if (sub.reembolsos.length > 0) return false;

      const dias = Number(sub.pedido.configSnapshot?.dias_retencion ?? 0);
      if (!Number.isFinite(dias) || dias < 0) return false;

      const vence = new Date(sub.fechaEntrega);
      vence.setUTCDate(vence.getUTCDate() + dias);

      return vence.getTime() <= ahora.getTime();
    })
    .map((sub) => sub.id);
}
