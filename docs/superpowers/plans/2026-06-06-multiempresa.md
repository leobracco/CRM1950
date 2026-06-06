# Multi-empresa (multi-tenant) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convertir el ERP mono-empresa en multi-tenant: cada empresa ingresa con sus usuarios y ve solo sus datos; un superadmin global administra todas las empresas.

**Architecture:** Una sola base CouchDB; cada documento de negocio lleva un campo `empresaId` (= slug de la empresa). El scoping por empresa se centraliza en `lib/db.js` (selectores) y `lib/crud.js`, y un middleware en `server.js` calcula `req.empresaId` por request. Los IDs y correlativos se namespacean por empresa. Firmware global; branding de rótulos/trazabilidad sale del doc `empresa`.

**Tech Stack:** Node.js + Express · CouchDB (nano, Mango `_find`) · express-session · vanilla JS SPA. Sin suite de tests: la verificación de cada tarea es `node --check` + arranque del server + `curl` contra la API.

**Convención clave:** `empresaId` es el **slug** (p. ej. `fabrica-1950`). El doc raíz es `empresa:<empresaId>`. Los docs de negocio llevan `empresaId: "<slug>"`. Los IDs se namespacean: `venta:<slug>:000007`, `counter:<slug>:venta`, `lote:<slug>:<codigo>`, `procterm:<slug>:<pid>`.

**Prerrequisito de entorno:** CouchDB 3.x corriendo y accesible (ver `config.js` / `COUCH_URL`). El server arranca igual si no hay CouchDB, pero las verificaciones con `curl` necesitan la base viva. Login bootstrap tras el seed: `superadmin` / `admin1950`.

---

## Resumen de tareas

1. Capa de datos: `lib/db.js` (índices, `findByType`/`find` con `empresaId`, `nextSeq` por empresa, helper `empresaDocId`).
2. Auth: rol `superadmin`, `empresaId` en sesión/login, `requireSuperadmin`, bloqueo de empresa suspendida.
3. Middleware tenant en `server.js` (`req.empresaId`).
4. `lib/crud.js`: scoping en list/get/put/delete + inyección de `empresaId` y namespacing del `_id` en POST.
5. `routes/empresas.js` (CRUD empresas + alta de admin inicial) + `/api/empresa-activa` + `/api/empresa` por contexto + montaje.
6. `lib/stock.js`: `empresaId` en `movimiento`.
7. Rutas de negocio (`ventas`, `compras`, `fabricacion`, `lotes`, `movimientos`, `dashboard`) scopeadas.
8. Máquinas: `lib/maquinas.js` (pairing por empresa, `verifyToken` separado de la carga del doc) + `routes/maquinas.js`.
9. Gateway + procesos: `lib/cloudGateway.js` y `lib/procesos.js` con `empresaId`.
10. Firmware global: `routes/firmware.js` → `requireSuperadmin`.
11. Trazabilidad pública `/t/:codigo` + `routes/etiquetas.js`: branding por empresa.
12. Frontend `public/js/app.js` + `public/index.html`: contexto de empresa, selector de superadmin, vista Empresas, nav.
13. Arranque limpio: `lib/seed.js` (`ensureSuperadmin`, sin sample data) + script `scripts/wipe.js` + ajuste de `server.js`.

---

### Task 1: Capa de datos (`lib/db.js`)

**Files:**
- Modify: `lib/db.js`

Centraliza el scoping por empresa: índices nuevos, `findByType`/`find` que aceptan `empresaId`, `nextSeq` por empresa, y un helper `empresaDocId`.

- [ ] **Step 1: Agregar índices con `empresaId`**

En `lib/db.js`, reemplazá el array `INDEXES` (líneas 11-19) por:

```javascript
const INDEXES = [
  { name: 'idx-type', fields: ['type'] },
  { name: 'idx-type-codigo', fields: ['type', 'codigo'] },
  { name: 'idx-type-fecha', fields: ['type', 'fecha'] },
  { name: 'idx-type-nombre', fields: ['type', 'nombre'] },
  { name: 'idx-type-serial', fields: ['type', 'serial'] },
  { name: 'idx-type-version', fields: ['type', 'version'] },
  { name: 'idx-type-maquinaId', fields: ['type', 'maquinaId'] },
  { name: 'idx-type-empresa', fields: ['type', 'empresaId'] },
  { name: 'idx-type-empresa-codigo', fields: ['type', 'empresaId', 'codigo'] },
  { name: 'idx-type-empresa-fecha', fields: ['type', 'empresaId', 'fecha'] }
];
```

- [ ] **Step 2: `findByType` y `find` aceptan `empresaId`**

Reemplazá `findByType` (líneas 66-78) y `find` (líneas 80-83) por:

```javascript
// Listar por tipo con filtros/orden simples vía Mango.
// extra.empresaId (string slug) agrega el filtro por empresa al selector.
async function findByType(type, extra = {}) {
  const selector = { type, ...(extra.selector || {}) };
  if (extra.empresaId) selector.empresaId = extra.empresaId;
  const q = {
    selector,
    limit: extra.limit || 1000,
    sort: extra.sort,
    fields: extra.fields
  };
  if (!q.sort) delete q.sort;
  if (!q.fields) delete q.fields;
  const res = await db.find(q);
  return res.docs;
}

async function find(query) {
  const res = await db.find(query);
  return res.docs;
}
```

- [ ] **Step 3: `nextSeq` por empresa + helper `empresaDocId`**

Reemplazá `nextSeq` (líneas 86-100) por la versión con `empresaId`, y agregá `empresaDocId` justo antes:

```javascript
// Construye el _id del doc raíz de una empresa a partir de su slug.
function empresaDocId(empresaId) {
  return `empresa:${empresaId}`;
}

// Genera un correlativo atómico-ish por empresa (doc counter:<empresaId>:<key>).
// Si empresaId es null/'' usa el contador global counter:<key> (para entidades sin tenant).
async function nextSeq(empresaId, key) {
  const id = empresaId ? `counter:${empresaId}:${key}` : `counter:${key}`;
  for (let i = 0; i < 5; i++) {
    try {
      const doc = (await tryGet(id)) || { _id: id, type: 'counter', value: 0, empresaId: empresaId || null };
      doc.value += 1;
      await db.insert(doc);
      return doc.value;
    } catch (e) {
      if (e.statusCode === 409) continue; // conflicto: reintentar
      throw e;
    }
  }
  throw new Error('No se pudo generar correlativo para ' + key);
}
```

> Cambio de firma: `nextSeq(key)` → `nextSeq(empresaId, key)`. Todos los llamadores (crud, stock, rutas) se actualizan en sus tareas respectivas.

- [ ] **Step 4: Exportar `empresaDocId`**

En el `module.exports` (líneas 102-107), agregá `empresaDocId`:

```javascript
module.exports = {
  nano,
  raw: () => db,
  init, isReady,
  get, tryGet, insert, remove, find, findByType, nextSeq, empresaDocId
};
```

- [ ] **Step 5: Verificar sintaxis**

Run: `node --check lib/db.js`
Expected: sin salida (exit 0).

- [ ] **Step 6: Commit**

```bash
git add lib/db.js
git commit -m "feat(multiempresa): scoping por empresaId en la capa de datos (db.js)"
```

---

### Task 2: Auth con superadmin y empresa (`lib/auth.js`)

**Files:**
- Modify: `lib/auth.js`

