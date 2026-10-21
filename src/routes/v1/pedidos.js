import { Router } from 'express';
import * as pedidos from '../../services/pedidos.js';
import { requiereSesion } from '../../middlewares/sesion.js';
import { idempotenciaRequerida } from '../../middlewares/idempotencia.js';
import {
  esquemaCheckout,
  esquemaIdPositivo,
  leerPaginacion,
} from '../../lib/validacion.js';

/**
 * PEDIDOS - Etapa 2
 * =================
 * POST /api/v1/pedidos       crear checkout (idempotente)
 * GET  /api/v1/pedidos       mis pedidos
 * GET  /api/v1/pedidos/{id}  detalle de un pedido propio
 */
const router = Router();

router.use(requiereSesion);

router.post('/', idempotenciaRequerida, async (req, res) => {
  const datos = esquemaCheckout.parse(req.body);
  const respuesta = await pedidos.crearPedido({
    usuario: req.usuario,
    datos,
    idempotenciaId: res.locals.idempotenciaId,
  });
  res.status(201).json(respuesta);
});

router.get('/', async (req, res) => {
  const { pagina, porPagina } = leerPaginacion(req.query);
  res.json(await pedidos.listarPedidos({ usuario: req.usuario, pagina, porPagina }));
});

router.get('/:id', async (req, res) => {
  const id = esquemaIdPositivo.parse(req.params.id);
  res.json(await pedidos.obtenerPedido({ usuario: req.usuario, id }));
});

export default router;
