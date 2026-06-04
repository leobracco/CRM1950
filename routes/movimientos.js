'use strict';

const express = require('express');
const database = require('../lib/db');

const router = express.Router();

// GET /api/movimientos?articuloId=...&limit=200
router.get('/', async (req, res) => {
  try {
    const selector = { type: 'movimiento' };
    if (req.query.articuloId) selector.articuloId = req.query.articuloId;
    const docs = await database.find({ selector, limit: parseInt(req.query.limit || '300', 10) });
    docs.sort((a, b) => (b.fecha || '').localeCompare(a.fecha || ''));
    res.json(docs);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
