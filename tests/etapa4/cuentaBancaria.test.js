import '../helpers/entorno.js';
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import pino from 'pino';
import { opcionesConBase, prisma, cerrarConexion } from '../helpers/base.js';
import {
  crearCatalogoParaVendedor,
  crearUsuarioDirecto,
} from '../helpers/datos.js';
import { crearUsuarioConSesion } from '../helpers/http.js';
import { RUTAS_REDACTADAS } from '../../src/lib/logger.js';
import {
  cifrarDatoBancario,
  cuentaBancariaCompleta,
  descifrarDatoBancario,
  enmascararDatoBancario,
} from '../../src/lib/cifradoBancario.js';

/**
 * CUENTA BANCARIA DEL VENDEDOR - ETAPA 4e
 * =======================================
 * Comprueba el cifrado AES-256-GCM, las mascaras de la API, la ausencia de
 * columnas en claro y la redaccion de logs. El detalle completo del admin y
 * el snapshot se cubren en liquidaciones.test.js.
 */

const CON_BASE = await opcionesConBase();

after(async () => {
  await cerrarConexion();
});

const CUENTA = {
  banco: 'Banco de Prueba',
  tipo_cuenta: 'ahorros',
  numero_cuenta: '12345678901234567890',
  titular: 'Titular de Prueba',
  documento_titular: '987654321',
};

