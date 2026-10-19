import { Router } from 'express';
import v1 from './v1/index.js';

/**
 * Raiz de la API.
 *
 * Todo lo versionado cuelga de aqui: /api/v1/...
 * La version va en el path y no en una cabecera para que la URL por si sola
 * diga que version estas usando y las rutas_old puedan convivir.
 */
const router = Router();

router.use('/v1', v1);

export default router;