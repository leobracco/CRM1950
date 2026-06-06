'use strict';

const express = require('express');
const database = require('../lib/db');

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const docs = await database.findByType('lote', { limit: 5000, empresaId: req.empresaId || undefined });
    docs.sort((a, b) => (b.fechaElaboracion || '').localeCompare(a.fechaElaboracion || ''));
    res.json(docs);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/:id', async (req, res) => {
  try {
    const lote = await database.get(req.params.id);
    if (!req.esSuperadmin && lote.empresaId !== req.empresaId) return res.status(404).json({ error: 'No encontrado' });
    res.json(lote);
  } catch (e) { res.status(404).json({ error: 'No encontrado' }); }
});

// GET /api/lotes/:id/trazabilidad  -> reporte de recall
router.get('/:id/trazabilidad', async (req, res) => {
  try {
    const lote = await database.get(req.params.id);
    if (!req.esSuperadmin && lote.empresaId !== req.empresaId) return res.status(404).json({ error: 'No encontrado' });
    const orden = lote.ordenId ? await database.tryGet(lote.ordenId) : null;

    // Movimientos asociados al lote
    const movs = await database.find({ selector: { type: 'movimiento', empresaId: req.empresaId, lote: lote.codigo }, limit: 5000 });

    // Insumos consumidos (origen) con proveedor del último ingreso
    const insumos = [];
    for (const c of (orden?.consumos || [])) {
      const ins = await database.tryGet(c.insumoId);
      insumos.push({
        insumoId: c.insumoId,
        nombre: ins?.nombre || c.descripcion || c.insumoId,
        cantidad: c.cantidad, unidad: ins?.unidad || '',
        proveedorId: ins?.proveedorId || null
      });
    }

    // Ventas del lote (destino)
    const ventaMovs = movs.filter(m => m.motivo === 'venta');
    const ventas = [];
    for (const m of ventaMovs) {
      const v = m.refId ? await database.tryGet(m.refId) : null;
      const cli = v?.clienteId ? await database.tryGet(v.clienteId) : null;
      ventas.push({
        ventaId: m.refId, numero: v?.numero, fecha: v?.fecha,
        cantidad: Math.abs(m.cantidad),
        clienteId: v?.clienteId, cliente: cli?.nombre || v?.clienteId || 'Consumidor final'
      });
    }

    res.json({ lote, orden, insumos, ventas, movimientos: movs });
  } catch (e) { res.status(404).json({ error: 'No encontrado: ' + e.message }); }
});

module.exports = router;