Agrega `empresaId` al usuario y a la sesión, el rol `superadmin`, el middleware `requireSuperadmin`, el bloqueo de login para empresas suspendidas, y scopea la gestión de usuarios.

- [ ] **Step 1: `crearUsuario` acepta `empresaId`**

Reemplazá `crearUsuario` (líneas 13-25) por:

```javascript
async function crearUsuario({ usuario, password, nombre, rol, empresaId }) {
  const _id = userDocId(usuario);
  const hash = await bcrypt.hash(password, 10);
  return database.insert({
    _id, type: 'user',
    usuario: usuario.toLowerCase().trim(),
    nombre: nombre || usuario,
    rol: rol || 'operario',
    empresaId: empresaId || null,
    hash,
    activo: true,
    creado: new Date().toISOString()
  });
}
```

- [ ] **Step 2: Login agrega `empresaId` y bloquea empresa suspendida**

Reemplazá el handler `POST /login` (líneas 28-41) por:

```javascript
// POST /api/login
router.post('/login', async (req, res) => {
  const { usuario, password } = req.body || {};
  if (!usuario || !password) return res.status(400).json({ error: 'Faltan credenciales' });
  try {
    const doc = await database.tryGet(userDocId(usuario));
    if (!doc || !doc.activo) return res.status(401).json({ error: 'Usuario o clave inválidos' });
    const ok = await bcrypt.compare(password, doc.hash);
    if (!ok) return res.status(401).json({ error: 'Usuario o clave inválidos' });
    // Si pertenece a una empresa, debe estar activa.
    if (doc.empresaId) {
      const emp = await database.tryGet(database.empresaDocId(doc.empresaId));
      if (!emp || emp.activo === false) return res.status(403).json({ error: 'Empresa suspendida o inexistente' });
    }
    req.session.user = { usuario: doc.usuario, nombre: doc.nombre, rol: doc.rol, empresaId: doc.empresaId || null };
    res.json({ ok: true, user: req.session.user });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
```

- [ ] **Step 3: `listarUsuarios` y `actualizarUsuario` scopeados por empresa**

Reemplazá `listarUsuarios` (líneas 67-69) y `actualizarUsuario` (líneas 72-82) por:

```javascript
// Lista usuarios (sin el hash). Si empresaId viene, filtra por esa empresa.
async function listarUsuarios(empresaId) {
  const docs = await database.findByType('user', { limit: 1000, empresaId: empresaId || undefined });
  return docs.map(({ hash, ...u }) => u);
}

// Edición por admin: nombre, rol, activo y reseteo de clave.
// Si scopeEmpresaId viene, valida que el usuario pertenezca a esa empresa.
async function actualizarUsuario(usuario, { nombre, rol, activo, password }, scopeEmpresaId) {
  const doc = await database.get(userDocId(usuario));
  if (scopeEmpresaId && doc.empresaId !== scopeEmpresaId) {
    const e = new Error('Usuario no encontrado'); e.statusCode = 404; throw e;
  }
  if (nombre != null) doc.nombre = nombre;
  if (rol != null) doc.rol = rol;
  if (activo != null) doc.activo = !!activo;
  if (password) doc.hash = await bcrypt.hash(password, 10);
  doc.actualizado = new Date().toISOString();
  await database.raw().insert(doc);
  const { hash, ...rest } = doc;
  return rest;
}
```

- [ ] **Step 4: Agregar `requireSuperadmin` y exportarlo**

Después de `requireRole` (línea 95), agregá:

```javascript
function requireSuperadmin(req, res, next) {
  if (req.session && req.session.user && req.session.user.rol === 'superadmin') return next();
  res.status(403).json({ error: 'Solo superadmin' });
}
```

Y reemplazá el `module.exports` (línea 97) por:

```javascript
module.exports = { router, requireAuth, requireRole, requireSuperadmin, crearUsuario, cambiarPassword, listarUsuarios, actualizarUsuario, userDocId };
```

- [ ] **Step 5: Verificar sintaxis**

Run: `node --check lib/auth.js`
Expected: sin salida (exit 0).

- [ ] **Step 6: Commit**

```bash
git add lib/auth.js
git commit -m "feat(multiempresa): superadmin, empresaId en sesion y bloqueo de empresa suspendida"
```

---

### Task 3: Middleware tenant en `server.js`

**Files:**
- Modify: `server.js`

Calcula `req.empresaId` para cada request autenticado y expone `/api/empresa-activa` (superadmin). Las `crud()` instances actuales NO se tocan acá (se adaptan en Task 4 vía `lib/crud.js`).

- [ ] **Step 1: Agregar el middleware tenant tras `requireAuth`**

En `server.js`, ubicá la línea `api.use(auth.requireAuth);` (línea 86). Inmediatamente DESPUÉS agregá:

```javascript
// Resuelve la empresa del contexto para cada request autenticado.
// - Usuario de empresa: su propia empresaId.
// - Superadmin: la "empresa activa" elegida (session.empresaActiva), o null.
api.use((req, res, next) => {
  const u = req.session.user;
  req.empresaId = (u.rol === 'superadmin') ? (req.session.empresaActiva || null) : (u.empresaId || null);
  req.esSuperadmin = (u.rol === 'superadmin');
  next();
});
```

- [ ] **Step 2: Verificar sintaxis**

Run: `node --check server.js`
Expected: sin salida (exit 0).

- [ ] **Step 3: Commit**

```bash
git add server.js
git commit -m "feat(multiempresa): middleware tenant que resuelve req.empresaId"
```

---

### Task 4: Scoping en el CRUD genérico (`lib/crud.js`)

**Files:**
- Modify: `lib/crud.js`

El CRUD genérico (insumos, productos, recetas, recetas-templado, clientes, proveedores) pasa a filtrar por `req.empresaId`, inyectar `empresaId` y namespacear el `_id` por empresa, y validar pertenencia en get/put/delete.

- [ ] **Step 1: Reescribir el router CRUD con scoping**

Reemplazá el cuerpo de `function crud(type, opts = {})` (líneas 14-86) por:

