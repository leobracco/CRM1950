'use strict';

// Acumula la telemetría de temperatura en documentos por proceso (type:procterm).
// Un "proceso" es el lapso entre que la máquina activa y desactiva la elaboración;
// el firmware lo identifica con estado.proceso_id (estable durante toda la corrida).

const database = require('./db');

const MAX_SAMPLES = 5000;          // tope defensivo de muestras por proceso
const abiertos = new Map();        // maquinaId -> procesoId actualmente en curso

function num(v) { return (typeof v === 'number' && isFinite(v)) ? v : null; }

// Inserta/actualiza un doc con reintento ante conflicto 409.
async function _upsert(id, mutate) {
  for (let i = 0; i < 5; i++) {
    try {
      let doc = await database.tryGet(id);
      const isNew = !doc;
      if (!doc) doc = { _id: id, type: 'procterm' };
      mutate(doc, isNew);
      await database.raw().insert(doc);
      return doc;
    } catch (e) {
      if (e.statusCode === 409) continue;
      throw e; // no-db u otro error: no romper el gateway
    }
  }
}

// Estadísticas resumidas de la curva (se calculan al cerrar el proceso).
function calcularResumen(doc) {
  const s = doc.samples || [];
  let tcMin = Infinity, tcMax = -Infinity, tcSum = 0, tcN = 0;
  let taMin = Infinity, taMax = -Infinity;
  const segPorEtapa = {};
  for (let i = 0; i < s.length; i++) {
    const x = s[i];
    if (x.tc != null) { tcMin = Math.min(tcMin, x.tc); tcMax = Math.max(tcMax, x.tc); tcSum += x.tc; tcN++; }
    if (x.ta != null) { taMin = Math.min(taMin, x.ta); taMax = Math.max(taMax, x.ta); }
    if (i > 0) {
      const dt = (new Date(x.t) - new Date(s[i - 1].t)) / 1000;
      const e = s[i - 1].et;
      if (dt > 0 && dt < 3600) segPorEtapa[e] = (segPorEtapa[e] || 0) + dt;
    }
  }
  const durSeg = s.length > 1 ? (new Date(s[s.length - 1].t) - new Date(s[0].t)) / 1000 : 0;
  return {
    muestras: s.length,
    duracionSeg: Math.round(durSeg),
    chocoMin: tcN ? +tcMin.toFixed(2) : null,
    chocoMax: tcN ? +tcMax.toFixed(2) : null,
    chocoProm: tcN ? +(tcSum / tcN).toFixed(2) : null,
    aguaMin: isFinite(taMin) ? +taMin.toFixed(2) : null,
    aguaMax: isFinite(taMax) ? +taMax.toFixed(2) : null,
    segPorEtapa
  };
}

// Cierra el proceso abierto de una máquina: fija fin y calcula el resumen.
async function cerrarProceso(maquinaId, empresaId) {
  const pid = abiertos.get(maquinaId);
  if (!pid) return;
  abiertos.delete(maquinaId);
  const id = empresaId ? `procterm:${empresaId}:${pid}` : `procterm:${pid}`;
  if (!(await database.tryGet(id))) return;
  await _upsert(id, (doc) => {
    if (doc.fin) return;
    doc.fin = new Date().toISOString();
    doc.resumen = calcularResumen(doc);
  });
}

// Registra una muestra de telemetría. Crea el doc del proceso la primera vez
// y cierra el anterior si cambió el proceso_id.
async function registrarMuestra(empresaId, maquinaId, serial, estado) {
  if (!estado) return;
  const pid = estado.proceso_id;
  const activo = !!estado.proceso_activo;

  if (activo && pid) {
    const previo = abiertos.get(maquinaId);
    if (previo && previo !== pid) await cerrarProceso(maquinaId, empresaId);

    const sample = {
      t: new Date().toISOString(),
      ta: num(estado.temp_agua),
      tc: num(estado.temp_choco),
      sp: num(estado.setpoint),
      et: estado.etapa_actual,
      m: !!estado.motor,
      b: !!estado.bomba
    };
    const id = empresaId ? `procterm:${empresaId}:${pid}` : `procterm:${pid}`;
    await _upsert(id, (doc, isNew) => {
      if (isNew) {
        doc.empresaId = empresaId || null;
        doc.maquinaId = maquinaId;
        doc.serial = serial || '';
        doc.procesoId = pid;
        doc.receta = (estado.config && estado.config.perfil) || '';
        doc.inicio = sample.t;
        doc.fin = null;
        doc.samples = [];
        doc.analisisIA = null;
      }
      if (doc.samples.length < MAX_SAMPLES) doc.samples.push(sample);
      doc.ultimaMuestra = sample.t;
    });
    abiertos.set(maquinaId, pid);
  } else if (abiertos.has(maquinaId)) {
    await cerrarProceso(maquinaId, empresaId);
  }
}

module.exports = { registrarMuestra, cerrarProceso, calcularResumen, _abiertos: abiertos };
