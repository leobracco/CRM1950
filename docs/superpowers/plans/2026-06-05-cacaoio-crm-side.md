# Integración CacaoIO — Lado CRM — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Agregar al CRM 1950 la capacidad de controlar máquinas CacaoIO por WebSocket en la nube: registro/pairing de máquinas, control en vivo, recetas de templado y OTA de firmware.

**Architecture:** Un gateway WebSocket (librería `ws`) montado sobre el mismo server HTTP de Express (puerto 6001, TLS por nginx). Los dispositivos abren una conexión saliente `wss://.../device-ws`, se autentican con `{maquinaId, token}` y mantienen un heartbeat. El navegador admin habla REST con el CRM y recibe estado en vivo por SSE. Documentos nuevos en la misma base CouchDB discriminados por `type` (`maquina`, `receta_templado`, `firmware`, `pairing`). Los binarios de firmware se guardan en disco y se sirven bajo `/firmware`.

**Tech Stack:** Node.js + Express 4 · `ws` · `multer` · CouchDB (nano) · bcryptjs · `crypto` (built-in) · `node:test` (built-in) · SPA vanilla JS.

---

## Notas de contexto para el implementador

- **No hay test runner previo** en este repo. Este plan agrega `node:test` (incluido en Node 20, sin dependencias) solo para la lógica pura (pairing/token y registro del gateway). El cableado HTTP/WS se verifica manualmente con `curl` y un mock device.
- **Patrón de datos:** todo doc lleva `type`. Helpers en `lib/db.js` (`findByType`, `get`, `tryGet`, `insert`, `remove`, `find`). IDs con prefijo `prefijo:codigo`.
- **Auth:** `auth.requireAuth` y `auth.requireRole('admin')` ya existen en `lib/auth.js`. Passwords/tokens se hashean con `bcryptjs`.
- **Config:** `config.js` lee `process.env` directo (sin dotenv). En el server, las env se exportan antes de arrancar pm2.
- **Arranque del server:** `server.js` crea `app`, monta routers bajo `/api`, y al final hace `app.listen(cfg.port)`. Para WebSocket hay que capturar el `http.Server` que devuelve `listen` y enganchar el upgrade.
- **Convención de commits del repo:** mensajes cortos en español, imperativo (ej. "agrega control de máquinas por websocket").

---

## Estructura de archivos (lado CRM)

| Archivo | Responsabilidad |
|---|---|
| `lib/protocol.js` (crear) | Constantes de tipos de mensaje WS, compartidas. |
| `lib/maquinas.js` (crear) | Lógica pura: generar código de pairing, generar/hashear/verificar token, crear doc máquina. |
| `lib/cloudGateway.js` (crear) | Servidor WS, autenticación de dispositivos, registro en memoria `maquinaId→socket`, suscriptores SSE, broadcast. |
| `routes/maquinas.js` (crear) | REST admin: listar, detalle, comando, enviar receta, generar pairing, lanzar OTA + SSE stream. |
| `routes/firmware.js` (crear) | Subir/listar binarios (multer), metadatos sha256. |
| `server.js` (modificar) | Montar gateway en el upgrade HTTP, ruta pública de pairing, CRUD recetas de templado, servir `/firmware`, coerción numérica de recetas. |
| `config.js` (modificar) | Agregar `publicUrl`. |
| `lib/db.js` (modificar) | Índices Mango para los nuevos `type`. |
| `package.json` (modificar) | Deps `ws`, `multer`; script `test`. |
| `public/index.html` (modificar) | Entradas de nav "Máquinas" y "Recetas de templado". |
| `public/js/app.js` (modificar) | Vistas `maquinasView`, CRUD recetas de templado, cliente SSE, modales de comando/OTA/pairing. |
| `public/css/styles.css` (modificar) | Estilos de las tarjetas de máquina. |
| `test/maquinas.test.js` (crear) | Unit tests de `lib/maquinas.js`. |
| `test/gateway.test.js` (crear) | Unit tests del registro/auth de `lib/cloudGateway.js`. |
| `test/mock-device.js` (crear) | Cliente WS de prueba para verificación manual E2E. |

---

## Task 1: Dependencias, script de test y constantes de protocolo

**Files:**
- Modify: `package.json`
- Create: `lib/protocol.js`

- [ ] **Step 1: Agregar dependencias**

Run:
```bash
cd "G:/LeonardoBracco/Productos/Cacao.io/Software/App_PC/CRM"
npm install ws@^8.18.0 multer@^1.4.5-lts.1
```
Expected: `package.json` queda con `ws` y `multer` en `dependencies`.

- [ ] **Step 2: Agregar script de test en `package.json`**

En la sección `"scripts"`, agregar la línea `test`:
```json
  "scripts": {
    "start": "node server.js",
    "dev": "node --watch server.js",
    "seed": "node lib/seed.js",
    "test": "node --test"
  },
```

- [ ] **Step 3: Crear `lib/protocol.js`**

```js
'use strict';

// Tipos de mensaje del canal WebSocket CRM <-> máquina CacaoIO.
// El campo discriminador en cada mensaje JSON es "t".
module.exports = {
  // Dispositivo -> CRM
  HELLO: 'hello',           // { t, maquinaId, token, serial, fwVersion, estado }
  TELEMETRIA: 'telemetria', // { t, ...status... }
  PONG: 'pong',             // { t }
  OTA_PROGRESO: 'ota_progreso', // { t, pct }

  // CRM -> dispositivo
  CONTROL: 'control',       // { t, payload: {...mismo JSON que /api/control...} }
  RECETA: 'receta',         // { t, payload: {nombre, temp_derretido, temp_templado, max_agua, delta_agua} }
  OTA: 'ota',               // { t, url, version, sha256 }
  PING: 'ping',             // { t }

  WS_PATH: '/device-ws',
  HEARTBEAT_MS: 20000       // intervalo de ping del servidor a cada dispositivo
};
```

