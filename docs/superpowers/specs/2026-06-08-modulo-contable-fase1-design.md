# Módulo Contable — Diseño general y Fase 1 (Núcleo contable)

**Fecha:** 2026-06-08
**Estado:** aprobado por el usuario para implementar la Fase 1.

## Objetivo general

Dar al ERP de la fábrica de alfajores un paquete contable **completo**: doble partida (debe/haber), cuentas corrientes de clientes y proveedores, caja diaria y balance. Todo multi-empresa (scoping por `empresaId`).

### Idea central

Un **libro diario de doble partida** es el cimiento. Cada hecho económico se registra como un **asiento** donde `Σdebe = Σhaber`. Todo lo demás son *vistas* sobre ese libro:

- **Cuenta corriente de un cliente** = mayor de "Deudores por ventas" filtrado por ese cliente.
- **Cuenta corriente de un proveedor** = mayor de "Proveedores" filtrado por ese proveedor.
- **Caja diaria** = movimientos de la cuenta "Caja/Banco".
- **Balance y estado de resultados** = sumas y saldos de las cuentas.

Como `debe = haber` siempre, todo concilia automáticamente.

### Fases (en este orden, aprobado)

| Fase | Entrega |
|------|---------|
| **1. Núcleo contable** | Plan de cuentas (estándar precargado + editable) + libro diario (asientos manuales con validación debe=haber) + libro mayor por cuenta |
| **2. Asientos automáticos** | Cada venta y compra genera su asiento (con/sin IVA, contado o cta. cte.) |
| **3. Cuentas corrientes + cobros/pagos** | Saldo por cliente y proveedor, registrar cobros y pagos, antigüedad de saldos |
| **4. Caja diaria + Balance** | Apertura/cierre y arqueo de caja, balance de sumas y saldos, estado de resultados por período |

Cada fase es software que funciona por sí solo. Este documento detalla la **Fase 1**; las otras quedan esbozadas arriba.

## Decisiones tomadas (Fase 1)

1. **Plan de cuentas:** estándar de PyME argentina precargado por empresa, con códigos jerárquicos, **editable** (agregar/editar/desactivar).
2. **Asientos:** **siempre editables/borrables** (se prioriza comodidad sobre inmutabilidad estricta). Se guarda `actualizado` para tener rastro.
3. **Acceso:** solo `admin` y `superadmin`.
4. **Moneda:** ARS, 2 decimales.

## Modelo de datos

Mismo patrón del ERP: un solo CouchDB, documentos discriminados por `type`, scoping por `empresaId` (= slug de la empresa).

### `cuenta` (plan de cuentas)

- `_id`: `cuenta:<slug>:<codigo>` (ej. `cuenta:fabrica-1950:1.1.01`)
- `type: 'cuenta'`, `empresaId`
- `codigo`: string jerárquico (ej. `"1.1.01"`)
- `nombre`: string (ej. `"Caja"`)
- `tipo`: `'activo' | 'pasivo' | 'patrimonio' | 'ingreso' | 'gasto'`
- `imputable`: boolean — `true` = cuenta hoja usable en asientos; `false` = título agrupador (ej. "1 Activo")
- `activa`: boolean
- `creado`, `actualizado`: ISO

El **saldo no se persiste**: se calcula sumando renglones de asientos (fuente única de verdad, como el kardex de stock).

**Naturaleza** (para calcular saldo y signo):
- Deudora (`activo`, `gasto`): saldo = `Σdebe − Σhaber`
- Acreedora (`pasivo`, `patrimonio`, `ingreso`): saldo = `Σhaber − Σdebe`

### `asiento` (libro diario)

- `_id`: `asiento:<slug>:<seq6>` (correlativo vía `nextSeq(empresaId, 'asiento')`)
- `type: 'asiento'`, `empresaId`
- `numero`: `"AS-000001"`
- `fecha`: ISO (fecha contable)
- `glosa`: string (descripción del asiento)
- `renglones`: `[{ cuentaCodigo, cuentaNombre, debe: number, haber: number, detalle: string }]`
- `origen`: `'manual'` (Fase 2 agregará `'venta'`/`'compra'` con `refType`/`refId`)
- `usuario`, `creado`, `actualizado`

**Asiento = un solo documento con sus renglones embebidos** (como `ventas.items`). La escritura es atómica → nunca queda un asiento a medio escribir sin balancear.

**Validación al guardar (`validarAsiento`):**
- `Σdebe === Σhaber` redondeado a 2 decimales.
- Total (`Σdebe`) > 0.
- Cada renglón tiene `debe` **o** `haber` (no ambos, no ninguno; valores ≥ 0).
- Cada `cuentaCodigo` existe, es `imputable`, está `activa` y pertenece a la empresa.

## Backend

### `lib/contabilidad.js`
- `PLAN_DEFAULT`: array con el plan de cuentas estándar (ver abajo).
- `sembrarPlan(empresaId)`: crea las cuentas de `PLAN_DEFAULT` que falten para la empresa. Idempotente.
- `naturaleza(tipo)`: `'deudora' | 'acreedora'`.
- `validarAsiento(doc, cuentasPorCodigo)`: tira `Error` con `statusCode 400` si no cumple las reglas.
- `saldoCuenta(empresaId, codigo, { desde, hasta })`: recorre asientos de la empresa, suma renglones de esa cuenta, devuelve `{ debe, haber, saldo }`.

