import './helpers/entorno.js';
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { opcionesConBase, prisma, cerrarConexion } from './helpers/base.js';
import { cliente, crearUsuarioConSesion } from './helpers/http.js';
import { crearCatalogo } from './helpers/datos.js';
import { crearVariante } from '../src/services/stock.js';

/**
 * CATALOGO PUBLICO, VENDEDOR Y ADMIN - ETAPA 3
 * =============================================
 * Cubre las rutas que alimentan la vista de local y el panel de administracion.
 * Las pruebas de carrito y checkout multi-local viven en sus propios archivos.
 */

const CON_BASE = await opcionesConBase();

after(async () => {
  await cerrarConexion();
});

async function crearAdminConSesion() {
  const admin = await crearUsuarioConSesion({ roles: ['comprador'] });
  await prisma.usuarioRol.create({
    data: { usuarioId: admin.id, rol: 'admin' },
  });
  return admin;
}

function sufijo() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function datosLocal(rubroId, extra = {}) {
  return {
    rubro_id: rubroId,
    nombre: `Local ${sufijo()}`,
    latitud: 4.65,
    longitud: -74.05,
    ...extra,
  };
}

describe('GET /api/v1/catalogo publico', () => {
  test('lista rubros y categorias sin sesion', CON_BASE, async () => {
    const rubro = await prisma.rubro.create({
      data: { nombre: `rubro-publico-${sufijo()}` },
    });
    const raiz = await prisma.categoriaGlobal.create({
      data: { nombre: `raiz-${sufijo()}`, rubroId: rubro.id },
    });
    const hija = await prisma.categoriaGlobal.create({
      data: {
        nombre: `hija-${sufijo()}`,
        rubroId: rubro.id,
        padreId: raiz.id,
      },
    });

    const anonimo = cliente();

    const rubros = await anonimo.get('/api/v1/rubros');
    assert.equal(rubros.status, 200);
    assert.ok(rubros.body.datos.some((r) => r.id === rubro.id));

    const categorias = await anonimo.get(
      `/api/v1/categorias-globales?rubro_id=${rubro.id}`,
    );
    assert.equal(categorias.status, 200);
    assert.deepEqual(
      categorias.body.datos.map((c) => c.id).sort((a, b) => a - b),
      [raiz.id, hija.id].sort((a, b) => a - b),
    );

    const hijas = await anonimo.get(
      `/api/v1/categorias-globales?rubro_id=${rubro.id}&padre_id=${raiz.id}`,
    );
    assert.equal(hijas.status, 200);
    assert.deepEqual(hijas.body.datos.map((c) => c.id), [hija.id]);
  });

  test('solo muestra locales activos o en plazo y su catalogo activo', CON_BASE, async () => {
    const activo = await crearCatalogo({ precio: 10000n, stockInicial: 4 });
    const enPlazo = await crearCatalogo({ estadoLocal: 'en_plazo' });
    const bloqueado = await crearCatalogo({ estadoLocal: 'bloqueado' });
    const suspendido = await crearCatalogo({ estadoLocal: 'suspendido' });
    const pendiente = await crearCatalogo({
      estadoLocal: 'pendiente_aprobacion',
    });

    const anonimo = cliente();

    for (const catalogo of [activo, enPlazo]) {
      const lista = await anonimo.get(
        `/api/v1/locales?rubro_id=${catalogo.rubro.id}`,
      );
      assert.equal(lista.status, 200);
      assert.ok(lista.body.datos.some((l) => l.id === catalogo.local.id));

      const detalle = await anonimo.get(`/api/v1/locales/${catalogo.local.id}`);
      assert.equal(detalle.status, 200);
      assert.equal(detalle.body.id, catalogo.local.id);
      assert.equal(detalle.body.productos.length, 1);
      assert.equal(detalle.body.productos[0].variantes.length, 1);
    }

    for (const catalogo of [bloqueado, suspendido, pendiente]) {
      const lista = await anonimo.get(
        `/api/v1/locales?rubro_id=${catalogo.rubro.id}`,
      );
      assert.equal(lista.status, 200);
      assert.equal(lista.body.datos.length, 0);

      const detalle = await anonimo.get(`/api/v1/locales/${catalogo.local.id}`);
      assert.equal(detalle.status, 404);
    }

    const porCategoria = await anonimo.get(
      `/api/v1/locales?categoria_global_id=${activo.categoria.id}`,
    );
    assert.equal(porCategoria.status, 200);
    assert.ok(porCategoria.body.datos.some((l) => l.id === activo.local.id));
  });

  test('los productos desactivados no aparecen en el catalogo publico', CON_BASE, async () => {
    const catalogo = await crearCatalogo();
    await prisma.producto.update({
      where: { id: catalogo.producto.id },
      data: { activo: false },
    });

    const anonimo = cliente();
    const detalle = await anonimo.get(`/api/v1/locales/${catalogo.local.id}`);
    assert.equal(detalle.status, 200);
    assert.deepEqual(detalle.body.productos, []);

    const productos = await anonimo.get(
      `/api/v1/locales/${catalogo.local.id}/productos`,
    );
    assert.equal(productos.status, 200);
    assert.equal(productos.body.datos.length, 0);
  });

  test('detalle publico: solo variantes activas, disponibilidad y resumen del local', CON_BASE, async () => {
    const catalogo = await crearCatalogo({ stockInicial: 4 });
    await crearVariante(prisma, {
      productoId: catalogo.producto.id,
      atributos: { talla: 'S' },
      precio: 11000n,
      stock: 9,
      activo: false,
    });

    const r = await cliente().get(
      `/api/v1/productos/${catalogo.producto.id}`,
    );
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.id, catalogo.producto.id);
    assert.equal(r.body.local.id, catalogo.local.id);
    assert.equal(r.body.local.nombre, catalogo.local.nombre);
    assert.equal(r.body.local.rubro.id, catalogo.rubro.id);
    assert.equal(r.body.variantes.length, 1);
    assert.equal(r.body.variantes[0].id, catalogo.variante.id);
    assert.equal(r.body.variantes[0].disponible, true);
    assert.equal(Object.hasOwn(r.body.variantes[0], 'stock'), false);
  });

  test('detalle publico: disponible es false cuando no hay stock', CON_BASE, async () => {
    const catalogo = await crearCatalogo({ stockInicial: 0 });
    const r = await cliente().get(
      `/api/v1/productos/${catalogo.producto.id}`,
    );

    assert.equal(r.status, 200);
    assert.equal(r.body.variantes.length, 1);
    assert.equal(r.body.variantes[0].disponible, false);
  });

  test('detalle publico: nunca expone productos ni locales inactivos', CON_BASE, async () => {
    const productoInactivo = await crearCatalogo();
    await prisma.producto.update({
      where: { id: productoInactivo.producto.id },
      data: { activo: false },
    });

    const localInactivo = await crearCatalogo();
    await prisma.local.update({
      where: { id: localInactivo.local.id },
      data: { estado: 'suspendido' },
    });

    const anonimo = cliente();
    const porProducto = await anonimo.get(
      `/api/v1/productos/${productoInactivo.producto.id}`,
    );
    const porLocal = await anonimo.get(
      `/api/v1/productos/${localInactivo.producto.id}`,
    );

    assert.equal(porProducto.status, 404);
    assert.equal(porLocal.status, 404);
  });
});

