import { PrismaClient } from '../../generated/prisma/index.js';
import { config } from '../config/entorno.js';
import { logger } from './logger.js';

// Una sola instancia del cliente en toda la aplicacion.
// En desarrollo se guarda en globalThis para no abrir un pool nuevo cada vez
// que el servidor reinicia con recarga automatica.
const globalPrisma = globalThis;

function crearCliente() {
  // Prisma con su propio log: se deja vacio porque los errores ya se
  // registran con nuestro formato estructurado mas abajo. Si se activan los
  // dos, cada error sale dos veces.
  const cliente = new PrismaClient({ log: [] });
  cliente.$on('error', (e) => logger.warn({ err: e }, 'error de prisma'));
  return cliente;
}

export const prisma = globalPrisma.__ccvPrisma ?? crearCliente();

if (!config.esProduccion) {
  globalPrisma.__ccvPrisma = prisma;
}

export default prisma;