import { Router } from 'express';
import authRouter from './auth.js';
import { prisma } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';

/**
 * Todo lo de la version 1 vive bajo /api/v1.
 * Cuando una ruta cambie de forma, se crea /api/v2 y la v1 sigue igual.
 */
const router = Router();

/**
 * GET /api/v1/salud
 * Comprobacion de vida. Tambien dice si la base de datos responde,
 * que es lo primero que hay que mirar cuando algo falla.
 */
router.get('/salud', async (_req, res) => {
  let estadoBase = 'error';
  try {
    await prisma.$queryRaw`SELECT 1`;
    estadoBase = 'ok';
  } catch (err) {
    logger.error({ err }, 'la base de datos no responde');
  }

  res.status(estadoBase === 'ok' ? 200 : 503).json({
    estado: estadoBase === 'ok' ? 'ok' : 'degradado',
    version: 'v1',
    base_de_datos: estadoBase,
  });
});

/**
 * GET /api/v1/csrf
 * Devuelve el token anti-CSRF de la sesion del navegador.
 *
 * El frontend la llama una vez al arrancar para tener el valor a mano antes
 * de su primera peticion que modifique datos. No toca la base de datos, asi
 * que funciona incluso con la base caida.
 */
router.get('/csrf', (req, res) => {
  res.json({
    token: req.csrfToken ?? null,
    cabecera: 'X-CSRF-Token',
  });
});

router.use('/auth', authRouter);

export default router;