'use strict';

const express = require('express');
const database = require('../lib/db');
const gw = require('../lib/cloudGateway');
const maquinasLib = require('../lib/maquinas');
const auth = require('../lib/auth');
const proto = require('../lib/protocol');

const router = express.Router();

// SSE: estado en vivo de las máquinas hacia el navegador.
router.get('/stream', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  res.write(': conectado\n\n');
  gw.addSseSubscriber(res, req.empresaId, req.esSuperadmin);
  req.on('close', () => gw.removeSseSubscriber(res));
});

// Listado (con flag online del gateway, sin exponer tokenHash).
router.get('/', async (req, res) => {
  try {
    const docs = await database.findByType('maquina', { limit: 1000, empresaId: req.empresaId || undefined });
    res.json(docs.map(({ tokenHash, ...m }) => ({ ...m, online: gw.online(m._id) })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/:id', async (req, res) => {
  try {
    const doc = await database.get(req.params.id);
    if (!req.esSuperadmin && doc.empresaId !== req.empresaId) return res.status(404).json({ error: 'No encontrada' });
    const { tokenHash, ...m } = doc;
    res.json({ ...m, online: gw.online(doc._id) });
  } catch (e) { res.status(404).json({ error: 'No encontrada' }); }
});

// Generar código de pairing (admin).
router.post('/pairing-code', auth.requireRole('admin'), async (req, res) => {
  if (!req.empresaId) return res.status(400).json({ error: 'Elegí una empresa' });
  try { res.json(await maquinasLib.crearPairing(req.empresaId)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Enviar comando de control (mismo JSON que /api/control del firmware).
router.post('/:id/control', async (req, res) => {
  try {
    const doc = await database.get(req.params.id);
    if (!req.esSuperadmin && doc.empresaId !== req.empresaId) return res.status(404).json({ error: 'No encontrada' });
  } catch (e) { return res.status(404).json({ error: 'No encontrada' }); }
  if (!gw.online(req.params.id)) return res.status(409).json({ error: 'Máquina desconectada' });
  const ok = gw.enviar(req.params.id, { t: proto.CONTROL, payload: req.body || {} });
  res.json({ ok });
});

// Enviar una receta de templado a la máquina.
router.post('/:id/receta', async (req, res) => {
  try {
    const doc = await database.get(req.params.id);
    if (!req.esSuperadmin && doc.empresaId !== req.empresaId) return res.status(404).json({ error: 'No encontrada' });
  } catch (e) { return res.status(404).json({ error: 'No encontrada' }); }
  if (!gw.online(req.params.id)) return res.status(409).json({ error: 'Máquina desconectada' });
  const { nombre, temp_derretido, temp_templado, max_agua, delta_agua,
          temp_precalentado, tiempo_mantener_min, mezcla_on_seg, mezcla_periodo_min } = req.body || {};
  if (!nombre) return res.status(400).json({ error: 'Falta el nombre de la receta' });
  const ok = gw.enviar(req.params.id, { t: proto.RECETA, payload: { nombre, temp_derretido, temp_templado, max_agua, delta_agua,
          temp_precalentado, tiempo_mantener_min, mezcla_on_seg, mezcla_periodo_min } });
  res.json({ ok });
});

// Cambiar nombre de la máquina (admin).
router.put('/:id', auth.requireRole('admin'), async (req, res) => {
  try {
    const doc = await database.get(req.params.id);
    if (!req.esSuperadmin && doc.empresaId !== req.empresaId) return res.status(404).json({ error: 'No encontrada' });
    if (req.body.nombre != null) doc.nombre = req.body.nombre;
    await database.raw().insert(doc);
    const { tokenHash, ...m } = doc;
    res.json(m);
  } catch (e) { res.status(404).json({ error: 'No encontrada' }); }
});

// Lanzar OTA: envía URL del binario + sha256 al dispositivo (admin).
// El firmware es GLOBAL (no lleva empresaId); solo la máquina destino se verifica por empresa.
router.post('/:id/ota', auth.requireRole('admin'), async (req, res) => {
  let maq;
  try {
    maq = await database.get(req.params.id);
    if (!req.esSuperadmin && maq.empresaId !== req.empresaId) return res.status(404).json({ error: 'No encontrada' });
  } catch (e) { return res.status(404).json({ error: 'No encontrada' }); }
  if (!gw.online(req.params.id)) return res.status(409).json({ error: 'Máquina desconectada' });
  try {
    const fw = await database.get(req.body.firmwareId);
    const cfg = require('../config');
    const url = `${cfg.publicUrl}${fw.archivo}`;
    const ok = gw.enviar(req.params.id, { t: proto.OTA, url, version: fw.version, sha256: fw.sha256 });
    res.json({ ok, url });
  } catch (e) { res.status(404).json({ error: 'Firmware no encontrado' }); }
});

// Eliminar máquina (admin).
router.delete('/:id', auth.requireRole('admin'), async (req, res) => {
  try {
    const doc = await database.get(req.params.id);
    if (!req.esSuperadmin && doc.empresaId !== req.empresaId) return res.status(404).json({ error: 'No encontrada' });
    await database.remove(doc._id, doc._rev);
    res.json({ ok: true });
  } catch (e) { res.status(404).json({ error: 'No encontrada' }); }
});

module.exports = router;