describe('catalogo del vendedor', () => {
  test('crea local pendiente, producto con variantes y stock inicial', CON_BASE, async () => {
    const vendedor = await crearUsuarioConSesion({ roles: ['vendedor'] });
    const rubro = await prisma.rubro.create({
      data: { nombre: `rubro-vendedor-${sufijo()}` },
    });
    const categoria = await prisma.categoriaGlobal.create({
      data: { nombre: `categoria-vendedor-${sufijo()}`, rubroId: rubro.id },
    });

    const localResp = await vendedor.cliente.post(
      '/api/v1/vendedor/locales',
      datosLocal(rubro.id),
    );
    assert.equal(localResp.status, 201, JSON.stringify(localResp.body));
    assert.equal(localResp.body.estado, 'pendiente_aprobacion');

    const subcategoriaResp = await vendedor.cliente.post(
      `/api/v1/vendedor/locales/${localResp.body.id}/subcategorias`,
      { nombre: `sub-${sufijo()}` },
    );
    assert.equal(subcategoriaResp.status, 201);

    const productoResp = await vendedor.cliente.post(
      '/api/v1/vendedor/productos',
      {
        local_id: localResp.body.id,
        categoria_global_id: categoria.id,
        subcategoria_local_id: subcategoriaResp.body.id,
        nombre: `Producto ${sufijo()}`,
        descripcion: 'Producto de prueba',
        fotos: [],
        atributos: { material: 'algodon' },
        variantes: [
          {
            atributos: { talla: 'M' },
            precio: 12000,
            stock: 7,
          },
          {
            atributos: { talla: 'L' },
            precio: 13000,
            stock: 2,
          },
        ],
      },
    );

    assert.equal(productoResp.status, 201, JSON.stringify(productoResp.body));
    assert.equal(productoResp.body.variantes.length, 2);
    assert.deepEqual(
      productoResp.body.variantes.map((v) => v.stock).sort((a, b) => a - b),
      [2, 7],
    );

    const variantesDb = await prisma.productoVariante.findMany({
      where: { productoId: productoResp.body.id },
      orderBy: { id: 'asc' },
    });
    assert.deepEqual(
      variantesDb.map((v) => Number(v.stock)).sort((a, b) => a - b),
      [2, 7],
    );

    const misLocales = await vendedor.cliente.get('/api/v1/vendedor/locales');
    assert.equal(misLocales.status, 200);
    assert.equal(misLocales.body.datos.length, 1);

    const misProductos = await vendedor.cliente.get('/api/v1/vendedor/productos');
    assert.equal(misProductos.status, 200);
    assert.equal(misProductos.body.datos.length, 1);

    // El local pendiente no aparece en el catalogo publico.
    const publico = await cliente().get(`/api/v1/locales/${localResp.body.id}`);
    assert.equal(publico.status, 404);
  });

  test('rechaza categorias de otro rubro y subcategorias de otro local', CON_BASE, async () => {
    const vendedor = await crearUsuarioConSesion({ roles: ['vendedor'] });
    const rubroPropio = await prisma.rubro.create({
      data: { nombre: `rubro-propio-${sufijo()}` },
    });
    const rubroAjeno = await prisma.rubro.create({
      data: { nombre: `rubro-ajeno-${sufijo()}` },
    });
    const categoriaAjena = await prisma.categoriaGlobal.create({
      data: { nombre: `categoria-ajena-${sufijo()}`, rubroId: rubroAjeno.id },
    });

    const local = await vendedor.cliente.post(
      '/api/v1/vendedor/locales',
      datosLocal(rubroPropio.id),
    );
    assert.equal(local.status, 201);

    const producto = await vendedor.cliente.post(
      '/api/v1/vendedor/productos',
      {
        local_id: local.body.id,
        categoria_global_id: categoriaAjena.id,
        nombre: `Producto invalido ${sufijo()}`,
        variantes: [{ precio: 10000, stock: 1 }],
      },
    );

    assert.equal(producto.status, 422);
    assert.equal(producto.body.error.codigo, 'categoria_no_corresponde_al_rubro');
  });

  test('ajusta el stock por diferencia y nunca lo deja negativo', CON_BASE, async () => {
    const vendedor = await crearUsuarioConSesion({ roles: ['vendedor'] });
    const otro = await crearUsuarioConSesion({ roles: ['vendedor'] });
    const rubro = await prisma.rubro.create({
      data: { nombre: `rubro-stock-${sufijo()}` },
    });
    const categoria = await prisma.categoriaGlobal.create({
      data: { nombre: `categoria-stock-${sufijo()}`, rubroId: rubro.id },
    });

    const local = await vendedor.cliente.post(
      '/api/v1/vendedor/locales',
      datosLocal(rubro.id),
    );
    const producto = await vendedor.cliente.post(
      '/api/v1/vendedor/productos',
      {
        local_id: local.body.id,
        categoria_global_id: categoria.id,
        nombre: `Producto stock ${sufijo()}`,
        variantes: [{ precio: 10000, stock: 10 }],
      },
    );
    assert.equal(producto.status, 201);
    const varianteId = producto.body.variantes[0].id;

    const suma = await vendedor.cliente.patch(
      `/api/v1/vendedor/variantes/${varianteId}/stock`,
      { diferencia: 5 },
    );
    assert.equal(suma.status, 200);
    assert.equal(suma.body.stock, 15);

    const resta = await vendedor.cliente.patch(
      `/api/v1/vendedor/variantes/${varianteId}/stock`,
      { diferencia: -4 },
    );
    assert.equal(resta.status, 200);
    assert.equal(resta.body.stock, 11);

    const negativa = await vendedor.cliente.patch(
      `/api/v1/vendedor/variantes/${varianteId}/stock`,
      { diferencia: -100 },
    );
    assert.equal(negativa.status, 422);
    assert.equal(negativa.body.error.codigo, 'stock_negativo');

    const despues = await prisma.productoVariante.findUnique({
      where: { id: varianteId },
    });
    assert.equal(despues.stock, 11);

    const ajeno = await otro.cliente.patch(
      `/api/v1/vendedor/variantes/${varianteId}/stock`,
      { diferencia: 1 },
    );
    assert.equal(ajeno.status, 403);
  });

  test('no permite cambiar el stock por el endpoint de metadatos de la variante', CON_BASE, async () => {
    const vendedor = await crearUsuarioConSesion({ roles: ['vendedor'] });
    const catalogo = await crearCatalogo({
      precio: 10000n,
      stockInicial: 6,
    });
    await prisma.local.update({
      where: { id: catalogo.local.id },
      data: { usuarioId: vendedor.id },
    });

    const r = await vendedor.cliente.patch(
      `/api/v1/vendedor/variantes/${catalogo.variante.id}`,
      { stock: 0 },
    );

    assert.equal(r.status, 400);
    const variante = await prisma.productoVariante.findUnique({
      where: { id: catalogo.variante.id },
    });
    assert.equal(variante.stock, 6);
  });
});