```javascript
function crud(type, opts = {}) {
  const router = express.Router();
  const prefix = opts.prefix || type;
  const searchFields = opts.searchFields || ['nombre', 'codigo'];

  // Listado (scopeado por empresa; búsqueda simple en memoria).
  router.get('/', async (req, res) => {
    try {
      let docs = await database.findByType(type, { limit: 5000, empresaId: req.empresaId || undefined });
      const q = (req.query.q || '').toString().toLowerCase().trim();
      if (q) {
        docs = docs.filter(d =>
          searchFields.some(f => (d[f] || '').toString().toLowerCase().includes(q)));
      }
      docs.sort((a, b) => (a.nombre || a.codigo || a._id).localeCompare(b.nombre || b.codigo || b._id));
      res.json(docs);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.get('/:id', async (req, res) => {
    try {
      const doc = await database.get(req.params.id);
      if (!req.esSuperadmin && doc.empresaId !== req.empresaId) return res.status(404).json({ error: 'No encontrado' });
      res.json(doc);
    } catch (e) { res.status(404).json({ error: 'No encontrado' }); }
  });

  router.post('/', async (req, res) => {
    try {
      if (!req.empresaId) return res.status(400).json({ error: 'Elegí una empresa antes de crear datos' });
      const body = { ...req.body };
      delete body._rev;
      const codigo = body.codigo || await database.nextSeq(req.empresaId, type);
      const id = body._id || `${prefix}:${req.empresaId}:${codigo}`;
      let doc = {
        ...body, _id: id, type,
        empresaId: req.empresaId,
        creado: new Date().toISOString(),
        actualizado: new Date().toISOString()
      };
      if (opts.beforeWrite) doc = await opts.beforeWrite(doc, req, true);
      const saved = await database.insert(doc);
      if (opts.afterWrite) await opts.afterWrite(saved, req, true);
      res.status(201).json(saved);
    } catch (e) {
      if (e.statusCode === 409) return res.status(409).json({ error: 'Ya existe ese código' });
      res.status(500).json({ error: e.message });
    }
  });

  router.put('/:id', async (req, res) => {
    try {
      const current = await database.get(req.params.id);
      if (!req.esSuperadmin && current.empresaId !== req.empresaId) return res.status(404).json({ error: 'No encontrado' });
      let doc = {
        ...current, ...req.body,
        _id: current._id, _rev: current._rev, type,
        empresaId: current.empresaId,
        creado: current.creado,
        actualizado: new Date().toISOString()
      };
      if (opts.beforeWrite) doc = await opts.beforeWrite(doc, req, false);
      const saved = await database.insert(doc);
      if (opts.afterWrite) await opts.afterWrite(saved, req, false);
      res.json(saved);
    } catch (e) {
      if (e.statusCode === 404) return res.status(404).json({ error: 'No encontrado' });
      res.status(500).json({ error: e.message });
    }
  });

  router.delete('/:id', async (req, res) => {
    try {
      const current = await database.get(req.params.id);
      if (!req.esSuperadmin && current.empresaId !== req.empresaId) return res.status(404).json({ error: 'No encontrado' });
      await database.remove(current._id, current._rev);
      res.json({ ok: true });
    } catch (e) { res.status(404).json({ error: 'No encontrado' }); }
  });

  return router;
}
```

- [ ] **Step 2: Verificar sintaxis**

Run: `node --check lib/crud.js`
Expected: sin salida (exit 0).

- [ ] **Step 3: Commit**

```bash
git add lib/crud.js
git commit -m "feat(multiempresa): CRUD generico scopeado por empresa (filtro, empresaId, _id namespaceado)"
```

---

### Task 5: Gestión de empresas (`routes/empresas.js`) + endpoints de contexto

**Files:**
- Create: `routes/empresas.js`
- Modify: `server.js`

CRUD de empresas (solo superadmin), alta del admin inicial, selector de empresa activa, y `/api/empresa` por contexto.

- [ ] **Step 1: Crear `routes/empresas.js`**

```javascript
'use strict';

const express = require('express');
const database = require('../lib/db');
const auth = require('../lib/auth');

const router = express.Router();

// Genera un slug único a partir del nombre. Si choca, agrega sufijo numérico.
function slugify(nombre) {
  const base = String(nombre || '').toLowerCase().trim()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return base || 'empresa';
}

async function slugUnico(nombre) {
  const base = slugify(nombre);
  let slug = base, n = 1;
  while (await database.tryGet(database.empresaDocId(slug))) { n += 1; slug = `${base}-${n}`; }
  return slug;
}

// Listado de empresas (solo superadmin).
router.get('/', auth.requireSuperadmin, async (req, res) => {
  try {
    const docs = await database.findByType('empresa', { limit: 1000 });
    docs.sort((a, b) => (a.nombre || a._id).localeCompare(b.nombre || b._id));
    res.json(docs);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Crea empresa + su usuario admin inicial (solo superadmin).
router.post('/', auth.requireSuperadmin, async (req, res) => {
  const b = req.body || {};
  if (!b.nombre || !b.adminUsuario || !b.adminPassword)
    return res.status(400).json({ error: 'Faltan nombre, adminUsuario o adminPassword' });
  if (await database.tryGet(auth.userDocId(b.adminUsuario)))
    return res.status(409).json({ error: 'Ese nombre de usuario ya existe' });
  try {
    const slug = await slugUnico(b.nombre);
    const empresa = {
      _id: database.empresaDocId(slug), type: 'empresa',
      nombre: b.nombre, razonSocial: b.razonSocial || b.nombre,
      cuit: b.cuit || '', domicilio: b.domicilio || '', localidad: b.localidad || '',
      email: b.email || '', telefono: b.telefono || '',
      activo: true, creado: new Date().toISOString(), actualizado: new Date().toISOString()
    };
    await database.insert(empresa);
    await auth.crearUsuario({ usuario: b.adminUsuario, password: b.adminPassword, nombre: b.adminNombre || b.adminUsuario, rol: 'admin', empresaId: slug });
    res.status(201).json(empresa);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Editar datos / suspender (solo superadmin).
router.put('/:slug', auth.requireSuperadmin, async (req, res) => {
  try {
    const doc = await database.get(database.empresaDocId(req.params.slug));
    const b = req.body || {};
    for (const k of ['nombre', 'razonSocial', 'cuit', 'domicilio', 'localidad', 'email', 'telefono']) {
      if (b[k] != null) doc[k] = b[k];
    }
    if (b.activo != null) doc.activo = !!b.activo;
    doc.actualizado = new Date().toISOString();
    await database.raw().insert(doc);
    res.json(doc);
  } catch (e) {
    if (e.statusCode === 404) return res.status(404).json({ error: 'Empresa no encontrada' });
    res.status(500).json({ error: e.message });
  }
});

// Setea la empresa activa del superadmin (contexto de trabajo).
router.post('/activa', auth.requireSuperadmin, async (req, res) => {
  const slug = (req.body && req.body.empresaId) || null;
  if (slug) {
    const emp = await database.tryGet(database.empresaDocId(slug));
    if (!emp) return res.status(404).json({ error: 'Empresa no encontrada' });
  }
  req.session.empresaActiva = slug;
  res.json({ ok: true, empresaActiva: slug });
});

module.exports = router;
```

- [ ] **Step 2: Montar la ruta y adaptar `/api/empresa` al contexto en `server.js`**

En `server.js`, después de `api.use('/procesos', require('./routes/procesos'));` (línea 101) agregá:

```javascript
api.use('/empresas', require('./routes/empresas'));
```

Reemplazá la línea `api.get('/empresa', (req, res) => res.json(cfg.empresa));` (línea 136) por:

```javascript
// Datos de la empresa del contexto (para rótulos/UI); cae a cfg.empresa si no hay.
api.get('/empresa', async (req, res) => {
  try {
    if (!req.empresaId) return res.json(cfg.empresa);
    const emp = await database.tryGet(database.empresaDocId(req.empresaId));
    res.json(emp || cfg.empresa);
  } catch (e) { res.json(cfg.empresa); }
});
```

- [ ] **Step 3: `/api/me` expone empresaActiva del superadmin**

En `lib/auth.js`, reemplazá el handler `GET /me` (líneas 49-52) por:

```javascript
// GET /api/me
router.get('/me', (req, res) => {
  if (req.session && req.session.user) {
    return res.json({ user: req.session.user, empresaActiva: req.session.empresaActiva || null });
  }
  res.status(401).json({ error: 'No autenticado' });
});
```

- [ ] **Step 4: Verificar sintaxis**

Run: `node --check routes/empresas.js && node --check server.js && node --check lib/auth.js`
Expected: sin salida (exit 0).

- [ ] **Step 5: Prueba funcional con server vivo**

Arrancá el server en segundo plano y probá el flujo de superadmin (requiere CouchDB + seed del superadmin de Task 13; si todavía no corriste el seed, creá el superadmin a mano una vez con `npm run seed` tras Task 13, o reordená para correr Task 13 antes de esta prueba).

