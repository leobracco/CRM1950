'use strict';

const bcrypt = require('bcryptjs');
const express = require('express');
const database = require('./db');

const router = express.Router();

function userDocId(usuario) {
  return `user:${String(usuario).toLowerCase().trim()}`;
}

async function crearUsuario({ usuario, password, nombre, rol }) {
  const _id = userDocId(usuario);
  const hash = await bcrypt.hash(password, 10);
  return database.insert({
    _id, type: 'user',
    usuario: usuario.toLowerCase().trim(),
    nombre: nombre || usuario,
    rol: rol || 'operario',
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
    req.session.user = { usuario: doc.usuario, nombre: doc.nombre, rol: doc.rol };
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
  if (req.session && req.session.user) return res.json({ user: req.session.user });
  res.status(401).json({ error: 'No autenticado' });
});

// Middlewares
function requireAuth(req, res, next) {
  if (req.session && req.session.user) return next();
  res.status(401).json({ error: 'No autenticado' });
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (req.session && req.session.user && roles.includes(req.session.user.rol)) return next();
    res.status(403).json({ error: 'Sin permisos' });
  };
}

module.exports = { router, requireAuth, requireRole, crearUsuario, userDocId };