- [ ] **Step 4: Verificar que el módulo carga**

Run:
```bash
node -e "console.log(require('./lib/protocol').WS_PATH)"
```
Expected: imprime `/device-ws`.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json lib/protocol.js
git commit -m "agrega deps ws/multer, script test y constantes de protocolo"
```

---

## Task 2: Índices Mango y config publicUrl

**Files:**
- Modify: `lib/db.js:11-16`
- Modify: `config.js:5`

- [ ] **Step 1: Agregar índices para los nuevos tipos**

En `lib/db.js`, ampliar el arreglo `INDEXES`:
```js
const INDEXES = [
  { name: 'idx-type', fields: ['type'] },
  { name: 'idx-type-codigo', fields: ['type', 'codigo'] },
  { name: 'idx-type-fecha', fields: ['type', 'fecha'] },
  { name: 'idx-type-nombre', fields: ['type', 'nombre'] },
  { name: 'idx-type-serial', fields: ['type', 'serial'] },
  { name: 'idx-type-version', fields: ['type', 'version'] }
];
```

- [ ] **Step 2: Agregar `publicUrl` a `config.js`**

Justo debajo de la línea `port: ...`, agregar:
```js
  // URL pública del CRM (la usa el firmware para descargar binarios OTA).
  publicUrl: process.env.PUBLIC_URL || 'https://leonardobracco.com',
```

- [ ] **Step 3: Verificar sintaxis**

Run:
```bash
node --check lib/db.js && node --check config.js && node -e "console.log(require('./config').publicUrl)"
```
Expected: imprime `https://leonardobracco.com` sin errores.

- [ ] **Step 4: Commit**

```bash
git add lib/db.js config.js
git commit -m "indices mango para maquinas/firmware y config publicUrl"
```

---

## Task 3: Lógica de pairing y tokens (`lib/maquinas.js`) — con tests

**Files:**
- Create: `lib/maquinas.js`
- Test: `test/maquinas.test.js`

- [ ] **Step 1: Escribir el test que falla**

`test/maquinas.test.js`:
```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const m = require('../lib/maquinas');

test('generarCodigoPairing da 6 dígitos', () => {
  const c = m.generarCodigoPairing();
  assert.match(c, /^\d{6}$/);
});

test('generarToken da hex largo y único', () => {
  const a = m.generarToken();
  const b = m.generarToken();
  assert.match(a, /^[0-9a-f]{48}$/);
  assert.notStrictEqual(a, b);
});

test('hash y verify de token', async () => {
  const tok = m.generarToken();
  const hash = await m.hashToken(tok);
  assert.notStrictEqual(hash, tok);
  assert.strictEqual(await m.verifyToken(tok, hash), true);
  assert.strictEqual(await m.verifyToken('otro', hash), false);
});

test('pairingVencido detecta expiración', () => {
  const futuro = new Date(Date.now() + 60000).toISOString();
  const pasado = new Date(Date.now() - 60000).toISOString();
  assert.strictEqual(m.pairingVencido({ vence: futuro, usado: false }), false);
  assert.strictEqual(m.pairingVencido({ vence: pasado, usado: false }), true);
  assert.strictEqual(m.pairingVencido({ vence: futuro, usado: true }), true);
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run:
```bash
node --test test/maquinas.test.js
```
Expected: FALLA con "Cannot find module '../lib/maquinas'".

- [ ] **Step 3: Implementar `lib/maquinas.js`**

```js
'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const database = require('./db');

const PAIRING_TTL_MS = 10 * 60 * 1000;

function generarCodigoPairing() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

function generarToken() {
  return crypto.randomBytes(24).toString('hex'); // 48 chars hex
}

function hashToken(token) {
  return bcrypt.hash(token, 10);
}

function verifyToken(token, hash) {
  return bcrypt.compare(token, hash);
}

function pairingVencido(doc) {
  if (!doc || doc.usado) return true;
  return new Date(doc.vence).getTime() < Date.now();
}

// Crea el doc pairing:<codigo> con TTL. Devuelve { codigo, vence }.
async function crearPairing() {
  const codigo = generarCodigoPairing();
  const vence = new Date(Date.now() + PAIRING_TTL_MS).toISOString();
  await database.insert({ _id: `pairing:${codigo}`, type: 'pairing', codigo, usado: false, vence, creado: new Date().toISOString() });
  return { codigo, vence };
}

// Valida un código y, si es válido, crea la máquina y devuelve { maquinaId, token }.
// Lanza Error con statusCode si el código es inválido/vencido.
async function vincular({ codigo, serial, fwVersion }) {
  const pdoc = await database.tryGet(`pairing:${codigo}`);
  if (pairingVencido(pdoc)) { const e = new Error('Código inválido o vencido'); e.statusCode = 400; throw e; }

  const maquinaId = `maquina:${crypto.randomUUID()}`;
  const token = generarToken();
  const tokenHash = await hashToken(token);
  await database.insert({
    _id: maquinaId, type: 'maquina',
    nombre: serial || 'Máquina nueva',
    serial: serial || '', tokenHash,
    online: false, ultimoVisto: null, ip: '',
    fwVersion: fwVersion || '', estado: {}, recetaActiva: '',
    creado: new Date().toISOString()
  });

  pdoc.usado = true;
  await database.raw().insert(pdoc);
  return { maquinaId, token };
}

