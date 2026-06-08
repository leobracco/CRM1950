'use strict';

const express = require('express');
const database = require('../lib/db');
const auth = require('../lib/auth');
const contabilidad = require('../lib/contabilidad');

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
  if (String(b.adminPassword).length < 4)
    return res.status(400).json({ error: 'La contraseña del admin debe tener al menos 4 caracteres' });
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
    const creada = await database.insert(empresa);
    try {
      await auth.crearUsuario({ usuario: b.adminUsuario, password: b.adminPassword, nombre: b.adminNombre || b.adminUsuario, rol: 'admin', empresaId: slug });
    } catch (eUser) {
      // Compensación: si no se pudo crear el admin, borramos la empresa para no dejarla huérfana.
      try { await database.remove(creada._id, creada._rev); }
      catch (eDel) { console.error('[empresas] No se pudo revertir la empresa huerfana', creada._id, eDel.message); }
      throw eUser;
    }
    // Sembrar el plan de cuentas estándar (no aborta la creación si falla).
    try { await contabilidad.sembrarPlan(slug); }
    catch (eSeed) { console.warn('[empresas] No se pudo sembrar el plan de cuentas de', slug, eSeed.message); }
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
