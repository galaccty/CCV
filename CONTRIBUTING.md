# Guía de contribución (backend)

> **Fuente de verdad:** los invariantes de este archivo son una copia de la sección 10 de `especificacion_centro_comercial_v4.md`. Si divergen, manda la sección 10.

Antes de abrir un pull request, revisa los invariantes.

**Criterio:** un invariante es **bloqueante** si el cambio puede mover dinero o cambiar si el dinero se mueve. Si un cambio rompe un invariante bloqueante, no se aprueba. Todos los de esta lista lo son; la única parte de revisión normal es la de retenciones del invariante 11.

## Invariantes

1. **El ledger es la fuente de verdad.** Todo movimiento de dinero pasa por un único `registrar_movimiento()` que actualiza los saldos en la misma transacción. Nadie asigna un saldo directamente.
2. **`pago.referencia` es UNIQUE.** Un webhook con referencia desconocida se registra y se alerta; nunca se descarta en silencio.
3. **El webhook responde 200 solo después de procesar** o de registrar su resultado. Ante un fallo transitorio responde 5xx para que Wompi reintente.
4. **El procesamiento de un pago aprobado es atómico:** el camino feliz ocurre en una transacción (A) y el camino de fallo por stock en otra (B). Nunca se llama a la API de Wompi dentro de una transacción de base de datos.
5. **Los snapshots de `sub_pedido` nunca se modifican.** El neto se deriva.
6. **"Entregado" y "el dinero se movió" son hechos distintos.** El saldo con disputa abierta, retención vigente o reembolso pendiente no se libera ni se liquida.
7. **El stock se descuenta siempre** con `UPDATE ... WHERE stock >= n AND activo = true`; si no afecta filas, la operación falla. Las únicas otras escrituras de stock son: devolverlo al cancelar un sub_pedido cuyo stock ya se había descontado, y el ajuste del vendedor (por diferencia, con `UPDATE ... SET stock = stock + d WHERE id = X AND stock + d >= 0`), más el stock inicial al crear una variante. Todas pasan por el módulo de stock.
8. **La deuda se compensa solo en liquidación y solo con saldo liberado.**
9. **El estado de un local por deuda solo lo cambian** `recalcular_estado_local()` y el job diario de bloqueo, siempre a través del mismo servicio.
10. **Todo POST que crea pedido o pago exige `Idempotency-Key`.**
11. **Nada financiero se borra.** Los productos se desactivan; el ledger y la auditoría son solo de agregar filas.
    - *Revisión normal (no bloquea):* los eventos de webhook, las vistas y los pedidos expirados tienen retención definida.
12. **Todo monto que aparece en pantalla se calcula en el backend.**

## Verificación automática (CI)

La plantilla de pull request es documentación. Lo que hace cumplir los invariantes es CI, que corre en cada push:

- **Invariante 1:** el build falla si aparece una escritura a las columnas de saldo de `cuenta_local` fuera del servicio del ledger.
- **Invariante 7:** toda escritura a `producto_variante.stock` debe pasar por el módulo de stock.
- **Cómo funcionan estos dos chequeos:** buscan el nombre de la tabla y de la columna cerca de cualquier escritura (no el método del ORM, para atrapar también SQL escrito a mano), con una lista blanca de archivos permitidos. Al fallar imprimen qué invariante se rompió y en qué archivo y línea. Se introducen junto con la corrección de cualquier violación existente, en el mismo commit, para que nunca nazcan en rojo.
- **Invariante 4**, en tres capas: (a) una regla de lint que prohíbe importar el cliente HTTP de Wompi fuera del módulo `wompi`; (b) un guardián en ejecución: el envoltorio de transacciones registra en un contexto (por ejemplo AsyncLocalStorage en Node) que hay una transacción abierta, y el cliente de Wompi lanza un error si lo encuentra, también en pruebas; (c) una prueba de integración que usa el envoltorio real de transacciones, llama al cliente de Wompi dentro y espera ese error específico. No se mockea la transacción.
- **Todos los invariantes:** cada uno tiene al menos un archivo de pruebas llamado `invariante_NN_<descripcion>.test.ts`, de `invariante_01_...` a `invariante_12_...`. Un paso de CI verifica que existan los doce y falla listando los que faltan. Para los invariantes 1 y 7, ese archivo ejecuta el chequeo estático. Las pruebas bloquean el merge si fallan.

## Reglas de trabajo

- Una migración ya aplicada nunca se edita; se agrega una nueva.
- Todo cambio que toque dinero, stock, estados de pedido o estados de local incluye pruebas, y cada restricción de integridad tiene una prueba que intenta violarla.
- Los contratos de API viven en la especificación OpenAPI de este repositorio, que es la fuente de verdad; se actualiza antes de implementar la ruta.
- Nunca se suben claves, credenciales ni archivos `.env`.
