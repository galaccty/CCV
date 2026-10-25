import { prisma } from '../lib/prisma.js';
import { errorNoEncontrado } from '../lib/errores.js';
import {
  cifrarDatoBancario,
  cuentaBancariaCompleta,
  descifrarDatoBancario,
  enmascararDatoBancario,
} from '../lib/cifradoBancario.js';

/**
 * CUENTA BANCARIA DEL LOCAL (Etapa 4e)
 * ====================================
 * El vendedor registra los datos una vez. El numero y el documento se cifran
 * aca, en el borde de la aplicacion, y jamas se devuelven en claro por estas
 * rutas. El snapshot de la liquidacion copia el cifrado tal cual.
 */

export function serializarCuentaBancariaVendedor(local) {
  const numero = local.numeroCuentaCifrado
    ? descifrarDatoBancario(local.numeroCuentaCifrado, 'numero_cuenta')
    : null;
  const documento = local.documentoTitularCifrado
    ? descifrarDatoBancario(
        local.documentoTitularCifrado,
        'documento_titular',
      )
    : null;

  return {
    local_id: local.id,
    banco: local.banco,
    tipo_cuenta: local.tipoCuentaBancaria,
    numero_cuenta_enmascarado: enmascararDatoBancario(numero),
    titular: local.titularCuenta,
    documento_titular_enmascarado: enmascararDatoBancario(documento),
    completa: cuentaBancariaCompleta(local),
    actualizado_en: local.actualizadoEn,
  };
}

export async function obtenerCuentaBancariaVendedor({ usuario, localId }) {
  const local = await prisma.local.findFirst({
    where: { id: localId, usuarioId: usuario.id },
  });

  if (!local) throw errorNoEncontrado('Local no encontrado.');
  return serializarCuentaBancariaVendedor(local);
}

export async function guardarCuentaBancariaVendedor({
  usuario,
  localId,
  datos,
}) {
  const local = await prisma.local.findFirst({
    where: { id: localId, usuarioId: usuario.id },
    select: { id: true },
  });

  if (!local) throw errorNoEncontrado('Local no encontrado.');

  const numeroCuentaCifrado = cifrarDatoBancario(
    datos.numero_cuenta,
    'numero_cuenta',
  );
  const documentoTitularCifrado = cifrarDatoBancario(
    datos.documento_titular,
    'documento_titular',
  );

  const actualizado = await prisma.local.update({
    where: { id: local.id },
    data: {
      banco: datos.banco,
      tipoCuentaBancaria: datos.tipo_cuenta,
      numeroCuentaCifrado,
      titularCuenta: datos.titular,
      documentoTitularCifrado,
    },
    select: {
      id: true,
      banco: true,
      tipoCuentaBancaria: true,
      numeroCuentaCifrado: true,
      titularCuenta: true,
      documentoTitularCifrado: true,
      actualizadoEn: true,
    },
  });

  return serializarCuentaBancariaVendedor(actualizado);
}

export function copiarCifradoBancario(local) {
  if (!cuentaBancariaCompleta(local)) return null;

  return {
    bancoDestino: local.banco,
    tipoCuentaDestino: local.tipoCuentaBancaria,
    numeroCuentaDestinoCifrado: local.numeroCuentaCifrado,
    titularDestino: local.titularCuenta,
    documentoTitularDestinoCifrado: local.documentoTitularCifrado,
  };
}

/** Datos completos, solo para el detalle de admin. */
export function serializarCuentaDestinoCompleta(datos) {
  if (!datos) return null;

  const numero = datos.numeroCuentaCifrado
    ? descifrarDatoBancario(datos.numeroCuentaCifrado, 'numero_cuenta')
    : null;
  const documento = datos.documentoTitularCifrado
    ? descifrarDatoBancario(
        datos.documentoTitularCifrado,
        'documento_titular',
      )
    : null;

  return {
    banco: datos.banco,
    tipo_cuenta: datos.tipoCuenta,
    numero_cuenta: numero,
    numero_cuenta_enmascarado: enmascararDatoBancario(numero),
    titular: datos.titular,
    documento_titular: documento,
    documento_titular_enmascarado: enmascararDatoBancario(documento),
  };
}

/** Datos enmascarados para vendedor y listas. */
export function serializarCuentaDestinoEnmascarada(datos) {
  if (!datos) return null;

  const numero = datos.numeroCuentaCifrado
    ? descifrarDatoBancario(datos.numeroCuentaCifrado, 'numero_cuenta')
    : null;
  const documento = datos.documentoTitularCifrado
    ? descifrarDatoBancario(
        datos.documentoTitularCifrado,
        'documento_titular',
      )
    : null;

  return {
    banco: datos.banco,
    tipo_cuenta: datos.tipoCuenta,
    numero_cuenta_enmascarado: enmascararDatoBancario(numero),
    titular: datos.titular,
    documento_titular_enmascarado: enmascararDatoBancario(documento),
  };
}

export function datosBancariosDesdeLocal(local) {
  return {
    banco: local.banco,
    tipoCuenta: local.tipoCuentaBancaria,
    numeroCuentaCifrado: local.numeroCuentaCifrado,
    titular: local.titularCuenta,
    documentoTitularCifrado: local.documentoTitularCifrado,
  };
}

export function datosBancariosDesdeSnapshot(liquidacion) {
  return {
    banco: liquidacion.bancoDestino,
    tipoCuenta: liquidacion.tipoCuentaDestino,
    numeroCuentaCifrado: liquidacion.numeroCuentaDestinoCifrado,
    titular: liquidacion.titularDestino,
    documentoTitularCifrado:
      liquidacion.documentoTitularDestinoCifrado,
  };
}
