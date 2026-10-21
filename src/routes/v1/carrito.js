import { Router } from 'express';
import * as carrito from '../../services/carrito.js';
import { requiereSesion } from '../../middlewares/sesion.js';
import { esquemaIdPositivo, esquemaItemCarrito } from '../../lib/validacion.js';

/**
 * CARRITO - Etapa 3
 * =================
 * GET    /api/v1/carrito
 * DELETE /api/v1/carrito
 * PUT    /api/v1/carrito/items/{variante_id}
 * DELETE /api/v1/carrito/items/{variante_id}
 *
 * La cantidad de PUT es absoluta: reemplaza la que hubiera para esa variante.
 */
const router = Router();

router.use(requiereSesion);

router.get('/', async (req, res) => {
  res.json(await carrito.verCarrito({ usuario: req.usuario }));
});

router.delete('/', async (req, res) => {
  await carrito.vaciarCarrito({ usuario: req.usuario });
  res.status(204).end();
});

router.put('/items/:variante_id', async (req, res) => {
  const varianteId = esquemaIdPositivo.parse(req.params.variante_id);
  const { cantidad } = esquemaItemCarrito.parse(req.body);

  res.json(
    await carrito.fijarItem({
      usuario: req.usuario,
      varianteId,
      cantidad,
    }),
  );
});

router.delete('/items/:variante_id', async (req, res) => {
  const varianteId = esquemaIdPositivo.parse(req.params.variante_id);
  await carrito.quitarItem({ usuario: req.usuario, varianteId });
  res.status(204).end();
});

export default router;
