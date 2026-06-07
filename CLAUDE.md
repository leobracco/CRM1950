# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Idioma

**Respondé siempre en castellano (español rioplatense).** El usuario, el dominio y la UI están en castellano; mantené los términos de dominio en castellano (insumos, recetas, lotes, etc.).

## Overview

ERP/CRM for an alfajor (Argentine cookie) factory: inventory of raw materials (insumos), sales, purchases, manufacturing with recipe consumption, batch (lote) traceability, regulatory labels (CAA / Ley 27.642 octagonal warning seals), per-unit serial numbers, and shipping labels.

**Stack:** Node.js + Express · CouchDB (single-DB pattern with Mango indexes) · vanilla HTML/CSS/JS SPA (no frameworks). Domain language and UI are in Spanish; keep new domain terms in Spanish to match.

## Commands

```bash
npm install        # install deps
npm start          # run server (node server.js)
npm run dev        # run with auto-reload (node --watch server.js)
npm run seed       # create the bootstrap superadmin (lib/seed.js runs standalone)
npm run wipe -- --si  # DANGER: delete every business doc (keeps _design); for a clean multi-empresa start
```

There is no test suite, linter, or build step. App serves at http://localhost:3000. Default bootstrap login: `superadmin` / `admin1950` (rol `superadmin`); from there you create empresas and their admins.

**CouchDB 3.x must be running.** Configure via env (or edit `config.js`): `COUCH_URL` (full URL with credentials, e.g. `http://admin:pass@127.0.0.1:5984`), `DB_NAME` (default `erp1950`), `SESSION_SECRET`, `ADMIN_USER`/`ADMIN_PASS`. The server still boots if CouchDB is unreachable (`db.init()` returns false) but API calls will fail.

## Architecture

**Single CouchDB database, discriminated by a `type` field.** There are no separate tables/collections. Every document carries `type` ∈ {`empresa`, `user`, `cliente`, `proveedor`, `insumo`, `producto`, `receta`, `compra`, `venta`, `orden`, `lote`, `movimiento`, `counter`}. Queries go through Mango `_find` against the indexes declared in `lib/db.js` (`INDEXES`). All listing/filtering helpers live in `lib/db.js` (`findByType`, `find`, `get`, `tryGet`, `insert`, `remove`).

**Multi-tenant (multi-empresa).** Every business document carries an `empresaId` (= the company SLUG, e.g. `fabrica-1950`; the root doc is `empresa:<slug>`). A tenant middleware in `server.js` (after `auth.requireAuth`) sets `req.empresaId` and `req.esSuperadmin`: a `superadmin` (rol global, `empresaId: null`) sees/manages all companies and picks an "empresa activa" stored in `req.session.empresaActiva`; `admin`/`operario` belong to one empresa. Scoping patterns: list queries pass `empresaId: req.empresaId || undefined` to `findByType`/`find`; `get/:id` guards with `if (!req.esSuperadmin && doc.empresaId !== req.empresaId) return 404`; POST handlers inject `empresaId`, validate referenced docs (→ 400), and **reject creation when `!req.empresaId`** (superadmin must select an empresa first). `auth.requireRole(...)` treats `superadmin` as a wildcard. **Firmware/OTA is GLOBAL** (no `empresaId`; managed only by superadmin). Pairing docs are global (`pairing:<codigo>`) with `empresaId` inside.

**Document IDs are meaningful, prefixed, and namespaced by empresa**, e.g. `venta:<slug>:000007`, `compra:<slug>:<seq6>`, `lote:<slug>:<codigo>`, `orden:<slug>:<seq6>`, `mov:<slug>:<seq8>`, `counter:<slug>:venta`, `procterm:<slug>:<pid>`. Global docs (no slug): `empresa:<slug>`, `user:<usuario>`, `pairing:<codigo>`, firmware. Because lote ids are namespaced, the public trace `/t/:codigo` looks up the lote by the `codigo` **field** via Mango, not by `_id`. When creating docs, follow the existing `prefix:<slug>:code` convention.

**Correlative numbering is atomic-ish via counter docs.** `db.nextSeq(empresaId, key)` increments `counter:<empresaId>:<key>` (or global `counter:<key>` when `empresaId` is null) with a 409-conflict retry loop. Used for OF (órdenes de fabricación), OC (compras), FV (ventas), and movimiento sequences. CouchDB has no real transactions, so all multi-step writes (manufacture, sale) rely on these retry loops, not atomicity — partial failures are possible.