describe('cifrado bancario - AES-256-GCM', () => {
  test('cifra con IV aleatorio y descifra con el campo correcto', () => {
    const primero = cifrarDatoBancario('1234567890', 'numero_cuenta');
    const segundo = cifrarDatoBancario('1234567890', 'numero_cuenta');

    assert.match(primero, /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    assert.notEqual(primero, segundo, 'cada cifrado debe usar un IV nuevo');
    assert.equal(
      descifrarDatoBancario(primero, 'numero_cuenta'),
      '1234567890',
    );
    assert.equal(
      descifrarDatoBancario(segundo, 'numero_cuenta'),
      '1234567890',
    );
  });

  test('el AAD ata el cifrado a su campo y no lo deja reutilizar', () => {
    const cifrado = cifrarDatoBancario('1234567890', 'numero_cuenta');

    assert.throws(
      () => descifrarDatoBancario(cifrado, 'documento_titular'),
      /No se pudo descifrar/,
    );
  });

  test('rechaza formatos invalidos y enmascara solo los ultimos cuatro', () => {
    assert.throws(
      () => descifrarDatoBancario('texto-en-claro', 'numero_cuenta'),
      /formato invalido/,
    );
    assert.equal(enmascararDatoBancario('12345678901234567890'), '****7890');
    assert.equal(enmascararDatoBancario('1234'), '****');
    assert.equal(enmascararDatoBancario(''), null);

    assert.equal(
      cuentaBancariaCompleta({
        banco: CUENTA.banco,
        tipoCuentaBancaria: CUENTA.tipo_cuenta,
        numeroCuentaCifrado: 'v1.a.b.c',
        titularCuenta: CUENTA.titular,
        documentoTitularCifrado: 'v1.d.e.f',
      }),
      true,
    );
    assert.equal(
      cuentaBancariaCompleta({ banco: CUENTA.banco }),
      false,
    );
  });
});

describe('cuenta bancaria por HTTP', () => {
  test(
    'el vendedor guarda y lee solo datos enmascarados; la base no guarda texto en claro',
    CON_BASE,
    async () => {
      const vendedor = await crearUsuarioConSesion({ roles: ['vendedor'] });
      const { local } = await crearCatalogoParaVendedor({
        vendedorId: vendedor.id,
      });

      const vacia = await vendedor.cliente.get(
        `/api/v1/vendedor/locales/${local.id}/cuenta-bancaria`,
      );
      assert.equal(vacia.status, 200, JSON.stringify(vacia.body));
      assert.equal(vacia.body.completa, false);
      assert.equal(vacia.body.numero_cuenta_enmascarado, null);

      const guardada = await vendedor.cliente.put(
        `/api/v1/vendedor/locales/${local.id}/cuenta-bancaria`,
        CUENTA,
      );
      assert.equal(guardada.status, 200, JSON.stringify(guardada.body));
      assert.equal(guardada.body.local_id, local.id);
      assert.equal(guardada.body.banco, CUENTA.banco);
      assert.equal(guardada.body.tipo_cuenta, CUENTA.tipo_cuenta);
      assert.equal(guardada.body.titular, CUENTA.titular);
      assert.equal(guardada.body.numero_cuenta_enmascarado, '****7890');
      assert.equal(
        guardada.body.documento_titular_enmascarado,
        '****4321',
      );
      assert.equal(guardada.body.completa, true);

      for (const valor of [
        CUENTA.numero_cuenta,
        CUENTA.documento_titular,
        'v1.',
      ]) {
        assert.equal(
          JSON.stringify(guardada.body).includes(valor),
          false,
          `la respuesta no puede incluir ${valor}`,
        );
      }

      const leida = await vendedor.cliente.get(
        `/api/v1/vendedor/locales/${local.id}/cuenta-bancaria`,
      );
      assert.equal(leida.status, 200, JSON.stringify(leida.body));
      assert.deepEqual(leida.body, guardada.body);

      const columnas = await prisma.$queryRaw`
        SELECT column_name::text AS nombre
          FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'local'
         ORDER BY ordinal_position
      `;
      const nombres = columnas.map((columna) => columna.nombre);
      assert.ok(nombres.includes('numero_cuenta_cifrado'));
      assert.ok(nombres.includes('documento_titular_cifrado'));
      assert.equal(nombres.includes('numero_cuenta'), false);
      assert.equal(nombres.includes('documento_titular'), false);

      const filas = await prisma.$queryRaw`
        SELECT "banco", "tipo_cuenta_bancaria"::text AS "tipo",
               "numero_cuenta_cifrado", "titular_cuenta",
               "documento_titular_cifrado"
          FROM "local"
         WHERE "id" = ${local.id}
      `;
      assert.equal(filas.length, 1);
      const fila = filas[0];
      assert.match(fila.numero_cuenta_cifrado, /^v1\./);
      assert.match(fila.documento_titular_cifrado, /^v1\./);
      assert.notEqual(fila.numero_cuenta_cifrado, CUENTA.numero_cuenta);
      assert.notEqual(fila.documento_titular_cifrado, CUENTA.documento_titular);

      const textoDeLaFila = JSON.stringify(fila);
      assert.equal(textoDeLaFila.includes(CUENTA.numero_cuenta), false);
      assert.equal(textoDeLaFila.includes(CUENTA.documento_titular), false);

      // Volver a guardar cambia el cifrado aunque el dato sea identico.
      const otraVez = await vendedor.cliente.put(
        `/api/v1/vendedor/locales/${local.id}/cuenta-bancaria`,
        CUENTA,
      );
      assert.equal(otraVez.status, 200);
      const despues = await prisma.local.findUnique({
        where: { id: local.id },
        select: {
          numeroCuentaCifrado: true,
          documentoTitularCifrado: true,
        },
      });
      assert.notEqual(
        despues.numeroCuentaCifrado,
        fila.numero_cuenta_cifrado,
      );
      assert.notEqual(
        despues.documentoTitularCifrado,
        fila.documento_titular_cifrado,
      );
    },
  );

  test('otro vendedor no puede leer ni reemplazar la cuenta', CON_BASE, async () => {
    const vendedorA = await crearUsuarioConSesion({ roles: ['vendedor'] });
    const vendedorB = await crearUsuarioConSesion({ roles: ['vendedor'] });
    const { local } = await crearCatalogoParaVendedor({
      vendedorId: vendedorA.id,
    });

    const lectura = await vendedorB.cliente.get(
      `/api/v1/vendedor/locales/${local.id}/cuenta-bancaria`,
    );
    assert.equal(lectura.status, 404, JSON.stringify(lectura.body));

    const escritura = await vendedorB.cliente.put(
      `/api/v1/vendedor/locales/${local.id}/cuenta-bancaria`,
      CUENTA,
    );
    assert.equal(escritura.status, 404, JSON.stringify(escritura.body));

    const sinCuenta = await prisma.local.findUnique({
      where: { id: local.id },
      select: { banco: true, numeroCuentaCifrado: true },
    });
    assert.equal(sinCuenta.banco, null);
    assert.equal(sinCuenta.numeroCuentaCifrado, null);
  });

  test('un comprador no puede usar las rutas de la cuenta bancaria', CON_BASE, async () => {
    const comprador = await crearUsuarioConSesion({ roles: ['comprador'] });
    const vendedor = await crearUsuarioDirecto({ roles: ['vendedor'] });
    const { local } = await crearCatalogoParaVendedor({
      vendedorId: vendedor.id,
    });

    const r = await comprador.cliente.get(
      `/api/v1/vendedor/locales/${local.id}/cuenta-bancaria`,
    );
    assert.equal(r.status, 403, JSON.stringify(r.body));
  });

  test('la validacion rechaza numeros y documentos no numericos', CON_BASE, async () => {
    const vendedor = await crearUsuarioConSesion({ roles: ['vendedor'] });
    const { local } = await crearCatalogoParaVendedor({
      vendedorId: vendedor.id,
    });

    const r = await vendedor.cliente.put(
      `/api/v1/vendedor/locales/${local.id}/cuenta-bancaria`,
      {
        ...CUENTA,
        numero_cuenta: '1234-5678',
        documento_titular: 'ABC12345',
      },
    );

    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.equal(r.body.error.codigo, 'validacion_invalida');
    assert.equal(
      await prisma.local.findUnique({
        where: { id: local.id },
        select: { numeroCuentaCifrado: true },
      }).then((fila) => fila.numeroCuentaCifrado),
      null,
    );
  });
});

describe('logs - los datos bancarios nunca se escriben en claro', () => {
  test('las rutas de redaccion ocultan numero, documento y sus cifrados', () => {
    let salida = '';
    const destino = {
      write(linea) {
        salida += linea;
      },
    };
    const registro = pino(
      {
        base: undefined,
        redact: {
          paths: RUTAS_REDACTADAS,
          censor: '[oculto]',
        },
      },
      destino,
    );

    const numero = '12345678901234567890';
    const documento = '987654321';
    const cifrado = cifrarDatoBancario(numero, 'numero_cuenta');
    const claveEnv = process.env.CUENTA_BANCARIA_ENCRYPTION_KEY;

    registro.info(
      {
        numero_cuenta: numero,
        documento_titular: documento,
        banco: 'Visible',
        CUENTA_BANCARIA_ENCRYPTION_KEY: claveEnv,
      },
      'cuenta guardada',
    );
    registro.info(
      {
        req: { body: { numero_cuenta: numero, documento_titular: documento } },
        cuenta: {
          numero_cuenta_cifrado: cifrado,
          documento_titular_cifrado: 'v1.cifrado.del.documento',
        },
      },
      'peticion',
    );

    assert.equal(salida.includes(numero), false);
    assert.equal(salida.includes(documento), false);
    assert.equal(salida.includes(cifrado), false);
    assert.equal(salida.includes(claveEnv), false);
    assert.equal(salida.includes('v1.cifrado.del.documento'), false);
    assert.equal(salida.includes('Visible'), true);
    assert.ok(salida.includes('[oculto]'));
  });

  test('el logger de la aplicacion usa exactamente esas rutas', () => {
    assert.ok(RUTAS_REDACTADAS.includes('numero_cuenta'));
    assert.ok(RUTAS_REDACTADAS.includes('documento_titular'));
    assert.ok(RUTAS_REDACTADAS.includes('*.numero_cuenta_cifrado'));
    assert.ok(RUTAS_REDACTADAS.includes('*.documento_titular_cifrado'));
    assert.ok(RUTAS_REDACTADAS.includes('CUENTA_BANCARIA_ENCRYPTION_KEY'));
  });
});
