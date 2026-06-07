'use strict';
/* ================= Fábrica de Alfajores 1950 — Frontend ================= */

const API = '/api';
let USER = null;
let EMPRESA_ACTIVA = null;
const refCache = {};

/* ---------- utils ---------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => (s == null ? '' : String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
const money = n => '$' + Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const numfmt = n => Number(n || 0).toLocaleString('es-AR', { maximumFractionDigits: 3 });
const dAR = iso => iso ? new Date(iso).toLocaleDateString('es-AR') : '—';
const dtAR = iso => iso ? new Date(iso).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' }) : '—';
const todayISO = () => new Date().toISOString().slice(0, 10);

async function api(method, path, body) {
  const opt = { method, headers: {} };
  if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  const r = await fetch(API + path, opt);
  if (r.status === 401 && USER) { location.reload(); return; }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || ('Error ' + r.status));
  return data;
}
const get = p => api('GET', p);
const post = (p, b) => api('POST', p, b);
const put = (p, b) => api('PUT', p, b);
const del = p => api('DELETE', p);

function toast(msg, kind = 'ok') {
  const t = document.createElement('div');
  t.className = 'toast ' + kind; t.textContent = msg;
  $('#toast').appendChild(t);
  setTimeout(() => t.remove(), 3200);
}

async function loadRef(resource, force) {
  if (!force && refCache[resource]) return refCache[resource];
  refCache[resource] = await get('/' + resource);
  return refCache[resource];
}
function refName(resource, id) {
  const it = (refCache[resource] || []).find(x => x._id === id);
  return it ? (it.nombre || it.codigo) : (id || '');
}

/* ---------- modal ---------- */
function modal({ title, body, footer, wide }) {
  const root = $('#modal-root');
  const bg = document.createElement('div'); bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal ${wide ? 'wide' : ''}">
    <div class="modal-head"><h3>${esc(title)}</h3><button class="x">×</button></div>
    <div class="modal-body"></div>
    <div class="modal-foot"></div></div>`;
  bg.querySelector('.modal-body').append(typeof body === 'string' ? Object.assign(document.createElement('div'), { innerHTML: body }) : body);
  if (footer) bg.querySelector('.modal-foot').append(...footer);
  const close = () => bg.remove();
  bg.querySelector('.x').onclick = close;
  bg.onclick = e => { if (e.target === bg) close(); };
  root.append(bg);
  return { bg, close, el: bg.querySelector('.modal') };
}
function btn(label, cls, onclick) {
  const b = document.createElement('button'); b.className = 'btn ' + cls; b.textContent = label; b.onclick = onclick; return b;
}

/* ================= LOGIN ================= */
async function doLogin() {
  const usuario = $('#luser').value.trim(), password = $('#lpass').value;
  $('#loginErr').classList.add('hidden');
  try {
    const r = await post('/login', { usuario, password });
    USER = r.user; startApp();
  } catch (e) { $('#loginErr').textContent = e.message; $('#loginErr').classList.remove('hidden'); }
}
$('#lbtn').onclick = doLogin;
$('#lpass').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
$('#logout').onclick = async () => { await post('/logout'); location.reload(); };
$('#chgPass').onclick = () => cambiarPassModal();
$('#menuBtn').onclick = () => $('#sidebar').classList.toggle('open');

/* ================= ROUTER ================= */
const TITLES = {
  dashboard: ['Tablero', 'Resumen de la operación'],
  ventas: ['Ventas', 'Pedidos y facturación'],
  clientes: ['Clientes', 'Cartera comercial'],
  compras: ['Compras', 'Órdenes de compra e ingreso de insumos'],
  proveedores: ['Proveedores', 'Abastecimiento'],
  fabricacion: ['Fabricación', 'Órdenes de producción y lotes'],
  recetas: ['Recetas', 'Formulación de productos'],
  productos: ['Productos', 'Catálogo de alfajores'],
  insumos: ['Insumos / Stock', 'Materias primas y existencias'],
  lotes: ['Lotes / Trazabilidad', 'Seguimiento y recall'],
  etiquetas: ['Etiquetas y Rótulos', 'Impresión de rótulos, series y envíos'],
  usuarios: ['Usuarios', 'Cuentas y accesos del sistema'],
  maquinas: ['Máquinas', 'Control de máquinas de templado CacaoIO'],
  procesos: ['Procesos', 'Curvas de temperatura y análisis con IA'],
  recetasTemplado: ['Recetas de templado', 'Perfiles de temperatura para las máquinas'],
  firmware: ['Firmware', 'Binarios OTA para las máquinas CacaoIO'],
  empresas: ['Empresas', 'Alta y administración de empresas']
};
function go(route) { if (!TITLES[route]) route = 'dashboard'; location.hash = '#/' + route; }
function render(route) {
  if (!TITLES[route]) route = 'dashboard';
  if (maquinasSSE && route !== 'maquinas') { maquinasSSE.close(); maquinasSSE = null; }
  $$('#nav a').forEach(a => a.classList.toggle('active', a.dataset.route === route));
  $('#pageTitle').textContent = TITLES[route][0];
  $('#pageSub').textContent = TITLES[route][1];
  $('#sidebar').classList.remove('open');
  const c = $('#content'); c.innerHTML = '<div class="empty">Cargando…</div>';
  VIEWS[route](c).catch(e => { c.innerHTML = `<div class="card card-pad" style="color:var(--red)">Error: ${esc(e.message)}</div>`; });
}
window.addEventListener('hashchange', () => render(location.hash.replace('#/', '') || 'dashboard'));
$$('#nav a').forEach(a => a.onclick = () => go(a.dataset.route));

async function boot() {
  try { const r = await get('/me'); USER = r.user; EMPRESA_ACTIVA = r.empresaActiva || null; startApp(); }
  catch { $('#login').classList.remove('hidden'); }
}
function startApp() {
  $('#login').classList.add('hidden');
  $('#app').classList.remove('hidden');
  $('#uName').textContent = USER.nombre;
  $('#avatar').textContent = (USER.nombre || 'U')[0].toUpperCase();
  $('#sideFoot').textContent = (USER.rol === 'superadmin' ? 'Superadmin' : USER.rol === 'admin' ? 'Administrador' : USER.nombre) + ' · v1.0';
  const esAdmin = USER.rol === 'admin' || USER.rol === 'superadmin';
  $$('[data-admin]').forEach(el => el.style.display = esAdmin ? '' : 'none');
  $$('[data-superadmin]').forEach(el => el.style.display = USER.rol === 'superadmin' ? '' : 'none');
  initEmpresaSwitch();
  render(location.hash.replace('#/', '') || 'dashboard');
}

// Selector de empresa activa para el superadmin (barra superior).
async function initEmpresaSwitch() {
  if (USER.rol !== 'superadmin') return;
  const sw = $('#empresaSwitch');
  const sel = $('#empresaSel');
  let empresas = [];
  try { empresas = await get('/empresas'); } catch (e) { return; }
  sel.innerHTML = '<option value="">— Todas las empresas —</option>' +
    empresas.map(e => `<option value="${esc(e._id.replace('empresa:', ''))}">${esc(e.nombre)}${e.activo === false ? ' (suspendida)' : ''}</option>`).join('');
  sel.value = EMPRESA_ACTIVA || '';
  sw.classList.remove('hidden');
  sel.onchange = async () => {
    try { await post('/empresas/activa', { empresaId: sel.value || null }); location.reload(); }
    catch (e) { toast(e.message, 'err'); }
  };
}

/* ================= GENERIC CRUD ================= */
const UNIDADES = ['kg', 'g', 'lt', 'ml', 'un', 'doc', 'pack'];
const SELLOS = [
  ['azucares', 'Alto en azúcares'], ['grasas-saturadas', 'Alto en grasas sat.'],
  ['grasas-totales', 'Alto en grasas tot.'], ['sodio', 'Alto en sodio'], ['calorias', 'Alto en calorías']
];
const LEYENDAS = [['edulcorantes', 'Contiene edulcorantes'], ['cafeina', 'Contiene cafeína']];
const NUT_FIELDS = [
  ['porcion', 'Porción', 'text'], ['porciones', 'Porciones/envase', 'text'],
  ['kcal', 'Valor energético (kcal)', 'number'], ['carbohidratos', 'Carbohidratos (g)', 'number'],
  ['azucares', 'Azúcares (g)', 'number'], ['proteinas', 'Proteínas (g)', 'number'],
  ['grasas', 'Grasas totales (g)', 'number'], ['grasasSat', 'Grasas saturadas (g)', 'number'],
  ['grasasTrans', 'Grasas trans (g)', 'number'], ['sodio', 'Sodio (mg)', 'number'], ['fibra', 'Fibra (g)', 'number']
];

const RES = {
  recetasTemplado: {
    resource: 'recetas-templado',
    columns: [['nombre', 'Receta'], ['temp_derretido', 'Derretido °C', 'num'], ['temp_templado', 'Templado °C', 'num'], ['max_agua', 'Máx. agua °C', 'num'], ['delta_agua', 'Δ agua °C', 'num']],
    fields: [
      { k: 'nombre', l: 'Nombre', t: 'text', req: 1 },
      { k: 'temp_derretido', l: 'Temp. derretido (°C)', t: 'number' },
      { k: 'temp_templado', l: 'Temp. templado (°C)', t: 'number' },
      { k: 'max_agua', l: 'Máx. temp. agua (°C)', t: 'number' },
      { k: 'delta_agua', l: 'Delta agua (°C)', t: 'number' },
      { k: 'temp_precalentado', l: 'Precalentado agua (°C, 0=off)', t: 'number' },
      { k: 'tiempo_mantener_min', l: 'Mantener templado (min, 0=off)', t: 'number' },
      { k: 'mezcla_on_seg', l: 'Mezclado ON (seg, 0=continuo)', t: 'number' },
      { k: 'mezcla_periodo_min', l: 'Mezclado período (min)', t: 'number' }
    ]
  },
  clientes: {
    resource: 'clientes',
    columns: [['codigo', 'Código'], ['nombre', 'Nombre'], ['cuit', 'CUIT'], ['localidad', 'Localidad'], ['telefono', 'Teléfono']],
    fields: [
      { k: 'codigo', l: 'Código', t: 'text', req: 1, lockEdit: 1 }, { k: 'nombre', l: 'Nombre / Razón social', t: 'text', req: 1 },
      { k: 'cuit', l: 'CUIT', t: 'text' }, { k: 'telefono', l: 'Teléfono', t: 'text' },
      { k: 'direccion', l: 'Dirección', t: 'text', full: 1 }, { k: 'localidad', l: 'Localidad', t: 'text' },
      { k: 'cp', l: 'CP', t: 'text' }, { k: 'email', l: 'Email', t: 'text' }
    ]
  },
  proveedores: {
    resource: 'proveedores',
    columns: [['codigo', 'Código'], ['nombre', 'Nombre'], ['cuit', 'CUIT'], ['localidad', 'Localidad'], ['telefono', 'Teléfono']],
    fields: [
      { k: 'codigo', l: 'Código', t: 'text', req: 1, lockEdit: 1 }, { k: 'nombre', l: 'Nombre / Razón social', t: 'text', req: 1 },
      { k: 'cuit', l: 'CUIT', t: 'text' }, { k: 'telefono', l: 'Teléfono', t: 'text' },
      { k: 'direccion', l: 'Dirección', t: 'text', full: 1 }, { k: 'localidad', l: 'Localidad', t: 'text' },
      { k: 'email', l: 'Email', t: 'text' }
    ]
  },
  insumos: {
    resource: 'insumos',
    columns: [['codigo', 'Código'], ['nombre', 'Insumo'], ['unidad', 'Un.'],
      ['stock', 'Stock', 'stockBadge'], ['stockMin', 'Mín.', 'num'], ['costoUnit', 'Costo', 'money']],
    rowExtra: r => `<button class="btn btn-ghost btn-sm" data-mov="${esc(r._id)}">Kardex</button>`,
    fields: [
      { k: 'codigo', l: 'Código', t: 'text', req: 1, lockEdit: 1 }, { k: 'nombre', l: 'Nombre', t: 'text', req: 1 },
      { k: 'unidad', l: 'Unidad', t: 'select', opts: UNIDADES.map(u => [u, u]) },
      { k: 'costoUnit', l: 'Costo unitario', t: 'number' },
      { k: 'stock', l: 'Stock actual', t: 'number' }, { k: 'stockMin', l: 'Stock mínimo (alerta)', t: 'number' },
      { k: 'proveedorId', l: 'Proveedor', t: 'ref', ref: 'proveedores', full: 1 }
    ]
  },
  productos: {
    resource: 'productos',
    columns: [['codigo', 'Código'], ['nombre', 'Producto'], ['categoria', 'Categoría'],
      ['stock', 'Stock', 'num'], ['costoUnit', 'Costo', 'money'], ['precio', 'Precio', 'money'], ['_margen', 'Margen', 'margen']],
    fields: [
      { k: 'codigo', l: 'Código', t: 'text', req: 1, lockEdit: 1 }, { k: 'nombre', l: 'Nombre', t: 'text', req: 1 },
      { k: 'categoria', l: 'Categoría', t: 'text' }, { k: 'precio', l: 'Precio de venta', t: 'number' },
      { k: 'pesoNeto', l: 'Peso neto', t: 'text' }, { k: 'vidaUtilDias', l: 'Vida útil (días)', t: 'number' },
      { k: 'ean', l: 'Código EAN', t: 'text' }, { k: 'stock', l: 'Stock inicial', t: 'number' },
      { k: 'conservacion', l: 'Conservación', t: 'textarea', full: 1 },
      { k: 'ingredientes', l: 'Ingredientes (para rótulo)', t: 'textarea', full: 1 },
      { k: 'nutricional', l: 'Información nutricional', t: 'nut', full: 1 },
      { k: 'sellos', l: 'Sellos frontales (Ley 27.642)', t: 'checks', opts: SELLOS, full: 1 },
      { k: 'leyendas', l: 'Leyendas precautorias', t: 'checks', opts: LEYENDAS, full: 1 }
    ]
  }
};

function fmtCell(kind, v, row) {
  if (kind === 'money') return money(v);
  if (kind === 'num') return numfmt(v);
  if (kind === 'stockBadge') {
    const low = Number(v || 0) <= Number(row.stockMin || 0);
    return `<span class="pill ${low ? 'bad' : 'ok'}">${numfmt(v)}</span>`;
  }
  if (kind === 'margen') {
    const c = Number(row.costoUnit || 0), p = Number(row.precio || 0);
    if (!p) return '<span class="muted">—</span>';
    const m = ((p - c) / p) * 100;
    return `<span class="pill ${m < 25 ? 'warn' : 'ok'}">${m.toFixed(0)}%</span>`;
  }
  return esc(v == null ? '' : v);
}
const isNumCol = k => ['money', 'num', 'stockBadge', 'margen'].includes(k);

async function crudView(c, cfgKey) {
  const cfg = RES[cfgKey];
  for (const f of cfg.fields) if (f.t === 'ref') await loadRef(f.ref);
  const rows = await get('/' + cfg.resource);
  refCache[cfg.resource] = rows;
  const head = cfg.columns.map(col => `<th class="${isNumCol(col[2]) ? 'num' : ''}">${col[1]}</th>`).join('') + '<th></th>';
  const body = rows.length ? rows.map(r => `<tr>${cfg.columns.map(col =>
    `<td class="${isNumCol(col[2]) ? 'num' : ''}">${fmtCell(col[2], r[col[0]], r)}</td>`).join('')}
    <td class="row-actions">${cfg.rowExtra ? cfg.rowExtra(r) : ''}
      <button class="btn btn-ghost btn-sm" data-edit="${esc(r._id)}">Editar</button>
      <button class="btn btn-danger btn-sm" data-del="${esc(r._id)}">✕</button></td></tr>`).join('')
    : `<tr><td colspan="${cfg.columns.length + 1}"><div class="empty">Sin registros. Creá el primero.</div></td></tr>`;

  c.innerHTML = `<div class="section-head"><h2>${TITLES[cfgKey][0]}</h2>
      <div class="toolbar"><input class="input" id="q" placeholder="Buscar…" style="width:200px">
        <button class="btn btn-primary" id="new">+ Nuevo</button></div></div>
    <div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody id="tb">${body}</tbody></table></div>`;

  $('#new').onclick = () => crudForm(cfgKey, null, () => render(cfgKey));
  $('#q').oninput = e => { const q = e.target.value.toLowerCase(); $$('#tb tr').forEach(tr => tr.style.display = tr.textContent.toLowerCase().includes(q) ? '' : 'none'); };
  $$('[data-edit]', c).forEach(b => b.onclick = () => crudForm(cfgKey, rows.find(x => x._id === b.dataset.edit), () => render(cfgKey)));
  $$('[data-del]', c).forEach(b => b.onclick = async () => { if (!confirm('¿Eliminar este registro?')) return; await del('/' + cfg.resource + '/' + encodeURIComponent(b.dataset.del)); toast('Eliminado'); render(cfgKey); });
  $$('[data-mov]', c).forEach(b => b.onclick = () => kardexModal(b.dataset.mov, rows.find(x => x._id === b.dataset.mov)));
}

function fieldHTML(f, val) {
  const v = val != null ? val : '';
  let inner;
  if (f.t === 'textarea') inner = `<textarea data-f="${f.k}">${esc(v)}</textarea>`;
  else if (f.t === 'select') inner = `<select data-f="${f.k}">${f.opts.map(o => `<option value="${esc(o[0])}" ${o[0] == v ? 'selected' : ''}>${esc(o[1])}</option>`).join('')}</select>`;
  else if (f.t === 'ref') {
    const list = refCache[f.ref] || [];
    inner = `<select data-f="${f.k}"><option value="">— ${esc(f.ref)} —</option>${list.map(o => `<option value="${esc(o._id)}" ${o._id === v ? 'selected' : ''}>${esc(o.nombre || o.codigo)}</option>`).join('')}</select>`;
  } else if (f.t === 'checks') {
    const arr = Array.isArray(val) ? val : [];
    inner = `<div class="checks">${f.opts.map(o => `<label><input type="checkbox" data-chk="${f.k}" value="${esc(o[0])}" ${arr.includes(o[0]) ? 'checked' : ''}>${esc(o[1])}</label>`).join('')}</div>`;
  } else if (f.t === 'nut') {
    const n = val || {};
    inner = `<div class="form-grid" data-nut="${f.k}" style="background:var(--paper-2);padding:.8rem;border-radius:10px;border:1px solid var(--line)">
      ${NUT_FIELDS.map(nf => `<div class="field" style="margin-bottom:.5rem"><label>${nf[1]}</label>
        <input class="input" data-nk="${nf[0]}" type="${nf[2]}" value="${esc(n[nf[0]] != null ? n[nf[0]] : '')}"></div>`).join('')}</div>`;
  } else {
    inner = `<input class="input" data-f="${f.k}" type="${f.t}" value="${esc(v)}" ${f.lock ? 'readonly' : ''}>`;
  }
  return `<div class="field ${f.full ? 'full' : ''}"><label>${f.l}${f.req ? ' *' : ''}</label>${inner}</div>`;
}
function collectForm(root, fields) {
  const out = {};
  fields.forEach(f => {
    if (f.t === 'checks') out[f.k] = $$(`[data-chk="${f.k}"]`, root).filter(x => x.checked).map(x => x.value);
    else if (f.t === 'nut') { const n = {}; $$('[data-nk]', $(`[data-nut="${f.k}"]`, root)).forEach(i => { n[i.dataset.nk] = i.type === 'number' ? (i.value === '' ? '' : Number(i.value)) : i.value; }); out[f.k] = n; }
    else { const el = $(`[data-f="${f.k}"]`, root); if (!el) return; out[f.k] = f.t === 'number' ? (el.value === '' ? 0 : Number(el.value)) : el.value; }
  });
  return out;
}
async function crudForm(cfgKey, row, done) {
  const cfg = RES[cfgKey];
  for (const f of cfg.fields) if (f.t === 'ref') await loadRef(f.ref);
  const isEdit = !!row;
  const form = document.createElement('div');
  form.innerHTML = `<div class="form-grid">${cfg.fields.map(f => fieldHTML({ ...f, lock: f.lockEdit && isEdit }, row ? row[f.k] : (f.t === 'number' ? 0 : ''))).join('')}</div>`;
  const save = btn(isEdit ? 'Guardar cambios' : 'Crear', 'btn-primary', async () => {
    const data = collectForm(form, cfg.fields);
    for (const f of cfg.fields) if (f.req && !data[f.k]) return toast('Falta: ' + f.l, 'err');
    try {
      if (isEdit) await put('/' + cfg.resource + '/' + encodeURIComponent(row._id), data);
      else await post('/' + cfg.resource, data);
      toast('Guardado'); m.close(); refCache[cfg.resource] = null; done && done();
    } catch (e) { toast(e.message, 'err'); }
  });
  const m = modal({ title: (isEdit ? 'Editar ' : 'Nuevo ') + TITLES[cfgKey][0].replace(' / Stock', ''), body: form, footer: [btn('Cancelar', 'btn-ghost', () => m.close()), save], wide: cfgKey === 'productos' });
}

async function kardexModal(id, art) {
  const movs = await get('/movimientos?articuloId=' + encodeURIComponent(id));
  const body = document.createElement('div');
  body.innerHTML = `<div class="table-wrap"><table><thead><tr>
    <th>Fecha</th><th>Motivo</th><th>Ref.</th><th>Lote</th><th class="num">Cant.</th></tr></thead><tbody>
    ${movs.length ? movs.map(m => `<tr><td>${dtAR(m.fecha)}</td>
      <td><span class="pill ${m.cantidad >= 0 ? 'ok' : 'bad'}">${esc(m.motivo)}</span></td>
      <td class="muted">${esc(m.refId || '')}</td><td>${esc(m.lote || '')}</td>
      <td class="num">${m.cantidad >= 0 ? '+' : ''}${numfmt(m.cantidad)}</td></tr>`).join('')
      : `<tr><td colspan="5"><div class="empty">Sin movimientos</div></td></tr>`}</tbody></table></div>`;
  modal({ title: 'Kardex · ' + (art?.nombre || id), body, wide: true });
}

/* ---------- ver documento (venta/compra) ---------- */
async function verDoc(type, id, refResource) {
  const d = await get('/' + (type === 'venta' ? 'ventas' : 'compras') + '/' + encodeURIComponent(id));
  await loadRef(refResource);
  const items = (d.items || []).map(it => `<tr><td>${esc(it.descripcion || it.productoId || it.insumoId)}</td>
    <td class="num">${numfmt(it.cantidad)}</td>
    <td class="num">${money(it.precioUnit != null ? it.precioUnit : it.costoUnit)}</td>
    <td class="num">${money(it.subtotal)}</td></tr>`).join('');
  const body = document.createElement('div');
  body.innerHTML = `<div class="card card-pad" style="margin-bottom:1rem"><div class="row">
      <div><div class="muted" style="font-size:.74rem">N°</div><b>${esc(d.numero)}</b></div>
      <div><div class="muted" style="font-size:.74rem">FECHA</div><b>${dAR(d.fecha)}</b></div>
      <div><div class="muted" style="font-size:.74rem">${type === 'venta' ? 'CLIENTE' : 'PROVEEDOR'}</div><b>${esc(refName(refResource, d.clienteId || d.proveedorId) || '—')}</b></div>
    </div></div>
    <div class="table-wrap"><table><thead><tr><th>Detalle</th><th class="num">Cant.</th><th class="num">Unit.</th><th class="num">Subtotal</th></tr></thead>
    <tbody>${items}</tbody></table></div>
    <div class="items-total"><span>Total</span><b>${money(d.total)}</b></div>`;
  modal({ title: (type === 'venta' ? 'Venta ' : 'Compra ') + d.numero, body, wide: true });
}

/* ================= ITEMS EDITOR (ventas/compras) ================= */
function itemsEditor({ refList, priceField, priceLabel }) {
  const wrap = document.createElement('div');
  wrap.innerHTML = `<div class="table-wrap"><table class="items"><thead><tr>
    <th style="width:40%">Artículo</th><th class="num">Cantidad</th><th class="num">${priceLabel}</th>
    <th class="num">Subtotal</th><th></th></tr></thead><tbody class="ib"></tbody></table></div>
    <div style="margin-top:.6rem"><button class="btn btn-ghost btn-sm add">+ Agregar ítem</button></div>
    <div class="items-total"><span>Total</span><b class="tot">$0,00</b></div>`;
  const tb = wrap.querySelector('.ib');
  function recalc() {
    let tot = 0;
    $$('tr', tb).forEach(tr => { const sub = Number($('.c', tr).value || 0) * Number($('.p', tr).value || 0); tot += sub; $('.sub', tr).textContent = money(sub); });
    wrap.querySelector('.tot').textContent = money(tot); return tot;
  }
  function addRow(item = {}) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td><select class="art"><option value="">— elegir —</option>
        ${refList.map(o => `<option value="${esc(o._id)}" data-price="${o[priceField] || 0}">${esc(o.nombre)}</option>`).join('')}</select></td>
      <td><input class="input c" type="number" step="0.01" value="${item.cantidad || 1}"></td>
      <td><input class="input p" type="number" step="0.01" value="${item.precio || 0}"></td>
      <td class="num sub">$0,00</td>
      <td><button class="btn btn-danger btn-sm rm">✕</button></td>`;
    tb.append(tr);
    const sel = $('.art', tr);
    sel.onchange = () => { const o = sel.selectedOptions[0]; if (o && o.dataset.price) $('.p', tr).value = o.dataset.price; recalc(); };
    $('.c', tr).oninput = recalc; $('.p', tr).oninput = recalc;
    $('.rm', tr).onclick = () => { tr.remove(); recalc(); };
    recalc();
  }
  wrap.querySelector('.add').onclick = () => addRow();
  addRow();
  return {
    element: wrap,
    items: () => $$('tr', tb).map(tr => ({
      refId: $('.art', tr).value, descripcion: $('.art', tr).selectedOptions[0]?.textContent.trim() || '',
      cantidad: Number($('.c', tr).value || 0), precio: Number($('.p', tr).value || 0)
    })).filter(i => i.refId && i.cantidad > 0)
  };
}

