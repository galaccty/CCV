## Qué cambia y por qué

<!-- Resumen breve del cambio -->

## Tipo de cambio

- [ ] No toca dinero, stock ni estados
- [ ] Toca dinero, stock, estados de pedido o estados de local (revisar TODA la lista de abajo)

## Invariantes (todos bloqueantes: si alguno no se cumple, no se aprueba)

Fuente: sección 10 de la especificación. CI verifica automáticamente los invariantes 1, 4 y 7 y corre las pruebas de los demás; esta lista es para que quien revisa no tenga que abrir nada.

- [ ] 1. Todo movimiento de dinero pasa por `registrar_movimiento()`; ningún saldo se asigna directamente
- [ ] 2. `pago.referencia` sigue siendo UNIQUE; las referencias desconocidas se registran y alertan
- [ ] 3. El webhook responde 200 solo después de procesar; 5xx ante fallos transitorios
- [ ] 4. El pago aprobado se procesa de forma atómica (camino feliz y camino de fallo por stock) y no hay llamadas a Wompi dentro de transacciones
- [ ] 5. Los snapshots de `sub_pedido` no se modifican
- [ ] 6. No se libera ni se liquida saldo con disputa abierta, retención vigente o reembolso pendiente
- [ ] 7. El stock solo lo escribe el módulo de stock: descuento condicionado, devolución por cancelación, ajuste por diferencia sin quedar negativo y stock inicial
- [ ] 8. La deuda se compensa solo en liquidación y con saldo liberado
- [ ] 9. El estado del local por deuda solo cambia mediante `recalcular_estado_local()` o el job de bloqueo
- [ ] 10. Los POST que crean pedido o pago exigen `Idempotency-Key`
- [ ] 11. Nada financiero se borra (el ledger y la auditoría solo agregan filas; los productos se desactivan)
- [ ] 12. Los montos que se muestran se calculan en el backend

## Revisión normal (comentarios, no bloquean)

- [ ] Lo que acumula datos (eventos de webhook, vistas, pedidos expirados) tiene retención definida

## Pruebas y contrato

- [ ] Hay pruebas nuevas o ajustadas, y las restricciones de integridad tienen una prueba que intenta violarlas
- [ ] Cada invariante que toca este cambio tiene su archivo `invariante_NN_<descripcion>.test.ts` y pasa
- [ ] CI pasa completo (incluidos los chequeos de los invariantes 1, 4 y 7)
- [ ] Si se agregó o cambió una ruta, la especificación OpenAPI está actualizada
- [ ] Si hay migraciones, son nuevas (no se editó ninguna ya aplicada) y dejan la base consistente en cada paso
