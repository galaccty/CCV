import './helpers/entorno.js';
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  correoUnico,
  limpiarCorreos,
  ultimoCorreo,
  tokenDeCorreo,
  correosEnviados,
  CONTRASENA_VALIDA,
} from './helpers/entorno.js';
import { opcionesConBase, cerrarConexion, prisma } from './helpers/base.js';
import {
  cliente,
  postSinCsrf,
  postConCsrfInvalido,
  crearUsuarioVerificado,
  crearUsuarioConSesion,
  conCookieFabricada,
} from './helpers/http.js';

// awaited en el nivel del modulo: los callbacks de describe no son async,
// asi que adentro no se puede hacer await.
const CON_BASE = await opcionesConBase();

/**
 * Pruebas de la Etapa 1: registro, verificacion, inicio de sesion,
 * restablecimiento y las reglas de seguridad que las rodean.
 */

describe('registro', () => {
  test('crea la cuenta con la contrasena hasheada', CON_BASE, async () => {
    const email = correoUnico('registro');
    const r = await cliente().post('/api/v1/auth/registro', {
      nombre: 'Ana Prueba',
      email,
      contrasena: CONTRASENA_VALIDA,
      roles: ['comprador', 'vendedor'],
      acepto_terminos: true,
    });

    assert.equal(r.status, 201);
    assert.equal(r.body.usuario.email, email);
    assert.deepEqual(r.body.usuario.roles, ['comprador', 'vendedor']);
    assert.equal(r.body.usuario.email_verificado, false);

    const fila = await prisma.usuario.findUnique({ where: { email } });
    assert.ok(fila);
    assert.notEqual(fila.passwordHash, CONTRASENA_VALIDA, 'la contrasena jamas se guarda en texto plano');
    assert.match(fila.passwordHash, /^\$2[aby]\$/, 'debe ser un hash de bcrypt');
    assert.equal(fila.aceptoTerminos, true);
    assert.ok(fila.fechaAceptacion);
  });

  test('la respuesta nunca incluye el hash de la contrasena', CON_BASE, async () => {
    const email = correoUnico('sinoffilter');
    const r = await cliente().post('/api/v1/auth/registro', {
      nombre: 'Sin Filtro',
      email,
      contrasena: CONTRASENA_VALIDA,
      acepto_terminos: true,
    });

    const texto = JSON.stringify(r.body);
    assert.equal(texto.includes('password'), false, 'la respuesta no debe mencionar password');
    assert.equal(texto.includes('$2a$'), false, 'la respuesta no debe incluir el hash');
  });

  test('rechaza un correo que ya existe', CON_BASE, async () => {
    const email = correoUnico('duplicado');
    const cuerpo = {
      nombre: 'Primera',
      email,
      contrasena: CONTRASENA_VALIDA,
      acepto_terminos: true,
    };
    await cliente().post('/api/v1/auth/registro', cuerpo);
    const r = await cliente().post('/api/v1/auth/registro', { ...cuerpo, nombre: 'Segunda' });

    assert.equal(r.status, 409);
    assert.equal(r.body.error.codigo, 'conflicto');
  });

  test('rechaza una contrasena debil', CON_BASE, async () => {
    const r = await cliente().post('/api/v1/auth/registro', {
      nombre: 'Contrasena Mala',
      email: correoUnico('debil'),
      contrasena: 'corta',
      acepto_terminos: true,
    });

    assert.equal(r.status, 400);
    assert.equal(r.body.error.codigo, 'validacion_invalida');
    assert.ok(r.body.error.detalles.requisitos.length > 0);
  });

  test('exige aceptar los terminos', CON_BASE, async () => {
    const r = await cliente().post('/api/v1/auth/registro', {
      nombre: 'Sin Aceptar',
      email: correoUnico('sinaceptar'),
      contrasena: CONTRASENA_VALIDA,
      acepto_terminos: false,
    });

    assert.equal(r.status, 400);
    assert.equal(r.body.error.codigo, 'validacion_invalida');
  });

  test('no deja registrar el rol admin por la via publica', CON_BASE, async () => {
    const email = correoUnico('falsoadmin');
    const r = await cliente().post('/api/v1/auth/registro', {
      nombre: 'Falso Admin',
      email,
      contrasena: CONTRASENA_VALIDA,
      roles: ['admin'],
      acepto_terminos: true,
    });

    // El esquema de validacion no acepta 'admin' como rol de registro, asi
    // que la peticion se rechaza. Lo que importa es que nadie quede con ese
    // rol, ni siquiera si en el futuro el esquema se relaja.
    assert.equal(r.status, 400, 'registrarse como admin debe rechazarse');

    const fila = await prisma.usuario.findUnique({
      where: { email },
      include: { roles: true },
    });

    assert.ok(
      fila === null || !fila.roles.some((x) => x.rol === 'admin'),
      'nadie puede auto-asignarse admin',
    );
  });

  test('envia el correo de verificacion', CON_BASE, async () => {
    limpiarCorreos();
    const email = correoUnico('correo');
    await cliente().post('/api/v1/auth/registro', {
      nombre: 'Correo Si',
      email,
      contrasena: CONTRASENA_VALIDA,
      acepto_terminos: true,
    });

    const enviado = ultimoCorreo('Verifica tu correo');
    assert.ok(enviado, 'debe enviarse el correo de verificacion');
    assert.equal(enviado.para, email);
    assert.ok(enviado.texto.includes('token='), 'el enlace debe traer el token');
  });
});