Run:
```bash
node server.js &
sleep 2
# login superadmin
curl -s -c /tmp/ck.txt -X POST localhost:3000/api/login -H 'Content-Type: application/json' -d '{"usuario":"superadmin","password":"admin1950"}'
# crear empresa + admin
curl -s -b /tmp/ck.txt -X POST localhost:3000/api/empresas -H 'Content-Type: application/json' -d '{"nombre":"Fabrica 1950","adminUsuario":"admin.f1950","adminPassword":"clave123"}'
# listar empresas
curl -s -b /tmp/ck.txt localhost:3000/api/empresas
kill %1
```
Expected: el login devuelve `rol":"superadmin"`; el POST devuelve la empresa con `_id":"empresa:fabrica-1950"` y `activo":true`; el listado incluye esa empresa.

- [ ] **Step 6: Commit**

```bash
git add routes/empresas.js server.js lib/auth.js
git commit -m "feat(multiempresa): gestion de empresas, empresa activa y /api/empresa por contexto"
```

---

### Task 6: Stock/kardex con empresa (`lib/stock.js`)

**Files:**
- Modify: `lib/stock.js`

`movimiento` recibe `empresaId`, lo guarda en el doc kardex y lo usa para el correlativo namespaceado.

- [ ] **Step 1: `movimiento` propaga `empresaId`**

Reemplazá la función `movimiento` (líneas 23-39) por:

```javascript
async function movimiento({ empresaId, articuloId, articuloTipo, cantidad, motivo, refType, refId, lote, costoUnit, usuario }) {
  const seq = await database.nextSeq(empresaId, 'movimiento');
  const mov = {
    _id: empresaId ? `mov:${empresaId}:${String(seq).padStart(8, '0')}` : `mov:${String(seq).padStart(8, '0')}`,
    type: 'movimiento',
    empresaId: empresaId || null,
    fecha: new Date().toISOString(),
    articuloId, articuloTipo,
    cantidad: Number(cantidad),
    motivo, refType, refId,
    lote: lote || null,
    costoUnit: costoUnit != null ? Number(costoUnit) : null,
    usuario: usuario || null
  };
  await database.insert(mov);
  const nuevoStock = await ajustarStock(articuloId, cantidad);
  return { mov, stock: nuevoStock };
}
```

> `ajustarStock` no cambia: opera sobre un artículo que ya existe (con su `empresaId`).

- [ ] **Step 2: Verificar sintaxis**

Run: `node --check lib/stock.js`
Expected: sin salida (exit 0).

- [ ] **Step 3: Commit**

```bash
git add lib/stock.js
git commit -m "feat(multiempresa): movimientos de stock con empresaId y correlativo por empresa"
```

---

### Task 7: Rutas de negocio scopeadas

**Files:**
- Modify: `routes/ventas.js`, `routes/compras.js`, `routes/fabricacion.js`, `routes/lotes.js`, `routes/movimientos.js`, `routes/dashboard.js`

Cada ruta hecha a mano filtra por `req.empresaId`, inyecta `empresaId` en los docs que crea, namespacea sus IDs/correlativos y pasa `empresaId` a `stock.movimiento`.

> **Patrón general (aplicalo en cada archivo):**
> - Cada `database.findByType(T, { limit })` → `database.findByType(T, { limit, empresaId: req.empresaId || undefined })`.
> - Cada `database.find({ selector: { type, ... } })` → agregá `empresaId: req.empresaId` al `selector`.
> - Cada `database.nextSeq('X')` → `database.nextSeq(req.empresaId, 'X')`.
> - Cada `database.insert({ _id: 'X:...', type, ... })` → agregá `empresaId: req.empresaId` y namespaceá el `_id` con `req.empresaId` (`X:<empresaId>:<codigo>`).
> - Cada `stock.movimiento({ ... })` → agregá `empresaId: req.empresaId`.
> - Tras un `database.get(id)`/`tryGet(id)` de un recurso que debe ser de la empresa, validá `doc.empresaId === req.empresaId` (salvo `req.esSuperadmin`); si no, respondé 404.

- [ ] **Step 1: `routes/ventas.js`**

Aplicá el patrón. Concretamente:
- Línea 11: `findByType('venta', { limit: 5000 })` → `findByType('venta', { limit: 5000, empresaId: req.empresaId || undefined })`.
- Línea 18 (`get`): tras obtener la venta, agregá guard de pertenencia (404 si no es de la empresa).
- Línea 31 (`tryGet(it.productoId)`): tras obtener el producto, rechazá con 400 `Producto inválido` si `prod.empresaId !== req.empresaId`.
- Línea 37: `nextSeq('venta')` → `nextSeq(req.empresaId, 'venta')`; el `_id` de la venta pasa a `venta:<empresaId>:<seq>`.
- Línea 50 (`find` de lotes FEFO): agregá `empresaId: req.empresaId` al selector.
- Línea 58 (`insert` venta): agregá `empresaId: req.empresaId`.
- Línea 69 (`stock.movimiento`): agregá `empresaId: req.empresaId`.

Antes de empezar, leé el archivo completo para ubicar el código exacto:
Run: `node -e "process.stdout.write(require('fs').readFileSync('routes/ventas.js','utf8'))"`

- [ ] **Step 2: `routes/compras.js`**

- Línea 12: `findByType('compra', ...)` con `empresaId`.
- Línea 19 (`get`): guard de pertenencia.
- Línea 29: `nextSeq('compra')` → `nextSeq(req.empresaId, 'compra')`; `_id` → `compra:<empresaId>:<seq>`.
- Línea 43 (`insert` compra): agregá `empresaId: req.empresaId`.
- Línea 55 (`stock.movimiento`): agregá `empresaId: req.empresaId`.
- Línea 62 (`get(it.insumoId)`): guard `ins.empresaId === req.empresaId` (400 `Insumo inválido` si no).

- [ ] **Step 3: `routes/fabricacion.js`**

- Línea 20: `findByType('orden', ...)` con `empresaId`.
- Líneas 27/38/44 (`get` orden/producto/receta): guards de pertenencia (404 / 400 según corresponda).
- Línea 59/74 (`tryGet(c.insumoId)`): guard de pertenencia (400 si el insumo no es de la empresa).
- Línea 67: `nextSeq('orden')` → `nextSeq(req.empresaId, 'orden')`; `_id` orden → `orden:<empresaId>:<seq>`.
- Línea 88 (`insert` lote): agregá `empresaId: req.empresaId`; el `_id` del lote pasa a `lote:<empresaId>:<codigo>`.
- Línea 97 (`insert` orden): agregá `empresaId: req.empresaId`.
- Líneas 78/109 (`stock.movimiento`): agregá `empresaId: req.empresaId`.
- Línea 118 (`get(productoId)`): guard de pertenencia.

> **Importante (código de lote):** el código visible del lote (`YYMMDD-seq`) se mantiene para el rótulo, pero el `_id` se namespacea (`lote:<empresaId>:<codigo>`). Guardá el código visible en un campo `codigo` del doc lote (ya existe) y construí el `_id` con el slug. La página pública `/t/:codigo` (Task 11) busca por el campo `codigo` vía Mango, no por `_id` directo.

- [ ] **Step 4: `routes/lotes.js`**

- Línea 10: `findByType('lote', ...)` con `empresaId`.
- Líneas 17/24 (`get` lote): guard de pertenencia.
- Línea 25 (`tryGet(lote.ordenId)`): sin guard extra (deriva del lote ya validado).
- Línea 28 (`find` movimientos por `lote`): agregá `empresaId: req.empresaId` al selector.
- Líneas 33/46/47 (`tryGet` insumo/refId/cliente): son derivados de docs ya validados; no requieren guard adicional.

