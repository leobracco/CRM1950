'use strict';

const express = require('express');
const database = require('../lib/db');
const contabilidad = require('../lib/contabilidad');

const router = express.Router();

// Lista el plan de cuentas de la empresa (ordenado por código). Cada cuenta
// imputable incluye su saldo calculado a partir de los asientos.
router.get('/', async (req, res) => {
  try {
    if (!req.empresaId) return res.status(400).json({ error: 'Elegí una empresa antes de ver la contabilidad' });
    const cuentas = await database.findByType('cuenta', { limit: 5000, empresaId: req.empresaId });
    cuentas.sort((a, b) => (a.codigo || '').localeCompare(b.codigo || '', undefined, { numeric: true }));

    // Saldos: una sola lectura de asientos y se acumula por código (evita N consultas).
    const asientos = await database.findByType('asiento', { limit: 20000, empresaId: req.empresaId });
    const acum = {};
    for (const a of asientos) {
      for (const r of (a.renglones || [])) {
        const k = r.cuentaCodigo;
        if (!k) continue;
        (acum[k] = acum[k] || { debe: 0, haber: 0 });
        acum[k].debe += Number(r.debe || 0);
        acum[k].haber += Number(r.haber || 0);
      }
    }
    const out = cuentas.map(c => {
      const t = acum[c.codigo] || { debe: 0, haber: 0 };
      return { ...c, debe: contabilidad.round2(t.debe), haber: contabilidad.round2(t.haber),
        saldo: c.imputable ? contabilidad.saldoSegunNaturaleza(c.tipo, t.debe, t.haber) : null };
    });
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Alta de cuenta.
router.post('/', async (req, res) => {
  try {
    if (!req.empresaId) return res.status(400).json({ error: 'Elegí una empresa antes de crear datos' });
    const b = req.body || {};
    const codigo = String(b.codigo || '').trim();
    const nombre = String(b.nombre || '').trim();
    const tipo = String(b.tipo || '').trim();
    if (!codigo || !nombre) return res.status(400).json({ error: 'Faltan código o nombre' });
    if (!contabilidad.TIPOS_VALIDOS.includes(tipo)) return res.status(400).json({ error: 'Tipo de cuenta inválido' });
    const _id = `cuenta:${req.empresaId}:${codigo}`;
    if (await database.tryGet(_id)) return res.status(409).json({ error: 'Ya existe una cuenta con ese código' });
    const doc = await database.insert({
      _id, type: 'cuenta', empresaId: req.empresaId,
      codigo, nombre, tipo,
      imputable: b.imputable !== false,
      activa: b.activa !== false,
      creado: new Date().toISOString(), actualizado: new Date().toISOString()
    });
    res.status(201).json(doc);
  } catch (e) {
    if (e.statusCode === 409) return res.status(409).json({ error: 'Ya existe una cuenta con ese código' });
    res.status(500).json({ error: e.message });
  }
});

// Edición (nombre / activa / imputable / tipo). El código no se cambia (es parte del _id).
router.put('/:id', async (req, res) => {
  try {
    const cur = await database.get(req.params.id);
    if (cur.type !== 'cuenta' || (!req.esSuperadmin && cur.empresaId !== req.empresaId)) return res.status(404).json({ error: 'No encontrada' });
    const b = req.body || {};
    if (b.nombre != null) cur.nombre = String(b.nombre).trim() || cur.nombre;
    if (b.tipo != null && contabilidad.TIPOS_VALIDOS.includes(b.tipo)) cur.tipo = b.tipo;
    if (b.imputable != null) cur.imputable = !!b.imputable;
    if (b.activa != null) cur.activa = !!b.activa;
    cur.actualizado = new Date().toISOString();
    await database.raw().insert(cur);
    res.json(cur);
  } catch (e) {
    if (e.statusCode === 404) return res.status(404).json({ error: 'No encontrada' });
    res.status(500).json({ error: e.message });
  }
});

// Baja: solo si ninguna línea de asiento la usa. Si está en uso, sugerir desactivar.
router.delete('/:id', async (req, res) => {
  try {
    const cur = await database.get(req.params.id);
    if (cur.type !== 'cuenta' || (!req.esSuperadmin && cur.empresaId !== req.empresaId)) return res.status(404).json({ error: 'No encontrada' });
    const asientos = await database.findByType('asiento', { limit: 20000, empresaId: cur.empresaId });
    const enUso = asientos.some(a => (a.renglones || []).some(r => r.cuentaCodigo === cur.codigo));
    if (enUso) return res.status(409).json({ error: 'La cuenta tiene asientos; desactivala en lugar de borrarla' });
    await database.remove(cur._id, cur._rev);
    res.json({ ok: true });
  } catch (e) {
    if (e.statusCode === 404) return res.status(404).json({ error: 'No encontrada' });
    res.status(500).json({ error: e.message });
  }
});

// Carga el plan de cuentas estándar (idempotente).
router.post('/sembrar', async (req, res) => {
  try {
    if (!req.empresaId) return res.status(400).json({ error: 'Elegí una empresa antes de crear datos' });
    const creadas = await contabilidad.sembrarPlan(req.empresaId);
    res.json({ ok: true, creadas });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
