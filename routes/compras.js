'use strict';

const express = require('express');
const database = require('../lib/db');
const stock = require('../lib/stock');

const router = express.Router();

// GET /api/compras
router.get('/', async (req, res) => {
  try {
    const docs = await database.findByType('compra', { limit: 5000, empresaId: req.empresaId || undefined });
    docs.sort((a, b) => (b.fecha || '').localeCompare(a.fecha || ''));
    res.json(docs);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/:id', async (req, res) => {
  try {
    const compra = await database.get(req.params.id);
    if (!req.esSuperadmin && compra.empresaId !== req.empresaId) return res.status(404).json({ error: 'No encontrado' });
    res.json(compra);
  } catch (e) { res.status(404).json({ error: 'No encontrado' }); }
});

// POST /api/compras  { proveedorId, fecha, items:[{insumoId, descripcion, cantidad, costoUnit}], obs }
router.post('/', async (req, res) => {
  try {
    if (!req.empresaId) return res.status(400).json({ error: 'Elegí una empresa antes de crear datos' });
    const { proveedorId, items = [], obs } = req.body || {};
    if (!items.length) return res.status(400).json({ error: 'La compra no tiene ítems' });

    // Validar pertenencia del proveedor a la empresa
    if (proveedorId) {
      const prov = await database.tryGet(proveedorId);
      if (prov && !req.esSuperadmin && prov.empresaId !== req.empresaId) {
        return res.status(400).json({ error: 'Proveedor inválido' });
      }
    }

    // Validar que los insumos referenciados existan y sean de la empresa
    // (un insumoId inexistente haría fallar el movimiento dejando la compra a medio crear).
    for (const it of items) {
      if (!it.insumoId) continue;
      const ins = await database.tryGet(it.insumoId);
      if (!ins || (!req.esSuperadmin && ins.empresaId !== req.empresaId)) {
        return res.status(400).json({ error: 'Insumo inválido' });
      }
    }

    const seq = await database.nextSeq(req.empresaId, 'compra');
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
      _id: `compra:${req.empresaId}:${String(seq).padStart(6, '0')}`,
      type: 'compra', empresaId: req.empresaId, numero, proveedorId,
      fecha, items: detalle, total: Number(total.toFixed(2)),
      obs: obs || '', estado: 'recibida',
      usuario: req.session.user?.usuario,
      creado: new Date().toISOString()
    });

    // Ingreso de stock + actualización de último costo del insumo
    for (const it of detalle) {
      if (!it.insumoId) continue;
      await stock.movimiento({
        empresaId: req.empresaId,
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
  } catch (e) {
    console.error('[compras] POST', e);
    res.status(e.statusCode || 500).json({ error: e.statusCode ? e.message : 'No se pudo registrar la compra' });
  }
});

module.exports = router;