- [ ] **Step 5: `routes/movimientos.js`**

- Línea 11: en el `find({ selector: { type: 'movimiento', articuloId } })`, agregá `empresaId: req.empresaId` al selector.

- [ ] **Step 6: `routes/dashboard.js`**

- Líneas 16-21: las seis llamadas `findByType('venta'|'compra'|'producto'|'insumo'|'orden'|'lote', { limit: 5000 })` → agregá `empresaId: req.empresaId || undefined` a cada una.

- [ ] **Step 7: Verificar sintaxis de todas**

Run: `node --check routes/ventas.js && node --check routes/compras.js && node --check routes/fabricacion.js && node --check routes/lotes.js && node --check routes/movimientos.js && node --check routes/dashboard.js`
Expected: sin salida (exit 0).

- [ ] **Step 8: Prueba de aislamiento (server vivo)**

Con CouchDB y el superadmin disponibles (ver Task 13), creá dos empresas con sus admin, cargá un insumo en cada una y verificá que no se ven cruzados.

Run:
```bash
node server.js &
sleep 2
# crear empresas A y B como superadmin
curl -s -c /tmp/s.txt -X POST localhost:3000/api/login -H 'Content-Type: application/json' -d '{"usuario":"superadmin","password":"admin1950"}' >/dev/null
curl -s -b /tmp/s.txt -X POST localhost:3000/api/empresas -H 'Content-Type: application/json' -d '{"nombre":"Empresa A","adminUsuario":"admin.a","adminPassword":"a12345"}' >/dev/null
curl -s -b /tmp/s.txt -X POST localhost:3000/api/empresas -H 'Content-Type: application/json' -d '{"nombre":"Empresa B","adminUsuario":"admin.b","adminPassword":"b12345"}' >/dev/null
# admin A crea un insumo
curl -s -c /tmp/a.txt -X POST localhost:3000/api/login -H 'Content-Type: application/json' -d '{"usuario":"admin.a","password":"a12345"}' >/dev/null
curl -s -b /tmp/a.txt -X POST localhost:3000/api/insumos -H 'Content-Type: application/json' -d '{"nombre":"Harina A","codigo":"HAR"}' >/dev/null
# admin B lista insumos: NO debe ver "Harina A"
curl -s -c /tmp/b.txt -X POST localhost:3000/api/login -H 'Content-Type: application/json' -d '{"usuario":"admin.b","password":"b12345"}' >/dev/null
echo "Insumos visibles para B (debe ser []):"
curl -s -b /tmp/b.txt localhost:3000/api/insumos
kill %1
```
Expected: el último listado es `[]` (B no ve el insumo de A).

- [ ] **Step 9: Commit**

```bash
git add routes/ventas.js routes/compras.js routes/fabricacion.js routes/lotes.js routes/movimientos.js routes/dashboard.js
git commit -m "feat(multiempresa): rutas de negocio scopeadas por empresa"
```

---

### Task 8: Máquinas con empresa (`lib/maquinas.js`, `routes/maquinas.js`)

**Files:**
- Modify: `lib/maquinas.js`, `routes/maquinas.js`

El pairing asocia la máquina a la empresa que generó el código. El gateway (Task 9) necesita la `empresaId` de la máquina, así que `vincular` la persiste en el doc.

- [ ] **Step 1: `crearPairing` y `vincular` con `empresaId`**

En `lib/maquinas.js`, reemplazá `crearPairing` (líneas 31-36) por:

```javascript
async function crearPairing(empresaId) {
  const codigo = generarCodigoPairing();
  const vence = new Date(Date.now() + PAIRING_TTL_MS).toISOString();
  await database.insert({ _id: `pairing:${codigo}`, type: 'pairing', codigo, empresaId: empresaId || null, usado: false, vence, creado: new Date().toISOString() });
  return { codigo, vence };
}
```

> El `_id` del pairing se mantiene global (`pairing:<codigo>`) porque el dispositivo envía solo el código de 6 dígitos sin empresa; la empresa viaja DENTRO del doc. El código es efímero y de un solo uso, así que la probabilidad de colisión entre empresas en la ventana de validez es despreciable; si `insert` da 409 por colisión, `crearPairing` se reintenta desde la ruta (ver Step 3).

En la función `vincular` (líneas 40-68), agregá `empresaId` al doc de máquina. Reemplazá el bloque del `database.insert` de la máquina (líneas 58-66) por:

```javascript
  await database.insert({
    _id: maquinaId, type: 'maquina',
    empresaId: pdoc.empresaId || null,
    nombre: serial || 'Máquina nueva',
    serial: serial || '', tokenHash,
    online: false, ultimoVisto: null, ip: '',
    fwVersion: fwVersion || '', estado: {}, recetaActiva: '',
    creado: new Date().toISOString()
  });
```

> `pdoc` es el doc de pairing recuperado al inicio de `vincular`; de ahí sale la `empresaId`.

- [ ] **Step 2: Verificar la firma exacta y exports de `lib/maquinas.js`**

Leé el archivo para confirmar que `crearPairing`/`vincular` están exportadas y ajustá si hace falta:
Run: `node -e "console.log(Object.keys(require('./lib/maquinas')))"`
Expected: incluye `crearPairing`, `vincular`, `verifyToken`.

- [ ] **Step 3: Scopear `routes/maquinas.js`**

Leé el archivo completo primero:
Run: `node -e "process.stdout.write(require('fs').readFileSync('routes/maquinas.js','utf8'))"`

Aplicá:
- Línea 24: `findByType('maquina', { limit: 1000 })` → agregá `empresaId: req.empresaId || undefined`.
- Líneas 31/64/87 (`get(req.params.id)` de una máquina): tras el get, guard `maq.empresaId === req.empresaId` (salvo `req.esSuperadmin`), 404 si no.
- En el endpoint que genera el código de pairing (busca el que llama a `maquinas.crearPairing(...)`): pasá `req.empresaId` → `maquinas.crearPairing(req.empresaId)`. Si `!req.empresaId`, respondé 400 `Elegí una empresa`.
- Línea 76 (`get(req.body.firmwareId)`): el firmware es global (no lleva `empresaId`); NO agregues guard de empresa ahí.

- [ ] **Step 4: Verificar sintaxis**

Run: `node --check lib/maquinas.js && node --check routes/maquinas.js`
Expected: sin salida (exit 0).

- [ ] **Step 5: Commit**

```bash
git add lib/maquinas.js routes/maquinas.js
git commit -m "feat(multiempresa): pairing y maquinas asociadas a su empresa"
```

---

### Task 9: Gateway y procesos con empresa (`lib/cloudGateway.js`, `lib/procesos.js`)

**Files:**
- Modify: `lib/cloudGateway.js`, `lib/procesos.js`

La telemetría que entra por WebSocket se guarda en `procterm` con la `empresaId` de la máquina, para que cada empresa vea solo sus curvas.

- [ ] **Step 1: `registrarMuestra` y `cerrarProceso` con `empresaId`**

En `lib/procesos.js`, reemplazá `cerrarProceso` (líneas 61-72) por:

