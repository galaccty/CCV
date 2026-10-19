/**
 * CREAR EL PRIMER ADMINISTRADOR
 * ============================
 * No existe registro publico de administradores: quien sea admin tiene que
 * existir ya en la base de datos. Este script lo crea usando ADMIN_EMAIL y
 * ADMIN_PASSWORD del .env.
 *
 *   npm run crear-admin
 *
 * Se puede volver a ejecutar: si el correo ya existe, actualiza la contrasena
 * y le agrega el rol admin sin borrar nada.
 */

import 'dotenv/config';
import { prisma } from '../src/lib/prisma.js';
import { logger } from '../src/lib/logger.js';
import { hashearContrasena, cumplePoliticaContrasena } from '../src/lib/crypto.js';

const email = String(process.env.ADMIN_EMAIL ?? '').trim().toLowerCase();
const contrasena = process.env.ADMIN_PASSWORD ?? '';

function validar() {
  const problemas = [];

  if (!email) problemas.push('falta ADMIN_EMAIL en el .env');
  else if (!/^\S+@\S+\.\S+$/.test(email)) problemas.push('ADMIN_EMAIL no tiene formato de correo');

  if (!contrasena) problemas.push('falta ADMIN_PASSWORD en el .env');
  else {
    const problemasContrasena = cumplePoliticaContrasena(contrasena);
    if (problemasContrasena.length > 0) {
      problemas.push(`ADMIN_PASSWORD es debil: ${problemasContrasena.join(', ')}`);
    }
  }
  return problemas;
}

const problemas = validar();
if (problemas.length > 0) {
  console.error('\nNo se puede crear el administrador:\n');
  for (const p of problemas) console.error(`  - ${p}`);
  console.error('\nEdita tu .env y vuelve a intentarlo.\n');
  process.exit(1);
}

try {
  const passwordHash = await hashearContrasena(contrasena);

  // 1. Crear o actualizar el usuario (sin tocar los roles todavia).
  const usuario = await prisma.usuario.upsert({
    where: { email },
    create: {
      nombre: 'Administrador',
      email,
      passwordHash,
      // Un admin creado desde la consola es responsable de su propio correo.
      emailVerificado: true,
      aceptoTerminos: true,
      fechaAceptacion: new Date(),
    },
    update: {
      passwordHash,
      emailVerificado: true,
      activo: true,
    },
  });

  // 2. Asegurar el rol admin. La clave primaria es (usuario_id, rol),
  //    asi que crearMany con skipDuplicates no vuelve a insertarlo.
  await prisma.usuarioRol.createMany({
    data: [{ usuarioId: usuario.id, rol: 'admin' }],
    skipDuplicates: true,
  });

  const roles = await prisma.usuarioRol.findMany({
    where: { usuarioId: usuario.id },
    select: { rol: true },
  });

  await prisma.auditoriaAdmin.create({
    data: {
      origen: 'admin',
      adminId: usuario.id,
      accion: 'administrador_creado_por_consola',
      objeto: 'usuario',
      objetoId: String(usuario.id),
      detalle: { email },
    },
  });

  logger.info({ usuarioId: usuario.id, email: usuario.email }, 'administrador creado');

  console.log('\nAdministrador listo:\n');
  console.log(`  correo:  ${usuario.email}`);
  console.log(`  roles:   ${roles.map((r) => r.rol).join(', ')}`);
  console.log('\nYa puede iniciar sesion con POST /api/v1/auth/login.\n');
} catch (err) {
  console.error('\nNo se pudo crear el administrador.');
  console.error('Revisa que DATABASE_URL sea correcta y que las migraciones esten aplicadas.');
  console.error(err.message);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}