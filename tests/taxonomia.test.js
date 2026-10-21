import './helpers/entorno.js';
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { opcionesConBase, prisma, cerrarConexion } from './helpers/base.js';
import { sembrarTaxonomia, TAXONOMIA_INICIAL } from '../scripts/seed.js';

/**
 * TAXONOMIA INICIAL - ETAPA 3
 * ===========================
 * Los rubros y categorias de arranque viven en el seed y deben poder correrse
 * varias veces sin duplicar filas.
 */

const CON_BASE = await opcionesConBase();

after(async () => {
  await cerrarConexion();
});

describe('seed de taxonomia', () => {
  test('crea los rubros y categorias iniciales sin duplicar al repetir', CON_BASE, async () => {
    const primera = await sembrarTaxonomia();

    assert.equal(primera.rubrosCreados, 8);
    assert.equal(primera.categoriasCreadas, 16);

    const segunda = await sembrarTaxonomia();
    assert.equal(segunda.rubrosCreados, 0);
    assert.equal(segunda.categoriasCreadas, 0);

    const rubrosIniciales = await prisma.rubro.count({
      where: {
        nombre: { in: TAXONOMIA_INICIAL.map((grupo) => grupo.rubro) },
      },
    });
    assert.equal(rubrosIniciales, 8);

    const ropa = await prisma.rubro.findUnique({
      where: { nombre: 'Ropa y accesorios' },
    });
    assert.ok(ropa);

    const raiz = await prisma.categoriaGlobal.findFirst({
      where: { nombre: 'Ropa', rubroId: ropa.id, padreId: null },
    });
    assert.ok(raiz);

    const hijas = await prisma.categoriaGlobal.findMany({
      where: { padreId: raiz.id },
      orderBy: { nombre: 'asc' },
    });
    assert.deepEqual(
      hijas.map((h) => h.nombre),
      ['Accesorios', 'Buzos', 'Camisetas', 'Pantalones'],
    );
  });
});