describe('verificacion de correo', () => {
  test('el token del enlace deja el correo verificado', CON_BASE, async () => {
    limpiarCorreos();
    const email = correoUnico('verificar');
    await cliente().post('/api/v1/auth/registro', {
      nombre: 'Verifico',
      email,
      contrasena: CONTRASENA_VALIDA,
      acepto_terminos: true,
    });

    const token = tokenDeCorreo(ultimoCorreo('Verifica tu correo'));
    assert.ok(token, 'el correo debe traer un token');

    const r = await cliente().post('/api/v1/auth/verificar-email', { token });
    assert.equal(r.status, 200);
    assert.equal(r.body.verificado, true);

    const fila = await prisma.usuario.findUnique({ where: { email } });
    assert.equal(fila.emailVerificado, true);
  });

  test('un token invalido no verifica nada', CON_BASE, async () => {
    const r = await cliente().post('/api/v1/auth/verificar-email', {
      token: 'esto-no-es-un-token-valido',
    });

    assert.equal(r.status, 400);
    assert.equal(r.body.error.codigo, 'validacion_invalida');
  });

  test('el token de verificacion no se puede reutilizar', CON_BASE, async () => {
    limpiarCorreos();
    const email = correoUnico('reutilizar');
    await cliente().post('/api/v1/auth/registro', {
      nombre: 'Reutilizo',
      email,
      contrasena: CONTRASENA_VALIDA,
      acepto_terminos: true,
    });

    const token = tokenDeCorreo(ultimoCorreo('Verifica tu correo'));

    const primero = await cliente().post('/api/v1/auth/verificar-email', { token });
    assert.equal(primero.status, 200);

    const segundo = await cliente().post('/api/v1/auth/verificar-email', { token });
    assert.equal(segundo.status, 400, 'un token usado no debe volver a servir');
  });
});

describe('inicio de sesion', () => {
  test('deja la cookie httpOnly y devuelve el usuario', CON_BASE, async () => {
    const usuario = await crearUsuarioVerificado();

    const r = await cliente().post('/api/v1/auth/login', {
      email: usuario.email,
      contrasena: usuario.contrasena,
    });

    assert.equal(r.status, 200);

    const cookies = r.headers['set-cookie'] ?? [];
    const sesion = cookies.find((c) => c.startsWith('ccv_sesion='));
    assert.ok(sesion, 'debe enviar la cookie de sesion');
    assert.match(sesion, /HttpOnly/i, 'la cookie de sesion debe ser httpOnly');
    assert.match(sesion, /SameSite=Lax/i);
    assert.equal(r.body.usuario.email, usuario.email);
  });

  test('la cookie del CSRF si es legible por el JavaScript', CON_BASE, async () => {
    const r = await cliente().get('/api/v1/csrf');

    assert.equal(r.status, 200);
    assert.ok(r.body.token, 'GET /api/v1/csrf debe devolver el token');

    const cookie = (r.headers['set-cookie'] ?? []).find((x) => x.startsWith('ccv_csrf='));
    assert.ok(cookie, 'debe enviar la cookie anti-CSRF');
    assert.equal(
      /HttpOnly/i.test(cookie),
      false,
      'la cookie anti-CSRF NO debe ser httpOnly: el frontend tiene que leerla',
    );
  });

  test('la cookie de sesion SI es httpOnly', CON_BASE, async () => {
    const usuario = await crearUsuarioVerificado();
    const r = await cliente().post('/api/v1/auth/login', {
      email: usuario.email,
      contrasena: usuario.contrasena,
    });

    const cookie = (r.headers['set-cookie'] ?? []).find((x) => x.startsWith('ccv_sesion='));
    assert.ok(cookie);
    assert.match(
      cookie,
      /HttpOnly/i,
      'la cookie de sesion debe ser httpOnly para que el JavaScript no la lea',
    );
  });

  test('contrasena incorrecta da 401 con el codigo esperado', CON_BASE, async () => {
    const usuario = await crearUsuarioVerificado();

    const r = await cliente().post('/api/v1/auth/login', {
      email: usuario.email,
      contrasena: 'ContrasenaEquivocada9',
    });

    assert.equal(r.status, 401);
    assert.equal(r.body.error.codigo, 'credenciales_invalidas');
  });

  test('no deja entrar sin verificar el correo', CON_BASE, async () => {
    limpiarCorreos();
    const email = correoUnico('sinverificar');
    await cliente().post('/api/v1/auth/registro', {
      nombre: 'Sin Verificar',
      email,
      contrasena: CONTRASENA_VALIDA,
      acepto_terminos: true,
    });

    const r = await cliente().post('/api/v1/auth/login', {
      email,
      contrasena: CONTRASENA_VALIDA,
    });

    assert.equal(r.status, 401);
    assert.match(r.body.error.mensaje, /verificar tu correo/i);
  });

  test('el mismo mensaje existe o no el usuario (no revela correos)', CON_BASE, async () => {
    const existente = await crearUsuarioVerificado();

    const r1 = await cliente().post('/api/v1/auth/login', {
      email: existente.email,
      contrasena: 'ContrasenaEquivocada9',
    });
    const r2 = await cliente().post('/api/v1/auth/login', {
      email: correoUnico('noexiste'),
      contrasena: 'ContrasenaEquivocada9',
    });

    assert.equal(r1.status, r2.status);
    assert.equal(r1.body.error.codigo, r2.body.error.codigo);
    assert.equal(r1.body.error.mensaje, r2.body.error.mensaje);
  });
});

