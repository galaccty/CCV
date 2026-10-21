import request from 'supertest';
import { crearApp } from '../../src/app.js';
import { prisma } from './base.js';

const app = crearApp();

/**
 * Cliente de pruebas que ya sabe lo del token anti-CSRF.
 *
 * El backend lo pide en toda peticion que modifica datos (seccion 7).
 * Aqui se resuelve solo: se pide una cookie GET y se manda de vuelta en la
 * cabecera X-CSRF-Token, que es exactamente lo que hara el frontend.
 */
export function cliente() {
  const agente = request.agent(app);

  return {
    app,
    agente,

    /** GET simple. */
    async get(ruta) {
      return agente.get(ruta);
    },

    /** POST con el token anti-CSRF si hace falta. */
    async post(ruta, cuerpo, cabeceras = {}) {
      return conCsrf(agente, 'post', ruta, cuerpo, cabeceras);
    },

    async patch(ruta, cuerpo) {
      return conCsrf(agente, 'patch', ruta, cuerpo);
    },

    async delete(ruta) {
      return conCsrf(agente, 'delete', ruta, undefined);
    },
  };
}

/** Reintenta sin CSRF a proposito, para probar que el backend lo rechaza. */
export async function postSinCsrf(ruta, cuerpo) {
  return request(app).post(ruta).send(cuerpo);
}

/** POST mandando un token CSRF equivocado. */
export async function postConCsrfInvalido(ruta, cuerpo) {
  return request(app)
    .post(ruta)
    .set('X-CSRF-Token', 'token-inventado-que-no-coincide')
    .send(cuerpo);
}

/**
 * Pide una ruta con una cookie de sesion fabricada a mano, para comprobar que
 * una firma invalida no da acceso. No usa el agente del cliente() justamente
 * porque hay que mandarle una cookie suelta.
 */
export async function conCookieFabricada(ruta, valorCookie) {
  return request(app).get(ruta).set('Cookie', `ccv_sesion=${valorCookie}`);
}

async function conCsrf(agente, metodo, ruta, cuerpo, cabeceras = {}) {
  const token = await obtenerTokenCsrf(agente);
  let peticion = agente[metodo](ruta).set('X-CSRF-Token', token);
  for (const [nombre, valor] of Object.entries(cabeceras)) {
    peticion = peticion.set(nombre, valor);
  }
  if (cuerpo !== undefined) peticion = peticion.send(cuerpo);
  return peticion;
}

/**
 * Pide el token anti-CSRF. Se usa /api/v1/csrf y no /api/v1/salud porque
 * salud devuelve 503 cuando la base de datos esta caida, y el token debe
 * estar disponible igual.
 */
async function obtenerTokenCsrf(agente) {
  const respuesta = await agente.get('/api/v1/csrf');
  const token = respuesta.body?.token;
  if (!token) throw new Error('El servidor no devolvio un token anti-CSRF');
  return token;
}

/** Registra un usuario, lo verifica y lo deja listo para iniciar sesion. */
export async function crearUsuarioVerificado(opciones = {}) {
  const {
    contrasena = 'PruebaSegura123',
    nombre = 'Usuario de prueba',
  } = opciones;

  // Si no pasan correo, generamos uno unico: si no, cada prueba que llame sin
  // argumento choca con la anterior.
  const email = opciones.email ?? `usuario.${Date.now()}.${Math.random().toString(36).slice(2, 8)}@ejemplo.com`;

  const cuerpo = {
    nombre,
    email,
    contrasena,
    roles: ['comprador'],
    acepto_terminos: true,
  };

  const registro = await cliente().post('/api/v1/auth/registro', cuerpo);
  if (registro.status !== 201) {
    throw new Error(`No se pudo registrar el usuario: ${JSON.stringify(registro.body)}`);
  }

  await marcarEmailVerificado(email);
  return { ...registro.body.usuario, contrasena };
}

/**
 * Registra un usuario con los roles indicados, verifica el correo e inicia
 * sesion con el mismo agente. Devuelve el agente listo para hacer peticiones
 * autenticadas (con su cookie de sesion y su token CSRF).
 *
 * Sirve para las pruebas de la Etapa 2, donde hacen falta comprador y vendedor.
 */
export async function crearUsuarioConSesion(opciones = {}) {
  const {
    contrasena = 'PruebaSegura123',
    nombre = 'Usuario de prueba',
    roles = ['comprador'],
  } = opciones;

  const email =
    opciones.email ??
    `usuario.${Date.now()}.${Math.random().toString(36).slice(2, 8)}@ejemplo.com`;

  const agente = cliente();
  const registro = await agente.post('/api/v1/auth/registro', {
    nombre,
    email,
    contrasena,
    roles,
    acepto_terminos: true,
  });

  if (registro.status !== 201) {
    throw new Error(
      `No se pudo registrar el usuario: ${JSON.stringify(registro.body)}`,
    );
  }

  await marcarEmailVerificado(email);

  const login = await agente.post('/api/v1/auth/login', { email, contrasena });
  if (login.status !== 200) {
    throw new Error(`No se pudo iniciar sesion: ${JSON.stringify(login.body)}`);
  }

  return {
    ...registro.body.usuario,
    contrasena,
    cliente: agente,
  };
}

/**
 * En las pruebas marcamos el correo como verificado directo en la base,
 * porque leer el enlace del correo de consola haria la prueba fragil.
 * El flujo real, con el enlace, se prueba en auth.test.js.
 */
export async function marcarEmailVerificado(email) {
  await prisma.usuario.updateMany({ where: { email }, data: { emailVerificado: true } });
}

export { app };