/* ================= VENTAS ================= */
async function ventasView(c) {
  const ventas = await get('/ventas'); await loadRef('clientes');
  c.innerHTML = `<div class="section-head"><h2>Ventas</h2>
    <button class="btn btn-primary" id="new">+ Nueva venta</button></div>
    <div class="table-wrap"><table><thead><tr><th>N°</th><th>Fecha</th><th>Cliente</th>
      <th class="num">Total</th><th>Estado</th><th></th></tr></thead><tbody>
      ${ventas.length ? ventas.map(v => `<tr><td><b>${esc(v.numero)}</b></td><td>${dAR(v.fecha)}</td>
        <td>${esc(refName('clientes', v.clienteId) || 'Consumidor final')}</td><td class="num">${money(v.total)}</td>
        <td><span class="pill ok">${esc(v.estado)}</span></td>
        <td class="row-actions">
          <button class="btn btn-ghost btn-sm" data-env="${esc(v._id)}">Envío</button>
          <button class="btn btn-ghost btn-sm" data-ver="${esc(v._id)}">Ver</button></td></tr>`).join('')
      : `<tr><td colspan="6"><div class="empty">Sin ventas registradas</div></td></tr>`}</tbody></table></div>`;
  $('#new').onclick = () => ventaForm(() => render('ventas'));
  $$('[data-ver]', c).forEach(b => b.onclick = () => verDoc('venta', b.dataset.ver, 'clientes'));
  $$('[data-env]', c).forEach(b => b.onclick = () => { go('etiquetas'); setTimeout(() => window._envioFromVenta && window._envioFromVenta(b.dataset.env), 300); });
}
async function ventaForm(done) {
  const productos = await loadRef('productos'); const clientes = await loadRef('clientes');
  const ed = itemsEditor({ refList: productos, priceField: 'precio', priceLabel: 'Precio' });
  const form = document.createElement('div');
  form.innerHTML = `<div class="form-grid">
      <div class="field"><label>Cliente</label><select data-f="cliente"><option value="">Consumidor final</option>
        ${clientes.map(c => `<option value="${esc(c._id)}">${esc(c.nombre)}</option>`).join('')}</select></div>
      <div class="field"><label>Fecha</label><input class="input" data-f="fecha" type="date" value="${todayISO()}"></div>
      <div class="full"></div></div>
    <div class="field"><label>Observaciones</label><textarea data-f="obs"></textarea></div>`;
  form.querySelector('.full').append(ed.element);
  const save = btn('Confirmar venta', 'btn-primary', async () => {
    const items = ed.items().map(i => ({ productoId: i.refId, descripcion: i.descripcion, cantidad: i.cantidad, precioUnit: i.precio }));
    if (!items.length) return toast('Agregá al menos un ítem', 'err');
    try {
      const r = await post('/ventas', { clienteId: $('[data-f="cliente"]', form).value || null, fecha: new Date($('[data-f="fecha"]', form).value).toISOString(), items, obs: $('[data-f="obs"]', form).value });
      toast('Venta ' + r.numero + ' registrada'); m.close(); refCache.productos = null; done && done();
    } catch (e) { toast(e.message, 'err'); }
  });
  const m = modal({ title: 'Nueva venta', body: form, footer: [btn('Cancelar', 'btn-ghost', () => m.close()), save], wide: true });
}

