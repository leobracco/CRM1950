'use strict';

const express = require('express');
const database = require('../lib/db');
const stock = require('../lib/stock');

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const docs = await database.findByType('venta', { limit: 5000, empresaId: req.empresaId || undefined });
    docs.sort((a, b) => (b.fecha || '').localeCompare(a.fecha || ''));
    res.json(docs);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/:id', async (req, res) => {
  try {
    const venta = await database.get(req.params.id);
    if (!req.esSuperadmin && venta.empresaId !== req.empresaId) return res.status(404).json({ error: 'No encontrado' });
    res.json(venta);
  } catch (e) { res.status(404).json({ error: 'No encontrado' }); }
});

// POST /api/ventas { clienteId, fecha, items:[{productoId, descripcion, cantidad, precioUnit, lote}], descuento, obs }
router.post('/', async (req, res) => {
  try {
    if (!req.empresaId) return res.status(400).json({ error: 'Elegí una empresa antes de crear datos' });
    const { clienteId, items = [], descuento = 0, obs } = req.body || {};
    if (!items.length) return res.status(400).json({ error: 'La venta no tiene ítems' });

    // Validar pertenencia del cliente a la empresa
    if (clienteId) {
      const cli = await database.tryGet(clienteId);
      if (cli && !req.esSuperadmin && cli.empresaId !== req.empresaId) {
        return res.status(400).json({ error: 'Cliente inválido' });
      }
    }

    // Validación de stock disponible
    for (const it of items) {
      if (!it.productoId) continue;
      const p = await database.tryGet(it.productoId);
      // Rechazar referencias inexistentes o de otra empresa (evita escrituras parciales).
      if (!p || (!req.esSuperadmin && p.empresaId !== req.empresaId)) {
        return res.status(400).json({ error: 'Producto inválido' });
      }
      if (Number(p.stock || 0) < Number(it.cantidad)) {
        return res.status(409).json({ error: `Stock insuficiente de ${p.nombre} (hay ${p.stock})` });
      }
    }

    const seq = await database.nextSeq(req.empresaId, 'venta');
    const numero = `FV-${String(seq).padStart(6, '0')}`;
    const fecha = req.body.fecha || new Date().toISOString();
    let total = 0;
    const detalle = [];
    for (const it of items) {
      const cantidad = Number(it.cantidad);
      const precioUnit = Number(it.precioUnit || 0);
      const subtotal = Number((cantidad * precioUnit).toFixed(2));
      total += subtotal;
      // FEFO: si no se indicó lote, asignar el de vencimiento más próximo
      let lote = it.lote || null;
      if (!lote && it.productoId) {
        const lotes = await database.find({ selector: { type: 'lote', empresaId: req.empresaId, productoId: it.productoId }, limit: 1000 });
        lotes.sort((a, b) => (a.fechaVencimiento || '').localeCompare(b.fechaVencimiento || ''));
        if (lotes.length) lote = lotes[0].codigo;
      }
      detalle.push({ ...it, cantidad, precioUnit, subtotal, lote });
    }
    total = Number((total - Number(descuento || 0)).toFixed(2));

    const venta = await database.insert({
      _id: `venta:${req.empresaId}:${String(seq).padStart(6, '0')}`,
      type: 'venta', empresaId: req.empresaId, numero, clienteId,
      fecha, items: detalle, descuento: Number(descuento || 0),
      total, obs: obs || '', estado: 'confirmada',
      usuario: req.session.user?.usuario,
      creado: new Date().toISOString()
    });

    for (const it of detalle) {
      if (!it.productoId) continue;
      await stock.movimiento({
        empresaId: req.empresaId,
        articuloId: it.productoId, articuloTipo: 'producto',
        cantidad: -Math.abs(it.cantidad), motivo: 'venta',
        refType: 'venta', refId: venta._id, lote: it.lote || null,
        usuario: req.session.user?.usuario
      });
    }

    res.status(201).json(venta);
  } catch (e) {
    console.error('[ventas] POST', e);
    res.status(e.statusCode || 500).json({ error: e.statusCode ? e.message : 'No se pudo registrar la venta' });
  }
});

module.exports = router;