### `routes/cuentas.js` (montado con `requireRole('admin')`)
- `GET /` → lista de cuentas de la empresa, ordenada por `codigo`. Incluye `saldo` calculado de cada cuenta imputable.
- `POST /` → alta de cuenta (valida código único, tipo válido).
- `PUT /:id` → editar nombre/activa/imputable.
- `DELETE /:id` → solo si no tiene asientos; si los tiene, error 409 sugiriendo desactivar.
- `POST /sembrar` → ejecuta `sembrarPlan(req.empresaId)`.

### `routes/asientos.js` (montado con `requireRole('admin')`)
- `GET /?desde&hasta` → libro diario (asientos ordenados por fecha desc).
- `GET /:id` → un asiento.
- `POST /` → crear asiento (valida balance y cuentas).
- `PUT /:id` → editar asiento (re-valida).
- `DELETE /:id` → borrar asiento.
- `GET /mayor/:codigo?desde&hasta` → libro mayor de una cuenta: apuntes `{ fecha, asientoNumero, detalle, debe, haber, saldoAcum }` + saldo final.

### `server.js`
- `api.use('/cuentas', auth.requireRole('admin'), require('./routes/cuentas'));`
- `api.use('/asientos', auth.requireRole('admin'), require('./routes/asientos'));`
- Ambas rutas rechazan si `!req.empresaId` (igual que el resto de rutas de negocio).
- `routes/empresas.js`: al crear empresa, llamar `sembrarPlan(slug)`.

Los índices Mango existentes (`idx-type-empresa-codigo`, `idx-type-empresa-fecha`) cubren las consultas; no hace falta agregar índices.

## Frontend (`public/js/app.js` + `public/index.html`)

Nuevo grupo **"Contabilidad"** en el sidebar (solo admin, atributo `data-admin`), con 3 rutas:

- **`cuentas` — Plan de cuentas:** tabla código / nombre / tipo / saldo. Botones nueva / editar / desactivar. Si la lista viene vacía → botón "Cargar plan estándar" (`POST /cuentas/sembrar`).
- **`diario` — Libro diario:** lista de asientos (número, fecha, glosa, total) + filtro por fechas. "Nuevo asiento" → modal con renglones dinámicos (agregar/quitar línea, elegir cuenta imputable, debe/haber, detalle). Muestra **Σdebe / Σhaber / diferencia en vivo** y no deja guardar si no balancea. Editar/borrar asiento.
- **`mayor` — Libro mayor:** selector de cuenta + rango de fechas → tabla de apuntes con saldo acumulado y saldo final.

Reutiliza `modal()`, `toast()`, `api()`, `esc()`, `loadRef()`/`refName()`. Agregar entradas en `TITLES` y en el menú de `index.html`.

## Plan de cuentas estándar (`PLAN_DEFAULT`)

```
1     ACTIVO                              (activo, agrupador)
1.1   Activo corriente                    (activo, agrupador)
1.1.01 Caja                               (activo, imputable)
1.1.02 Banco cuenta corriente             (activo, imputable)
1.1.03 Deudores por ventas                (activo, imputable)
1.1.04 IVA crédito fiscal                 (activo, imputable)
1.1.05 Mercaderías (bienes de cambio)     (activo, imputable)
1.2   Activo no corriente                 (activo, agrupador)
1.2.01 Bienes de uso (máquinas/equipos)   (activo, imputable)
2     PASIVO                              (pasivo, agrupador)
2.1   Pasivo corriente                    (pasivo, agrupador)
2.1.01 Proveedores                        (pasivo, imputable)
2.1.02 IVA débito fiscal                  (pasivo, imputable)
2.1.03 Sueldos a pagar                    (pasivo, imputable)
2.1.04 Cargas sociales a pagar            (pasivo, imputable)
2.1.05 Impuestos a pagar                  (pasivo, imputable)
3     PATRIMONIO NETO                     (patrimonio, agrupador)
3.1.01 Capital                            (patrimonio, imputable)
3.1.02 Resultados acumulados              (patrimonio, imputable)
4     INGRESOS                            (ingreso, agrupador)
4.1.01 Ventas                             (ingreso, imputable)
4.1.02 Otros ingresos                     (ingreso, imputable)
5     GASTOS                              (gasto, agrupador)
5.1.01 Costo de mercadería vendida        (gasto, imputable)
5.1.02 Compras de insumos                 (gasto, imputable)
5.1.03 Sueldos y jornales                 (gasto, imputable)
5.1.04 Cargas sociales                    (gasto, imputable)
5.1.05 Alquileres                         (gasto, imputable)
5.1.06 Servicios (luz/gas/agua/internet)  (gasto, imputable)
5.1.07 Fletes y distribución              (gasto, imputable)
5.1.08 Impuestos y tasas                  (gasto, imputable)
5.1.09 Gastos bancarios                   (gasto, imputable)
5.1.10 Otros gastos                       (gasto, imputable)
```

`1.1.03 Deudores por ventas` y `2.1.01 Proveedores` quedan listas para las cuentas corrientes de la Fase 3.

## Pruebas

El repo no tiene test runner. Se incluye un **script node standalone** (`scripts/test-contabilidad.js`, estilo `lib/seed.js`) que valida `validarAsiento` con casos balancea / no balancea / cuenta inválida, ejecutable con `node scripts/test-contabilidad.js`. Verificación manual de las 3 vistas en la UI.

## Fuera de alcance (Fase 1)

- Asientos automáticos desde ventas/compras (Fase 2).
- Cobros/pagos y saldos por cliente/proveedor (Fase 3).
- Caja diaria, balance y estado de resultados (Fase 4).
- IVA discriminado automáticamente (Fase 2). En Fase 1 el usuario puede usar las cuentas de IVA manualmente en sus asientos.
