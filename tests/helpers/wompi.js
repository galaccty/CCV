import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import request from 'supertest';
import { app, crearUsuarioConSesion } from './http.js';
import { crearCatalogo } from './datos.js';
import { config } from '../../src/config/entorno.js';

/**
 * Utilidades compartidas de las pruebas de Wompi.
 * La firma se calcula igual que en el proveedor falso, asi que los eventos
 * que se mandan al webhook son criptograficamente validos.
 */

export const SECRETO_EVENTOS =
  config.WOMPI_EVENTS_KEY || 'test_events_falsa';

export function claveUnica(prefijo = 'webhook') {
  return `${prefijo}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function sha256(texto) {
  return crypto.createHash('sha256').update(texto, 'utf8').digest('hex');
}

export function crearEvento({
  id,
  reference,
  status = 'APPROVED',
  amountInCents,
  timestamp = Date.now(),
  checksum,
}) {
  const cuerpo = {
    event: 'transaction.updated',
    data: {
      transaction: {
        id,
        reference,
        status,
        amount_in_cents: Number(amountInCents),
        currency: 'COP',
      },
    },
    environment: 'test',
    signature: {
      properties: [
        'transaction.id',
        'transaction.status',
        'transaction.amount_in_cents',
      ],
      checksum: '',
    },
    timestamp,
  };

  if (checksum !== undefined) {
    cuerpo.signature.checksum = checksum;
    return cuerpo;
  }

  cuerpo.signature.checksum = sha256(
    `${id}${status}${amountInCents}${timestamp}${SECRETO_EVENTOS}`,
  );
  return cuerpo;
}

export async function enviarEvento(cuerpo, { conCabecera = false } = {}) {
  let peticion = request(app).post('/api/v1/pagos/webhook').send(cuerpo);
  if (conCabecera) {
    peticion = peticion.set('X-Event-Checksum', cuerpo.signature.checksum);
  }
  return peticion;
}

export async function crearPagoPendiente({
  cantidad = 3,
  stockInicial = 10,
  precio = 10000n,
} = {}) {
  const comprador = await crearUsuarioConSesion();
  const { variante, local } = await crearCatalogo({ precio, stockInicial });

  const checkout = await comprador.cliente.post(
    '/api/v1/pedidos',
    {
      direccion: {
        texto: 'Calle 1 # 2-3, Bogota',
        latitud: 4.65,
        longitud: -74.05,
      },
      metodo_pago: 'tarjeta',
      items: [{ variante_id: variante.id, cantidad }],
    },
    { 'Idempotency-Key': claveUnica('checkout') },
  );

  assert.equal(checkout.status, 201, JSON.stringify(checkout.body));

  const pagoResp = await comprador.cliente.post(
    `/api/v1/pedidos/${checkout.body.id}/pagos`,
    undefined,
    { 'Idempotency-Key': claveUnica('pago') },
  );

  assert.equal(pagoResp.status, 201, JSON.stringify(pagoResp.body));

  return {
    comprador,
    variante,
    local,
    pedido: checkout.body,
    pago: pagoResp.body.pago,
    montoEnCentavos: BigInt(pagoResp.body.checkout.monto_en_centavos),
  };
}
