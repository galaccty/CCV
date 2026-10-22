-- Etapa 3c: telefono de contacto de la cuenta.
-- Es opcional y se edita desde PATCH /api/v1/auth/perfil. El formato
-- (digitos con + opcional) se valida en la API antes de guardarlo.
ALTER TABLE "usuario" ADD COLUMN "telefono" VARCHAR(30);
