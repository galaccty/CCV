import '../helpers/entorno.js';
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { opcionesConBase, cerrarConexion } from '../helpers/base.js';
import { ejecutarJob } from '../../src/jobs/ejecutarJob.js';

const CON_BASE = await opcionesConBase();

after(async () => {
  await cerrarConexion();
});

function claveDePrueba() {
  return 42000 + Math.floor(Math.random() * 10000);
}

describe('ejecutarJob - candado advisory', () => {
  test('dos instancias no ejecutan el mismo job a la vez', CON_BASE, async () => {
    const clave = claveDePrueba();
    let liberar;
    let marcarEmpezado;
    const empezo = new Promise((resolve) => {
      marcarEmpezado = resolve;
    });
    const espera = new Promise((resolve) => {
      liberar = resolve;
    });

    const primera = ejecutarJob({
      nombre: 'prueba-a',
      clave,
      ejecutar: async () => {
        marcarEmpezado();
        await espera;
        return 'primera';
      },
    });

    await empezo;

    const segunda = await ejecutarJob({
      nombre: 'prueba-b',
      clave,
      ejecutar: async () => 'segunda',
    });

    assert.deepEqual(segunda, { ejecutado: false, motivo: 'ocupado' });

    liberar();
    const resultadoPrimera = await primera;
    assert.equal(resultadoPrimera.ejecutado, true);
    assert.equal(resultadoPrimera.resultado, 'primera');

    const tercera = await ejecutarJob({
      nombre: 'prueba-c',
      clave,
      ejecutar: async () => 'tercera',
    });
    assert.deepEqual(tercera, { ejecutado: true, resultado: 'tercera' });
  });

  test('el candado se libera aunque el job falle', CON_BASE, async () => {
    const clave = claveDePrueba();

    await assert.rejects(
      () =>
        ejecutarJob({
          nombre: 'prueba-falla',
          clave,
          ejecutar: async () => {
            throw new Error('fallo de prueba');
          },
        }),
      /fallo de prueba/,
    );

    const despues = await ejecutarJob({
      nombre: 'prueba-despues',
      clave,
      ejecutar: async () => 'ok',
    });
    assert.deepEqual(despues, { ejecutado: true, resultado: 'ok' });
  });
});