```javascript
async function cerrarProceso(maquinaId, empresaId) {
  const pid = abiertos.get(maquinaId);
  if (!pid) return;
  abiertos.delete(maquinaId);
  const id = empresaId ? `procterm:${empresaId}:${pid}` : `procterm:${pid}`;
  if (!(await database.tryGet(id))) return;
  await _upsert(id, (doc) => {
    if (doc.fin) return;
    doc.fin = new Date().toISOString();
    doc.resumen = calcularResumen(doc);
  });
}
```

Reemplazá la firma y el cuerpo de `registrarMuestra` (líneas 76-113) para recibir `empresaId`, namespacear el `_id` y guardar el campo. Reemplazá:

```javascript
async function registrarMuestra(maquinaId, serial, estado) {
```
por:
```javascript
async function registrarMuestra(empresaId, maquinaId, serial, estado) {
```

Dentro, reemplazá `const previo = abiertos.get(maquinaId); if (previo && previo !== pid) await cerrarProceso(maquinaId);` por:
```javascript
    const previo = abiertos.get(maquinaId);
    if (previo && previo !== pid) await cerrarProceso(maquinaId, empresaId);
```

Reemplazá `const id = \`procterm:${pid}\`;` por:
```javascript
    const id = empresaId ? `procterm:${empresaId}:${pid}` : `procterm:${pid}`;
```

Dentro del `_upsert(id, (doc, isNew) => { if (isNew) { ... } })`, agregá `doc.empresaId = empresaId || null;` como primera asignación del bloque `if (isNew)`.

Y reemplazá la rama final `} else if (abiertos.has(maquinaId)) { await cerrarProceso(maquinaId); }` por:
```javascript
  } else if (abiertos.has(maquinaId)) {
    await cerrarProceso(maquinaId, empresaId);
  }
```

- [ ] **Step 2: El gateway pasa la `empresaId` de la máquina**

En `lib/cloudGateway.js`, en el handler de conexión (función `attach`), donde se valida el token y se recupera el doc de la máquina (alrededor de la línea 96, `const doc = await database.tryGet(msg.maquinaId);`), guardá la empresa en una variable de cierre. Agregá junto a `let id = null;` (línea ~85):

```javascript
    let empresaId = null;
```

Y tras autenticar (después de `id = msg.maquinaId;`, línea ~99) agregá:

```javascript
      empresaId = doc.empresaId || null;
```

Cambiá ambas llamadas a `_onMessage(id, ip, msg)` por `_onMessage(id, empresaId, ip, msg)`.

Reemplazá la firma de `_onMessage` (línea 58) `async function _onMessage(id, ip, msg) {` por `async function _onMessage(id, empresaId, ip, msg) {` y la llamada a procesos (línea ~67) `await procesos.registrarMuestra(id, msg.serial, msg.estado);` por:

```javascript
      await procesos.registrarMuestra(empresaId, id, msg.serial, msg.estado);
```

- [ ] **Step 3: Scopear el listado/detalle en `routes/procesos.js`**

- Línea 15: `findByType('procterm', { selector, fields, limit })` → agregá `empresaId: req.empresaId || undefined`.
- Líneas 28/35/107 (`get(req.params.id)`): guard `doc.empresaId === req.empresaId` (salvo `req.esSuperadmin`), 404 si no.

- [ ] **Step 4: Verificar sintaxis**

Run: `node --check lib/procesos.js && node --check lib/cloudGateway.js && node --check routes/procesos.js`
Expected: sin salida (exit 0).

- [ ] **Step 5: Commit**

```bash
git add lib/procesos.js lib/cloudGateway.js routes/procesos.js
git commit -m "feat(multiempresa): telemetria y procesos termicos por empresa"
```

---

### Task 10: Firmware global (`routes/firmware.js`, `server.js`)

**Files:**
- Modify: `routes/firmware.js`

El firmware lo gestiona solo el superadmin y es común a todas las empresas. NO lleva `empresaId`.

- [ ] **Step 1: Restringir la gestión de firmware a superadmin**

Leé el archivo:
Run: `node -e "process.stdout.write(require('fs').readFileSync('routes/firmware.js','utf8'))"`

En las rutas que **suben/listan/borran** binarios (las que hoy escriben/leen docs `firmware`), agregá `auth.requireSuperadmin` como middleware. Importá auth si no está: agregá al tope `const auth = require('../lib/auth');`. Ejemplo de patrón:
```javascript
router.post('/', auth.requireSuperadmin, /* handler existente */);
router.delete('/:id', auth.requireSuperadmin, /* handler existente */);
```
El `GET /` de listado puede quedar accesible a cualquier autenticado (las máquinas y la UI de máquinas lo consultan para elegir versión OTA); NO le agregues `empresaId`.

> El servido estático `app.use('/firmware', express.static(...))` en `server.js` (línea 141) queda igual: descarga pública para OTA.

- [ ] **Step 2: Verificar sintaxis**

Run: `node --check routes/firmware.js`
Expected: sin salida (exit 0).

- [ ] **Step 3: Commit**

```bash
git add routes/firmware.js
git commit -m "feat(multiempresa): gestion de firmware restringida a superadmin (global)"
```

---

### Task 11: Trazabilidad pública y rótulos con branding por empresa

**Files:**
- Modify: `server.js`, `routes/etiquetas.js`

La página pública `/t/:codigo` y los rótulos usan los datos de la empresa dueña del lote, con `cfg.empresa` como fallback.

- [ ] **Step 1: `/t/:codigo` busca el lote por campo `codigo` y carga la empresa**

En `server.js`, reemplazá el handler `app.get('/t/:codigo', ...)` (líneas 70-77) por:

```javascript
app.get('/t/:codigo', async (req, res) => {
  try {
    // El _id del lote está namespaceado por empresa; buscamos por el campo "codigo".
    const lotes = await database.find({ selector: { type: 'lote', codigo: req.params.codigo }, limit: 1 });
    const lote = lotes[0];
    if (!lote) return res.status(404).send('Lote no encontrado');
    const producto = await database.tryGet(lote.productoId);
    const empresa = lote.empresaId ? await database.tryGet(database.empresaDocId(lote.empresaId)) : null;
    res.send(publicTrace(lote, producto, req.query.s, empresa || cfg.empresa));
  } catch (e) { res.status(500).send('Error'); }
});
```

- [ ] **Step 2: `publicTrace` recibe la empresa**

En `server.js`, reemplazá la firma de `publicTrace` (línea 148) `function publicTrace(lote, producto, serie) {` por `function publicTrace(lote, producto, serie, empresa) {`. Dentro, reemplazá la interpolación que usa `cfg.empresa.razonSocial` (línea 167) por `${(empresa && empresa.razonSocial) || cfg.empresa.razonSocial}`.

- [ ] **Step 3: Rótulos con branding de empresa en `routes/etiquetas.js`**

Leé el archivo:
Run: `node -e "process.stdout.write(require('fs').readFileSync('routes/etiquetas.js','utf8'))"`

En los dos puntos donde se usa `cfg.empresa` (líneas ~36 y ~94), reemplazá por los datos de la empresa del contexto. Al inicio de cada handler que arma el print-data, cargá:
```javascript
    const empresa = req.empresaId ? (await database.tryGet(database.empresaDocId(req.empresaId))) || cfg.empresa : cfg.empresa;
```
y usá `empresa.razonSocial` / `empresa.cuit` / etc. en lugar de `cfg.empresa.*`. Importá `database` y `cfg` si no estuvieran ya importados en el archivo (verificá el `require` al tope).

- [ ] **Step 4: Verificar sintaxis**

Run: `node --check server.js && node --check routes/etiquetas.js`
Expected: sin salida (exit 0).

