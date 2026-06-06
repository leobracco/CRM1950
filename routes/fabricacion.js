'use strict';

const express = require('express');
const database = require('../lib/db');
const stock = require('../lib/stock');

const router = express.Router();

function yymmdd(d) {
  const x = new Date(d);
  return x.toISOString().slice(2, 10).replace(/-/g, '');
}
function addDays(iso, days) {
  const d = new Date(iso); d.setDate(d.getDate() + Number(days || 0));
  return d.toISOString();
}

router.get('/', async (req, res) => {
  try {
    const docs = await database.findByType('orden', { limit: 5000, empresaId: req.empresaId || undefined });
    docs.sort((a, b) => (b.fecha || '').localeCompare(a.fecha || ''));
    res.json(docs);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/:id', async (req, res) => {
  try {
    const orden = await database.get(req.params.id);
    if (!req.esSuperadmin && orden.empresaId !== req.empresaId) return res.status(404).json({ error: 'No encontrado' });
    res.json(orden);
  } catch (e) { res.status(404).json({ error: 'No encontrado' }); }
});

// POST /api/fabricacion { productoId, cantidad, recetaId?, consumos?, fechaElaboracion?, force?, obs }
router.post('/', async (req, res) => {
  try {
    const { productoId, recetaId, force, obs } = req.body || {};
    const cantidad = Number(req.body.cantidad);
    if (!productoId || !cantidad) return res.status(400).json({ error: 'Falta producto o cantidad' });

    const producto = await database.get(productoId);
    if (!req.esSuperadmin && producto.empresaId !== req.empresaId) return res.status(400).json({ error: 'Producto inválido' });
    const fechaElaboracion = req.body.fechaElaboracion || new Date().toISOString();

    // Determinar consumos de insumos
    let consumos = [];
    if (recetaId) {
      const receta = await database.get(recetaId);
      if (!req.esSuperadmin && receta.empresaId !== req.empresaId) return res.status(400).json({ error: 'Receta inválida' });
      const rinde = Number(receta.rinde || 1);
      const factor = cantidad / rinde;
      consumos = (receta.items || []).map(i => ({
        insumoId: i.insumoId,
        descripcion: i.descripcion,
        cantidad: Number((Number(i.cantidad) * factor).toFixed(4))
      }));
    } else if (Array.isArray(req.body.consumos)) {
      consumos = req.body.consumos.map(c => ({ ...c, cantidad: Number(c.cantidad) }));
    }

    // Validar pertenencia de los insumos consumidos a la empresa
    for (const c of consumos) {
      const ins = await database.tryGet(c.insumoId);
      if (ins && !req.esSuperadmin && ins.empresaId !== req.empresaId) {
        return res.status(400).json({ error: 'Insumo inválido' });
      }
    }

    // Validar stock de insumos
    if (!force) {
      for (const c of consumos) {
        const ins = await database.tryGet(c.insumoId);
        if (ins && Number(ins.stock || 0) < c.cantidad) {
          return res.status(409).json({ error: `Stock insuficiente de ${ins.nombre} (hay ${ins.stock}, requiere ${c.cantidad})` });
        }
      }
    }

    // Crear lote
    const seq = await database.nextSeq(req.empresaId, 'orden');
    const ordenId = `orden:${req.empresaId}:${String(seq).padStart(6, '0')}`;
    const loteCodigo = `${yymmdd(fechaElaboracion)}-${String(seq).padStart(4, '0')}`;
    const fechaVencimiento = addDays(fechaElaboracion, producto.vidaUtilDias || 90);

    // Consumir insumos y calcular costo
    let costoTotal = 0;
    for (const c of consumos) {
      const ins = await database.tryGet(c.insumoId);
      const costoUnit = ins ? Number(ins.costoUnit || 0) : 0;
      costoTotal += costoUnit * c.cantidad;
      c.costoUnit = costoUnit;
      await stock.movimiento({
        empresaId: req.empresaId,
        articuloId: c.insumoId, articuloTipo: 'insumo',
        cantidad: -Math.abs(c.cantidad), motivo: 'fabricacion',
        refType: 'orden', refId: ordenId,
        lote: loteCodigo, costoUnit, usuario: req.session.user?.usuario
      });
    }
    costoTotal = Number(costoTotal.toFixed(2));
    const costoUnit = Number((costoTotal / cantidad).toFixed(4));

    const lote = await database.insert({
      _id: `lote:${req.empresaId}:${loteCodigo}`, type: 'lote', empresaId: req.empresaId, codigo: loteCodigo,
      productoId, productoNombre: producto.nombre,
      cantidad, fechaElaboracion, fechaVencimiento,
      ordenId,
      estado: 'liberado', costoUnit,
      creado: new Date().toISOString()
    });

    const orden = await database.insert({
      _id: ordenId,
      type: 'orden', empresaId: req.empresaId, numero: `OF-${String(seq).padStart(6, '0')}`,
      productoId, productoNombre: producto.nombre, cantidad,
      recetaId: recetaId || null, consumos, loteCodigo,
      fecha: fechaElaboracion, fechaVencimiento,
      costoTotal, costoUnit, obs: obs || '', estado: 'finalizada',
      usuario: req.session.user?.usuario,
      creado: new Date().toISOString()
    });

    // Producir stock del producto
    await stock.movimiento({
      empresaId: req.empresaId,
      articuloId: productoId, articuloTipo: 'producto',
      cantidad: Math.abs(cantidad), motivo: 'fabricacion',
      refType: 'orden', refId: orden._id, lote: loteCodigo,
      costoUnit, usuario: req.session.user?.usuario
    });

    // Guardar último costo en el producto
    try {
      const p = await database.get(productoId);
      p.costoUnit = costoUnit; p.actualizado = new Date().toISOString();
      await database.raw().insert(p);
    } catch (_) {}

    res.status(201).json({ orden, lote });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