describe('sesion', () => {
  test('/yo devuelve el usuario conectado', CON_BASE, async () => {
    const usuario = await crearUsuarioVerificado();
    const c = cliente();

    await c.post('/api/v1/auth/login', { email: usuario.email, contrasena: usuario.contrasena });
    const r = await c.get('/api/v1/auth/yo');

    assert.equal(r.status, 200);
    assert.equal(r.body.usuario.email, usuario.email);
    assert.ok(Array.isArray(r.body.usuario.roles));
  });

  test('/yo sin sesion da 401', CON_BASE, async () => {
    const r = await cliente().get('/api/v1/auth/yo');
    assert.equal(r.status, 401);
    assert.equal(r.body.error.codigo, 'no_autenticado');
  });

  test('logout limpia la cookie', CON_BASE, async () => {
    const usuario = await crearUsuarioVerificado();
    const c = cliente();
    await c.post('/api/v1/auth/login', { email: usuario.email, contrasena: usuario.contrasena });

    const r = await c.post('/api/v1/auth/logout');
    assert.equal(r.status, 200);

    const despues = await c.get('/api/v1/auth/yo');
    assert.equal(despues.status, 401);
  });

  test('una cookie manipulada no da acceso', CON_BASE, async () => {
    const usuario = await crearUsuarioVerificado();

    // Cuerpo y firma inventados: el servidor tiene que rechazar la cookie
    // aunque el contenido parezca un id de usuario valido.
    const r = await conCookieFabricada(
      '/api/v1/auth/yo',
      `v1.${Buffer.from(JSON.stringify({ u: usuario.id, exp: Date.now() + 60000 })).toString('base64url')}.aaabbbbccccdddd`,
    );

    assert.equal(r.status, 401, 'una cookie firmada con cualquier cosa no sirve');
  });
});

