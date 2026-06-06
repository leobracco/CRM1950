'use strict';

const Nano = require('nano');
const cfg = require('../config');

const nano = Nano(cfg.couchUrl);
let db = nano.db.use(cfg.dbName);
let ready = false;

// Índices Mango: agilizan los _find por tipo y campos usados en listados/búsquedas.
const INDEXES = [
  { name: 'idx-type', fields: ['type'] },
  { name: 'idx-type-codigo', fields: ['type', 'codigo'] },
  { name: 'idx-type-fecha', fields: ['type', 'fecha'] },
  { name: 'idx-type-nombre', fields: ['type', 'nombre'] },
  { name: 'idx-type-serial', fields: ['type', 'serial'] },
  { name: 'idx-type-version', fields: ['type', 'version'] },
  { name: 'idx-type-maquinaId', fields: ['type', 'maquinaId'] }
];

async function init() {
  try {
    const list = await nano.db.list();
    if (!list.includes(cfg.dbName)) {
      await nano.db.create(cfg.dbName);
      console.log(`[db] Base "${cfg.dbName}" creada.`);
    }
    db = nano.db.use(cfg.dbName);

    for (const ix of INDEXES) {
      await db.createIndex({ index: { fields: ix.fields }, name: ix.name, type: 'json' });
    }
    ready = true;
    console.log(`[db] CouchDB conectado en ${cfg.couchUrl.replace(/\/\/.*@/, '//***@')}`);
    return true;
  } catch (err) {
    ready = false;
    console.warn('[db] No se pudo conectar a CouchDB:', err.message);
    console.warn('[db] El servidor arranca igual; revisá COUCH_URL y que CouchDB esté corriendo.');
    return false;
  }
}

const isReady = () => ready;

// ---- Helpers genéricos ----

async function get(id) {
  return db.get(id);
}

async function tryGet(id) {
  try { return await db.get(id); } catch (e) { return null; }
}

async function insert(doc) {
  const res = await db.insert(doc);
  return { ...doc, _id: res.id, _rev: res.rev };
}

async function remove(id, rev) {
  return db.destroy(id, rev);
}

// Listar por tipo con filtros/orden simples vía Mango.
async function findByType(type, extra = {}) {
  const selector = { type, ...(extra.selector || {}) };
  const q = {
    selector,
    limit: extra.limit || 1000,
    sort: extra.sort,
    fields: extra.fields
  };
  if (!q.sort) delete q.sort;
  if (!q.fields) delete q.fields;
  const res = await db.find(q);
  return res.docs;
}

async function find(query) {
  const res = await db.find(query);
  return res.docs;
}

// Genera un número correlativo atómico-ish por contador (doc counter:<key>)
async function nextSeq(key) {
  const id = `counter:${key}`;
  for (let i = 0; i < 5; i++) {
    try {
      const doc = (await tryGet(id)) || { _id: id, type: 'counter', value: 0 };
      doc.value += 1;
      await db.insert(doc);
      return doc.value;
    } catch (e) {
      if (e.statusCode === 409) continue; // conflicto: reintentar
      throw e;
    }
  }
  throw new Error('No se pudo generar correlativo para ' + key);
}

module.exports = {
  nano,
  raw: () => db,
  init, isReady,
  get, tryGet, insert, remove, find, findByType, nextSeq
};
