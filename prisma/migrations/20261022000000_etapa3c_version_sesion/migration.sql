-- Etapa 3c: version de la sesion del usuario.
-- Cambiar o restablecer la contrasena incrementa esta columna. El token de
-- sesion lleva la version con la que se emitio; si no coincide con la de la
-- base, la cookie deja de ser valida. Asi se cierran todas las sesiones
-- anteriores y la sesion que hizo el cambio recibe una cookie nueva.
ALTER TABLE "usuario"
  ADD COLUMN "version_sesion" INTEGER NOT NULL DEFAULT 0;
