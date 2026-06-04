'use strict';

const path = require('path');
const express = require('express');
const session = require('express-session');

const cfg = require('./config');
const database = require('./lib/db');
const auth = require('./lib/auth');
const crud = require('./lib/crud');
const seed = require('./lib/seed');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(session({
  name: 'erp1950.sid',
  secret: cfg.sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 1000 * 60 * 60 * 8 }
}));

// ---- Helpers de coerción numérica ----
const num = (v, d = 0) => (v === '' || v == null ? d : Number(v));
async function beforeProducto(doc) {
  doc.stock = num(doc.stock); doc.precio = num(doc.precio);
  doc.costoUnit = num(doc.costoUnit); doc.vidaUtilDias = num(doc.vidaUtilDias, 90);
  doc.sellos = doc.sellos || []; doc.leyendas = doc.leyendas || [];
  return doc;
}
async function beforeInsumo(doc) {
  doc.stock = num(doc.stock); doc.stockMin = num(doc.stockMin);
  doc.costoUnit = num(doc.costoUnit);
  return doc;
}
async function beforeReceta(doc) {
  doc.rinde = num(doc.rinde, 1);
  doc.items = (doc.items || []).map(i => ({ ...i, cantidad: num(i.cantidad) }));
  return doc;
}

// ---- API pública (sin auth) ----
app.use('/api', auth.router);

// Trazabilidad pública por código de lote (QR del rótulo)
app.get('/t/:codigo', async (req, res) => {
  try {
    const lote = await database.tryGet(`lote:${req.params.codigo}`);
    if (!lote) return res.status(404).send('Lote no encontrado');
    const producto = await database.tryGet(lote.productoId);
    res.send(publicTrace(lote, producto, req.query.s));
  } catch (e) { res.status(500).send('Error'); }
});
app.get('/t/envio/:tracking', (req, res) => {
  res.send(`<!doctype html><meta charset="utf-8"><title>Seguimiento</title>
  <body style="font-family:system-ui;padding:2rem;text-align:center">
  <h2>Envío ${req.params.tracking}</h2><p>Fábrica de Alfajores 1950</p></body>`);
});

// ---- A partir de acá, todo requiere sesión ----
const api = express.Router();
api.use(auth.requireAuth);
api.use('/insumos', crud('insumo', { beforeWrite: beforeInsumo }));
api.use('/productos', crud('producto', { beforeWrite: beforeProducto }));
api.use('/recetas', crud('receta', { beforeWrite: beforeReceta }));
api.use('/clientes', crud('cliente'));
api.use('/proveedores', crud('proveedor'));
api.use('/compras', require('./routes/compras'));
api.use('/ventas', require('./routes/ventas'));
api.use('/fabricacion', require('./routes/fabricacion'));
api.use('/lotes', require('./routes/lotes'));
api.use('/etiquetas', require('./routes/etiquetas'));
api.use('/movimientos', require('./routes/movimientos'));
api.use('/dashboard', require('./routes/dashboard'));

// Cambiar la propia contraseña (cualquier usuario autenticado)
api.post('/cambiar-password', async (req, res) => {
  const { actual, nueva } = req.body || {};
  if (!actual || !nueva) return res.status(400).json({ error: 'Faltan datos' });
  if (String(nueva).length < 4) return res.status(400).json({ error: 'La nueva contraseña es muy corta (mín. 4)' });
  try { res.json(await auth.cambiarPassword(req.session.user.usuario, actual, nueva)); }
  catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
});

// Gestión de usuarios (solo admin)
api.get('/usuarios', auth.requireRole('admin'), async (req, res) => {
  try { res.json(await auth.listarUsuarios()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
api.post('/usuarios', auth.requireRole('admin'), async (req, res) => {
  if (!req.body || !req.body.usuario || !req.body.password)
    return res.status(400).json({ error: 'Faltan usuario o contraseña' });
  try {
    const { hash, ...u } = await auth.crearUsuario(req.body);
    res.status(201).json(u);
  } catch (e) {
    if (e.statusCode === 409) return res.status(409).json({ error: 'El usuario ya existe' });
    res.status(500).json({ error: e.message });
  }
});
api.put('/usuarios/:usuario', auth.requireRole('admin'), async (req, res) => {
  try { res.json(await auth.actualizarUsuario(req.params.usuario, req.body || {})); }
  catch (e) {
    if (e.statusCode === 404) return res.status(404).json({ error: 'Usuario no encontrado' });
    res.status(e.statusCode || 500).json({ error: e.message });
  }
});
api.get('/empresa', (req, res) => res.json(cfg.empresa));

app.use('/api', api);

// ---- Frontend (SPA) ----
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// Página pública de trazabilidad
function publicTrace(lote, producto, serie) {
  const f = iso => iso ? new Date(iso).toLocaleDateString('es-AR') : '—';
  return `<!doctype html><html lang="es"><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Trazabilidad · ${lote.productoNombre}</title>
  <style>body{font-family:system-ui,Segoe UI,Roboto;margin:0;background:#f3ead9;color:#2b1d12}
  .card{max-width:480px;margin:0 auto;padding:2rem}
  .brand{font-weight:800;letter-spacing:.2em;color:#7b3f1d}
  h1{font-size:1.6rem;margin:.2rem 0 1rem}
  .row{display:flex;justify-content:space-between;padding:.6rem 0;border-bottom:1px solid #d8c6a8}
  .k{color:#8a6d4a}</style></head>
  <body><div class="card">
  <div class="brand">1950 · ALFAJORES</div>
  <h1>${lote.productoNombre || 'Producto'}</h1>
  <div class="row"><span class="k">Lote</span><b>${lote.codigo}</b></div>
  <div class="row"><span class="k">Elaboración</span><span>${f(lote.fechaElaboracion)}</span></div>
  <div class="row"><span class="k">Vencimiento</span><span>${f(lote.fechaVencimiento)}</span></div>
  ${serie ? `<div class="row"><span class="k">Unidad N°</span><span>${serie}</span></div>` : ''}
  ${producto?.ean ? `<div class="row"><span class="k">EAN</span><span>${producto.ean}</span></div>` : ''}
  <p style="margin-top:1.5rem;color:#8a6d4a;font-size:.9rem">Producto elaborado por ${cfg.empresa.razonSocial}. Verificá la fecha de vencimiento antes de consumir.</p>
  </div></body></html>`;
}

// ---- Arranque ----
(async () => {
  const ok = await database.init();
  if (ok) {
    try {
      await seed.ensureAdmin();
      await seed.ensureSampleData();
    } catch (e) { console.warn('[seed]', e.message); }
  }
  app.listen(cfg.port, () => {
    console.log(`\n  Fábrica de Alfajores 1950 — ERP`);
    console.log(`  ▶ http://localhost:${cfg.port}`);
    console.log(`  Usuario: ${cfg.bootstrapAdmin.usuario}  Clave: ${cfg.bootstrapAdmin.password}\n`);
  });
})();