/* ================= COMPRAS ================= */
async function comprasView(c) {
  const compras = await get('/compras'); await loadRef('proveedores');
  c.innerHTML = `<div class="section-head"><h2>Compras</h2>
    <button class="btn btn-primary" id="new">+ Nueva compra</button></div>
    <div class="table-wrap"><table><thead><tr><th>N°</th><th>Fecha</th><th>Proveedor</th>
      <th class="num">Total</th><th>Estado</th><th></th></tr></thead><tbody>
      ${compras.length ? compras.map(v => `<tr><td><b>${esc(v.numero)}</b></td><td>${dAR(v.fecha)}</td>
        <td>${esc(refName('proveedores', v.proveedorId) || '—')}</td><td class="num">${money(v.total)}</td>
        <td><span class="pill info">${esc(v.estado)}</span></td>
        <td class="row-actions"><button class="btn btn-ghost btn-sm" data-ver="${esc(v._id)}">Ver</button></td></tr>`).join('')
      : `<tr><td colspan="6"><div class="empty">Sin compras registradas</div></td></tr>`}</tbody></table></div>`;
  $('#new').onclick = () => compraForm(() => render('compras'));
  $$('[data-ver]', c).forEach(b => b.onclick = () => verDoc('compra', b.dataset.ver, 'proveedores'));
}
async function compraForm(done) {
  const insumos = await loadRef('insumos'); const proveedores = await loadRef('proveedores');
  const ed = itemsEditor({ refList: insumos, priceField: 'costoUnit', priceLabel: 'Costo' });
  const form = document.createElement('div');
  form.innerHTML = `<div class="form-grid">
      <div class="field"><label>Proveedor</label><select data-f="prov"><option value="">—</option>
        ${proveedores.map(c => `<option value="${esc(c._id)}">${esc(c.nombre)}</option>`).join('')}</select></div>
      <div class="field"><label>Fecha</label><input class="input" data-f="fecha" type="date" value="${todayISO()}"></div>
      <div class="full"></div></div>`;
  form.querySelector('.full').append(ed.element);
  const save = btn('Registrar compra (ingresa stock)', 'btn-primary', async () => {
    const items = ed.items().map(i => ({ insumoId: i.refId, descripcion: i.descripcion, cantidad: i.cantidad, costoUnit: i.precio }));
    if (!items.length) return toast('Agregá al menos un ítem', 'err');
    try {
      const r = await post('/compras', { proveedorId: $('[data-f="prov"]', form).value || null, fecha: new Date($('[data-f="fecha"]', form).value).toISOString(), items });
      toast('Compra ' + r.numero + ' registrada'); m.close(); refCache.insumos = null; done && done();
    } catch (e) { toast(e.message, 'err'); }
  });
  const m = modal({ title: 'Nueva compra', body: form, footer: [btn('Cancelar', 'btn-ghost', () => m.close()), save], wide: true });
}

