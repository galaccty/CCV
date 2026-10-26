import { Router } from 'express';
import * as subPedidos from '../../services/subPedidos.js';
import * as disputas from '../../services/disputas.js';
import * as cancelaciones from '../../services/cancelaciones.js';
import { requiereSesion, requiereRol } from '../../middlewares/sesion.js';
import { idempotenciaRequerida } from '../../middlewares/idempotencia.js';
import {
  esquemaAbrirDisputa,
  esquemaCancelarSubPedido,
  esquemaEnviarSubPedido,
  esquemaIdPositivo,
} from '../../lib/validacion.js';

/**
 * SUB-PEDIDOS - Etapa 2
 * =====================
 * POST /api/v1/sub-pedidos/{id}/aceptar   vendedor: por_aceptar -> preparando
 * POST /api/v1/sub-pedidos/{id}/enviar    vendedor: preparando -> enviado
 * POST /api/v1/sub-pedidos/{id}/entregar  comprador o vendedor: enviado -> entregado
 * POST /api/v1/sub-pedidos/{id}/cancelar   comprador o vendedor, segun estado
 */
const router = Router();

router.use(requiereSesion);

router.post(
  '/:id/aceptar',
  requiereRol('vendedor', 'admin'),
  async (req, res) => {
    const id = esquemaIdPositivo.parse(req.params.id);
    res.json(await subPedidos.aceptarSubPedido({ usuario: req.usuario, id }));
  },
);

router.post(
  '/:id/enviar',
  requiereRol('vendedor', 'admin'),
  async (req, res) => {
    const id = esquemaIdPositivo.parse(req.params.id);
    const { evidencia_envio: evidenciaEnvio } = esquemaEnviarSubPedido.parse(
      req.body,
    );
    res.json(
      await subPedidos.enviarSubPedido({
        usuario: req.usuario,
        id,
        evidenciaEnvio,
      }),
    );
  },
);

router.post('/:id/entregar', async (req, res) => {
  const id = esquemaIdPositivo.parse(req.params.id);
  res.json(await subPedidos.entregarSubPedido({ usuario: req.usuario, id }));
});

router.post(
  '/:id/cancelar',
  requiereRol('comprador', 'vendedor', 'admin'),
  idempotenciaRequerida,
  async (req, res) => {
    const id = esquemaIdPositivo.parse(req.params.id);
    const { motivo } = esquemaCancelarSubPedido.parse(req.body);

    res.json(
      await cancelaciones.cancelarSubPedido({
        usuario: req.usuario,
        id,
        motivo,
        idempotenciaId: res.locals.idempotenciaId,
      }),
    );
  },
);

router.post('/:id/disputas', async (req, res) => {
  const subPedidoId = esquemaIdPositivo.parse(req.params.id);
  const datos = esquemaAbrirDisputa.parse(req.body);

  res.status(201).json(
    await disputas.abrirDisputa({
      usuario: req.usuario,
      subPedidoId,
      datos,
    }),
  );
});

export default router;
