import { Router } from 'express';
import * as direcciones from '../../services/direcciones.js';
import { requiereSesion } from '../../middlewares/sesion.js';
import {
  esquemaActualizarDireccion,
  esquemaCrearDireccion,
  esquemaIdPositivo,
} from '../../lib/validacion.js';

/**
 * DIRECCIONES DEL COMPRADOR - Etapa 3b
 * =====================================
 * GET    /api/v1/direcciones
 * POST   /api/v1/direcciones
 * PATCH  /api/v1/direcciones/{id}
 * DELETE /api/v1/direcciones/{id}
 * PATCH  /api/v1/direcciones/{id}/principal
 *
 * Todas exigen sesion y solo permiten operar sobre direcciones propias.
 */
const router = Router();

router.use(requiereSesion);

router.get('/', async (req, res) => {
  res.json(await direcciones.listarDirecciones({ usuario: req.usuario }));
});

router.post('/', async (req, res) => {
  const datos = esquemaCrearDireccion.parse(req.body);
  res
    .status(201)
    .json(await direcciones.crearDireccion({ usuario: req.usuario, datos }));
});

router.patch('/:id/principal', async (req, res) => {
  const id = esquemaIdPositivo.parse(req.params.id);
  res.json(
    await direcciones.marcarDireccionPrincipal({
      usuario: req.usuario,
      id,
    }),
  );
});

router.patch('/:id', async (req, res) => {
  const id = esquemaIdPositivo.parse(req.params.id);
  const datos = esquemaActualizarDireccion.parse(req.body);
  res.json(
    await direcciones.actualizarDireccion({
      usuario: req.usuario,
      id,
      datos,
    }),
  );
});

router.delete('/:id', async (req, res) => {
  const id = esquemaIdPositivo.parse(req.params.id);
  await direcciones.eliminarDireccion({ usuario: req.usuario, id });
  res.status(204).end();
});

export default router;
