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

// Subir un nuevo binario (firmware global: solo superadmin).
router.post('/', auth.requireSuperadmin, upload.single('archivo'), async (req, res) => {
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

// Eliminar una versión (firmware global: solo superadmin): borra doc y archivo.
router.delete('/:id', auth.requireSuperadmin, async (req, res) => {
  try {
    const doc = await database.get(req.params.id);
    const file = path.join(DIR, path.basename(doc.archivo));
    fs.promises.unlink(file).catch(() => {});
    await database.remove(doc._id, doc._rev);
    res.json({ ok: true });
  } catch (e) { res.status(404).json({ error: 'No encontrado' }); }
});

module.exports = router;