describe('restablecimiento de contrasena', () => {
  test('pide el enlace y cambia la contrasena', CON_BASE, async () => {
    limpiarCorreos();
    const usuario = await crearUsuarioVerificado();

    const pedir = await cliente().post('/api/v1/auth/solicitar-restablecimiento', {
      email: usuario.email,
    });
    assert.equal(pedir.status, 200);

    const correoEnviado = ultimoCorreo('Restablece tu contrasena');
    assert.ok(correoEnviado);
    const token = tokenDeCorreo(correoEnviado);

    const nueva = 'NuevaContrasena456';
    const cambiar = await cliente().post('/api/v1/auth/restablecer-contrasena', {
      token,
      contrasena: nueva,
    });
    assert.equal(cambiar.status, 200);

    const loginNuevo = await cliente().post('/api/v1/auth/login', {
      email: usuario.email,
      contrasena: nueva,
    });
    assert.equal(loginNuevo.status, 200);

    const loginViejo = await cliente().post('/api/v1/auth/login', {
      email: usuario.email,
      contrasena: usuario.contrasena,
    });
    assert.equal(loginViejo.status, 401, 'la contrasena vieja debe dejar de servir');
  });

  test('responde igual exista o no la cuenta', CON_BASE, async () => {
    const r1 = await cliente().post('/api/v1/auth/solicitar-restablecimiento', {
      email: correoUnico('noexiste'),
    });
    const r2 = await cliente().post('/api/v1/auth/solicitar-restablecimiento', {
      email: 'tampoco@existe.com',
    });

    assert.equal(r1.status, r2.status);
    assert.equal(r1.body.mensaje, r2.body.mensaje);
  });

  test('el token de restablecimiento sirve una sola vez', CON_BASE, async () => {
    limpiarCorreos();
    const usuario = await crearUsuarioVerificado();
    await cliente().post('/api/v1/auth/solicitar-restablecimiento', { email: usuario.email });
    const token = tokenDeCorreo(ultimoCorreo('Restablece tu contrasena'));

    await cliente().post('/api/v1/auth/restablecer-contrasena', {
      token,
      contrasena: 'PrimeraNueva123',
    });
    const segundo = await cliente().post('/api/v1/auth/restablecer-contrasena', {
      token,
      contrasena: 'SegundaNueva123',
    });

    assert.equal(segundo.status, 400, 'un token usado no debe volver a servir');
  });

  test('no acepta una contrasena debil al restablecer', CON_BASE, async () => {
    limpiarCorreos();
    const usuario = await crearUsuarioVerificado();
    await cliente().post('/api/v1/auth/solicitar-restablecimiento', { email: usuario.email });
    const token = tokenDeCorreo(ultimoCorreo('Restablece tu contrasena'));

    const r = await cliente().post('/api/v1/auth/restablecer-contrasena', {
      token,
      contrasena: 'corta',
    });

    assert.equal(r.status, 400);
    assert.equal(r.body.error.codigo, 'validacion_invalida');
  });
});