/* ================= FABRICACIÓN ================= */
async function fabricacionView(c) {
  const ordenes = await get('/fabricacion');
  c.innerHTML = `<div class="section-head"><h2>Órdenes de fabricación</h2>
    <button class="btn btn-primary" id="new">+ Nueva orden</button></div>
    <div class="table-wrap"><table><thead><tr><th>N°</th><th>Fecha</th><th>Producto</th>
      <th class="num">Cantidad</th><th>Lote</th><th class="num">Costo/u</th><th></th></tr></thead><tbody>
      ${ordenes.length ? ordenes.map(o => `<tr><td><b>${esc(o.numero)}</b></td><td>${dAR(o.fecha)}</td>
        <td>${esc(o.productoNombre)}</td><td class="num">${numfmt(o.cantidad)}</td>
        <td><span class="pill info">${esc(o.loteCodigo)}</span></td><td class="num">${money(o.costoUnit)}</td>
        <td class="row-actions"><button class="btn btn-ghost btn-sm" data-rot="${esc(o.loteId || '')}">Rótulo</button></td></tr>`).join('')
      : `<tr><td colspan="7"><div class="empty">Sin órdenes de fabricación</div></td></tr>`}</tbody></table></div>`;
  $('#new').onclick = () => fabricacionForm(() => render('fabricacion'));
  $$('[data-rot]', c).forEach(b => b.onclick = () => { go('etiquetas'); setTimeout(() => window._rotuloFromLote && window._rotuloFromLote(b.dataset.rot), 300); });
}
async function fabricacionForm(done) {
  const [productos, recetas, insumos] = await Promise.all([loadRef('productos'), loadRef('recetas'), loadRef('insumos')]);
  const form = document.createElement('div');
  form.innerHTML = `<div class="form-grid">
      <div class="field"><label>Producto a fabricar *</label><select data-f="producto"><option value="">—</option>
        ${productos.map(p => `<option value="${esc(p._id)}">${esc(p.nombre)}</option>`).join('')}</select></div>
      <div class="field"><label>Cantidad (unidades) *</label><input class="input" data-f="cant" type="number" value="100"></div>
      <div class="field"><label>Receta</label><select data-f="receta"><option value="">— sin receta —</option>
        ${recetas.map(r => `<option value="${esc(r._id)}">${esc(r.nombre)} (rinde ${r.rinde})</option>`).join('')}</select></div>
      <div class="field"><label>Fecha de elaboración</label><input class="input" data-f="fecha" type="date" value="${todayISO()}"></div>
    </div><div id="consumos" style="margin-top:.5rem"></div>`;
  const selProd = $('[data-f="producto"]', form), selRec = $('[data-f="receta"]', form), inpCant = $('[data-f="cant"]', form);
  function pintar() {
    const recId = selRec.value, cant = Number(inpCant.value || 0), box = $('#consumos', form);
    if (!recId) { box.innerHTML = '<p class="hint">Elegí una receta para ver el consumo de insumos y el costo estimado.</p>'; return; }
    const rec = recetas.find(r => r._id === recId);
    if (rec.productoId && !selProd.value) selProd.value = rec.productoId;
    const factor = cant / Number(rec.rinde || 1);
    let costo = 0, faltan = false;
    const rows = (rec.items || []).map(it => {
      const ins = insumos.find(i => i._id === it.insumoId) || {};
      const req = Number(it.cantidad) * factor, cu = Number(ins.costoUnit || 0);
      costo += cu * req; const ok = Number(ins.stock || 0) >= req; if (!ok) faltan = true;
      return `<tr><td>${esc(ins.nombre || it.descripcion)}</td><td class="num">${numfmt(req)} ${esc(ins.unidad || '')}</td>
        <td class="num">${money(cu * req)}</td><td><span class="pill ${ok ? 'ok' : 'bad'}">${ok ? 'OK' : 'Falta'} (${numfmt(ins.stock || 0)})</span></td></tr>`;
    }).join('');
    box.innerHTML = `<div class="card card-pad"><b>Consumo de insumos</b>
      <div class="table-wrap" style="margin-top:.6rem"><table><thead><tr><th>Insumo</th><th class="num">Requerido</th><th class="num">Costo</th><th>Stock</th></tr></thead><tbody>${rows}</tbody></table></div>
      <div class="items-total"><span>Costo estimado total</span><b>${money(costo)}</b></div>
      <div class="items-total" style="padding-top:.2rem"><span>Costo por unidad</span><b>${money(cant ? costo / cant : 0)}</b></div>
      ${faltan ? '<p class="hint" style="color:var(--red)">⚠ Hay insumos con stock insuficiente. Podés forzar igualmente.</p>' : ''}</div>`;
  }
  selRec.onchange = pintar; inpCant.oninput = pintar; pintar();
  const save = btn('Fabricar', 'btn-primary', async () => {
    const productoId = selProd.value, cantidad = Number(inpCant.value || 0);
    if (!productoId || !cantidad) return toast('Falta producto o cantidad', 'err');
    try {
      const r = await post('/fabricacion', { productoId, cantidad, recetaId: selRec.value || null, fechaElaboracion: new Date($('[data-f="fecha"]', form).value).toISOString(), force: true });
      toast('Orden ' + r.orden.numero + ' · Lote ' + r.lote.codigo);
      m.close(); refCache.productos = null; refCache.insumos = null; done && done(); fabResultModal(r);
    } catch (e) { toast(e.message, 'err'); }
  });
  const m = modal({ title: 'Nueva orden de fabricación', body: form, footer: [btn('Cancelar', 'btn-ghost', () => m.close()), save], wide: true });
}
function fabResultModal(r) {
  const body = document.createElement('div');
  body.innerHTML = `<div class="card card-pad">
    <p>Se fabricaron <b>${numfmt(r.orden.cantidad)}</b> u. de <b>${esc(r.orden.productoNombre)}</b>.</p>
    <div class="row" style="margin-top:.5rem">
      <div><div class="muted" style="font-size:.78rem">LOTE</div><b>${esc(r.lote.codigo)}</b></div>
      <div><div class="muted" style="font-size:.78rem">VENCE</div><b>${dAR(r.lote.fechaVencimiento)}</b></div>
      <div><div class="muted" style="font-size:.78rem">COSTO/U</div><b>${money(r.orden.costoUnit)}</b></div></div></div>`;
  const m = modal({ title: 'Producción finalizada', body,
    footer: [btn('Imprimir rótulo', 'btn-primary', () => { m.close(); go('etiquetas'); setTimeout(() => window._rotuloFromLote(r.lote._id), 300); }), btn('Cerrar', 'btn-ghost', () => m.close())] });
}

