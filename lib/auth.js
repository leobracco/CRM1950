'use strict';

const bcrypt = require('bcryptjs');
const express = require('express');
const database = require('./db');

const router = express.Router();

function userDocId(usuario) {
  return `user:${String(usuario).toLowerCase().trim()}`;
}

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
      if (!emp) {
        console.warn(`[auth] Login bloqueado: empresa "${doc.empresaId}" no encontrada para usuario "${doc.usuario}"`);
        return res.status(403).json({ error: 'Empresa suspendida o inexistente' });
      }
      if (emp.activo === false) return res.status(403).json({ error: 'Empresa suspendida o inexistente' });
    } else if (doc.rol !== 'superadmin') {
      // Sin empresa y sin ser superadmin: no tiene acceso a ningún dato.
      return res.status(403).json({ error: 'Tu usuario no tiene una empresa asignada. Contactá al administrador.' });
    }
    req.session.user = { usuario: doc.usuario, nombre: doc.nombre, rol: doc.rol, empresaId: doc.empresaId || null };
    res.json({ ok: true, user: req.session.user });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/logout
router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// GET /api/me
router.get('/me', (req, res) => {
  if (req.session && req.session.user) {
    return res.json({ user: req.session.user, empresaActiva: req.session.empresaActiva || null });
  }
  res.status(401).json({ error: 'No autenticado' });
});

// Cambia la contraseña del propio usuario (verifica la actual)
async function cambiarPassword(usuario, actual, nueva) {
  const doc = await database.get(userDocId(usuario));
  const ok = await bcrypt.compare(actual, doc.hash);
  if (!ok) { const e = new Error('La contraseña actual es incorrecta'); e.statusCode = 401; throw e; }
  doc.hash = await bcrypt.hash(nueva, 10);
  doc.actualizado = new Date().toISOString();
  await database.raw().insert(doc);
  return { ok: true };
}

// Lista usuarios (sin el hash). Si empresaId viene, filtra por esa empresa.
async function listarUsuarios(empresaId) {
  const docs = await database.findByType('user', { limit: 1000, empresaId: empresaId || undefined });
  return docs.map(({ hash, ...u }) => u);
}

// Edición por admin: nombre, rol, activo y reseteo de clave.
// Si scopeEmpresaId viene, valida que el usuario pertenezca a esa empresa.
// empresaId solo lo puede cambiar el superadmin (scopeEmpresaId undefined).
async function actualizarUsuario(usuario, { nombre, rol, activo, password, empresaId }, scopeEmpresaId) {
  const doc = await database.get(userDocId(usuario));
  if (scopeEmpresaId && doc.empresaId !== scopeEmpresaId) {
    const e = new Error('Usuario no encontrado'); e.statusCode = 404; throw e;
  }
  if (nombre != null) doc.nombre = nombre;
  if (rol != null) doc.rol = rol;
  if (activo != null) doc.activo = !!activo;
  if (password) doc.hash = await bcrypt.hash(password, 10);
  if (empresaId !== undefined && !scopeEmpresaId) doc.empresaId = empresaId || null;
  doc.actualizado = new Date().toISOString();
  await database.raw().insert(doc);
  const { hash, ...rest } = doc;
  return rest;
}

// Middlewares
function requireAuth(req, res, next) {
  if (req.session && req.session.user) return next();
  res.status(401).json({ error: 'No autenticado' });
}

function requireRole(...roles) {
  return (req, res, next) => {
    const u = req.session && req.session.user;
    // El superadmin administra todo: pasa cualquier chequeo de rol.
    if (u && (u.rol === 'superadmin' || roles.includes(u.rol))) return next();
    res.status(403).json({ error: 'Sin permisos' });
  };
}

function requireSuperadmin(req, res, next) {
  if (req.session && req.session.user && req.session.user.rol === 'superadmin') return next();
  res.status(403).json({ error: 'Solo superadmin' });
}

module.exports = { router, requireAuth, requireRole, requireSuperadmin, crearUsuario, cambiarPassword, listarUsuarios, actualizarUsuario, userDocId };