module.exports = {
  generarCodigoPairing, generarToken, hashToken, verifyToken,
  pairingVencido, crearPairing, vincular, PAIRING_TTL_MS
};
```

- [ ] **Step 4: Correr el test y verificar que pasa**

Run:
```bash
node --test test/maquinas.test.js
```
Expected: PASS (4 tests ok). Los tests de `generar*`, `hash/verify` y `pairingVencido` no tocan la base; corren sin CouchDB.

- [ ] **Step 5: Commit**

```bash
git add lib/maquinas.js test/maquinas.test.js
git commit -m "logica de pairing y tokens de maquina con tests"
```

---

## Task 4: Gateway WebSocket (`lib/cloudGateway.js`) — registro testeable

**Files:**
- Create: `lib/cloudGateway.js`
- Test: `test/gateway.test.js`

El gateway expone una API que `server.js` y `routes/maquinas.js` usan. Para poder testear la lógica de registro sin sockets reales, el registro acepta objetos "socket-like" con método `send`.

- [ ] **Step 1: Escribir el test que falla**

`test/gateway.test.js`:
```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const gw = require('../lib/cloudGateway');

function fakeSocket() {
  return { sent: [], send(s) { this.sent.push(s); }, readyState: 1 };
}

test('registrar y enviar comando a máquina online', () => {
  gw._reset();
  const s = fakeSocket();
  gw._register('maquina:1', s);
  assert.strictEqual(gw.online('maquina:1'), true);
  const ok = gw.enviar('maquina:1', { t: 'ping' });
  assert.strictEqual(ok, true);
  assert.deepStrictEqual(JSON.parse(s.sent[0]), { t: 'ping' });
});

test('enviar a máquina offline devuelve false', () => {
  gw._reset();
  assert.strictEqual(gw.online('maquina:x'), false);
  assert.strictEqual(gw.enviar('maquina:x', { t: 'ping' }), false);
});

test('desregistrar deja la máquina offline', () => {
  gw._reset();
  const s = fakeSocket();
  gw._register('maquina:2', s);
  gw._unregister('maquina:2', s);
  assert.strictEqual(gw.online('maquina:2'), false);
});

test('suscriptor SSE recibe broadcast', () => {
  gw._reset();
  const recibidos = [];
  const sub = { write: (s) => recibidos.push(s) };
  gw.addSseSubscriber(sub);
  gw.broadcast({ maquinaId: 'maquina:1', online: true });
  assert.match(recibidos[0], /maquina:1/);
  assert.match(recibidos[0], /^data: /);
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run:
```bash
node --test test/gateway.test.js
```
Expected: FALLA con "Cannot find module '../lib/cloudGateway'".

- [ ] **Step 3: Implementar `lib/cloudGateway.js`**

```js
'use strict';

const { WebSocketServer } = require('ws');
const proto = require('./protocol');
const maquinas = require('./maquinas');
const database = require('./db');

// Registro en memoria: maquinaId -> socket
const sockets = new Map();
// Suscriptores SSE (objetos response de Express)
const sseSubs = new Set();

function _reset() { sockets.clear(); sseSubs.clear(); }
function _register(id, socket) { sockets.set(id, socket); }
function _unregister(id, socket) { if (sockets.get(id) === socket) sockets.delete(id); }

function online(id) { return sockets.has(id); }

function enviar(id, msg) {
  const s = sockets.get(id);
  if (!s || s.readyState !== 1) return false;
  s.send(JSON.stringify(msg));
  return true;
}

function addSseSubscriber(res) {
  sseSubs.add(res);
}
function removeSseSubscriber(res) {
  sseSubs.delete(res);
}
function broadcast(obj) {
  const payload = `data: ${JSON.stringify(obj)}\n\n`;
  for (const res of sseSubs) {
    try { res.write(payload); } catch (e) { sseSubs.delete(res); }
  }
}

// Persiste estado de la máquina y avisa a los navegadores por SSE.
async function actualizarMaquina(id, patch) {
  try {
    const doc = await database.tryGet(id);
    if (!doc) return;
    Object.assign(doc, patch);
    await database.raw().insert(doc);
  } catch (e) { /* conflicto/no-db: no romper el gateway */ }
  broadcast({ maquinaId: id, ...patch });
}

// Maneja un mensaje entrante ya parseado de un dispositivo autenticado.
async function _onMessage(id, ip, msg) {
  switch (msg.t) {
    case proto.HELLO:
    case proto.TELEMETRIA:
      await actualizarMaquina(id, {
        online: true, ultimoVisto: new Date().toISOString(), ip,
        estado: msg.estado || msg, fwVersion: msg.fwVersion || undefined,
        recetaActiva: (msg.estado && msg.estado.config && msg.estado.config.perfil) || undefined
      });
      break;
    case proto.OTA_PROGRESO:
      broadcast({ maquinaId: id, otaPct: msg.pct });
      break;
    case proto.PONG:
      break;
    default:
      break;
  }
}

// Engancha el upgrade WebSocket sobre el http.Server de Express.
function attach(httpServer) {
  const wss = new WebSocketServer({ server: httpServer, path: proto.WS_PATH });

  wss.on('connection', (ws, req) => {
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim();
    let id = null;
    let autenticado = false;

    const authTimer = setTimeout(() => { if (!autenticado) ws.close(4001, 'sin auth'); }, 5000);

    ws.on('message', async (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      if (!autenticado) {
        if (msg.t !== proto.HELLO || !msg.maquinaId || !msg.token) { ws.close(4001, 'hello requerido'); return; }
        const doc = await database.tryGet(msg.maquinaId);
        if (!doc || !doc.tokenHash || !(await maquinas.verifyToken(msg.token, doc.tokenHash))) {
          ws.close(4003, 'token invalido'); return;
        }
        autenticado = true;
        id = msg.maquinaId;
        clearTimeout(authTimer);
        _register(id, ws);
        await _onMessage(id, ip, msg);
        return;
      }
      await _onMessage(id, ip, msg);
    });

    ws.on('close', async () => {
      clearTimeout(authTimer);
      if (id) { _unregister(id, ws); await actualizarMaquina(id, { online: false, ultimoVisto: new Date().toISOString() }); }
    });
    ws.on('error', () => { /* el close limpia */ });
  });

  // Heartbeat: ping a todos los dispositivos conectados.
  setInterval(() => {
    for (const id of sockets.keys()) enviar(id, { t: proto.PING });
  }, proto.HEARTBEAT_MS);

  return wss;
}

module.exports = {
  attach, online, enviar, addSseSubscriber, removeSseSubscriber, broadcast,
  _reset, _register, _unregister
};
```

- [ ] **Step 4: Correr el test y verificar que pasa**

Run:
```bash
node --test test/gateway.test.js
```
Expected: PASS (4 tests). Usan solo `_register/_unregister/online/enviar/broadcast`, sin abrir sockets ni base.

- [ ] **Step 5: Commit**

```bash
git add lib/cloudGateway.js test/gateway.test.js
git commit -m "gateway websocket con registro en memoria y broadcast sse"
```

---

## Task 5: Montar el gateway y la ruta pública de pairing en `server.js`

**Files:**
- Modify: `server.js`

- [ ] **Step 1: Importar el gateway y maquinas arriba**

En `server.js`, junto a los otros `require` (después de `const seed = require('./lib/seed');`):
```js
const cloudGateway = require('./lib/cloudGateway');
const maquinasLib = require('./lib/maquinas');
```

- [ ] **Step 2: Agregar la ruta pública de pairing (antes de requireAuth)**

En la sección "API pública (sin auth)", debajo de `app.use('/api', auth.router);`, agregar:
```js
// Alta de máquina (pública: el dispositivo aún no tiene token).
app.post('/api/maquinas/pairing', async (req, res) => {
  const { codigo, serial, fwVersion } = req.body || {};
  if (!codigo) return res.status(400).json({ error: 'Falta el código' });
  try {
    const r = await maquinasLib.vincular({ codigo, serial, fwVersion });
    res.json(r); // { maquinaId, token }
  } catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
});
```

- [ ] **Step 3: Servir los binarios de firmware (público, antes del static SPA)**

Debajo de `app.use(express.static(path.join(__dirname, 'public')));` NO — debe ir antes del fallback `app.get('*')`. Agregar junto a la sección estática:
```js
// Binarios de firmware para descarga OTA del dispositivo (público).
app.use('/firmware', express.static(path.join(__dirname, 'firmware')));
```

- [ ] **Step 4: Capturar el http.Server y enganchar el gateway**

Reemplazar el bloque final de arranque `app.listen(...)` por una variante que guarde el server y le adjunte el gateway:
```js
  const httpServer = app.listen(cfg.port, () => {
    console.log(`\n  Fábrica de Alfajores 1950 — ERP`);
    console.log(`  ▶ http://localhost:${cfg.port}`);
    console.log(`  Usuario: ${cfg.bootstrapAdmin.usuario}  Clave: ${cfg.bootstrapAdmin.password}\n`);
  });
  cloudGateway.attach(httpServer);
