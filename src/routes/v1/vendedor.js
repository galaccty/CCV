import { Router } from 'express';
import * as subPedidos from '../../services/subPedidos.js';
import { requiereRol } from '../../middlewares/sesion.js';
import {
  esquemaListaSubPedidos,
  leerPaginacion,
} from '../../lib/validacion.js';

/**
 * VENDEDOR - Etapa 2
 * ==================
 * GET /api/v1/vendedor/sub-pedidos
 * Lista los sub-pedidos de los locales del vendedor autenticado.
 */
const router = Router();

router.get(
  '/sub-pedidos',
  requiereRol('vendedor', 'admin'),
  async (req, res) => {
    const { estado } = esquemaListaSubPedidos.parse(req.query);
    const { pagina, porPagina } = leerPaginacion(req.query);

    res.json(
      await subPedidos.listarSubPedidosVendedor({
        usuario: req.usuario,
        estado,
        pagina,
        porPagina,
      }),
    );
  },
);

export default router;