**Generic CRUD factory** (`lib/crud.js`): `crud(type, opts)` returns an Express router with GET list (with in-memory `?q=` search over `searchFields`), GET/:id, POST, PUT, DELETE. `opts.beforeWrite(doc, req, isNew)` is the hook for coercion/validation/derivation (see numeric coercion hooks `beforeProducto`/`beforeInsumo`/`beforeReceta` in `server.js`). `opts.afterWrite` for side effects. `insumos`, `productos`, `recetas`, `clientes`, `proveedores` are all just `crud()` instances. Routes with real business logic (`compras`, `ventas`, `fabricacion`, `lotes`, `etiquetas`, `movimientos`, `dashboard`) live in `routes/` as hand-written routers.

**Stock + kardex** (`lib/stock.js`): never mutate `doc.stock` directly in business code. Call `stock.movimiento({...})` — it writes a `movimiento` (kardex) doc AND applies `ajustarStock` (also a 409-retry loop). Sign convention: positive delta = inflow, negative = consumption/sale. This is the single source of truth for stock changes and traceability.

### Core domain flows

- **Compra** (`routes/compras.js`): creates `compra` doc → `stock.movimiento(+)` per insumo → updates each insumo's `costoUnit` (last cost).
- **Fabricación** (`routes/fabricacion.js`): scales recipe by `cantidad/rinde` → validates insumo stock (unless `force`) → consumes insumos via `movimiento(-)` → creates a `lote` (code `YYMMDD-seq`, `fechaVencimiento` = elaboración + `producto.vidaUtilDias`) → creates `orden` (OF) → produces finished `producto` stock via `movimiento(+)` → writes computed `costoUnit` back to the producto.
- **Venta** (`routes/ventas.js`): validates product stock → **FEFO** lot assignment (if no lot given, picks the lot with the nearest `fechaVencimiento`) → creates `venta` (FV) → `movimiento(-)` per product. Note: stock is tracked in aggregate, not per-lot, so FEFO assignment is informational on the movimiento, not an actual per-lot decrement.
- **Trazabilidad / recall** (`routes/lotes.js` `:id/trazabilidad`): from a lote, walks back to the `orden` (origin = consumed insumos + suppliers) and forward via `movimiento`s where `motivo='venta'` (destination = sales + customers).
- **Etiquetas** (`routes/etiquetas.js`): builds print-data JSON (label/rótulo, per-unit serie, shipping). Generates QR data-URLs (`qrcode` lib) pointing at the public trace URL `/t/<lote>` (and `?s=<serial>` per unit).

### Auth & routing layers (`server.js`)

Three layers, in order:
1. **Public, no auth**: `/api/login`, `/api/logout`, `/api/me` (mounted via `auth.router`), plus the public traceability pages `/t/:codigo` and `/t/envio/:tracking` (the consumer-facing QR target, rendered server-side as inline HTML in `server.js`).
2. **Auth-required API**: everything under the `api` router after `api.use(auth.requireAuth)`, followed by the **tenant middleware** that sets `req.empresaId`/`req.esSuperadmin`. Sessions are cookie-based (`express-session`, **in-memory store** — resets on restart). `/api/usuarios` is gated by `auth.requireRole('admin')` (and scoped to the caller's empresa); `/api/empresas` (CRUD + `/activa`) and firmware upload/delete are `auth.requireSuperadmin`.
3. **SPA fallback**: static `public/`, then `app.get('*')` serves `index.html` for client-side routing.

Passwords are bcrypt-hashed (`lib/auth.js`); user docs are `user:<usuario-lowercase>` with a `rol` field (`superadmin`, `admin`, `operario`) and an `empresaId` (null for superadmin). Usernames are globally unique. Login is blocked if the user's empresa is missing/suspended.

### Frontend SPA (`public/js/app.js`, ~730 lines, single file)

Hash-based routing: `VIEWS` map (route → render fn) + `TITLES`, dispatched by `render()`/`go()`. `api()` is the fetch wrapper (auto-reloads on 401). `crudView()` is the generic list/form UI mirroring the backend `crud()` factory; `loadRef`/`refName` cache reference lists (clientes, productos…) for dropdowns and name lookups. `modal()`/`toast()`/`btn()` are the shared UI primitives. Always escape interpolated values with `esc()` (already used throughout).

## Notes

- Seed (`lib/seed.js` → `ensureSuperadmin`) only creates the bootstrap superadmin on boot if it doesn't exist (no sample business data). Idempotent. A clean start (e.g. migrating an old single-empresa DB) needs `npm run wipe -- --si` + restart, then re-create empresas and re-pair machines.
- `erp1950/` is an empty/extracted dir and `erp1950.zip` is a packaged snapshot — not the live source. Work in the repo root (`server.js`, `lib/`, `routes/`, `public/`).
- Production gaps called out in README: in-memory sessions, no HTTPS/`cookie.secure`, no per-lot stock decrement, no CouchDB backups configured.
