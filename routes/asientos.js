'use strict';

const express = require('express');
const database = require('../lib/db');
const contabilidad = require('../lib/contabilidad');

const router = express.Router();

// Carga el plan de cuentas de la empresa indexado por código.
async function cuentasPorCodigo(empresaId) {
  const cuentas = await database.findByType('cuenta', { limit: 5000, empresaId });
  const map = {};
  for (const c of cuentas) map[c.codigo] = c;
  return map;
}

// Normaliza y valida los renglones; completa cuentaNombre desde el plan.
function prepararRenglones(renglones, mapa) {
  return (Array.isArray(renglones) ? renglones : []).map(r => {
    const cuentaCodigo = String(r.cuentaCodigo || '').trim();
    const cuenta = mapa[cuentaCodigo];
    return {
      cuentaCodigo,
      cuentaNombre: cuenta ? cuenta.nombre : '',
      debe: contabilidad.round2(r.debe || 0),
      haber: contabilidad.round2(r.haber || 0),
      detalle: String(r.detalle || '').slice(0, 200)
    };
  });
}

// Libro diario (filtro opcional por rango de fechas).
router.get('/', async (req, res) => {
  try {
    if (!req.empresaId) return res.status(400).json({ error: 'Elegí una empresa antes de ver la contabilidad' });
    let asientos = await database.findByType('asiento', { limit: 20000, empresaId: req.empresaId });
    const { desde, hasta } = req.query;
    if (desde) asientos = asientos.filter(a => (a.fecha || '') >= desde);
    if (hasta) asientos = asientos.filter(a => (a.fecha || '') <= hasta + '\uffff');
    asientos.sort((a, b) => (b.fecha || '').localeCompare(a.fecha || ''));
    res.json(asientos);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Libro mayor de una cuenta: apuntes ordenados por fecha con saldo acumulado.
router.get('/mayor/:codigo', async (req, res) => {
  try {
    if (!req.empresaId) return res.status(400).json({ error: 'Elegí una empresa antes de ver la contabilidad' });
    const codigo = req.params.codigo;
    const cuenta = await database.tryGet(`cuenta:${req.empresaId}:${codigo}`);
    if (!cuenta) return res.status(404).json({ error: 'Cuenta no encontrada' });

    let asientos = await database.findByType('asiento', { limit: 20000, empresaId: req.empresaId });
    const { desde, hasta } = req.query;
    if (desde) asientos = asientos.filter(a => (a.fecha || '') >= desde);
    if (hasta) asientos = asientos.filter(a => (a.fecha || '') <= hasta + '\uffff');
    asientos.sort((a, b) => (a.fecha || '').localeCompare(b.fecha || ''));

    const deudora = contabilidad.naturaleza(cuenta.tipo) === 'deudora';
    let saldoAcum = 0;
    const apuntes = [];
    for (const a of asientos) {
      for (const r of (a.renglones || [])) {
        if (r.cuentaCodigo !== codigo) continue;
        const debe = Number(r.debe || 0), haber = Number(r.haber || 0);
        saldoAcum = contabilidad.round2(saldoAcum + (deudora ? debe - haber : haber - debe));
        apuntes.push({
          asientoId: a._id, numero: a.numero, fecha: a.fecha,
          glosa: a.glosa, detalle: r.detalle || '',
          debe: contabilidad.round2(debe), haber: contabilidad.round2(haber),
          saldoAcum
        });
      }
    }
    res.json({
      cuenta: { codigo: cuenta.codigo, nombre: cuenta.nombre, tipo: cuenta.tipo, naturaleza: contabilidad.naturaleza(cuenta.tipo) },
      apuntes, saldoFinal: saldoAcum
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/:id', async (req, res) => {
  try {
    const a = await database.get(req.params.id);
    if (a.type !== 'asiento' || (!req.esSuperadmin && a.empresaId !== req.empresaId)) return res.status(404).json({ error: 'No encontrado' });
    res.json(a);
  } catch (e) { res.status(404).json({ error: 'No encontrado' }); }
});

// Crear asiento (escritura atómica de un solo doc balanceado).
router.post('/', async (req, res) => {
  try {
    if (!req.empresaId) return res.status(400).json({ error: 'Elegí una empresa antes de crear datos' });
    const b = req.body || {};
    const mapa = await cuentasPorCodigo(req.empresaId);
    const renglones = prepararRenglones(b.renglones, mapa);
    contabilidad.validarAsiento({ renglones }, mapa);

    const seq = await database.nextSeq(req.empresaId, 'asiento');
    const numero = `AS-${String(seq).padStart(6, '0')}`;
    const asiento = await database.insert({
      _id: `asiento:${req.empresaId}:${String(seq).padStart(6, '0')}`,
      type: 'asiento', empresaId: req.empresaId, numero,
      fecha: b.fecha || new Date().toISOString().slice(0, 10),
      glosa: String(b.glosa || '').slice(0, 300),
      renglones, origen: 'manual',
      usuario: req.session.user?.usuario,
      creado: new Date().toISOString(), actualizado: new Date().toISOString()
    });
    res.status(201).json(asiento);
  } catch (e) {
    res.status(e.statusCode || 500).json({ error: e.statusCode ? e.message : 'No se pudo registrar el asiento' });
  }
});

// Editar asiento (siempre editable; re-valida balance).
router.put('/:id', async (req, res) => {
  try {
    const cur = await database.get(req.params.id);
    if (cur.type !== 'asiento' || (!req.esSuperadmin && cur.empresaId !== req.empresaId)) return res.status(404).json({ error: 'No encontrado' });
    const b = req.body || {};
    const mapa = await cuentasPorCodigo(cur.empresaId);
    const renglones = prepararRenglones(b.renglones != null ? b.renglones : cur.renglones, mapa);
    contabilidad.validarAsiento({ renglones }, mapa);

    cur.fecha = b.fecha || cur.fecha;
    cur.glosa = b.glosa != null ? String(b.glosa).slice(0, 300) : cur.glosa;
    cur.renglones = renglones;
    cur.actualizado = new Date().toISOString();
    await database.raw().insert(cur);
    res.json(cur);
  } catch (e) {
    if (e.statusCode === 404) return res.status(404).json({ error: 'No encontrado' });
    res.status(e.statusCode || 500).json({ error: e.statusCode ? e.message : 'No se pudo actualizar el asiento' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const cur = await database.get(req.params.id);
    if (cur.type !== 'asiento' || (!req.esSuperadmin && cur.empresaId !== req.empresaId)) return res.status(404).json({ error: 'No encontrado' });
    await database.remove(cur._id, cur._rev);
    res.json({ ok: true });
  } catch (e) {
    if (e.statusCode === 404) return res.status(404).json({ error: 'No encontrado' });
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
