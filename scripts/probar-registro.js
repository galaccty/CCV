/**
 * PROBAR EL REGISTRO DESDE LA TERMINAL
 * ====================================
 * Hace el flujo completo sin pelearte con curl y con el token CSRF:
 * pide el token, se registra un usuario y te imprime el enlace de
 * verificación que saldría por correo.
 *
 *   node scripts/probar-registro.js
 *
 * El servidor tiene que estar corriendo en otra terminal (npm run dev).
 */

import { randomBytes } from 'node:crypto';

const BASE = process.env.BASE_URL ?? 'http://localhost:3000';

const sello = randomBytes(4).toString('hex');
const cuerpoRegistro = {
  nombre: 'Ana Prueba',
  email: `ana.${sello}@ejemplo.com`,
  contrasena: 'MiContrasena123',
  roles: ['comprador', 'vendedor'],
  acepto_terminos: true,
};

function mostrar(titulo, valor) {
  console.log(`\n${titulo}\n${'-'.repeat(titulo.length)}\n${valor}\n`);
}

try {
  // 1. Token anti-CSRF. La respuesta tambien deja la cookie en tu "navegador"
  //    simulado, que guardamos a mano para mandarla en cada peticion.
  const csrf = await fetch(`${BASE}/api/v1/csrf`);
  const { token } = await csrf.json();
  const cookie = (csrf.headers.getSetCookie?.() ?? [])
    .map((c) => c.split(';')[0])
    .join('; ');

  if (!token) throw new Error('el servidor no devolvio un token CSRF');

  // 2. Registro
  const registro = await fetch(`${BASE}/api/v1/auth/registro`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-Token': token,
      Cookie: cookie,
    },
    body: JSON.stringify(cuerpoRegistro),
  });

  const cuerpo = await registro.json();

  mostrar('CUERPO ENVIADO', JSON.stringify(cuerpoRegistro, null, 2));
  mostrar('RESPUESTA', `HTTP ${registro.status}\n${JSON.stringify(cuerpo, null, 2)}`);

  if (registro.status !== 201) {
    console.error('\nEl registro fallo. Mira el codigo de error de arriba.\n');
    process.exit(1);
  }

  console.log('El correo de verificacion salio por consola, en la terminal del');
  console.log('servidor (la otra terminal, donde corre npm run dev). Copialo,');
  console.log('abre el enlace y despues podes iniciar sesion.\n');
} catch (err) {
  console.error(`\nNo se pudo conectar con ${BASE}: ${err.message}`);
  console.error('Revisa que el servidor este corriendo con: npm run dev\n');
  process.exit(1);
}