import { Router } from 'express';
import * as adminCatalogo from '../../services/adminCatalogo.js';
import { requiereRol } from '../../middlewares/sesion.js';
import {
  esquemaActualizarCategoriaGlobal,
  esquemaActualizarRubro,
  esquemaCambiarEstadoLocal,
  esquemaCrearCategoriaGlobal,
  esquemaCrearRubro,
  esquemaFiltrosLocales,
  esquemaIdPositivo,
  leerPaginacion,
} from '../../lib/validacion.js';

/**
 * ADMIN - Etapa 3
 * ===============
 * GET   /api/v1/admin/locales
 * PATCH /api/v1/admin/locales/{id}/estado
 * POST  /api/v1/admin/rubros
 * PATCH /api/v1/admin/rubros/{id}
 * POST  /api/v1/admin/categorias-globales
 * PATCH /api/v1/admin/categorias-globales/{id}
 */
const router = Router();

router.use(requiereRol('admin'));

router.get('/locales', async (req, res) => {
  const { estado } = esquemaFiltrosLocales.parse(req.query);
  const { pagina, porPagina } = leerPaginacion(req.query);

  res.json(
    await adminCatalogo.listarLocalesAdmin({
      estado,
      pagina,
      porPagina,
    }),
  );
});

router.patch('/locales/:id/estado', async (req, res) => {
  const id = esquemaIdPositivo.parse(req.params.id);
  const { estado } = esquemaCambiarEstadoLocal.parse(req.body);

  res.json(
    await adminCatalogo.cambiarEstadoLocal({
      admin: req.usuario,
      id,
      estado,
    }),
  );
});

router.post('/rubros', async (req, res) => {
  const datos = esquemaCrearRubro.parse(req.body);
  res.status(201).json(await adminCatalogo.crearRubro({ datos }));
});

router.patch('/rubros/:id', async (req, res) => {
  const id = esquemaIdPositivo.parse(req.params.id);
  const datos = esquemaActualizarRubro.parse(req.body);
  res.json(await adminCatalogo.actualizarRubro({ id, datos }));
});

router.post('/categorias-globales', async (req, res) => {
  const datos = esquemaCrearCategoriaGlobal.parse(req.body);
  res
    .status(201)
    .json(await adminCatalogo.crearCategoriaGlobal({ datos }));
});

router.patch('/categorias-globales/:id', async (req, res) => {
  const id = esquemaIdPositivo.parse(req.params.id);
  const datos = esquemaActualizarCategoriaGlobal.parse(req.body);
  res.json(await adminCatalogo.actualizarCategoriaGlobal({ id, datos }));
});

export default router;
