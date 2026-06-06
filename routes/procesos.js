'use strict';

const express = require('express');
const database = require('../lib/db');
const cfg = require('../config');
const auth = require('../lib/auth');

const router = express.Router();

// Listado de procesos térmicos (sin las muestras, para que sea liviano).
// Filtro opcional por ?maquinaId=...  Orden por inicio descendente.
router.get('/', async (req, res) => {
  try {
    const selector = req.query.maquinaId ? { maquinaId: req.query.maquinaId } : {};
    const docs = await database.findByType('procterm', {
      selector,
      fields: ['_id', 'maquinaId', 'serial', 'receta', 'inicio', 'fin', 'resumen', 'ultimaMuestra', 'analisisIA'],
      limit: 1000,
      empresaId: req.empresaId || undefined
    });
    docs.sort((a, b) => String(b.inicio || '').localeCompare(String(a.inicio || '')));
    res.json(docs.map(d => ({ ...d, tieneAnalisis: !!d.analisisIA, analisisIA: undefined })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Detalle con todas las muestras para graficar.
router.get('/:id', async (req, res) => {
  try {
    const doc = await database.get(req.params.id);
    if (!req.esSuperadmin && doc.empresaId !== req.empresaId) return res.status(404).json({ error: 'Proceso no encontrado' });
    res.json(doc);
  } catch (e) { res.status(404).json({ error: 'Proceso no encontrado' }); }
});

router.delete('/:id', auth.requireRole('admin'), async (req, res) => {
  try {
    const doc = await database.get(req.params.id);
    if (!req.esSuperadmin && doc.empresaId !== req.empresaId) return res.status(404).json({ error: 'No encontrado' });
    await database.remove(doc._id, doc._rev);
    res.json({ ok: true });
  } catch (e) { res.status(404).json({ error: 'No encontrado' }); }
});

// ------------------------------------------------------------------
// Análisis IA con Google Gemini (free tier).
// ------------------------------------------------------------------

// Submuestrea la curva a ~40 puntos para no inflar el prompt.
function resumirCurva(samples, n = 40) {
  if (!samples || !samples.length) return [];
  const paso = Math.max(1, Math.floor(samples.length / n));
  const out = [];
  for (let i = 0; i < samples.length; i += paso) {
    const s = samples[i];
    out.push({
      min: i === 0 ? 0 : Math.round((new Date(s.t) - new Date(samples[0].t)) / 60000),
      agua: s.ta, choco: s.tc, sp: s.sp, etapa: s.et
    });
  }
  return out;
}

const ETAPAS = { 0: 'precalentado', 1: 'derretido', 2: 'templado', 3: 'mantener' };

function construirPrompt(doc) {
  const r = doc.resumen || {};
  const curva = resumirCurva(doc.samples);
  const seg = r.segPorEtapa || {};
  const etapasTxt = Object.keys(seg).map(k => `${ETAPAS[k] || ('etapa ' + k)}: ${Math.round(seg[k] / 60)} min`).join(', ');
  return [
    'Sos un técnico experto en templado de chocolate. Analizá esta corrida de una máquina templadora.',
    'El "setpoint" (sp) es la temperatura objetivo; "choco" es la temperatura real del chocolate y "agua" la del baño.',
    `Receta: ${doc.receta || 'N/D'}.`,
    `Duración: ${Math.round((r.duracionSeg || 0) / 60)} min. Tiempo por etapa: ${etapasTxt || 'N/D'}.`,
    `Chocolate min/prom/max: ${r.chocoMin}/${r.chocoProm}/${r.chocoMax} °C. Agua min/max: ${r.aguaMin}/${r.aguaMax} °C.`,
    `Curva (minuto, agua, choco, setpoint, etapa): ${JSON.stringify(curva)}`,
    '',
    'Respondé en español, claro y breve (máximo 180 palabras), con estas secciones:',
    '1) Calidad del templado (¿siguió bien el setpoint? ¿hubo sobrepasos u oscilaciones?).',
    '2) Anomalías o riesgos detectados.',
    '3) Recomendaciones concretas (ajustes de receta o de PID).',
    'No inventes datos que no estén en la curva.'
  ].join('\n');
}

async function analizarConGemini(prompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${cfg.geminiModel}:generateContent?key=${cfg.geminiApiKey}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
  });
  if (!resp.ok) {
    const t = await resp.text();
    const err = new Error(`Gemini HTTP ${resp.status}: ${t.slice(0, 300)}`);
    err.statusCode = 502;
    throw err;
  }
  const j = await resp.json();
  const texto = j?.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';
  if (!texto) { const e = new Error('Gemini no devolvió texto'); e.statusCode = 502; throw e; }
  return texto.trim();
}

router.post('/:id/analizar', async (req, res) => {
  if (!cfg.geminiApiKey) {
    return res.status(400).json({ error: 'Falta configurar GEMINI_API_KEY en el servidor' });
  }
  try {
    const doc = await database.get(req.params.id);
    if (!req.esSuperadmin && doc.empresaId !== req.empresaId) return res.status(404).json({ error: 'Proceso no encontrado' });
    if (!doc.samples || !doc.samples.length) return res.status(400).json({ error: 'El proceso no tiene muestras' });
    const texto = await analizarConGemini(construirPrompt(doc));
    doc.analisisIA = { texto, modelo: cfg.geminiModel, fecha: new Date().toISOString() };
    await database.raw().insert(doc);
    res.json(doc.analisisIA);
  } catch (e) {
    res.status(e.statusCode || 500).json({ error: e.message });
  }
});

module.exports = router;
