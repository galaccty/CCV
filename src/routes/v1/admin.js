import { Router } from 'express';
import * as adminCatalogo from '../../services/adminCatalogo.js';
import * as pagoDeuda from '../../services/pagoDeuda.js';
import * as cuentaLocal from '../../services/cuentaLocal.js';
import * as liquidaciones from '../../services/liquidaciones.js';
import * as disputas from '../../services/disputas.js';
import * as reembolsos from '../../services/reembolsos.js';
import * as cancelaciones from '../../services/cancelaciones.js';
import { requiereRol } from '../../middlewares/sesion.js';
import { idempotenciaRequerida } from '../../middlewares/idempotencia.js';
import {
  esquemaActualizarCategoriaGlobal,
  esquemaActualizarRubro,
  esquemaCambiarEstadoLocal,
  esquemaCrearCategoriaGlobal,
  esquemaCrearLiquidacion,
  esquemaCrearRubro,
  esquemaAgregarEvidencia,
  esquemaConfirmarLiquidacion,
  esquemaFallarLiquidacion,
  esquemaFiltrosCancelacionesEfectivo,
  esquemaFiltrosDisputas,
  esquemaFiltrosLiquidaciones,
  esquemaFiltrosLocales,
  esquemaIdPositivo,
  esquemaLocalQuery,
  esquemaRegistrarPagoDeuda,
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

router.get('/locales/:id/cuenta', async (req, res) => {
  const localId = esquemaIdPositivo.parse(req.params.id);
  res.json(await cuentaLocal.obtenerCuentaAdmin({ localId }));
});

router.get('/locales/:id/movimientos', async (req, res) => {
  const localId = esquemaIdPositivo.parse(req.params.id);
  const { pagina, porPagina } = leerPaginacion(req.query);
  res.json(
    await cuentaLocal.listarMovimientosAdmin({
      localId,
      pagina,
      porPagina,
    }),
  );
});

router.post(
  '/locales/:id/pagos-deuda',
  idempotenciaRequerida,
  async (req, res) => {
    const localId = esquemaIdPositivo.parse(req.params.id);
    const datos = esquemaRegistrarPagoDeuda.parse(req.body);
    const respuesta = await pagoDeuda.registrarPagoDeudaAdmin({
      admin: req.usuario,
      localId,
      datos,
      idempotenciaId: res.locals.idempotenciaId,
    });
    res.status(201).json(respuesta);
  },
);

router.post(
  '/pagos-deuda/:id/confirmar',
  idempotenciaRequerida,
  async (req, res) => {
    const id = esquemaIdPositivo.parse(req.params.id);
    const respuesta = await pagoDeuda.confirmarPagoDeuda({
      admin: req.usuario,
      id,
      idempotenciaId: res.locals.idempotenciaId,
    });
    res.json(respuesta);
  },
);

// ---------------------------------------------------------------------------
// Liquidaciones y compensacion de deuda (Etapa 4e)
// ---------------------------------------------------------------------------

router.get('/liquidaciones', async (req, res) => {
  const filtros = esquemaFiltrosLiquidaciones.parse(req.query);
  const { pagina, porPagina } = leerPaginacion(req.query);

  res.json(
    await liquidaciones.listarLiquidacionesAdmin({
      localId: filtros.local_id,
      estado: filtros.estado,
      pagina,
      porPagina,
    }),
  );
});

router.post(
  '/liquidaciones',
  idempotenciaRequerida,
  async (req, res) => {
    const datos = esquemaCrearLiquidacion.parse(req.body);
    const respuesta = await liquidaciones.crearLiquidacion({
      admin: req.usuario,
      datos,
      idempotenciaId: res.locals.idempotenciaId,
    });
    res.status(201).json(respuesta);
  },
);

router.get('/liquidaciones/:id', async (req, res) => {
  const id = esquemaIdPositivo.parse(req.params.id);
  res.json(
    await liquidaciones.obtenerLiquidacionAdmin({ id, admin: req.usuario }),
  );
});

router.post(
  '/liquidaciones/:id/preparar',
  idempotenciaRequerida,
  async (req, res) => {
    const id = esquemaIdPositivo.parse(req.params.id);
    res.json(
      await liquidaciones.prepararLiquidacion({
        admin: req.usuario,
        id,
        idempotenciaId: res.locals.idempotenciaId,
      }),
    );
  },
);

router.post(
  '/liquidaciones/:id/confirmar',
  idempotenciaRequerida,
  async (req, res) => {
    const id = esquemaIdPositivo.parse(req.params.id);
    const datos = esquemaConfirmarLiquidacion.parse(req.body);
    res.json(
      await liquidaciones.confirmarLiquidacion({
        admin: req.usuario,
        id,
        datos,
        idempotenciaId: res.locals.idempotenciaId,
      }),
    );
  },
);

router.post(
  '/liquidaciones/:id/fallar',
  idempotenciaRequerida,
  async (req, res) => {
    const id = esquemaIdPositivo.parse(req.params.id);
    const datos = esquemaFallarLiquidacion.parse(req.body);
    res.json(
      await liquidaciones.fallarLiquidacion({
        admin: req.usuario,
        id,
        datos,
        idempotenciaId: res.locals.idempotenciaId,
      }),
    );
  },
);

router.post(
  '/liquidaciones/:id/cancelar',
  idempotenciaRequerida,
  async (req, res) => {
    const id = esquemaIdPositivo.parse(req.params.id);
    res.json(
      await liquidaciones.cancelarLiquidacion({
        admin: req.usuario,
        id,
        idempotenciaId: res.locals.idempotenciaId,
      }),
    );
  },
);

// ---------------------------------------------------------------------------
// Cancelaciones de efectivo aceptado (Etapa 4f-1)
// ---------------------------------------------------------------------------

router.get('/cancelaciones-efectivo', async (req, res) => {
  const filtros = esquemaFiltrosCancelacionesEfectivo.parse(req.query);
  const { pagina, porPagina } = leerPaginacion(req.query);

  res.json(
    await cancelaciones.listarCancelacionesEfectivo({
      localId: filtros.local_id,
      fecha: filtros.fecha,
      desde: filtros.desde,
      hasta: filtros.hasta,
      fechaDesde: filtros.fecha_desde,
      fechaHasta: filtros.fecha_hasta,
      pagina,
      porPagina,
    }),
  );
});

// ---------------------------------------------------------------------------
// Disputas (Etapa 4c-1)
// ---------------------------------------------------------------------------

router.get('/disputas', async (req, res) => {
  const filtros = esquemaFiltrosDisputas.parse(req.query);
  const { pagina, porPagina } = leerPaginacion(req.query);

  res.json(
    await disputas.listarDisputasAdmin({
      estado: filtros.estado,
      localId: filtros.local_id,
      pagina,
      porPagina,
    }),
  );
});

router.get('/disputas/:id', async (req, res) => {
  const id = esquemaIdPositivo.parse(req.params.id);
  res.json(await disputas.obtenerDisputa({ usuario: req.usuario, id }));
});

router.post('/disputas/:id/evidencia', async (req, res) => {
  const disputaId = esquemaIdPositivo.parse(req.params.id);
  const datos = esquemaAgregarEvidencia.parse(req.body);

  res.status(201).json(
    await disputas.agregarEvidencia({
      usuario: req.usuario,
      disputaId,
      datos,
      lado: 'admin',
    }),
  );
});

// ---------------------------------------------------------------------------
// Resolucion de disputas y devolucion de producto (Etapa 4c-2b)
// ---------------------------------------------------------------------------

router.post(
  '/disputas/:id/resolver',
  idempotenciaRequerida,
  async (req, res) => {
    const disputaId = esquemaIdPositivo.parse(req.params.id);

    res.json(
      await disputas.resolverDisputa({
        disputaId,
        admin: req.usuario,
        datos: req.body,
        idempotenciaId: res.locals.idempotenciaId,
      }),
    );
  },
);

router.post(
  '/sub-pedidos/:id/producto-recibido',
  idempotenciaRequerida,
  async (req, res) => {
    const subPedidoId = esquemaIdPositivo.parse(req.params.id);

    res.json(
      await disputas.registrarProductoRecibido({
        subPedidoId,
        admin: req.usuario,
        datos: req.body ?? {},
        idempotenciaId: res.locals.idempotenciaId,
      }),
    );
  },
);

// ---------------------------------------------------------------------------
// Reembolsos por linea (Etapa 4c-2a)
// ---------------------------------------------------------------------------

router.post(
  '/reembolsos/:id/completar',
  idempotenciaRequerida,
  async (req, res) => {
    const reembolsoId = esquemaIdPositivo.parse(req.params.id);

    res.json(
      await reembolsos.completarReembolso({
        reembolsoId,
        admin: req.usuario,
        idempotenciaId: res.locals.idempotenciaId,
      }),
    );
  },
);

router.post(
  '/reembolsos/:id/fallar',
  idempotenciaRequerida,
  async (req, res) => {
    const reembolsoId = esquemaIdPositivo.parse(req.params.id);

    res.json(
      await reembolsos.fallarReembolso({
        reembolsoId,
        admin: req.usuario,
        idempotenciaId: res.locals.idempotenciaId,
      }),
    );
  },
);

export default router;
