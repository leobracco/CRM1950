'use strict';

const express = require('express');
const database = require('../lib/db');
const stock = require('../lib/stock');

const router = express.Router();

// GET /api/compras
router.get('/', async (req, res) => {
  try {
    const docs = await database.findByType('compra', { limit: 5000 });
    docs.sort((a, b) => (b.fecha || '').localeCompare(a.fecha || ''));
    res.json(docs);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/:id', async (req, res) => {
  try { res.json(await database.get(req.params.id)); }
  catch (e) { res.status(404).json({ error: 'No encontrado' }); }
});

// POST /api/compras  { proveedorId, fecha, items:[{insumoId, descripcion, cantidad, costoUnit}], obs }
router.post('/', async (req, res) => {
  try {
    const { proveedorId, items = [], obs } = req.body || {};
    if (!items.length) return res.status(400).json({ error: 'La compra no tiene ítems' });

    const seq = await database.nextSeq('compra');
    const numero = `OC-${String(seq).padStart(6, '0')}`;
    const fecha = req.body.fecha || new Date().toISOString();
    let total = 0;
    const detalle = [];

    for (const it of items) {
      const cantidad = Number(it.cantidad);
      const costoUnit = Number(it.costoUnit || 0);
      const subtotal = Number((cantidad * costoUnit).toFixed(2));
      total += subtotal;
      detalle.push({ ...it, cantidad, costoUnit, subtotal });
    }

    const compra = await database.insert({
      _id: `compra:${String(seq).padStart(6, '0')}`,
      type: 'compra', numero, proveedorId,
      fecha, items: detalle, total: Number(total.toFixed(2)),
      obs: obs || '', estado: 'recibida',
      usuario: req.session.user?.usuario,
      creado: new Date().toISOString()
    });

    // Ingreso de stock + actualización de último costo del insumo
    for (const it of detalle) {
      if (!it.insumoId) continue;
      await stock.movimiento({
        articuloId: it.insumoId, articuloTipo: 'insumo',
        cantidad: it.cantidad, motivo: 'compra',
        refType: 'compra', refId: compra._id,
        costoUnit: it.costoUnit, usuario: req.session.user?.usuario
      });
      try {
        const ins = await database.get(it.insumoId);
        ins.costoUnit = it.costoUnit;
        ins.actualizado = new Date().toISOString();
        await database.raw().insert(ins);
      } catch (_) { /* insumo manual sin ficha */ }
    }

    res.status(201).json(compra);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
