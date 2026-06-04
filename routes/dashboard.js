'use strict';

const express = require('express');
const database = require('../lib/db');

const router = express.Router();

function inMonth(iso, ref = new Date()) {
  const d = new Date(iso);
  return d.getFullYear() === ref.getFullYear() && d.getMonth() === ref.getMonth();
}

router.get('/', async (req, res) => {
  try {
    const [ventas, compras, productos, insumos, ordenes, lotes] = await Promise.all([
      database.findByType('venta', { limit: 5000 }),
      database.findByType('compra', { limit: 5000 }),
      database.findByType('producto', { limit: 5000 }),
      database.findByType('insumo', { limit: 5000 }),
      database.findByType('orden', { limit: 5000 }),
      database.findByType('lote', { limit: 5000 })
    ]);

    const ventasMes = ventas.filter(v => inMonth(v.fecha));
    const comprasMes = compras.filter(c => inMonth(c.fecha));

    const stockValor = productos.reduce((s, p) => s + Number(p.stock || 0) * Number(p.costoUnit || 0), 0);
    const insumosBajos = insumos
      .filter(i => Number(i.stock || 0) <= Number(i.stockMin || 0))
      .map(i => ({ _id: i._id, nombre: i.nombre, stock: i.stock || 0, stockMin: i.stockMin || 0, unidad: i.unidad }));

    const hoy = new Date();
    const en30 = new Date(); en30.setDate(en30.getDate() + 30);
    const lotesPorVencer = lotes
      .filter(l => l.fechaVencimiento && new Date(l.fechaVencimiento) >= hoy && new Date(l.fechaVencimiento) <= en30)
      .sort((a, b) => a.fechaVencimiento.localeCompare(b.fechaVencimiento))
      .slice(0, 10);

    // Serie de ventas últimos 14 días
    const serie = {};
    for (let i = 13; i >= 0; i--) {
      const d = new Date(); d.setDate(d.getDate() - i);
      serie[d.toISOString().slice(0, 10)] = 0;
    }
    ventas.forEach(v => {
      const k = (v.fecha || '').slice(0, 10);
      if (k in serie) serie[k] += Number(v.total || 0);
    });

    res.json({
      kpis: {
        ventasMesTotal: Number(ventasMes.reduce((s, v) => s + Number(v.total || 0), 0).toFixed(2)),
        ventasMesCount: ventasMes.length,
        comprasMesTotal: Number(comprasMes.reduce((s, c) => s + Number(c.total || 0), 0).toFixed(2)),
        productos: productos.length,
        insumos: insumos.length,
        ordenes: ordenes.length,
        stockValor: Number(stockValor.toFixed(2))
      },
      insumosBajos,
      lotesPorVencer,
      ventasRecientes: ventas.sort((a, b) => (b.fecha || '').localeCompare(a.fecha || '')).slice(0, 6),
      ordenesRecientes: ordenes.sort((a, b) => (b.fecha || '').localeCompare(a.fecha || '')).slice(0, 6),
      serieVentas: Object.entries(serie).map(([fecha, total]) => ({ fecha, total }))
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