describe('cuenta del comprador', () => {
  test('edita el nombre y el teléfono de la cuenta', CON_BASE, async () => {
    const usuario = await crearUsuarioConSesion();

    const r = await usuario.cliente.patch('/api/v1/auth/perfil', {
      nombre: 'Ana Actualizada',
      telefono: '+573001234567',
    });

    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.usuario.nombre, 'Ana Actualizada');
    assert.equal(r.body.usuario.telefono, '+573001234567');

    const yo = await usuario.cliente.get('/api/v1/auth/yo');
    assert.equal(yo.status, 200);
    assert.equal(yo.body.usuario.nombre, 'Ana Actualizada');
    assert.equal(yo.body.usuario.telefono, '+573001234567');

    const fila = await prisma.usuario.findUnique({ where: { id: usuario.id } });
    assert.equal(fila.nombre, 'Ana Actualizada');
    assert.equal(fila.telefono, '+573001234567');
  });

  test('permite borrar el teléfono con null', CON_BASE, async () => {
    const usuario = await crearUsuarioConSesion();
    await usuario.cliente.patch('/api/v1/auth/perfil', {
      telefono: '+573001234567',
    });

    const r = await usuario.cliente.patch('/api/v1/auth/perfil', {
      telefono: null,
    });

    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.usuario.telefono, null);
  });

  test('rechaza un teléfono con formato inválido', CON_BASE, async () => {
    const usuario = await crearUsuarioConSesion();

    for (const telefono of ['123', '300 123 4567', 'abc1234567']) {
      const r = await usuario.cliente.patch('/api/v1/auth/perfil', { telefono });
      assert.equal(r.status, 400, telefono);
      assert.equal(r.body.error.codigo, 'validacion_invalida');
    }
  });

  test('rechaza un perfil vacío y exige sesión', CON_BASE, async () => {
    const sinSesion = await cliente().patch('/api/v1/auth/perfil', {
      nombre: 'Sin Sesion',
    });
    assert.equal(sinSesion.status, 401);

    const usuario = await crearUsuarioConSesion();
    const vacio = await usuario.cliente.patch('/api/v1/auth/perfil', {});
    assert.equal(vacio.status, 400);
    assert.equal(vacio.body.error.codigo, 'validacion_invalida');
  });

  test('cambia la contraseña pidiendo la actual', CON_BASE, async () => {
    const usuario = await crearUsuarioConSesion();
    const nueva = 'NuevaContrasena456';

    const cambio = await usuario.cliente.post('/api/v1/auth/cambiar-contrasena', {
      contrasena_actual: usuario.contrasena,
      contrasena_nueva: nueva,
    });
    assert.equal(cambio.status, 200, JSON.stringify(cambio.body));
    assert.equal(cambio.body.actualizada, true);

    const loginViejo = await cliente().post('/api/v1/auth/login', {
      email: usuario.email,
      contrasena: usuario.contrasena,
    });
    assert.equal(loginViejo.status, 401, 'la contraseña anterior deja de servir');

    const loginNuevo = await cliente().post('/api/v1/auth/login', {
      email: usuario.email,
      contrasena: nueva,
    });
    assert.equal(loginNuevo.status, 200, 'la contraseña nueva sí sirve');
  });

  test('no cambia la contraseña si la actual no coincide', CON_BASE, async () => {
    const usuario = await crearUsuarioConSesion();

    const r = await usuario.cliente.post('/api/v1/auth/cambiar-contrasena', {
      contrasena_actual: 'ContrasenaEquivocada9',
      contrasena_nueva: 'NuevaContrasena456',
    });

    assert.equal(r.status, 401);
    assert.equal(r.body.error.codigo, 'credenciales_invalidas');

    const login = await cliente().post('/api/v1/auth/login', {
      email: usuario.email,
      contrasena: usuario.contrasena,
    });
    assert.equal(login.status, 200, 'la contraseña original sigue sirviendo');
  });

  test('rechaza una contraseña nueva débil o sin sesión', CON_BASE, async () => {
    const sinSesion = await cliente().post('/api/v1/auth/cambiar-contrasena', {
      contrasena_actual: 'lo-que-sea',
      contrasena_nueva: 'NuevaContrasena456',
    });
    assert.equal(sinSesion.status, 401);

    const usuario = await crearUsuarioConSesion();
    const debil = await usuario.cliente.post('/api/v1/auth/cambiar-contrasena', {
      contrasena_actual: usuario.contrasena,
      contrasena_nueva: 'corta',
    });
    assert.equal(debil.status, 400);
    assert.equal(debil.body.error.codigo, 'validacion_invalida');
  });

  test('reenvía la verificación e invalida el enlace anterior', CON_BASE, async () => {
    limpiarCorreos();
    const email = correoUnico('reenvio');
    await cliente().post('/api/v1/auth/registro', {
      nombre: 'Reenvio',
      email,
      contrasena: CONTRASENA_VALIDA,
      acepto_terminos: true,
    });

    const tokenViejo = tokenDeCorreo(ultimoCorreo('Verifica tu correo'));
    assert.ok(tokenViejo);

    limpiarCorreos();
    const r = await cliente().post('/api/v1/auth/reenviar-verificacion', { email });

    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.enviado, true);
    const reenviado = ultimoCorreo('Verifica tu correo');
    assert.ok(reenviado, 'debe enviarse un correo nuevo');
    assert.equal(reenviado.para, email);

    const tokenNuevo = tokenDeCorreo(reenviado);
    assert.notEqual(tokenNuevo, tokenViejo);

    const viejo = await cliente().post('/api/v1/auth/verificar-email', {
      token: tokenViejo,
    });
    assert.equal(viejo.status, 400, 'el enlace anterior deja de servir');

    const nuevo = await cliente().post('/api/v1/auth/verificar-email', {
      token: tokenNuevo,
    });
    assert.equal(nuevo.status, 200);
    assert.equal(nuevo.body.verificado, true);
  });

  test('no revela si la cuenta existe o ya estaba verificada', CON_BASE, async () => {
    const usuario = await crearUsuarioVerificado();
    limpiarCorreos();

    const verificado = await cliente().post('/api/v1/auth/reenviar-verificacion', {
      email: usuario.email,
    });
    const noExiste = await cliente().post('/api/v1/auth/reenviar-verificacion', {
      email: correoUnico('noexiste'),
    });

    assert.equal(verificado.status, 200);
    assert.equal(noExiste.status, 200);
    assert.equal(verificado.body.mensaje, noExiste.body.mensaje);
    assert.equal(verificado.body.enviado, true);
    assert.equal(noExiste.body.enviado, true);
    assert.equal(correosEnviados.length, 0, 'no se envía correo si ya está verificada');
  });

  test('el reenvío valida el correo', CON_BASE, async () => {
    const r = await cliente().post('/api/v1/auth/reenviar-verificacion', {
      email: 'no-es-un-correo',
    });

    assert.equal(r.status, 400);
    assert.equal(r.body.error.codigo, 'validacion_invalida');
  });
});

after(async () => {
  await cerrarConexion();
});