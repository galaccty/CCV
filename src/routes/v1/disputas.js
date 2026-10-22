import { Router } from 'express';
import * as disputas from '../../services/disputas.js';
import { requiereSesion } from '../../middlewares/sesion.js';
import {
  esquemaAgregarEvidencia,
  esquemaFiltrosDisputas,
  esquemaIdPositivo,
  leerPaginacion,
} from '../../lib/validacion.js';

/**
 * DISPUTAS - Etapa 4c-1
 * =====================
 * GET  /api/v1/disputas                 disputas del comprador autenticado
 * GET  /api/v1/disputas/{id}            detalle (comprador, vendedor o admin)
 * POST /api/v1/disputas/{id}/evidencia  texto o URL https
 *
 * La apertura vive en /sub-pedidos/{id}/disputas.
 */
const router = Router();

router.use(requiereSesion);

router.get('/', async (req, res) => {
  const filtros = esquemaFiltrosDisputas.parse(req.query);
  const { pagina, porPagina } = leerPaginacion(req.query);

  res.json(
    await disputas.listarDisputasComprador({
      usuario: req.usuario,
      estado: filtros.estado,
      localId: filtros.local_id,
      pagina,
      porPagina,
    }),
  );
});

router.get('/:id', async (req, res) => {
  const id = esquemaIdPositivo.parse(req.params.id);
  res.json(await disputas.obtenerDisputa({ usuario: req.usuario, id }));
});

router.post('/:id/evidencia', async (req, res) => {
  const id = esquemaIdPositivo.parse(req.params.id);
  const datos = esquemaAgregarEvidencia.parse(req.body);

  res.status(201).json(
    await disputas.agregarEvidencia({
      usuario: req.usuario,
      disputaId: id,
      datos,
    }),
  );
});

export default router;