- [ ] **Step 5: Commit**

```bash
git add server.js routes/etiquetas.js
git commit -m "feat(multiempresa): trazabilidad publica y rotulos con branding por empresa"
```

---

### Task 12: Frontend multi-empresa (`public/js/app.js`, `public/index.html`)

**Files:**
- Modify: `public/js/app.js`, `public/index.html`

El superadmin obtiene un selector de empresa en la barra superior y una vista "Empresas"; los usuarios normales ven fija su empresa. La nav muestra ítems `data-superadmin` solo al superadmin.

- [ ] **Step 1: Nav con ítems de superadmin en `index.html`**

En `public/index.html`, reemplazá el bloque de "Sistema" (líneas 53-55) por:

```html
        <div class="grp" data-superadmin>Sistema</div>
        <a data-route="empresas" data-superadmin><span class="ic">🏢</span> Empresas</a>
        <a data-route="firmware" data-superadmin><span class="ic">⬆</span> Firmware</a>
        <a data-route="usuarios" data-admin><span class="ic">⚷</span> Usuarios</a>
```

Y en la barra superior, antes del bloque `<div class="user">` (línea 69), agregá el contenedor del selector:

```html
        <div id="empresaSwitch" class="hidden" style="margin-left:auto;display:flex;align-items:center;gap:.5rem">
          <label style="font-size:.8rem;color:var(--muted)">Empresa</label>
          <select id="empresaSel" class="input" style="width:auto;min-width:180px"></select>
        </div>
```

- [ ] **Step 2: Contexto de empresa en `app.js`**

Leé el archivo para ubicar el manejo de sesión/usuario actual y el objeto de rutas/nav:
Run: `node -e "process.stdout.write(require('fs').readFileSync('public/js/app.js','utf8'))"`

Buscá dónde se guarda el usuario tras `/api/me`/login (variable de estado del usuario, p. ej. `state.user` o similar) y dónde se aplica la visibilidad de `data-admin` en la nav. Agregá lógica equivalente para `data-superadmin`:
- Tras cargar `/api/me`, guardá `esSuperadmin = user.rol === 'superadmin'` y `empresaActiva`.
- Mostrá u oculta los nodos `[data-superadmin]` según `esSuperadmin` (mismo patrón que el código actual usa para `[data-admin]`).
- Si es superadmin, mostrá `#empresaSwitch` (quitá `hidden`) y poblá `#empresaSel` con `GET /api/empresas`; seleccioná `empresaActiva`. Al cambiar el `select`, hacé `POST /api/empresas/activa {empresaId}` y luego recargá la vista actual.

Código a agregar (adaptá los nombres de helpers `api/get/post` y la variable de usuario a los reales del archivo):

```javascript
async function initEmpresaSwitch(user, empresaActiva) {
  document.querySelectorAll('[data-superadmin]').forEach(el => {
    el.style.display = user.rol === 'superadmin' ? '' : 'none';
  });
  if (user.rol !== 'superadmin') return;
  const sw = document.getElementById('empresaSwitch');
  const sel = document.getElementById('empresaSel');
  const empresas = await get('/empresas');
  sel.innerHTML = '<option value="">— Elegí una empresa —</option>' +
    empresas.map(e => `<option value="${esc(e._id.replace('empresa:',''))}">${esc(e.nombre)}</option>`).join('');
  sel.value = empresaActiva || '';
  sw.classList.remove('hidden');
  sel.onchange = async () => {
    await post('/empresas/activa', { empresaId: sel.value || null });
    location.reload();
  };
}
```

Llamá a `initEmpresaSwitch(user, empresaActiva)` en el arranque de la app, después de pintar la nav (donde hoy se aplica `data-admin`). Tomá `empresaActiva` de la respuesta de `/api/me`.

> Nota: usá los helpers `get`/`post`/`esc` que ya existen en `app.js`. Si `get`/`post` no aceptan rutas relativas a `/api`, usá la forma que use el resto del archivo (p. ej. `api('/empresas')`).

- [ ] **Step 3: Vista "Empresas" (solo superadmin)**

Agregá `'empresas'` al map de TITLES (`['Empresas','Alta y administración de empresas']`) y a VIEWS (`empresas: empresasView`). Implementá `empresasView(c)` siguiendo el patrón de las otras vistas (`crudView`/render manual). Debe:
- Listar empresas (`GET /api/empresas`) en una tabla: nombre, CUIT, estado (activa/suspendida), botones Editar / Suspender-Reactivar.
- Botón "Nueva empresa" que abre un `modal()` con campos: nombre, razón social, CUIT, domicilio, email, teléfono, **usuario admin** y **contraseña admin**; al guardar hace `POST /api/empresas`.
- Editar: `modal()` con los datos; guarda con `PUT /api/empresas/:slug` (slug = `_id` sin `empresa:`).
- Suspender/Reactivar: `PUT /api/empresas/:slug { activo:false|true }`.

Código de la vista (adaptá helpers a los reales del archivo — `modal`, `toast`, `btn`, `esc`, `get`, `post`, `put`):

```javascript
async function empresasView(c) {
  const empresas = await get('/empresas');
  c.innerHTML = `
    <div class="toolbar"><button class="btn btn-primary" id="nuevaEmp">+ Nueva empresa</button></div>
    <table class="table"><thead><tr><th>Nombre</th><th>CUIT</th><th>Estado</th><th></th></tr></thead>
    <tbody>${empresas.map(e => {
      const slug = e._id.replace('empresa:', '');
      return `<tr>
        <td>${esc(e.nombre)}</td><td>${esc(e.cuit || '—')}</td>
        <td>${e.activo === false ? '<span class="pill warn">Suspendida</span>' : '<span class="pill">Activa</span>'}</td>
        <td style="text-align:right">
          <button class="btn btn-sm" data-edit="${esc(slug)}">Editar</button>
          <button class="btn btn-sm" data-toggle="${esc(slug)}" data-act="${e.activo === false ? '1' : '0'}">${e.activo === false ? 'Reactivar' : 'Suspender'}</button>
        </td></tr>`;
    }).join('')}</tbody></table>`;

  document.getElementById('nuevaEmp').onclick = () => formEmpresa();
  c.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => {
    const e = empresas.find(x => x._id.replace('empresa:', '') === b.dataset.edit);
    formEmpresa(e);
  });
  c.querySelectorAll('[data-toggle]').forEach(b => b.onclick = async () => {
    await put('/empresas/' + b.dataset.toggle, { activo: b.dataset.act === '1' });
    toast('Empresa actualizada'); render();
  });
}

function formEmpresa(e) {
  const esNueva = !e;
  const body = `
    <div class="field"><label>Nombre</label><input id="emp_nombre" class="input" value="${esc(e?.nombre || '')}"></div>
    <div class="field"><label>Razón social</label><input id="emp_razon" class="input" value="${esc(e?.razonSocial || '')}"></div>
    <div class="field"><label>CUIT</label><input id="emp_cuit" class="input" value="${esc(e?.cuit || '')}"></div>
    <div class="field"><label>Domicilio</label><input id="emp_dom" class="input" value="${esc(e?.domicilio || '')}"></div>
    <div class="field"><label>Email</label><input id="emp_email" class="input" value="${esc(e?.email || '')}"></div>
    <div class="field"><label>Teléfono</label><input id="emp_tel" class="input" value="${esc(e?.telefono || '')}"></div>
    ${esNueva ? `<hr><div class="field"><label>Usuario admin</label><input id="emp_au" class="input"></div>
    <div class="field"><label>Contraseña admin</label><input id="emp_ap" class="input" type="password"></div>` : ''}`;
  modal(esNueva ? 'Nueva empresa' : 'Editar empresa', body, async () => {
    const datos = {
      nombre: val('emp_nombre'), razonSocial: val('emp_razon'), cuit: val('emp_cuit'),
      domicilio: val('emp_dom'), email: val('emp_email'), telefono: val('emp_tel')
    };
    if (esNueva) {
      datos.adminUsuario = val('emp_au'); datos.adminPassword = val('emp_ap');
      await post('/empresas', datos);
    } else {
      await put('/empresas/' + e._id.replace('empresa:', ''), datos);
    }
    toast('Guardado'); render();
  });
}

function val(id) { return document.getElementById(id).value.trim(); }
```