/* ================= RECETAS ================= */
async function recetasView(c) {
  const [recetas, productos, insumos] = await Promise.all([get('/recetas'), loadRef('productos'), loadRef('insumos')]);
  refCache.recetas = recetas;
  const costoRec = r => (r.items || []).reduce((s, it) => s + Number((insumos.find(i => i._id === it.insumoId) || {}).costoUnit || 0) * Number(it.cantidad), 0);
  c.innerHTML = `<div class="section-head"><h2>Recetas</h2>
    <button class="btn btn-primary" id="new">+ Nueva receta</button></div>
    <div class="table-wrap"><table><thead><tr><th>Código</th><th>Receta</th><th>Producto</th>
      <th class="num">Rinde</th><th class="num">Costo lote</th><th class="num">Costo/u</th><th></th></tr></thead><tbody>
      ${recetas.length ? recetas.map(r => { const cl = costoRec(r); return `<tr><td>${esc(r.codigo)}</td><td><b>${esc(r.nombre)}</b></td>
        <td>${esc(refName('productos', r.productoId) || '—')}</td><td class="num">${numfmt(r.rinde)}</td>
        <td class="num">${money(cl)}</td><td class="num">${money(r.rinde ? cl / r.rinde : 0)}</td>
        <td class="row-actions"><button class="btn btn-ghost btn-sm" data-edit="${esc(r._id)}">Editar</button>
          <button class="btn btn-danger btn-sm" data-del="${esc(r._id)}">✕</button></td></tr>`; }).join('')
      : `<tr><td colspan="7"><div class="empty">Sin recetas</div></td></tr>`}</tbody></table></div>`;
  $('#new').onclick = () => recetaForm(null, productos, insumos, () => render('recetas'));
  $$('[data-edit]', c).forEach(b => b.onclick = () => recetaForm(recetas.find(x => x._id === b.dataset.edit), productos, insumos, () => render('recetas')));
  $$('[data-del]', c).forEach(b => b.onclick = async () => { if (!confirm('¿Eliminar receta?')) return; await del('/recetas/' + encodeURIComponent(b.dataset.del)); toast('Eliminada'); render('recetas'); });
}
function recetaForm(row, productos, insumos, done) {
  const isEdit = !!row;
  const form = document.createElement('div');
  form.innerHTML = `<div class="form-grid">
      <div class="field"><label>Código *</label><input class="input" data-f="codigo" value="${esc(row?.codigo || '')}" ${isEdit ? 'readonly' : ''}></div>
      <div class="field"><label>Nombre *</label><input class="input" data-f="nombre" value="${esc(row?.nombre || '')}"></div>
      <div class="field"><label>Producto resultante</label><select data-f="producto"><option value="">—</option>
        ${productos.map(p => `<option value="${esc(p._id)}" ${row?.productoId === p._id ? 'selected' : ''}>${esc(p.nombre)}</option>`).join('')}</select></div>
      <div class="field"><label>Rinde (unidades)</label><input class="input" data-f="rinde" type="number" value="${row?.rinde || 100}"></div>
    </div>
    <label style="font-size:.78rem;font-weight:600;color:var(--cocoa-700)">Insumos</label>
    <div class="table-wrap"><table class="items"><thead><tr><th style="width:55%">Insumo</th><th class="num">Cantidad</th><th></th></tr></thead><tbody class="ib"></tbody></table></div>
    <button class="btn btn-ghost btn-sm add" style="margin-top:.5rem">+ Agregar insumo</button>`;
  const tb = $('.ib', form);
  function addRow(it = {}) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td><select class="art"><option value="">—</option>
      ${insumos.map(i => `<option value="${esc(i._id)}" data-d="${esc(i.nombre)}" ${i._id === it.insumoId ? 'selected' : ''}>${esc(i.nombre)} (${esc(i.unidad || '')})</option>`).join('')}</select></td>
      <td><input class="input c" type="number" step="0.0001" value="${it.cantidad || 0}"></td>
      <td><button class="btn btn-danger btn-sm rm">✕</button></td>`;
    tb.append(tr); $('.rm', tr).onclick = () => tr.remove();
  }
  (row?.items && row.items.length ? row.items : [{}]).forEach(addRow);
  $('.add', form).onclick = () => addRow();
  const save = btn(isEdit ? 'Guardar' : 'Crear', 'btn-primary', async () => {
    const data = {
      codigo: $('[data-f="codigo"]', form).value.trim(), nombre: $('[data-f="nombre"]', form).value.trim(),
      productoId: $('[data-f="producto"]', form).value || null, rinde: Number($('[data-f="rinde"]', form).value || 1),
      items: $$('tr', tb).map(tr => ({ insumoId: $('.art', tr).value, descripcion: $('.art', tr).selectedOptions[0]?.dataset.d || '', cantidad: Number($('.c', tr).value || 0) })).filter(i => i.insumoId && i.cantidad > 0)
    };
    if (!data.codigo || !data.nombre) return toast('Falta código o nombre', 'err');
    try {
      if (isEdit) await put('/recetas/' + encodeURIComponent(row._id), data); else await post('/recetas', data);
      toast('Guardado'); m.close(); refCache.recetas = null; done && done();
    } catch (e) { toast(e.message, 'err'); }
  });
  const m = modal({ title: isEdit ? 'Editar receta' : 'Nueva receta', body: form, footer: [btn('Cancelar', 'btn-ghost', () => m.close()), save], wide: true });
}

/* ================= LOTES / TRAZABILIDAD ================= */
async function lotesView(c) {
  const lotes = await get('/lotes');
  c.innerHTML = `<div class="section-head"><h2>Lotes y trazabilidad</h2></div>
    <div class="table-wrap"><table><thead><tr><th>Lote</th><th>Producto</th>
      <th class="num">Cantidad</th><th>Elaboración</th><th>Vencimiento</th><th class="num">Costo/u</th><th></th></tr></thead><tbody>
      ${lotes.length ? lotes.map(l => { const venc = l.fechaVencimiento && new Date(l.fechaVencimiento) < new Date(); return `<tr>
        <td><b>${esc(l.codigo)}</b></td><td>${esc(l.productoNombre)}</td><td class="num">${numfmt(l.cantidad)}</td>
        <td>${dAR(l.fechaElaboracion)}</td><td>${dAR(l.fechaVencimiento)} ${venc ? '<span class="pill bad">vencido</span>' : ''}</td>
        <td class="num">${money(l.costoUnit)}</td>
        <td class="row-actions">
          <button class="btn btn-ghost btn-sm" data-tz="${esc(l._id)}">Trazabilidad</button>
          <button class="btn btn-ghost btn-sm" data-rot="${esc(l._id)}">Rótulo</button></td></tr>`; }).join('')
      : `<tr><td colspan="7"><div class="empty">Aún no hay lotes. Generá uno desde Fabricación.</div></td></tr>`}</tbody></table></div>`;
  $$('[data-tz]', c).forEach(b => b.onclick = () => trazaModal(b.dataset.tz));
  $$('[data-rot]', c).forEach(b => b.onclick = () => { go('etiquetas'); setTimeout(() => window._rotuloFromLote(b.dataset.rot), 300); });
}
async function trazaModal(loteId) {
  const t = await get('/lotes/' + encodeURIComponent(loteId) + '/trazabilidad');
  const body = document.createElement('div');
  body.innerHTML = `
    <div class="card card-pad" style="margin-bottom:1rem"><div class="row">
        <div><div class="muted" style="font-size:.74rem">LOTE</div><b>${esc(t.lote.codigo)}</b></div>
        <div><div class="muted" style="font-size:.74rem">PRODUCTO</div><b>${esc(t.lote.productoNombre)}</b></div>
        <div><div class="muted" style="font-size:.74rem">ELABORACIÓN</div><b>${dAR(t.lote.fechaElaboracion)}</b></div>
        <div><div class="muted" style="font-size:.74rem">VENCE</div><b>${dAR(t.lote.fechaVencimiento)}</b></div></div></div>
    <h4 style="font-family:Fraunces;margin:.4rem 0">Origen · Insumos consumidos</h4>
    <div class="table-wrap" style="margin-bottom:1rem"><table><thead><tr><th>Insumo</th><th class="num">Cantidad</th></tr></thead>
      <tbody>${t.insumos.length ? t.insumos.map(i => `<tr><td>${esc(i.nombre)}</td><td class="num">${numfmt(i.cantidad)} ${esc(i.unidad)}</td></tr>`).join('') : '<tr><td colspan="2" class="muted">—</td></tr>'}</tbody></table></div>
    <h4 style="font-family:Fraunces;margin:.4rem 0">Destino · Ventas del lote</h4>
    <div class="table-wrap"><table><thead><tr><th>Venta</th><th>Fecha</th><th>Cliente</th><th class="num">Cantidad</th></tr></thead>
      <tbody>${t.ventas.length ? t.ventas.map(v => `<tr><td>${esc(v.numero || '')}</td><td>${dAR(v.fecha)}</td><td>${esc(v.cliente)}</td><td class="num">${numfmt(v.cantidad)}</td></tr>`).join('') : '<tr><td colspan="4" class="muted">Sin ventas asociadas todavía</td></tr>'}</tbody></table></div>`;
  modal({ title: 'Trazabilidad de lote', body, wide: true });
}

/* ================= ETIQUETAS ================= */
const SELLO_TXT = { azucares: 'Alto en azúcares', 'grasas-saturadas': 'Alto en grasas saturadas', 'grasas-totales': 'Alto en grasas totales', sodio: 'Alto en sodio', calorias: 'Alto en calorías' };
const LEYENDA_TXT = { edulcorantes: 'Contiene edulcorantes · no recomendable en niños/as', cafeina: 'Contiene cafeína · evitar en niños/as' };
const NUT_ROWS = [['kcal', 'Valor energético', 'kcal'], ['carbohidratos', 'Carbohidratos', 'g'], ['azucares', 'Azúcares totales', 'g'], ['proteinas', 'Proteínas', 'g'], ['grasas', 'Grasas totales', 'g'], ['grasasSat', 'Grasas saturadas', 'g'], ['grasasTrans', 'Grasas trans', 'g'], ['fibra', 'Fibra alimentaria', 'g'], ['sodio', 'Sodio', 'mg']];

function rotuloHTML(r) {
  const p = r.producto, n = p.nutricional || {};
  const sellos = (p.sellos || []).map(s => `<div class="sello">${esc(SELLO_TXT[s] || s)}</div>`).join('');
  const leyendas = (p.leyendas || []).map(l => `<div class="leyenda-sello">${esc(LEYENDA_TXT[l] || l)}</div>`).join('');
  const nut = `<div class="nut"><div class="nh">Información Nutricional</div>
    <div class="nr"><span>Porción: ${esc(n.porcion || '—')}</span><span>${esc(n.porciones || '')}</span></div>
    ${NUT_ROWS.map(row => n[row[0]] != null && n[row[0]] !== '' ? `<div class="nr"><span>${row[1]}</span><b>${numfmt(n[row[0]])} ${row[2]}</b></div>` : '').join('')}</div>`;
  return `<div class="rotulo">
    <div class="r-brand">1950</div><div class="r-sub">Alfajores artesanales</div>
    <h4>${esc(p.nombre)}</h4>
    ${(sellos || leyendas) ? `<div class="sellos">${sellos}${leyendas}</div>` : ''}
    <div class="r-grid">
      <div style="flex:1">
        <div class="r-small"><b>Ingredientes:</b> ${esc(r.ingredientes || '—')}</div>
        <div class="r-small" style="margin-top:1.5mm"><b>Peso neto:</b> ${esc(p.pesoNeto || '—')} &nbsp; <b>EAN:</b> ${esc(p.ean || '—')}</div>
        <div class="r-small"><b>Lote:</b> ${esc(r.lote.codigo)}</div>
        <div class="r-small"><b>Elab.:</b> ${dAR(r.lote.elaboracion)} &nbsp; <b>Vto.:</b> ${dAR(r.lote.vencimiento)}</div>
        <div class="r-small" style="margin-top:1.5mm">${esc(p.conservacion || '')}</div>
      </div>
      <div style="text-align:center"><img class="r-qr" src="${r.qr}"><div class="r-small">Trazabilidad</div></div>
    </div>
    ${nut}
    <div class="r-small" style="margin-top:2mm">Elaborado por ${esc(r.empresa.razonSocial)} · ${esc(r.empresa.rne)} · CUIT ${esc(r.empresa.cuit)}<br>${esc(r.empresa.direccion)}</div>
  </div>`;
}
function envioHTML(r) {
  const e = r.envio;
  return `<div class="envio">
    <div class="e-top"><div><div class="e-brand">1950</div><div style="font-size:7pt">${esc(r.remitente.razonSocial)}<br>${esc(r.remitente.direccion)}</div></div>
      <div style="text-align:right"><div style="font-size:7pt;letter-spacing:.1em">REMITO / ENVÍO</div><b>${esc(e.numero || e.tracking)}</b></div></div>
    <div style="font-size:7pt;letter-spacing:.15em;color:#666">DESTINATARIO</div>
    <div class="e-to">${esc(e.destinatario || '')}</div>
    <div style="font-size:9pt;margin:.5mm 0 3mm">${esc(e.direccion || '')}${e.localidad ? ' · ' + esc(e.localidad) : ''}${e.cp ? ' (CP ' + esc(e.cp) + ')' : ''}<br>${e.telefono ? 'Tel: ' + esc(e.telefono) : ''}</div>
    <div class="e-row"><div style="font-size:8pt">
        <div><b>Bultos:</b> ${esc(e.bultos || 1)}</div>${e.peso ? `<div><b>Peso:</b> ${esc(e.peso)}</div>` : ''}
        ${e.obs ? `<div><b>Obs:</b> ${esc(e.obs)}</div>` : ''}</div>
      <img src="${r.qr}"></div></div>`;
}
async function etiquetasView(c) {
  const lotes = await get('/lotes'); const ventas = await get('/ventas'); await loadRef('clientes');
  c.innerHTML = `<div class="section-head"><h2>Etiquetas y rótulos</h2></div>
    <div class="card card-pad no-print" style="margin-bottom:1rem">
      <div class="label-tools">
        <div class="field" style="margin:0;min-width:260px"><label>Lote</label>
          <select id="lote"><option value="">— elegir lote —</option>
          ${lotes.map(l => `<option value="${esc(l._id)}">${esc(l.codigo)} · ${esc(l.productoNombre)}</option>`).join('')}</select></div>
        <div style="align-self:flex-end;display:flex;gap:.5rem;flex-wrap:wrap">
          <button class="btn btn-primary" id="bRot">Rótulo de producto</button>
          <button class="btn btn-ghost" id="bSerie">Números de serie</button></div>
      </div>
      <hr style="border:none;border-top:1px solid var(--line);margin:.8rem 0">
      <div class="label-tools">
        <div class="field" style="margin:0;min-width:260px"><label>Etiqueta de envío (desde venta)</label>
          <select id="venta"><option value="">— venta —</option>
          ${ventas.map(v => `<option value="${esc(v._id)}">${esc(v.numero)} · ${esc(refName('clientes', v.clienteId) || 'Consumidor')}</option>`).join('')}</select></div>
        <button class="btn btn-ghost" id="bEnvio" style="align-self:flex-end">Generar etiqueta de envío</button>
        <button class="btn btn-ghost" id="bPrint" style="align-self:flex-end">🖨 Imprimir</button>
      </div>
    </div>
    <div class="print-area" id="print"><div class="empty no-print">Elegí un lote o una venta para generar la etiqueta.</div></div>`;
  const out = $('#print', c);
  async function rotulo(loteId) { if (!loteId) return toast('Elegí un lote', 'err'); out.innerHTML = rotuloHTML(await get('/etiquetas/rotulo/' + encodeURIComponent(loteId))); }
  async function series(loteId) {
    if (!loteId) return toast('Elegí un lote', 'err');
    const cant = prompt('¿Cuántas unidades etiquetar?', '12'); if (!cant) return;
    const r = await get(`/etiquetas/serie/${encodeURIComponent(loteId)}?cantidad=${parseInt(cant, 10)}`);
    out.innerHTML = `<div class="card card-pad no-print"><b>Series · ${esc(r.lote.productoNombre)} · Lote ${esc(r.lote.codigo)}</b></div>
      <div class="serie-grid">${r.series.map(s => `<div class="serie"><img src="${s.qr}"><div class="s-txt"><b>1950</b><br>${esc(r.lote.productoNombre)}<br>Lote ${esc(r.lote.codigo)}<br>N° ${esc(s.corr)}</div></div>`).join('')}</div>`;
  }
  async function envio(payload) { out.innerHTML = envioHTML(await post('/etiquetas/envio', payload)); }
  $('#bRot', c).onclick = () => rotulo($('#lote', c).value);
  $('#bSerie', c).onclick = () => series($('#lote', c).value);
  $('#bEnvio', c).onclick = () => { const v = $('#venta', c).value; if (!v) return toast('Elegí una venta', 'err'); envio({ ventaId: v }); };
  $('#bPrint', c).onclick = () => window.print();
  window._rotuloFromLote = async id => { $('#lote', c).value = id; await rotulo(id); };
  window._envioFromVenta = async id => { $('#venta', c).value = id; await envio({ ventaId: id }); };
}

/* ================= DASHBOARD ================= */
async function dashboardView(c) {
  const d = await get('/dashboard');
  const k = d.kpis;
  const maxV = Math.max(1, ...d.serieVentas.map(s => s.total));
  const chart = d.serieVentas.map(s => `<div class="bar" style="height:${Math.max(3, s.total / maxV * 100)}%" title="${dAR(s.fecha)}: ${money(s.total)}"><span>${s.fecha.slice(8, 10)}</span></div>`).join('');
  c.innerHTML = `
    <div class="kpis">
      <div class="card kpi"><div class="lbl">Ventas del mes</div><div class="val">${money(k.ventasMesTotal)}</div><div class="delta">${k.ventasMesCount} operaciones</div></div>
      <div class="card kpi"><div class="lbl">Compras del mes</div><div class="val">${money(k.comprasMesTotal)}</div></div>
      <div class="card kpi"><div class="lbl">Valor de stock (PT)</div><div class="val">${money(k.stockValor)}</div></div>
      <div class="card kpi"><div class="lbl">Productos</div><div class="val">${k.productos}</div><div class="delta">${k.insumos} insumos · ${k.ordenes} órdenes</div></div>
    </div>
    <div class="row">
      <div class="card card-pad" style="flex:2;min-width:320px">
        <div class="section-head" style="margin-bottom:.4rem"><h2 style="font-size:1.05rem">Ventas · últimos 14 días</h2></div>
        <div class="chart">${chart}</div><div style="height:1.2rem"></div>
      </div>
      <div class="card card-pad" style="flex:1;min-width:260px">
        <div class="section-head" style="margin-bottom:.6rem"><h2 style="font-size:1.05rem">Stock bajo</h2></div>
        ${d.insumosBajos.length ? d.insumosBajos.map(i => `<div style="display:flex;justify-content:space-between;padding:.4rem 0;border-bottom:1px solid #f0e6d3">
          <span>${esc(i.nombre)}</span><span class="pill bad">${numfmt(i.stock)} / ${numfmt(i.stockMin)} ${esc(i.unidad || '')}</span></div>`).join('') : '<div class="muted">Todo el stock por encima del mínimo ✓</div>'}
      </div>
    </div>
    <div class="row" style="margin-top:1rem">
      <div class="card card-pad" style="flex:1;min-width:300px">
        <div class="section-head" style="margin-bottom:.6rem"><h2 style="font-size:1.05rem">Últimas ventas</h2></div>
        <div class="table-wrap" style="border:none"><table><tbody>
          ${d.ventasRecientes.length ? d.ventasRecientes.map(v => `<tr><td><b>${esc(v.numero)}</b></td><td class="muted">${dAR(v.fecha)}</td><td class="num">${money(v.total)}</td></tr>`).join('') : '<tr><td class="muted">Sin datos</td></tr>'}
        </tbody></table></div>
      </div>
      <div class="card card-pad" style="flex:1;min-width:300px">
        <div class="section-head" style="margin-bottom:.6rem"><h2 style="font-size:1.05rem">Lotes por vencer (30 días)</h2></div>
        <div class="table-wrap" style="border:none"><table><tbody>
          ${d.lotesPorVencer.length ? d.lotesPorVencer.map(l => `<tr><td><b>${esc(l.codigo)}</b></td><td>${esc(l.productoNombre)}</td><td class="muted">${dAR(l.fechaVencimiento)}</td></tr>`).join('') : '<tr><td class="muted">Ninguno próximo a vencer ✓</td></tr>'}
        </tbody></table></div>
      </div>
    </div>`;
}

/* ================= CUENTA / USUARIOS ================= */
const ROLES = [['admin', 'Administrador'], ['ventas', 'Ventas'], ['produccion', 'Producción'], ['deposito', 'Depósito'], ['operario', 'Operario']];
const rolLabel = r => (ROLES.find(o => o[0] === r) || [, r || '—'])[1];

function cambiarPassModal() {
  const form = document.createElement('div');
  form.innerHTML = `<div class="form-grid">
    <div class="field full"><label>Contraseña actual *</label><input class="input" id="pAct" type="password" autocomplete="current-password"></div>
    <div class="field full"><label>Nueva contraseña *</label><input class="input" id="pNue" type="password" autocomplete="new-password"></div>
    <div class="field full"><label>Repetir nueva *</label><input class="input" id="pRep" type="password" autocomplete="new-password"></div></div>`;
  const save = btn('Cambiar', 'btn-primary', async () => {
    const actual = $('#pAct', form).value, nueva = $('#pNue', form).value, rep = $('#pRep', form).value;
    if (!actual || !nueva) return toast('Completá los campos', 'err');
    if (nueva.length < 4) return toast('La nueva contraseña es muy corta (mín. 4)', 'err');
    if (nueva !== rep) return toast('Las contraseñas no coinciden', 'err');
    try { await post('/cambiar-password', { actual, nueva }); toast('Contraseña actualizada'); m.close(); }
    catch (e) { toast(e.message, 'err'); }
  });
  const m = modal({ title: 'Cambiar contraseña', body: form, footer: [btn('Cancelar', 'btn-ghost', () => m.close()), save] });
}

async function usuariosView(c) {
  const users = await get('/usuarios');
  c.innerHTML = `<div class="section-head"><h2>Usuarios</h2>
      <button class="btn btn-primary" id="new">+ Nuevo usuario</button></div>
    <div class="table-wrap"><table><thead><tr><th>Usuario</th><th>Nombre</th><th>Rol</th><th>Estado</th><th></th></tr></thead><tbody>
    ${users.length ? users.map(u => `<tr>
      <td><b>${esc(u.usuario)}</b></td><td>${esc(u.nombre || '')}</td>
      <td><span class="pill">${esc(rolLabel(u.rol))}</span></td>
      <td><span class="pill ${u.activo !== false ? 'ok' : 'bad'}">${u.activo !== false ? 'Activo' : 'Inactivo'}</span></td>
      <td class="row-actions"><button class="btn btn-ghost btn-sm" data-edit="${esc(u.usuario)}">Editar</button></td></tr>`).join('')
      : `<tr><td colspan="5"><div class="empty">Sin usuarios</div></td></tr>`}</tbody></table></div>`;
  $('#new').onclick = () => usuarioForm(null);
  $$('[data-edit]', c).forEach(b => b.onclick = () => usuarioForm(users.find(u => u.usuario === b.dataset.edit)));
}

function usuarioForm(u) {
  const isEdit = !!u;
  const form = document.createElement('div');
  form.innerHTML = `<div class="form-grid">
    <div class="field"><label>Usuario *</label><input class="input" id="uUser" value="${esc(u?.usuario || '')}" ${isEdit ? 'readonly' : ''} autocomplete="off"></div>
    <div class="field"><label>Nombre</label><input class="input" id="uNom" value="${esc(u?.nombre || '')}"></div>
    <div class="field"><label>Rol</label><select id="uRol">${ROLES.map(o => `<option value="${o[0]}" ${u?.rol === o[0] ? 'selected' : ''}>${o[1]}</option>`).join('')}</select></div>
    <div class="field"><label>${isEdit ? 'Nueva contraseña (opcional)' : 'Contraseña *'}</label><input class="input" id="uPass" type="password" autocomplete="new-password"></div>
    ${isEdit ? `<div class="field full"><label style="display:flex;align-items:center;gap:.4rem"><input type="checkbox" id="uAct" ${u.activo !== false ? 'checked' : ''}> Activo</label></div>` : ''}</div>`;
  const save = btn(isEdit ? 'Guardar' : 'Crear', 'btn-primary', async () => {
    const usuario = $('#uUser', form).value.trim();
    const nombre = $('#uNom', form).value.trim();
    const rol = $('#uRol', form).value;
    const password = $('#uPass', form).value;
    if (!usuario) return toast('Falta el usuario', 'err');
    try {
      if (isEdit) {
        const body = { nombre, rol, activo: $('#uAct', form).checked };
        if (password) body.password = password;
        await put('/usuarios/' + encodeURIComponent(usuario), body);
      } else {
        if (!password) return toast('Falta la contraseña', 'err');
        await post('/usuarios', { usuario, nombre, rol, password });
      }
      toast('Guardado'); m.close(); render('usuarios');
    } catch (e) { toast(e.message, 'err'); }
  });
  const m = modal({ title: isEdit ? 'Editar usuario' : 'Nuevo usuario', body: form, footer: [btn('Cancelar', 'btn-ghost', () => m.close()), save] });
}

/* ================= FIRMWARE (OTA) ================= */
const fmtBytes = n => { n = Number(n || 0); return n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(2) + ' MB'; };

async function firmwareView(c) {
  const fws = await get('/firmware');
  c.innerHTML = `<div class="section-head"><h2>Firmware</h2>
      <button class="btn btn-primary" id="new">+ Subir firmware</button></div>
    <div class="table-wrap"><table><thead><tr><th>Versión</th><th>Subido</th><th class="num">Tamaño</th><th>SHA-256</th><th>Notas</th><th></th></tr></thead><tbody>
    ${fws.length ? fws.map(f => `<tr>
      <td><b>${esc(f.version)}</b></td><td class="muted">${dtAR(f.subido)}</td>
      <td class="num">${fmtBytes(f.tamano)}</td>
      <td><code title="${esc(f.sha256 || '')}">${esc((f.sha256 || '').slice(0, 12))}…</code></td>
      <td>${esc(f.notas || '')}</td>
      <td class="row-actions">
        <a class="btn btn-ghost btn-sm" href="${esc(f.archivo)}" download>Descargar</a>
        <button class="btn btn-danger btn-sm" data-del="${esc(f._id)}">✕</button></td></tr>`).join('')
      : `<tr><td colspan="6"><div class="empty">No hay binarios subidos todavía.</div></td></tr>`}</tbody></table></div>`;
  $('#new').onclick = () => firmwareForm();
  $$('[data-del]', c).forEach(b => b.onclick = async () => {
    if (!confirm('¿Eliminar esta versión de firmware? Se borra el binario del servidor.')) return;
    try { await del('/firmware/' + encodeURIComponent(b.dataset.del)); toast('Eliminado'); render('firmware'); }
    catch (e) { toast(e.message, 'err'); }
  });
}

function firmwareForm() {
  const form = document.createElement('div');
  form.innerHTML = `<div class="form-grid">
    <div class="field"><label>Versión *</label><input class="input" id="fVer" placeholder="1.0.0" autocomplete="off"></div>
    <div class="field full"><label>Archivo .bin *</label><input class="input" id="fBin" type="file" accept=".bin"></div>
    <div class="field full"><label>Notas (opcional)</label><input class="input" id="fNot" placeholder="precalentado + mantener + mezclado"></div></div>
    <p class="muted">El binario sale de <code>.pio/build/CacaoIO/firmware.bin</code> tras compilar. Se calcula el SHA-256 en el servidor.</p>`;
  const save = btn('Subir', 'btn-primary', async () => {
    const version = $('#fVer', form).value.trim();
    const file = $('#fBin', form).files[0];
    const notas = $('#fNot', form).value.trim();
    if (!version) return toast('Falta la versión', 'err');
    if (!file) return toast('Elegí un archivo .bin', 'err');
    const fd = new FormData();
    fd.append('version', version); fd.append('notas', notas); fd.append('archivo', file);
    save.disabled = true; save.textContent = 'Subiendo…';
    try {
      const r = await fetch(API + '/firmware', { method: 'POST', body: fd });
      if (r.status === 401) { location.reload(); return; }
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || ('Error ' + r.status));
      toast('Firmware subido'); m.close(); render('firmware');
    } catch (e) { toast(e.message, 'err'); save.disabled = false; save.textContent = 'Subir'; }
  });
  const m = modal({ title: 'Subir firmware', body: form, footer: [btn('Cancelar', 'btn-ghost', () => m.close()), save] });
}

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

/* ================= PROCESOS (curvas de temperatura + IA) ================= */
let chartJsPromise = null;
function loadChartJs() {
  if (window.Chart) return Promise.resolve();
  if (chartJsPromise) return chartJsPromise;
  chartJsPromise = new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js';
    s.onload = res; s.onerror = () => rej(new Error('No se pudo cargar Chart.js'));
    document.head.appendChild(s);
  });
  return chartJsPromise;
}

const fmtDur = seg => {
  seg = Math.round(Number(seg || 0));
  const h = Math.floor(seg / 3600), m = Math.floor((seg % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
};
const ETAPA_NOMBRE = { 0: 'Precalentado', 1: 'Derretido', 2: 'Templado', 3: 'Mantener' };

async function procesosView(c) {
  const [procs, maquinas] = await Promise.all([get('/procesos'), get('/maquinas')]);
  const nombreMaq = id => { const m = maquinas.find(x => x._id === id); return m ? m.nombre : (id || '—'); };
  c.innerHTML = `<div class="section-head"><h2>Procesos de templado</h2></div>
    <div class="table-wrap"><table><thead><tr>
      <th>Máquina</th><th>Receta</th><th>Inicio</th><th class="num">Duración</th>
      <th class="num">Choco prom/máx</th><th>Estado</th><th>IA</th><th></th></tr></thead><tbody>
    ${procs.length ? procs.map(p => {
      const r = p.resumen || {};
      const enCurso = !p.fin;
      const dur = enCurso ? '—' : fmtDur(r.duracionSeg);
      const choco = (r.chocoProm != null) ? `${r.chocoProm}° / ${r.chocoMax}°` : '—';
      return `<tr>
        <td><b>${esc(nombreMaq(p.maquinaId))}</b></td>
        <td>${esc(p.receta || '—')}</td>
        <td class="muted">${dtAR(p.inicio)}</td>
        <td class="num">${dur}</td>
        <td class="num">${choco}</td>
        <td><span class="pill ${enCurso ? 'warn' : 'ok'}">${enCurso ? 'En curso' : 'Finalizado'}</span></td>
        <td>${p.tieneAnalisis ? '✓' : '—'}</td>
        <td class="row-actions"><button class="btn btn-ghost btn-sm" data-ver="${esc(p._id)}">Ver curva</button></td>
      </tr>`;
    }).join('') : `<tr><td colspan="8"><div class="empty">Todavía no se registraron procesos. Aparecen cuando una máquina vinculada inicia una elaboración.</div></td></tr>`}
    </tbody></table></div>`;
  $$('[data-ver]', c).forEach(b => b.onclick = () => procesoDetalle(b.dataset.ver, nombreMaq));
}

let procChart = null;
async function procesoDetalle(id, nombreMaq) {
  const c = $('#content');
  c.innerHTML = '<div class="empty">Cargando curva…</div>';
  let doc;
  try { [doc] = await Promise.all([get('/procesos/' + encodeURIComponent(id)), loadChartJs()]); }
  catch (e) { c.innerHTML = `<div class="card card-pad" style="color:var(--red)">Error: ${esc(e.message)}</div>`; return; }

  const r = doc.resumen || {};
  const seg = r.segPorEtapa || {};
  const etapasTxt = Object.keys(seg).sort().map(k => `${ETAPA_NOMBRE[k] || ('Etapa ' + k)}: ${fmtDur(seg[k])}`).join(' · ') || '—';
  const nombre = nombreMaq ? nombreMaq(doc.maquinaId) : (doc.serial || doc.maquinaId);

  c.innerHTML = `<div class="section-head">
      <h2>Curva · ${esc(nombre)}</h2>
      <button class="btn btn-ghost" id="volver">← Volver</button></div>
    <div class="card card-pad" style="margin-bottom:1rem">
      <div class="muted" style="font-size:.8rem;margin-bottom:.4rem">
        Receta <b>${esc(doc.receta || '—')}</b> · Inicio ${dtAR(doc.inicio)} · ${doc.fin ? 'Duración ' + fmtDur(r.duracionSeg) : 'En curso'}
      </div>
      <div style="position:relative;height:340px"><canvas id="procCanvas"></canvas></div>
      <div class="maq-temps" style="margin-top:.8rem">
        <div><span class="muted">Choco mín/prom/máx</span><b>${r.chocoMin ?? '—'}° / ${r.chocoProm ?? '—'}° / ${r.chocoMax ?? '—'}°</b></div>
        <div><span class="muted">Agua mín/máx</span><b>${r.aguaMin ?? '—'}° / ${r.aguaMax ?? '—'}°</b></div>
        <div><span class="muted">Muestras</span><b>${(doc.samples || []).length}</b></div>
      </div>
      <div class="muted" style="font-size:.78rem;margin-top:.5rem">Tiempo por etapa: ${esc(etapasTxt)}</div>
    </div>
    <div class="card card-pad">
      <div class="section-head" style="margin:0 0 .6rem"><h3 style="margin:0">Análisis con IA</h3>
        <button class="btn btn-primary btn-sm" id="analizar">${doc.analisisIA ? 'Reanalizar' : 'Analizar con IA'}</button></div>
      <div id="iaBox" class="ia-box">${doc.analisisIA
        ? renderIA(doc.analisisIA)
        : '<div class="muted">Generá un análisis automático de esta corrida (calidad del templado, anomalías y recomendaciones).</div>'}</div>
    </div>`;

  $('#volver').onclick = () => render('procesos');
  dibujarCurva(doc.samples || []);

  $('#analizar').onclick = async () => {
    const b = $('#analizar'); b.disabled = true; b.textContent = 'Analizando…';
    $('#iaBox').innerHTML = '<div class="muted">Consultando a la IA, puede tardar unos segundos…</div>';
    try {
      const a = await post('/procesos/' + encodeURIComponent(id) + '/analizar');
      $('#iaBox').innerHTML = renderIA(a);
      b.textContent = 'Reanalizar';
    } catch (e) {
      $('#iaBox').innerHTML = `<div style="color:var(--red)">${esc(e.message)}</div>`;
      b.textContent = 'Analizar con IA';
    } finally { b.disabled = false; }
  };
}

function renderIA(a) {
  const txt = esc(a.texto || '').replace(/\n/g, '<br>');
  return `<div class="ia-text">${txt}</div>
    <div class="muted" style="font-size:.72rem;margin-top:.6rem">${esc(a.modelo || '')} · ${dtAR(a.fecha)}</div>`;
}

function dibujarCurva(samples) {
  if (procChart) { procChart.destroy(); procChart = null; }
  // Submuestreo defensivo para no dibujar miles de puntos.
  const paso = Math.max(1, Math.ceil(samples.length / 800));
  const s = samples.filter((_, i) => i % paso === 0);
  const t0 = s.length ? new Date(s[0].t).getTime() : 0;
  const labels = s.map(x => +(((new Date(x.t).getTime() - t0) / 60000).toFixed(1)));
  const ctx = $('#procCanvas').getContext('2d');
  procChart = new window.Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'Chocolate °C', data: s.map(x => x.tc), borderColor: '#c0392b', backgroundColor: 'transparent', tension: .25, pointRadius: 0, borderWidth: 2 },
        { label: 'Agua °C', data: s.map(x => x.ta), borderColor: '#2980b9', backgroundColor: 'transparent', tension: .25, pointRadius: 0, borderWidth: 1.5 },
        { label: 'Setpoint °C', data: s.map(x => x.sp), borderColor: '#7f8c8d', backgroundColor: 'transparent', borderDash: [6, 4], pointRadius: 0, borderWidth: 1.5 }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: { title: { display: true, text: 'Minutos' }, ticks: { maxTicksLimit: 12 } },
        y: { title: { display: true, text: '°C' } }
      },
      plugins: { legend: { position: 'top' } }
    }
  });
}

/* ================= VIEWS MAP + BOOT ================= */
/* ================= EMPRESAS (superadmin) ================= */
async function empresasView(c) {
  const empresas = await get('/empresas');
  c.innerHTML = `<div class="section-head"><h2>Empresas</h2>
      <button class="btn btn-primary" id="new">+ Nueva empresa</button></div>
    <div class="table-wrap"><table><thead><tr><th>Nombre</th><th>CUIT</th><th>Estado</th><th></th></tr></thead><tbody>
    ${empresas.length ? empresas.map(e => {
      const slug = e._id.replace('empresa:', '');
      const susp = e.activo === false;
      return `<tr>
        <td><b>${esc(e.nombre)}</b></td><td>${esc(e.cuit || '—')}</td>
        <td><span class="pill ${susp ? 'bad' : 'ok'}">${susp ? 'Suspendida' : 'Activa'}</span></td>
        <td class="row-actions">
          <button class="btn btn-ghost btn-sm" data-edit="${esc(slug)}">Editar</button>
          <button class="btn btn-ghost btn-sm" data-toggle="${esc(slug)}" data-act="${susp ? '1' : '0'}">${susp ? 'Reactivar' : 'Suspender'}</button>
        </td></tr>`;
    }).join('') : `<tr><td colspan="4"><div class="empty">Todavía no hay empresas. Creá la primera.</div></td></tr>`}</tbody></table></div>`;
  $('#new').onclick = () => empresaForm(null);
  $$('[data-edit]', c).forEach(b => b.onclick = () => empresaForm(empresas.find(x => x._id.replace('empresa:', '') === b.dataset.edit)));
  $$('[data-toggle]', c).forEach(b => b.onclick = async () => {
    try { await put('/empresas/' + encodeURIComponent(b.dataset.toggle), { activo: b.dataset.act === '1' }); toast('Empresa actualizada'); render('empresas'); }
    catch (e) { toast(e.message, 'err'); }
  });
}

function empresaForm(e) {
  const isEdit = !!e;
  const slug = isEdit ? e._id.replace('empresa:', '') : null;
  const form = document.createElement('div');
  form.innerHTML = `<div class="form-grid">
    <div class="field"><label>Nombre *</label><input class="input" id="eNom" value="${esc(e?.nombre || '')}"></div>
    <div class="field"><label>Razón social</label><input class="input" id="eRazon" value="${esc(e?.razonSocial || '')}"></div>
    <div class="field"><label>CUIT</label><input class="input" id="eCuit" value="${esc(e?.cuit || '')}"></div>
    <div class="field"><label>Teléfono</label><input class="input" id="eTel" value="${esc(e?.telefono || '')}"></div>
    <div class="field full"><label>Domicilio</label><input class="input" id="eDom" value="${esc(e?.domicilio || '')}"></div>
    <div class="field"><label>Localidad</label><input class="input" id="eLoc" value="${esc(e?.localidad || '')}"></div>
    <div class="field"><label>Email</label><input class="input" id="eMail" value="${esc(e?.email || '')}"></div>
    ${isEdit ? '' : `<div class="field"><label>Usuario admin *</label><input class="input" id="eAU" autocomplete="off"></div>
    <div class="field"><label>Contraseña admin *</label><input class="input" id="eAP" type="password" autocomplete="new-password"></div>`}</div>`;
  const save = btn(isEdit ? 'Guardar' : 'Crear empresa', 'btn-primary', async () => {
    const datos = {
      nombre: $('#eNom', form).value.trim(), razonSocial: $('#eRazon', form).value.trim(),
      cuit: $('#eCuit', form).value.trim(), telefono: $('#eTel', form).value.trim(),
      domicilio: $('#eDom', form).value.trim(), localidad: $('#eLoc', form).value.trim(),
      email: $('#eMail', form).value.trim()
    };
    if (!datos.nombre) return toast('Falta el nombre', 'err');
    try {
      if (isEdit) {
        await put('/empresas/' + encodeURIComponent(slug), datos);
      } else {
        datos.adminUsuario = $('#eAU', form).value.trim();
        datos.adminPassword = $('#eAP', form).value;
        if (!datos.adminUsuario || !datos.adminPassword) return toast('Falta el usuario o la contraseña del admin', 'err');
        await post('/empresas', datos);
      }
      toast('Guardado'); m.close(); render('empresas');
    } catch (err) { toast(err.message, 'err'); }
  });
  const m = modal({ title: isEdit ? 'Editar empresa' : 'Nueva empresa', body: form, footer: [btn('Cancelar', 'btn-ghost', () => m.close()), save] });
}

const VIEWS = {
  dashboard: dashboardView,
  ventas: ventasView,
  clientes: c => crudView(c, 'clientes'),
  compras: comprasView,
  proveedores: c => crudView(c, 'proveedores'),
  fabricacion: fabricacionView,
  recetas: recetasView,
  productos: c => crudView(c, 'productos'),
  insumos: c => crudView(c, 'insumos'),
  lotes: lotesView,
  etiquetas: etiquetasView,
  usuarios: usuariosView,
  maquinas: maquinasView,
  procesos: procesosView,
  recetasTemplado: c => crudView(c, 'recetasTemplado'),
  firmware: firmwareView,
  empresas: empresasView
};
boot();
