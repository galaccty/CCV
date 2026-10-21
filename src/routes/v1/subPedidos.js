import { Router } from 'express';
import * as subPedidos from '../../services/subPedidos.js';
import { requiereSesion, requiereRol } from '../../middlewares/sesion.js';
import {
  esquemaEnviarSubPedido,
  esquemaIdPositivo,
} from '../../lib/validacion.js';

/**
 * SUB-PEDIDOS - Etapa 2
 * =====================
 * POST /api/v1/sub-pedidos/{id}/aceptar   vendedor: por_aceptar -> preparando
 * POST /api/v1/sub-pedidos/{id}/enviar    vendedor: preparando -> enviado
 * POST /api/v1/sub-pedidos/{id}/entregar  comprador o vendedor: enviado -> entregado
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

export default router;
