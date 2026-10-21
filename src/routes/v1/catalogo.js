import { Router } from 'express';
import * as catalogo from '../../services/catalogo.js';
import {
  esquemaFiltrosCategorias,
  esquemaFiltrosLocales,
  esquemaFiltrosProductos,
  esquemaIdPositivo,
  leerPaginacion,
} from '../../lib/validacion.js';

/**
 * CATALOGO PUBLICO - Etapa 3
 * ==========================
 * GET /api/v1/rubros
 * GET /api/v1/categorias-globales
 * GET /api/v1/locales
 * GET /api/v1/locales/{id}
 * GET /api/v1/locales/{id}/productos
 *
 * No exigen sesion. Solo muestran locales que pueden vender.
 */
const router = Router();

router.get('/rubros', async (_req, res) => {
  res.json(await catalogo.listarRubros());
});

router.get('/categorias-globales', async (req, res) => {
  const { rubro_id: rubroId, padre_id: padreId } =
    esquemaFiltrosCategorias.parse(req.query);

  res.json(
    await catalogo.listarCategoriasGlobales({
      rubroId,
      padreId,
    }),
  );
});

router.get('/locales', async (req, res) => {
  const { rubro_id: rubroId, categoria_global_id: categoriaGlobalId } =
    esquemaFiltrosLocales.parse(req.query);
  const { pagina, porPagina } = leerPaginacion(req.query);

  res.json(
    await catalogo.listarLocales({
      rubroId,
      categoriaGlobalId,
      pagina,
      porPagina,
    }),
  );
});

router.get('/locales/:id', async (req, res) => {
  const id = esquemaIdPositivo.parse(req.params.id);
  res.json(await catalogo.obtenerLocal({ id }));
});

router.get('/locales/:id/productos', async (req, res) => {
  const localId = esquemaIdPositivo.parse(req.params.id);
  const {
    categoria_global_id: categoriaGlobalId,
    subcategoria_local_id: subcategoriaLocalId,
  } = esquemaFiltrosProductos.parse(req.query);
  const { pagina, porPagina } = leerPaginacion(req.query);

  res.json(
    await catalogo.listarProductosDeLocal({
      localId,
      categoriaGlobalId,
      subcategoriaLocalId,
      pagina,
      porPagina,
    }),
  );
});

export default router;
