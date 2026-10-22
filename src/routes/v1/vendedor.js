import { Router } from 'express';
import * as subPedidos from '../../services/subPedidos.js';
import * as vendedorCatalogo from '../../services/vendedorCatalogo.js';
import * as pagoDeuda from '../../services/pagoDeuda.js';
import * as cuentaLocal from '../../services/cuentaLocal.js';
import { requiereRol } from '../../middlewares/sesion.js';
import { idempotenciaRequerida } from '../../middlewares/idempotencia.js';
import {
  esquemaActualizarLocal,
  esquemaActualizarProducto,
  esquemaActualizarSubcategoria,
  esquemaActualizarVariante,
  esquemaAjusteStock,
  esquemaCrearLocal,
  esquemaCrearProducto,
  esquemaCrearSubcategoria,
  esquemaCrearVariante,
  esquemaFiltrosPagosDeuda,
  esquemaFiltrosProductos,
  esquemaIdPositivo,
  esquemaListaSubPedidos,
  esquemaLocalQuery,
  esquemaReportarPagoDeuda,
  leerPaginacion,
} from '../../lib/validacion.js';

/**
 * VENDEDOR
 * ========
 * Etapa 2:
 *   GET    /api/v1/vendedor/sub-pedidos
 *
 * Etapa 3:
 *   GET    /api/v1/vendedor/locales
 *   POST   /api/v1/vendedor/locales
 *   PATCH  /api/v1/vendedor/locales/{id}
 *   POST   /api/v1/vendedor/locales/{id}/subcategorias
 *   PATCH  /api/v1/vendedor/subcategorias/{id}
 *   GET    /api/v1/vendedor/productos
 *   POST   /api/v1/vendedor/productos
 *   PATCH  /api/v1/vendedor/productos/{id}
 *   POST   /api/v1/vendedor/productos/{id}/variantes
 *   PATCH  /api/v1/vendedor/variantes/{id}
 *   PATCH  /api/v1/vendedor/variantes/{id}/stock
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

// ---------------------------------------------------------------------------
// Locales
// ---------------------------------------------------------------------------

router.get('/locales', requiereRol('vendedor'), async (req, res) => {
  const { pagina, porPagina } = leerPaginacion(req.query);
  res.json(
    await vendedorCatalogo.listarLocalesVendedor({
      usuario: req.usuario,
      pagina,
      porPagina,
    }),
  );
});

router.post('/locales', requiereRol('vendedor'), async (req, res) => {
  const datos = esquemaCrearLocal.parse(req.body);
  const local = await vendedorCatalogo.crearLocal({
    usuario: req.usuario,
    datos,
  });
  res.status(201).json(local);
});

router.patch('/locales/:id', requiereRol('vendedor'), async (req, res) => {
  const id = esquemaIdPositivo.parse(req.params.id);
  const datos = esquemaActualizarLocal.parse(req.body);
  res.json(
    await vendedorCatalogo.actualizarLocal({
      usuario: req.usuario,
      id,
      datos,
    }),
  );
});

router.post(
  '/locales/:id/subcategorias',
  requiereRol('vendedor'),
  async (req, res) => {
    const localId = esquemaIdPositivo.parse(req.params.id);
    const datos = esquemaCrearSubcategoria.parse(req.body);
    const subcategoria = await vendedorCatalogo.crearSubcategoria({
      usuario: req.usuario,
      localId,
      datos,
    });
    res.status(201).json(subcategoria);
  },
);

router.patch(
  '/subcategorias/:id',
  requiereRol('vendedor'),
  async (req, res) => {
    const id = esquemaIdPositivo.parse(req.params.id);
    const datos = esquemaActualizarSubcategoria.parse(req.body);
    res.json(
      await vendedorCatalogo.actualizarSubcategoria({
        usuario: req.usuario,
        id,
        datos,
      }),
    );
  },
);

// ---------------------------------------------------------------------------
// Productos y variantes
// ---------------------------------------------------------------------------

router.get('/productos', requiereRol('vendedor'), async (req, res) => {
  const { local_id: localId } = esquemaFiltrosProductos.parse(req.query);
  const { pagina, porPagina } = leerPaginacion(req.query);

  res.json(
    await vendedorCatalogo.listarProductosVendedor({
      usuario: req.usuario,
      localId,
      pagina,
      porPagina,
    }),
  );
});

router.post('/productos', requiereRol('vendedor'), async (req, res) => {
  const datos = esquemaCrearProducto.parse(req.body);
  const producto = await vendedorCatalogo.crearProducto({
    usuario: req.usuario,
    datos,
  });
  res.status(201).json(producto);
});

router.patch('/productos/:id', requiereRol('vendedor'), async (req, res) => {
  const id = esquemaIdPositivo.parse(req.params.id);
  const datos = esquemaActualizarProducto.parse(req.body);
  res.json(
    await vendedorCatalogo.actualizarProducto({
      usuario: req.usuario,
      id,
      datos,
    }),
  );
});

router.post(
  '/productos/:id/variantes',
  requiereRol('vendedor'),
  async (req, res) => {
    const productoId = esquemaIdPositivo.parse(req.params.id);
    const datos = esquemaCrearVariante.parse(req.body);
    const variante = await vendedorCatalogo.crearVariante({
      usuario: req.usuario,
      productoId,
      datos,
    });
    res.status(201).json(variante);
  },
);

router.patch('/variantes/:id', requiereRol('vendedor'), async (req, res) => {
  const id = esquemaIdPositivo.parse(req.params.id);
  const datos = esquemaActualizarVariante.parse(req.body);
  res.json(
    await vendedorCatalogo.actualizarVariante({
      usuario: req.usuario,
      id,
      datos,
    }),
  );
});

router.patch(
  '/variantes/:id/stock',
  requiereRol('vendedor'),
  async (req, res) => {
    const id = esquemaIdPositivo.parse(req.params.id);
    const { diferencia } = esquemaAjusteStock.parse(req.body);

    res.json(
      await vendedorCatalogo.ajustarStockVariante({
        usuario: req.usuario,
        id,
        diferencia,
      }),
    );
  },
);

router.get('/cuenta', requiereRol('vendedor'), async (req, res) => {
  const { local_id: localId } = esquemaLocalQuery.parse(req.query);
  res.json(
    await cuentaLocal.obtenerCuentaVendedor({
      usuario: req.usuario,
      localId,
    }),
  );
});

router.get('/movimientos', requiereRol('vendedor'), async (req, res) => {
  const { local_id: localId } = esquemaLocalQuery.parse(req.query);
  const { pagina, porPagina } = leerPaginacion(req.query);
  res.json(
    await cuentaLocal.listarMovimientosVendedor({
      usuario: req.usuario,
      localId,
      pagina,
      porPagina,
    }),
  );
});

router.get('/deuda/pagos', async (req, res) => {
  const filtros = esquemaFiltrosPagosDeuda.parse(req.query);
  const { pagina, porPagina } = leerPaginacion(req.query);

  res.json(
    await pagoDeuda.listarPagosDeudaVendedor({
      usuario: req.usuario,
      localId: filtros.local_id,
      estado: filtros.estado,
      pagina,
      porPagina,
    }),
  );
});

router.post('/deuda/pagos', idempotenciaRequerida, async (req, res) => {
  const datos = esquemaReportarPagoDeuda.parse(req.body);
  const respuesta = await pagoDeuda.reportarPagoDeuda({
    usuario: req.usuario,
    datos,
    idempotenciaId: res.locals.idempotenciaId,
  });
  res.status(201).json(respuesta);
});

export default router;
