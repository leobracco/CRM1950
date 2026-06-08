# Módulo Contable Fase 1 — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development o executing-plans. Steps usan checkbox (`- [ ]`).

**Goal:** Núcleo contable de doble partida: plan de cuentas (estándar precargado + editable), libro diario (asientos manuales con validación debe=haber) y libro mayor por cuenta, todo multi-empresa y solo para admin.

**Architecture:** Documentos CouchDB `cuenta` y `asiento` discriminados por `type` y scopeados por `empresaId`. El asiento embebe sus renglones en un solo doc (escritura atómica → siempre balanceado). Los saldos se calculan recorriendo asientos (fuente única de verdad). Backend: `lib/contabilidad.js` (lógica pura + seed) + `routes/cuentas.js` + `routes/asientos.js`. Frontend: 3 vistas nuevas en el SPA single-file.

**Tech Stack:** Node + Express + CouchDB (nano/Mango) + SPA vanilla.

---

### Task 1: Lógica contable pura (`lib/contabilidad.js`)

**Files:**
- Create: `lib/contabilidad.js`
- Create test: `scripts/test-contabilidad.js`

Exporta: `PLAN_DEFAULT` (array de `{codigo, nombre, tipo, imputable}`), `naturaleza(tipo)`, `validarAsiento(doc, cuentasPorCodigo)`, `sembrarPlan(empresaId)`, `saldoCuenta(empresaId, codigo, {desde,hasta})`.

- [ ] **Step 1:** Escribir `lib/contabilidad.js` con `PLAN_DEFAULT` (las 30 cuentas del spec), `naturaleza(tipo)` → `'deudora'` para activo/gasto, `'acreedora'` resto. `validarAsiento(doc, cuentasPorCodigo)`: lanza `Error` con `statusCode=400` si renglones<2, si algún renglón tiene debe>0 y haber>0 (o ambos 0/negativos), si cuenta no existe/no imputable/inactiva, o si `round2(Σdebe)!==round2(Σhaber)` o total≤0. `sembrarPlan(empresaId)`: inserta las cuentas de `PLAN_DEFAULT` que falten (`_id: cuenta:<empresaId>:<codigo>`), idempotente. `saldoCuenta`: recorre `findByType('asiento',{empresaId})`, filtra por fecha, suma debe/haber de renglones con ese código, devuelve `{debe,haber,saldo}` según naturaleza.
- [ ] **Step 2:** Escribir `scripts/test-contabilidad.js`: casos asiento balanceado (ok), desbalanceado (throw), cuenta inexistente (throw), renglón con debe+haber (throw). Usa `assert` y un `cuentasPorCodigo` falso.
- [ ] **Step 3:** Correr `node scripts/test-contabilidad.js` → Esperado: "OK: 4/4".
- [ ] **Step 4:** Commit.

### Task 2: Rutas plan de cuentas (`routes/cuentas.js`)

**Files:**
- Create: `routes/cuentas.js`
- Modify: `server.js` (montar `/cuentas`)

- [ ] **Step 1:** Escribir `routes/cuentas.js`: `GET /` (cuentas de la empresa ordenadas por código, cada imputable con `saldo` via `saldoCuenta`), `POST /` (alta: valida código único, tipo válido, `_id: cuenta:<empresaId>:<codigo>`), `PUT /:id` (edita nombre/activa/imputable, guard empresa), `DELETE /:id` (409 si hay asientos que la usan, sino borra), `POST /sembrar` (`sembrarPlan(req.empresaId)`). Todas rechazan si `!req.empresaId`.
- [ ] **Step 2:** En `server.js` agregar `api.use('/cuentas', auth.requireRole('admin'), require('./routes/cuentas'));` junto a las demás rutas.
- [ ] **Step 3:** Verificación manual con curl tras levantar: `POST /api/cuentas/sembrar` crea 30 cuentas; `GET /api/cuentas` las lista.
- [ ] **Step 4:** Commit.

### Task 3: Rutas libro diario / mayor (`routes/asientos.js`)

**Files:**
- Create: `routes/asientos.js`
- Modify: `server.js` (montar `/asientos`)

- [ ] **Step 1:** Escribir `routes/asientos.js`: `GET /?desde&hasta` (asientos por fecha desc), `GET /:id`, `POST /` (carga cuentas de la empresa en `cuentasPorCodigo`, valida con `validarAsiento`, numera con `nextSeq(empresaId,'asiento')`, `_id: asiento:<empresaId>:<seq6>`, completa `cuentaNombre` en cada renglón), `PUT /:id` (re-valida, conserva número/creado), `DELETE /:id`, `GET /mayor/:codigo?desde&hasta` (apuntes de esa cuenta con saldo acumulado según naturaleza). Guard empresa en todas.
- [ ] **Step 2:** En `server.js` agregar `api.use('/asientos', auth.requireRole('admin'), require('./routes/asientos'));`.
- [ ] **Step 3:** Verificación manual: `POST /api/asientos` con asiento balanceado → 201; desbalanceado → 400; `GET /api/asientos/mayor/1.1.01` lista apuntes.
- [ ] **Step 4:** Commit.

### Task 4: Seed de plan al crear empresa (`routes/empresas.js`)

**Files:**
- Modify: `routes/empresas.js`

- [ ] **Step 1:** Importar `const contabilidad = require('../lib/contabilidad');` y tras crear la empresa+admin, llamar `await contabilidad.sembrarPlan(slug);` (dentro de try, sin abortar la creación si falla: log de warning).
- [ ] **Step 2:** Commit.

### Task 5: Frontend — menú + vistas (`public/index.html`, `public/js/app.js`)

**Files:**
- Modify: `public/index.html` (3 ítems de menú con `data-admin`)
- Modify: `public/js/app.js` (`TITLES`, `VIEWS`, 3 funciones de vista)

- [ ] **Step 1:** En `index.html`, agregar en el sidebar (con `data-admin`): `cuentas` (Plan de cuentas), `diario` (Libro diario), `mayor` (Libro mayor).
- [ ] **Step 2:** En `app.js` `TITLES`, agregar las 3 entradas. En `VIEWS`, mapear a `cuentasView`, `diarioView`, `mayorView`.
- [ ] **Step 3:** Escribir `cuentasView`: tabla código/nombre/tipo/saldo; si vacío botón "Cargar plan estándar" (`POST /cuentas/sembrar`); nueva/editar/desactivar vía modal.
- [ ] **Step 4:** Escribir `diarioView` + `asientoForm`: lista de asientos con filtro fechas; modal con renglones dinámicos (agregar/quitar, select de cuentas imputables, debe/haber, detalle), totales Σdebe/Σhaber/diferencia en vivo, botón guardar deshabilitado si no balancea; editar/borrar.
- [ ] **Step 5:** Escribir `mayorView`: select de cuenta + rango fechas → tabla apuntes con saldo acumulado.
- [ ] **Step 6:** Verificación manual en navegador (login admin): cargar plan, crear asiento balanceado, ver mayor.
- [ ] **Step 7:** Commit.

### Task 6: Deploy

- [ ] **Step 1:** `git push origin main`.
- [ ] **Step 2:** En el server: `cd /opt/1950/CRM && git pull && set -a && . ./.env && set +a && pm2 restart crm1950 --update-env`.
- [ ] **Step 3:** Verificar `GET /api/cuentas` responde tras login y que la UI carga las 3 vistas.