> Adaptá `modal(title, bodyHtml, onSave)`, `render()`, `val()` y los helpers a las firmas reales que ya usa `app.js`. Si ya existe un helper de input-value, reutilizalo en vez de `val`.

- [ ] **Step 4: Verificar sintaxis del JS del frontend**

Run: `node --check public/js/app.js`
Expected: sin salida (exit 0).

- [ ] **Step 5: Prueba manual en navegador**

Arrancá el server, entrá como `superadmin`, verificá: aparece el selector de empresa y la vista "Empresas"; creá una empresa con su admin; cambiá la empresa activa y confirmá que las vistas de negocio muestran datos de esa empresa. Luego entrá como el admin de una empresa y confirmá que NO ves el selector ni "Empresas"/"Firmware".

- [ ] **Step 6: Commit**

```bash
git add public/js/app.js public/index.html
git commit -m "feat(multiempresa): frontend con selector de empresa, vista Empresas y nav de superadmin"
```

---

### Task 13: Arranque limpio — seed superadmin + script de wipe

**Files:**
- Modify: `lib/seed.js`, `server.js`, `config.js`, `package.json`
- Create: `scripts/wipe.js`

El seed deja de cargar la Fábrica 1950 de ejemplo y crea un superadmin. Un script de wipe (manual) vacía la base.

- [ ] **Step 1: `config.js` — bootstrap del superadmin**

En `config.js`, reemplazá el bloque `bootstrapAdmin` (líneas 25-30) por:

```javascript
  bootstrapAdmin: {
    usuario: process.env.ADMIN_USER || 'superadmin',
    password: process.env.ADMIN_PASS || 'admin1950',
    nombre: 'Superadmin',
    rol: 'superadmin'
  },
```

- [ ] **Step 2: `lib/seed.js` — `ensureSuperadmin`, sin sample data**

Reemplazá `ensureAdmin` (líneas 7-12) por:

```javascript
async function ensureSuperadmin() {
  const id = auth.userDocId(cfg.bootstrapAdmin.usuario);
  if (await database.tryGet(id)) return;
  await auth.crearUsuario({ ...cfg.bootstrapAdmin, empresaId: null });
  console.log('[seed] Usuario superadmin creado.');
}
```

Eliminá la función `ensureSampleData` (líneas 14-69) por completo y ajustá el `module.exports` para exportar solo `ensureSuperadmin` (y lo que ya exportara que siga vigente). Si el archivo se ejecuta standalone (tiene un bloque tipo `if (require.main === module)`), que llame a `ensureSuperadmin`.

- [ ] **Step 3: `server.js` — usar `ensureSuperadmin`**

En `server.js`, en el bloque de arranque (líneas 172-186), reemplazá:

```javascript
      await seed.ensureAdmin();
      await seed.ensureSampleData();
```
por:
```javascript
      await seed.ensureSuperadmin();
```

Y reemplazá el log de credenciales (líneas 182-183) por:
```javascript
    console.log(`  Usuario: ${cfg.bootstrapAdmin.usuario}  Clave: ${cfg.bootstrapAdmin.password}\n`);
```
(ya usa `cfg.bootstrapAdmin`, así que con el cambio de Step 1 muestra `superadmin`).

- [ ] **Step 4: Crear `scripts/wipe.js`**

```javascript
'use strict';

// Borra TODOS los documentos de negocio (deja índices de diseño _design intactos).
// Uso: node scripts/wipe.js --si
// Requiere CouchDB accesible (config.js / COUCH_URL).

const database = require('../lib/db');

async function main() {
  if (!process.argv.includes('--si')) {
    console.log('Esto BORRA todos los datos. Reejecutá con: node scripts/wipe.js --si');
    process.exit(1);
  }
  const ok = await database.init();
  if (!ok) { console.error('No hay CouchDB.'); process.exit(1); }
  const db = database.raw();
  const all = await db.list({ include_docs: false });
  const dels = all.rows
    .filter(r => !r.id.startsWith('_design/'))
    .map(r => ({ _id: r.id, _rev: r.value.rev, _deleted: true }));
  if (!dels.length) { console.log('Base ya vacía.'); return; }
  await db.bulk({ docs: dels });
  console.log(`Borrados ${dels.length} documentos.`);
}

main().catch(e => { console.error(e); process.exit(1); });
```

- [ ] **Step 5: `package.json` — script `wipe`**

En `package.json`, en `"scripts"`, agregá:

```json
    "wipe": "node scripts/wipe.js"
```

(respetá las comas del JSON existente).

- [ ] **Step 6: Verificar sintaxis**

Run: `node --check lib/seed.js && node --check server.js && node --check config.js && node --check scripts/wipe.js`
Expected: sin salida (exit 0).

- [ ] **Step 7: Prueba de arranque limpio**

Run:
```bash
node scripts/wipe.js --si
node server.js &
sleep 2
curl -s -X POST localhost:3000/api/login -H 'Content-Type: application/json' -d '{"usuario":"superadmin","password":"admin1950"}'
kill %1
```
Expected: el wipe reporta borrados (o "Base ya vacía"); el arranque crea el superadmin (`[seed] Usuario superadmin creado.`); el login devuelve `rol":"superadmin"`.

- [ ] **Step 8: Commit**

```bash
git add lib/seed.js server.js config.js scripts/wipe.js package.json
git commit -m "feat(multiempresa): seed de superadmin sin datos de ejemplo + script de wipe"
```

---

## Verificación final (end-to-end)

Tras completar todas las tareas:

1. `node scripts/wipe.js --si` y reiniciar el server.
2. Entrar como `superadmin`; crear dos empresas (A y B) con su admin cada una.
3. Como admin A: cargar insumo, producto, receta, registrar una compra y una venta; verificar correlativos arrancando en 1.
4. Como admin B: confirmar que NO ve nada de A (listados vacíos; acceso por `_id` de A da 404).
5. Como superadmin: alternar empresa activa y comprobar que el contexto cambia; subir un firmware (solo superadmin) y verificar que admin A/B no ven la vista Firmware.
6. Vincular la máquina física desde A (generar código, re-emparejar); confirmar que sus procesos/curvas aparecen solo en A.
7. Generar un rótulo en A y abrir `/t/<codigo>`: debe mostrar la razón social de la empresa A.

## Notas de despliegue

- El cambio de credenciales bootstrap (`admin`→`superadmin`) implica que en producción hay que correr el wipe + reiniciar (o crear el superadmin manualmente) y volver a dar de alta empresas y re-vincular máquinas.
- Recordar que las sesiones son en memoria (se reinician con cada restart) — limitación preexistente, no introducida por este cambio.
