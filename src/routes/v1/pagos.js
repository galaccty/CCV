import { Router } from 'express';
import * as pagos from '../../services/pagos.js';
import * as webhooks from '../../services/webhooks.js';
import { requiereSesion } from '../../middlewares/sesion.js';
import { idempotenciaRequerida } from '../../middlewares/idempotencia.js';
import { esquemaIdPositivo } from '../../lib/validacion.js';
import { errorValidacion } from '../../lib/errores.js';

/**
 * PAGOS - Etapa 2
 * ===============
 * POST /api/v1/pedidos/{id}/pagos  crear pago + datos del checkout (idempotente)
 * POST /api/v1/pagos/webhook       evento de Wompi (sin sesion ni CSRF)
 */
const router = Router();

router.post(
  '/pedidos/:id/pagos',
  requiereSesion,
  idempotenciaRequerida,
  async (req, res) => {
    const pedidoId = esquemaIdPositivo.parse(req.params.id);
    const respuesta = await pagos.crearPago({
      usuario: req.usuario,
      pedidoId,
      idempotenciaId: res.locals.idempotenciaId,
    });
    res.status(201).json(respuesta);
  },
);

router.post('/pagos/webhook', async (req, res) => {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
    throw errorValidacion('El cuerpo del webhook debe ser un objeto JSON.');
  }

  // Wompi manda el checksum en X-Event-Checksum; algunos ejemplos lo repiten
  // dentro de signature.checksum. Se acepta cualquiera de los dos.
  const checksum = req.get('x-event-checksum') ?? undefined;

  const resultado = await webhooks.procesarEvento({
    cuerpo: req.body,
    checksum,
  });

  // 200 SOLO despues de procesar. Los errores transitorios los convierte el
  // manejador global en 5xx para que Wompi reintente.
  res.status(200).json(resultado);
});

export default router;
