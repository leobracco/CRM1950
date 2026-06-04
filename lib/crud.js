'use strict';

const express = require('express');
const database = require('./db');

/**
 * Crea un router CRUD para un "type" de documento.
 * opts:
 *   prefix      -> prefijo de _id (default = type)
 *   searchFields-> campos donde busca ?q= (default ['nombre','codigo'])
 *   beforeWrite -> async (doc, req, isNew) => doc   (hook para validar/derivar)
 *   afterWrite  -> async (doc, req, isNew) => void  (hook efectos colaterales)
 */
function crud(type, opts = {}) {
  const router = express.Router();
  const prefix = opts.prefix || type;
  const searchFields = opts.searchFields || ['nombre', 'codigo'];

  // Listado (con búsqueda simple en memoria sobre el resultado por tipo)
  router.get('/', async (req, res) => {
    try {
      let docs = await database.findByType(type, { limit: 5000 });
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
    try { res.json(await database.get(req.params.id)); }
    catch (e) { res.status(404).json({ error: 'No encontrado' }); }
  });

  router.post('/', async (req, res) => {
    try {
      const body = { ...req.body };
      delete body._rev;
      const id = body._id || `${prefix}:${body.codigo || await database.nextSeq(type)}`;
      let doc = {
        ...body, _id: id, type,
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
      let doc = {
        ...current, ...req.body,
        _id: current._id, _rev: current._rev, type,
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
      await database.remove(current._id, current._rev);
      res.json({ ok: true });
    } catch (e) { res.status(404).json({ error: 'No encontrado' }); }
  });

  return router;
}

module.exports = crud;
