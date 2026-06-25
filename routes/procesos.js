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
    if (doc.type !== 'procterm') return res.status(404).json({ error: 'Proceso no encontrado' });
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
// Análisis IA con Groq (free tier, API compatible con OpenAI).
// ------------------------------------------------------------------

// Submuestrea la curva a ~60 puntos para no inflar el prompt. Incluye el estado
// del motor (agitador) y la bomba: afectan la transferencia térmica agua->choco.
function resumirCurva(samples, n = 60) {
  if (!samples || !samples.length) return [];
  const paso = Math.max(1, Math.floor(samples.length / n));
  const out = [];
  for (let i = 0; i < samples.length; i += paso) {
    const s = samples[i];
    out.push({
      min: i === 0 ? 0 : Math.round((new Date(s.t) - new Date(samples[0].t)) / 60000),
      agua: s.ta, choco: s.tc, sp: s.sp, etapa: s.et,
      motor: s.m ? 1 : 0, bomba: s.b ? 1 : 0
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
    'Sos un ingeniero de procesos especialista en templado (cristalización) de chocolate y en control de temperatura PID.',
    'Contexto técnico: el templado busca formar cristales beta V de manteca de cacao. El perfil típico es fundir (~45-50 °C), enfriar para nuclear cristales (~27-28 °C) y recalentar a la temperatura de trabajo (negro ~31-32 °C, leche ~29-30 °C). Un buen control sigue el setpoint con bajo error, sin sobrepasos ni oscilaciones; el "agua" es el baño que calienta/enfría y arrastra al "choco" con cierto retardo térmico (lag). El motor es el agitador y la bomba recircula: ambos mejoran la homogeneidad y la transferencia de calor.',
    'El "setpoint" (sp) es la temperatura objetivo; "choco" es la temperatura real del chocolate, "agua" la del baño; motor y bomba son 0/1 (apagado/encendido).',
    `Receta: ${doc.receta || 'N/D'}.`,
    `Duración: ${Math.round((r.duracionSeg || 0) / 60)} min. Tiempo por etapa: ${etapasTxt || 'N/D'}.`,
    `Chocolate min/prom/max: ${r.chocoMin}/${r.chocoProm}/${r.chocoMax} °C. Agua min/max: ${r.aguaMin}/${r.aguaMax} °C.`,
    `Curva (minuto, agua, choco, setpoint, etapa, motor, bomba): ${JSON.stringify(curva)}`,
    '',
    'Respondé en español técnico pero claro, con datos cuantitativos extraídos de la curva (°C, °C/min, minutos, %). Usá estas secciones:',
    '1) Seguimiento del setpoint: error medio y máximo del choco respecto al sp, sobrepasos (cuantificados en °C y %), oscilaciones y en qué tramos.',
    '2) Dinámica térmica: velocidad de las rampas de calentamiento y enfriamiento (°C/min), retardo (lag) entre agua y choco, y efecto observable del motor/bomba sobre la respuesta.',
    '3) Calidad del templado: ¿el perfil fundido -> enfriado -> recalentado fue correcto para la receta? ¿se alcanzaron y sostuvieron las ventanas de cristalización? riesgo de cristales inestables, fat bloom o producto sobre/sub-templado.',
    '4) Anomalías y riesgos: saltos bruscos, lecturas dudosas de sensores, tramos sin control, reinicios.',
    '5) Recomendaciones concretas: ajustes de receta (setpoints, tiempos) y de sintonía PID (sugerí dirección de Kp/Ki/Kd según el comportamiento visto), justificados con lo observado.',
    'Sé concreto y apoyate siempre en números de la curva. No inventes datos que no estén en la curva; si algo no se puede determinar, decilo.'
  ].join('\n');
}

async function analizarConGroq(prompt) {
  const url = 'https://api.groq.com/openai/v1/chat/completions';
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${cfg.groqApiKey}`
    },
    body: JSON.stringify({
      model: cfg.groqModel,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      max_tokens: 1400
    })
  });
  if (!resp.ok) {
    const t = await resp.text();
    const err = new Error(`Groq HTTP ${resp.status}: ${t.slice(0, 300)}`);
    err.statusCode = 502;
    throw err;
  }
  const j = await resp.json();
  const texto = j?.choices?.[0]?.message?.content || '';
  if (!texto) { const e = new Error('Groq no devolvió texto'); e.statusCode = 502; throw e; }
  return texto.trim();
}

router.post('/:id/analizar', async (req, res) => {
  if (!cfg.groqApiKey) {
    return res.status(400).json({ error: 'Falta configurar GROQ_API_KEY en el servidor' });
  }
  try {
    const doc = await database.get(req.params.id);
    if (doc.type !== 'procterm') return res.status(404).json({ error: 'Proceso no encontrado' });
    if (!req.esSuperadmin && doc.empresaId !== req.empresaId) return res.status(404).json({ error: 'Proceso no encontrado' });
    if (!doc.samples || !doc.samples.length) return res.status(400).json({ error: 'El proceso no tiene muestras' });
    const texto = await analizarConGroq(construirPrompt(doc));
    doc.analisisIA = { texto, modelo: cfg.groqModel, fecha: new Date().toISOString() };
    await database.raw().insert(doc);
    res.json(doc.analisisIA);
  } catch (e) {
    res.status(e.statusCode || 500).json({ error: e.message });
  }
});

module.exports = router;