describe('administracion del catalogo', () => {
  test('el admin aprueba y suspende locales y deja auditoria', CON_BASE, async () => {
    const admin = await crearAdminConSesion();
    const catalogo = await crearCatalogo({
      estadoLocal: 'pendiente_aprobacion',
    });

    const aprobar = await admin.cliente.patch(
      `/api/v1/admin/locales/${catalogo.local.id}/estado`,
      { estado: 'activo' },
    );
    assert.equal(aprobar.status, 200, JSON.stringify(aprobar.body));
    assert.equal(aprobar.body.estado, 'activo');

    const auditoria = await prisma.auditoriaAdmin.findFirst({
      where: {
        objeto: 'local',
        objetoId: String(catalogo.local.id),
        accion: 'cambiar_estado_local',
      },
      orderBy: { id: 'desc' },
    });
    assert.ok(auditoria);
    assert.equal(auditoria.origen, 'admin');
    assert.equal(auditoria.adminId, admin.id);

    const suspender = await admin.cliente.patch(
      `/api/v1/admin/locales/${catalogo.local.id}/estado`,
      { estado: 'suspendido' },
    );
    assert.equal(suspender.status, 200);
    assert.equal(suspender.body.estado, 'suspendido');

    const publico = await cliente().get(`/api/v1/locales/${catalogo.local.id}`);
    assert.equal(publico.status, 404);
  });

  test('no permite saltarse la deuda ni desbloquear a mano un local', CON_BASE, async () => {
    const admin = await crearAdminConSesion();

    const enPlazo = await crearCatalogo({ estadoLocal: 'en_plazo' });
    const reactivar = await admin.cliente.patch(
      `/api/v1/admin/locales/${enPlazo.local.id}/estado`,
      { estado: 'activo' },
    );
    assert.equal(reactivar.status, 409);
    assert.equal(reactivar.body.error.codigo, 'estado_controlado_por_deuda');

    // Suspender por politica del admin si es una accion valida, aunque el
    // local estuviera en plazo.
    const suspender = await admin.cliente.patch(
      `/api/v1/admin/locales/${enPlazo.local.id}/estado`,
      { estado: 'suspendido' },
    );
    assert.equal(suspender.status, 200);
    assert.equal(suspender.body.estado, 'suspendido');

    const bloqueado = await crearCatalogo({ estadoLocal: 'bloqueado' });
    const desbloquear = await admin.cliente.patch(
      `/api/v1/admin/locales/${bloqueado.local.id}/estado`,
      { estado: 'activo' },
    );
    assert.equal(desbloquear.status, 409);
    assert.equal(desbloquear.body.error.codigo, 'estado_solo_sistema');

    const local = await prisma.local.findUnique({
      where: { id: bloqueado.local.id },
    });
    assert.equal(local.estado, 'bloqueado');
  });

  test('crea y edita rubros y categorias, y evita ciclos', CON_BASE, async () => {
    const admin = await crearAdminConSesion();

    const rubroResp = await admin.cliente.post('/api/v1/admin/rubros', {
      nombre: `rubro-admin-${sufijo()}`,
    });
    assert.equal(rubroResp.status, 201);
    assert.ok(rubroResp.body.id);

    const renombrado = await admin.cliente.patch(
      `/api/v1/admin/rubros/${rubroResp.body.id}`,
      { nombre: `rubro-admin-editado-${sufijo()}` },
    );
    assert.equal(renombrado.status, 200);

    const padre = await admin.cliente.post(
      '/api/v1/admin/categorias-globales',
      { nombre: `padre-${sufijo()}`, rubro_id: rubroResp.body.id },
    );
    assert.equal(padre.status, 201);

    const hija = await admin.cliente.post(
      '/api/v1/admin/categorias-globales',
      {
        nombre: `hija-${sufijo()}`,
        rubro_id: rubroResp.body.id,
        padre_id: padre.body.id,
      },
    );
    assert.equal(hija.status, 201);
    assert.equal(hija.body.padre_id, padre.body.id);

    const ciclo = await admin.cliente.patch(
      `/api/v1/admin/categorias-globales/${padre.body.id}`,
      { padre_id: hija.body.id },
    );
    assert.equal(ciclo.status, 422);
    assert.equal(ciclo.body.error.codigo, 'categoria_padre_invalida');
  });

  test('un comprador no puede entrar al panel de admin', CON_BASE, async () => {
    const comprador = await crearUsuarioConSesion();
    const r = await comprador.cliente.get('/api/v1/admin/locales');
    assert.equal(r.status, 403);
  });
});
