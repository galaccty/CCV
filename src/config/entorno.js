import { config as cargarDotenv } from 'dotenv';
import { z } from 'zod';

// Carga el .env una sola vez. Las variables ya definidas en el sistema
// (por ejemplo en Railway o Vercel) tienen prioridad sobre el archivo.
cargarDotenv({ quiet: true });

const esquemaConfig = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1, 'falta DATABASE_URL en el .env'),

  CORS_ORIGINS: z.string().default('http://localhost:5173'),

  SESSION_SECRET: z
    .string()
    .min(16, 'SESSION_SECRET debe tener al menos 16 caracteres'),
  SESSION_COOKIE_SECURE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  SESSION_MAX_AGE_MINUTOS: z.coerce.number().int().positive().default(120),

  MAIL_DRIVER: z.enum(['consola', 'ninguno']).default('consola'),
  MAIL_FROM: z.string().default('no-reply@tudominio.co'),
  MAIL_PROVEEDOR_API_KEY: z.string().optional().default(''),

  // Wompi. Hasta que existan las llaves de sandbox se usa el proveedor falso:
  // no hace ninguna llamada HTTP y permite probar el corte vertical completo.
  WOMPI_PROVEEDOR: z.enum(['falso', 'real']).default('falso'),
  WOMPI_PUB_KEY: z.string().optional().default(''),
  WOMPI_PRV_KEY: z.string().optional().default(''),
  WOMPI_EVENTS_KEY: z.string().optional().default(''),
  WOMPI_INTEGRITY_KEY: z.string().optional().default(''),
  WOMPI_API_BASE: z.string().url().default('https://sandbox.wompi.co/v1'),
  WOMPI_CHECKOUT_BASE: z.string().url().default('https://checkout.wompi.co/p/'),
  WOMPI_REDIRECT_URL: z.string().optional().default(''),
});

const resultado = esquemaConfig.safeParse(process.env);

if (!resultado.success) {
  const problemas = resultado.error.issues
    .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
    .join('\n');
  throw new Error(
    `Configuracion invalida. Revisa tu archivo .env:\n${problemas}\n\n` +
      'Copia .env.example a .env y completa los valores.',
  );
}

const valores = resultado.data;

if (
  valores.NODE_ENV === 'production' &&
  valores.SESSION_SECRET.includes('CAMBIAME')
) {
  throw new Error(
    'SESSION_SECRET sigue con el valor de ejemplo. Genera uno antes de desplegar.',
  );
}

export const config = {
  ...valores,
  esProduccion: valores.NODE_ENV === 'production',
  esPrueba: valores.NODE_ENV === 'test',
  origenesPermitidos: valores.CORS_ORIGINS.split(',')
    .map((o) => o.trim())
    .filter(Boolean),
  sessionMaxAgeMs: valores.SESSION_MAX_AGE_MINUTOS * 60 * 1000,
};