```

- [ ] **Step 5: Verificar sintaxis y arranque**

Run:
```bash
node --check server.js
```
Expected: sin errores.

- [ ] **Step 6: Commit**

```bash
git add server.js
git commit -m "monta gateway websocket, pairing publico y servido de firmware"
```

---

## Task 6: Rutas REST de máquinas (`routes/maquinas.js`)

**Files:**
- Create: `routes/maquinas.js`
- Modify: `server.js` (registrar router)

Este router se monta bajo el `api` autenticado. Acciones de gestión requieren rol admin.

- [ ] **Step 1: Crear `routes/maquinas.js`**

```js
'use strict';

const express = require('express');
const database = require('../lib/db');
const gw = require('../lib/cloudGateway');
const maquinasLib = require('../lib/maquinas');
const auth = require('../lib/auth');
const proto = require('../lib/protocol');

const router = express.Router();

// SSE: estado en vivo de las máquinas hacia el navegador.
router.get('/stream', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  res.write(': conectado\n\n');
  gw.addSseSubscriber(res);
  req.on('close', () => gw.removeSseSubscriber(res));
});

// Listado (con flag online del gateway, sin exponer tokenHash).
router.get('/', async (req, res) => {
  try {
    const docs = await database.findByType('maquina', { limit: 1000 });
    res.json(docs.map(({ tokenHash, ...m }) => ({ ...m, online: gw.online(m._id) })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/:id', async (req, res) => {
  try {
    const doc = await database.get(req.params.id);
    const { tokenHash, ...m } = doc;
    res.json({ ...m, online: gw.online(doc._id) });
  } catch (e) { res.status(404).json({ error: 'No encontrada' }); }
});

// Generar código de pairing (admin).
router.post('/pairing-code', auth.requireRole('admin'), async (req, res) => {
  try { res.json(await maquinasLib.crearPairing()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Enviar comando de control (mismo JSON que /api/control del firmware).
router.post('/:id/control', async (req, res) => {
  if (!gw.online(req.params.id)) return res.status(409).json({ error: 'Máquina desconectada' });
  const ok = gw.enviar(req.params.id, { t: proto.CONTROL, payload: req.body || {} });
  res.json({ ok });
});

// Enviar una receta de templado a la máquina.
router.post('/:id/receta', async (req, res) => {
  if (!gw.online(req.params.id)) return res.status(409).json({ error: 'Máquina desconectada' });
  const { nombre, temp_derretido, temp_templado, max_agua, delta_agua } = req.body || {};
  if (!nombre) return res.status(400).json({ error: 'Falta el nombre de la receta' });
  const ok = gw.enviar(req.params.id, { t: proto.RECETA, payload: { nombre, temp_derretido, temp_templado, max_agua, delta_agua } });
  res.json({ ok });
});

// Cambiar nombre de la máquina (admin).
router.put('/:id', auth.requireRole('admin'), async (req, res) => {
  try {
    const doc = await database.get(req.params.id);
    if (req.body.nombre != null) doc.nombre = req.body.nombre;
    await database.raw().insert(doc);
    const { tokenHash, ...m } = doc;
    res.json(m);
  } catch (e) { res.status(404).json({ error: 'No encontrada' }); }
});

// Lanzar OTA: envía URL del binario + sha256 al dispositivo (admin).
router.post('/:id/ota', auth.requireRole('admin'), async (req, res) => {
  if (!gw.online(req.params.id)) return res.status(409).json({ error: 'Máquina desconectada' });
  try {
    const fw = await database.get(req.body.firmwareId);
    const cfg = require('../config');
    const url = `${cfg.publicUrl}${fw.archivo}`;
    const ok = gw.enviar(req.params.id, { t: proto.OTA, url, version: fw.version, sha256: fw.sha256 });
    res.json({ ok, url });
  } catch (e) { res.status(404).json({ error: 'Firmware no encontrado' }); }
});

// Eliminar máquina (admin).
router.delete('/:id', auth.requireRole('admin'), async (req, res) => {
  try {
    const doc = await database.get(req.params.id);
    await database.remove(doc._id, doc._rev);
    res.json({ ok: true });
  } catch (e) { res.status(404).json({ error: 'No encontrada' }); }
});

module.exports = router;
```

- [ ] **Step 2: Registrar el router en `server.js`**

En la sección de routers autenticados (junto a `api.use('/dashboard', ...)`), agregar:
```js
api.use('/maquinas', require('./routes/maquinas'));
```

- [ ] **Step 3: Verificar sintaxis**

Run:
```bash
node --check routes/maquinas.js && node --check server.js
```
Expected: sin errores.

- [ ] **Step 4: Commit**

```bash
git add routes/maquinas.js server.js
git commit -m "rutas rest de maquinas: control, receta, pairing, ota y sse"
```

---

## Task 7: Subida y registro de firmware (`routes/firmware.js`)

**Files:**
- Create: `routes/firmware.js`
- Modify: `server.js` (registrar router)
- Create (dir): `firmware/` (carpeta de binarios, vía `.gitkeep`)

- [ ] **Step 1: Crear la carpeta de binarios con `.gitkeep`**

```bash
mkdir -p "G:/LeonardoBracco/Productos/Cacao.io/Software/App_PC/CRM/firmware"
printf "" > "G:/LeonardoBracco/Productos/Cacao.io/Software/App_PC/CRM/firmware/.gitkeep"
```

- [ ] **Step 2: Ignorar los binarios `.bin` en git**

Crear/editar `.gitignore` en la raíz agregando:
```
firmware/*.bin
```

- [ ] **Step 3: Crear `routes/firmware.js`**

```js
'use strict';

const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const database = require('../lib/db');
const auth = require('../lib/auth');

const router = express.Router();
const DIR = path.join(__dirname, '..', 'firmware');

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, DIR),
  filename: (req, file, cb) => {
    const ver = (req.body.version || 'sinver').replace(/[^0-9a-zA-Z._-]/g, '');
    cb(null, `cacaoio-${ver}-${Date.now()}.bin`);
  }
});
const upload = multer({ storage, limits: { fileSize: 4 * 1024 * 1024 } });

function sha256File(p) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(p).on('data', d => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

// Listar versiones de firmware (admin).
router.get('/', auth.requireRole('admin'), async (req, res) => {
  try {
    const docs = await database.findByType('firmware', { limit: 1000 });
    docs.sort((a, b) => (b.subido || '').localeCompare(a.subido || ''));
    res.json(docs);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Subir un nuevo binario (admin).
router.post('/', auth.requireRole('admin'), upload.single('archivo'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Falta el archivo .bin' });
    const sha256 = await sha256File(req.file.path);
    const doc = await database.insert({
      _id: `firmware:${Date.now()}`, type: 'firmware',
      version: req.body.version || 'sinver',
      archivo: `/firmware/${req.file.filename}`,
      sha256, tamano: req.file.size,
      notas: req.body.notas || '',
      subido: new Date().toISOString()
    });
    res.status(201).json(doc);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Eliminar una versión (admin): borra doc y archivo.
router.delete('/:id', auth.requireRole('admin'), async (req, res) => {
  try {
    const doc = await database.get(req.params.id);
    const file = path.join(DIR, path.basename(doc.archivo));
    fs.promises.unlink(file).catch(() => {});
    await database.remove(doc._id, doc._rev);
    res.json({ ok: true });
  } catch (e) { res.status(404).json({ error: 'No encontrado' }); }
});

module.exports = router;
```

- [ ] **Step 4: Registrar el router en `server.js`**

Junto a los demás routers autenticados:
```js
api.use('/firmware', require('./routes/firmware'));
```

- [ ] **Step 5: Verificar sintaxis**

Run:
```bash
node --check routes/firmware.js && node --check server.js
```
Expected: sin errores.

- [ ] **Step 6: Commit**

```bash
git add routes/firmware.js server.js .gitignore firmware/.gitkeep
git commit -m "subida y registro de binarios de firmware con sha256"
```

---

## Task 8: CRUD de recetas de templado

**Files:**
- Modify: `server.js`

Reutiliza la fábrica `crud()` genérica con coerción numérica.

- [ ] **Step 1: Agregar hook de coerción numérica**

En `server.js`, junto a `beforeProducto`/`beforeInsumo`/`beforeReceta`, agregar:
```js
async function beforeRecetaTemplado(doc) {
  doc.temp_derretido = num(doc.temp_derretido, 45);
  doc.temp_templado = num(doc.temp_templado, 27);
  doc.max_agua = num(doc.max_agua, 60);
  doc.delta_agua = num(doc.delta_agua, 15);
  return doc;
}
```

- [ ] **Step 2: Montar el CRUD**

Junto a `api.use('/recetas', ...)`:
```js
api.use('/recetas-templado', crud('receta_templado', { beforeWrite: beforeRecetaTemplado, searchFields: ['nombre'] }));
```

- [ ] **Step 3: Verificar sintaxis**

Run:
```bash
node --check server.js
```
Expected: sin errores.

- [ ] **Step 4: Verificación funcional (requiere CouchDB y sesión)**

Con el server corriendo y logueado (cookie en `cookies.txt`):
```bash
curl -s -b cookies.txt -X POST http://localhost:6001/api/recetas-templado \
  -H 'Content-Type: application/json' \
  -d '{"nombre":"Test Leche","temp_derretido":45,"temp_templado":27,"max_agua":60,"delta_agua":15}'
curl -s -b cookies.txt http://localhost:6001/api/recetas-templado
```
Expected: el POST devuelve el doc creado con `type:"receta_templado"` y el GET lo lista.

- [ ] **Step 5: Commit**

```bash
git add server.js
git commit -m "crud de recetas de templado"
```

---

## Task 9: Frontend — navegación, vista de máquinas y recetas de templado

**Files:**
- Modify: `public/index.html:42-47` (grupo Producción del nav)
- Modify: `public/js/app.js` (TITLES, RES, VIEWS, vista máquinas, SSE)
- Modify: `public/css/styles.css` (tarjetas de máquina)

- [ ] **Step 1: Agregar entradas de nav en `index.html`**

Dentro del grupo `<div class="grp">Producción</div>`, agregar dos enlaces (después de "Insumos / Stock" o donde corresponda):
```html
        <a data-route="maquinas"><span class="ic">⚗</span> Máquinas</a>
        <a data-route="recetasTemplado"><span class="ic">🌡</span> Recetas de templado</a>
```

- [ ] **Step 2: Agregar títulos en `app.js` (mapa TITLES)**

En el objeto `TITLES`, agregar:
```js
  maquinas: ['Máquinas', 'Control de máquinas de templado CacaoIO'],
  recetasTemplado: ['Recetas de templado', 'Perfiles de temperatura para las máquinas'],
```

- [ ] **Step 3: Agregar config CRUD de recetas de templado (objeto RES)**

En el objeto `RES`, agregar una entrada:
```js
  recetasTemplado: {
    resource: 'recetas-templado',
    columns: [['nombre', 'Receta'], ['temp_derretido', 'Derretido °C', 'num'], ['temp_templado', 'Templado °C', 'num'], ['max_agua', 'Máx. agua °C', 'num'], ['delta_agua', 'Δ agua °C', 'num']],
    fields: [
      { k: 'nombre', l: 'Nombre', t: 'text', req: 1 },
      { k: 'temp_derretido', l: 'Temp. derretido (°C)', t: 'number' },
      { k: 'temp_templado', l: 'Temp. templado (°C)', t: 'number' },
      { k: 'max_agua', l: 'Máx. temp. agua (°C)', t: 'number' },
      { k: 'delta_agua', l: 'Delta agua (°C)', t: 'number' }
    ]
  },
```

- [ ] **Step 4: Agregar la vista de máquinas y su cliente SSE en `app.js`**

Antes de la línea `const VIEWS = {`, agregar:
```js
/* ================= MÁQUINAS (CacaoIO) ================= */
let maquinasSSE = null;

function maquinaCard(m) {
  const on = m.online;
  const e = m.estado || {};
  const ta = (e.temp_choco != null) ? e.temp_choco : '—';
  const tw = (e.temp_agua != null) ? e.temp_agua : '—';
  return `<div class="card card-pad maq-card" data-maq="${esc(m._id)}">
    <div class="maq-head">
      <b>${esc(m.nombre)}</b>
      <span class="pill ${on ? 'ok' : 'bad'}">${on ? 'En línea' : 'Desconectada'}</span>
    </div>
    <div class="maq-temps">
      <div><span class="muted">Chocolate</span><b class="t-choco">${esc(ta)}°</b></div>
      <div><span class="muted">Agua</span><b class="t-agua">${esc(tw)}°</b></div>
      <div><span class="muted">Etapa</span><b class="t-etapa">${esc(e.etapa_actual || '—')}</b></div>
    </div>
    <div class="muted" style="font-size:.74rem">Receta: ${esc(m.recetaActiva || '—')} · FW ${esc(m.fwVersion || '—')}</div>
    <div class="row-actions" style="margin-top:.6rem">
      <button class="btn btn-ghost btn-sm" data-ctrl="${esc(m._id)}" ${on ? '' : 'disabled'}>Control</button>
      <button class="btn btn-ghost btn-sm" data-rec="${esc(m._id)}" ${on ? '' : 'disabled'}>Enviar receta</button>
      <button class="btn btn-ghost btn-sm" data-ota="${esc(m._id)}" ${on ? '' : 'disabled'}>Actualizar FW</button>
    </div>
    ${on ? '' : '<div class="muted" style="font-size:.74rem;margin-top:.3rem">Operar desde el panel local de la máquina.</div>'}
  </div>`;
}

async function maquinasView(c) {
  const maquinas = await get('/maquinas');
  c.innerHTML = `<div class="section-head"><h2>Máquinas</h2>
      <button class="btn btn-primary" id="vincular">+ Vincular máquina</button></div>
    <div class="maq-grid">${maquinas.length ? maquinas.map(maquinaCard).join('')
      : '<div class="empty">Sin máquinas vinculadas.</div>'}</div>`;

  $('#vincular').onclick = vincularModal;
  bindMaquinaButtons(c, maquinas);
  conectarSSE();
}

function bindMaquinaButtons(c, maquinas) {
  const find = id => maquinas.find(x => x._id === id);
  $$('[data-ctrl]', c).forEach(b => b.onclick = () => controlModal(find(b.dataset.ctrl)));
  $$('[data-rec]', c).forEach(b => b.onclick = () => enviarRecetaModal(find(b.dataset.rec)));
  $$('[data-ota]', c).forEach(b => b.onclick = () => otaModal(find(b.dataset.ota)));
}

function conectarSSE() {
  if (maquinasSSE) maquinasSSE.close();
  maquinasSSE = new EventSource(API + '/maquinas/stream');
  maquinasSSE.onmessage = ev => {
    let d; try { d = JSON.parse(ev.data); } catch { return; }
    const card = $(`[data-maq="${d.maquinaId}"]`);
    if (!card) return;
    if (d.online != null) {
      const pill = card.querySelector('.pill');
      pill.className = 'pill ' + (d.online ? 'ok' : 'bad');
      pill.textContent = d.online ? 'En línea' : 'Desconectada';
    }
    const e = d.estado || {};
    if (e.temp_choco != null) card.querySelector('.t-choco').textContent = e.temp_choco + '°';
    if (e.temp_agua != null) card.querySelector('.t-agua').textContent = e.temp_agua + '°';
    if (e.etapa_actual != null) card.querySelector('.t-etapa').textContent = e.etapa_actual;
  };
}

async function vincularModal() {
  const r = await post('/maquinas/pairing-code');
  const body = document.createElement('div');
  body.innerHTML = `<p>En el portal WiFi de la máquina (AP <b>CacaoIO</b>) cargá la red de la fábrica y este código:</p>
    <div style="font-size:2.4rem;font-weight:800;letter-spacing:.2em;text-align:center;margin:1rem 0">${esc(r.codigo)}</div>
    <p class="muted">Válido por 10 minutos. La máquina aparecerá acá apenas se conecte.</p>`;
  modal({ title: 'Vincular máquina', body });
}

function controlModal(m) {
  const e = m.estado || {};
  const form = document.createElement('div');
  form.innerHTML = `<div class="form-grid">
    <div class="field"><label>Proceso activo</label>
      <select data-f="proceso_activo"><option value="true">Encendido</option><option value="false" ${!e.proceso_activo ? 'selected' : ''}>Apagado</option></select></div>
    <div class="field"><label>Motor revolvedor</label>
      <select data-f="motor"><option value="true">Encendido</option><option value="false" ${!e.motor ? 'selected' : ''}>Apagado</option></select></div>
    <div class="field"><label>Bomba</label>
      <select data-f="bomba"><option value="true">Encendida</option><option value="false" ${!e.bomba ? 'selected' : ''}>Apagada</option></select></div>
  </div>`;
  const enviar = btn('Enviar', 'btn-primary', async () => {
    const payload = {
      proceso_activo: $('[data-f="proceso_activo"]', form).value === 'true',
      motor: $('[data-f="motor"]', form).value === 'true',
      bomba: $('[data-f="bomba"]', form).value === 'true'
    };
    try { await post('/maquinas/' + encodeURIComponent(m._id) + '/control', payload); toast('Comando enviado'); mm.close(); }
    catch (err) { toast(err.message, 'err'); }
  });
  const mm = modal({ title: 'Control · ' + m.nombre, body: form, footer: [btn('Cancelar', 'btn-ghost', () => mm.close()), enviar] });
}

async function enviarRecetaModal(m) {
  const recetas = await get('/recetas-templado');
  const body = document.createElement('div');
  body.innerHTML = `<div class="field"><label>Receta de templado</label>
    <select id="recSel">${recetas.map(r => `<option value="${esc(r._id)}">${esc(r.nombre)}</option>`).join('')}</select></div>`;
  const enviar = btn('Enviar a la máquina', 'btn-primary', async () => {
    const r = recetas.find(x => x._id === $('#recSel', body).value);
    if (!r) return;
    try {
      await post('/maquinas/' + encodeURIComponent(m._id) + '/receta',
        { nombre: r.nombre, temp_derretido: r.temp_derretido, temp_templado: r.temp_templado, max_agua: r.max_agua, delta_agua: r.delta_agua });
      toast('Receta enviada'); mm.close();
    } catch (err) { toast(err.message, 'err'); }
  });
  const mm = modal({ title: 'Enviar receta · ' + m.nombre, body, footer: [btn('Cancelar', 'btn-ghost', () => mm.close()), enviar] });
}

async function otaModal(m) {
  const fws = await get('/firmware');
  const body = document.createElement('div');
  body.innerHTML = fws.length ? `<div class="field"><label>Versión de firmware</label>
      <select id="fwSel">${fws.map(f => `<option value="${esc(f._id)}">${esc(f.version)} · ${dtAR(f.subido)}</option>`).join('')}</select></div>
    <p class="muted">La máquina descargará y aplicará la actualización, luego se reinicia.</p>`
    : '<div class="empty">No hay binarios subidos. Subí uno en la sección de firmware.</div>';
  const footer = fws.length ? [btn('Cancelar', 'btn-ghost', () => mm.close()),
    btn('Actualizar', 'btn-primary', async () => {
      try { await post('/maquinas/' + encodeURIComponent(m._id) + '/ota', { firmwareId: $('#fwSel', body).value }); toast('Actualización enviada'); mm.close(); }
      catch (err) { toast(err.message, 'err'); }
    })] : [btn('Cerrar', 'btn-ghost', () => mm.close())];
  const mm = modal({ title: 'Actualizar firmware · ' + m.nombre, body, footer });
}
```

- [ ] **Step 5: Registrar las vistas en el mapa VIEWS**

En el objeto `VIEWS`, agregar:
```js
  maquinas: maquinasView,
  recetasTemplado: c => crudView(c, 'recetasTemplado'),
```

- [ ] **Step 6: Cerrar el SSE al cambiar de ruta**

En la función `render(route)`, al inicio (después de calcular `route`), agregar el cierre del stream para no dejar conexiones colgadas:
```js
  if (maquinasSSE && route !== 'maquinas') { maquinasSSE.close(); maquinasSSE = null; }
```

- [ ] **Step 7: Estilos de tarjetas en `styles.css`**

Agregar al final de `public/css/styles.css`:
```css
.maq-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:1rem}
.maq-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:.6rem}
.maq-temps{display:flex;gap:1.2rem;margin:.4rem 0}
.maq-temps div{display:flex;flex-direction:column}
.maq-temps b{font-size:1.4rem}
.maq-card .muted{display:block}
```

- [ ] **Step 8: Verificación funcional manual**

Con el server corriendo y logueado como admin:
1. Abrir el CRM, ir a "Máquinas" → "Vincular máquina" → debe mostrar un código de 6 dígitos.
2. Ir a "Recetas de templado" → crear una receta → debe listarse.
Expected: ambas vistas cargan sin errores en consola.

- [ ] **Step 9: Commit**

```bash
git add public/index.html public/js/app.js public/css/styles.css
git commit -m "frontend: vista de maquinas, recetas de templado, control/ota y sse en vivo"
```

---

## Task 10: Verificación end-to-end con un dispositivo simulado

**Files:**
- Create: `test/mock-device.js`

Este script simula una máquina: hace pairing por HTTP, abre el WS, manda `hello` + telemetría periódica y responde a comandos. Sirve para validar todo el lado CRM sin hardware.

- [ ] **Step 1: Crear `test/mock-device.js`**

```js
'use strict';
// Uso: node test/mock-device.js <baseHttp> <wsUrl> <codigoPairing>
// Ej:  node test/mock-device.js http://localhost:6001 ws://localhost:6001/device-ws 123456
const WebSocket = require('ws');

const base = process.argv[2] || 'http://localhost:6001';
const wsUrl = process.argv[3] || 'ws://localhost:6001/device-ws';
const codigo = process.argv[4];

async function main() {
  if (!codigo) { console.error('Falta el código de pairing'); process.exit(1); }
  const r = await fetch(base + '/api/maquinas/pairing', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ codigo, serial: 'MOCK-001', fwVersion: '0.9.0' })
  });
  const cred = await r.json();
  if (!cred.token) { console.error('Pairing falló:', cred); process.exit(1); }
  console.log('Vinculada:', cred.maquinaId);

  const ws = new WebSocket(wsUrl);
  let estado = { temp_choco: 30, temp_agua: 40, etapa_actual: 1, motor: false, bomba: false, proceso_activo: false, config: { perfil: 'Mock Leche' } };

  ws.on('open', () => {
    ws.send(JSON.stringify({ t: 'hello', maquinaId: cred.maquinaId, token: cred.token, serial: 'MOCK-001', fwVersion: '0.9.0', estado }));
    setInterval(() => {
      estado.temp_choco = +(28 + Math.random() * 4).toFixed(1);
      ws.send(JSON.stringify({ t: 'telemetria', estado }));
    }, 2000);
  });
  ws.on('message', raw => {
    const m = JSON.parse(raw.toString());
    if (m.t === 'ping') return ws.send(JSON.stringify({ t: 'pong' }));
    console.log('CMD recibido:', m);
    if (m.t === 'control' && m.payload) Object.assign(estado, m.payload);
    if (m.t === 'ota') ws.send(JSON.stringify({ t: 'ota_progreso', pct: 100 }));
  });
  ws.on('close', (c, r) => console.log('WS cerrado', c, r.toString()));
}
main();
```

- [ ] **Step 2: Correr la verificación E2E**

En una terminal, con el server y CouchDB corriendo, generar un código (logueado como admin) y luego:
```bash
# 1) generar código desde la UI o por curl con cookie de sesión:
curl -s -b cookies.txt -X POST http://localhost:6001/api/maquinas/pairing-code
# 2) usar ese código con el mock (reemplazar 123456):
node test/mock-device.js http://localhost:6001 ws://localhost:6001/device-ws 123456
```
Expected:
- El mock imprime "Vinculada: maquina:...".
- En el CRM, la sección "Máquinas" muestra la tarjeta MOCK-001 **En línea** con la temperatura del chocolate variando cada 2s.
- Al pulsar "Control" y enviar un comando, el mock imprime "CMD recibido: { t: 'control', ... }".
- Al cerrar el mock (Ctrl+C), la tarjeta pasa a **Desconectada**.

- [ ] **Step 3: Correr toda la suite de tests unitarios**

Run:
```bash
npm test
```
Expected: PASS de `test/maquinas.test.js` y `test/gateway.test.js` (los unit tests no requieren CouchDB).

- [ ] **Step 4: Commit**

```bash
git add test/mock-device.js
git commit -m "mock device para verificacion e2e del gateway"
```

---

## Self-review (cobertura del spec — lado CRM)

- **Gateway WS en el CRM** → Tasks 4, 5. ✔
- **Modelo de datos (maquina/receta_templado/firmware/pairing + índices)** → Tasks 2, 3, 7, 8. ✔
- **Pairing portal AP + código** → Tasks 3 (lógica), 5 (ruta pública), 9 (UI código). ✔
- **Control en vivo (mismo contrato /api/control)** → Task 6 (`/control`), Task 9 (modal). ✔
- **Recetas de templado separadas + enviar a máquina** → Tasks 8, 9. ✔
- **OTA: subir .bin + empujar + sha256** → Tasks 6 (`/ota`), 7 (subida/sha256). ✔
- **Seguridad: token hasheado, rutas admin** → Tasks 3, 6, 7. ✔
- **SSE estado en vivo + online/offline** → Tasks 4, 6, 9. ✔
- **Casos borde: offline → 409, re-sync por hello** → Tasks 4, 6, 9. ✔

El **lado firmware** (WIFI_AP_STA, cliente WS saliente, OTA con Update.h, portal de pairing, persistencia de credenciales) está cubierto en el plan hermano `2026-06-05-cacaoio-firmware-side.md`.
