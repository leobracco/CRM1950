'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const database = require('./db');

const PAIRING_TTL_MS = 10 * 60 * 1000;

function generarCodigoPairing() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

function generarToken() {
  return crypto.randomBytes(24).toString('hex'); // 48 chars hex
}

function hashToken(token) {
  return bcrypt.hash(token, 10);
}

function verifyToken(token, hash) {
  return bcrypt.compare(token, hash);
}

function pairingVencido(doc) {
  if (!doc || doc.usado) return true;
  return new Date(doc.vence).getTime() < Date.now();
}

// Crea el doc pairing:<codigo> con TTL. Devuelve { codigo, vence }.
async function crearPairing() {
  const codigo = generarCodigoPairing();
  const vence = new Date(Date.now() + PAIRING_TTL_MS).toISOString();
  await database.insert({ _id: `pairing:${codigo}`, type: 'pairing', codigo, usado: false, vence, creado: new Date().toISOString() });
  return { codigo, vence };
}

// Valida un código y, si es válido, crea la máquina y devuelve { maquinaId, token }.
// Lanza Error con statusCode si el código es inválido/vencido.
async function vincular({ codigo, serial, fwVersion }) {
  const pdoc = await database.tryGet(`pairing:${codigo}`);
  if (pairingVencido(pdoc)) { const e = new Error('Código inválido o vencido'); e.statusCode = 400; throw e; }

  const maquinaId = `maquina:${crypto.randomUUID()}`;
  const token = generarToken();
  const tokenHash = await hashToken(token);
  await database.insert({
    _id: maquinaId, type: 'maquina',
    nombre: serial || 'Máquina nueva',
    serial: serial || '', tokenHash,
    online: false, ultimoVisto: null, ip: '',
    fwVersion: fwVersion || '', estado: {}, recetaActiva: '',
    creado: new Date().toISOString()
  });

  pdoc.usado = true;
  await database.raw().insert(pdoc);
  return { maquinaId, token };
}

module.exports = {
  generarCodigoPairing, generarToken, hashToken, verifyToken,
  pairingVencido, crearPairing, vincular, PAIRING_TTL_MS
};
