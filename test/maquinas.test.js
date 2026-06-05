'use strict';
const test = require('node:test');
const assert = require('node:assert');
const m = require('../lib/maquinas');

test('generarCodigoPairing da 6 dígitos', () => {
  const c = m.generarCodigoPairing();
  assert.match(c, /^\d{6}$/);
});

test('generarToken da hex largo y único', () => {
  const a = m.generarToken();
  const b = m.generarToken();
  assert.match(a, /^[0-9a-f]{48}$/);
  assert.notStrictEqual(a, b);
});

test('hash y verify de token', async () => {
  const tok = m.generarToken();
  const hash = await m.hashToken(tok);
  assert.notStrictEqual(hash, tok);
  assert.strictEqual(await m.verifyToken(tok, hash), true);
  assert.strictEqual(await m.verifyToken('otro', hash), false);
});

test('pairingVencido detecta expiración', () => {
  const futuro = new Date(Date.now() + 60000).toISOString();
  const pasado = new Date(Date.now() - 60000).toISOString();
  assert.strictEqual(m.pairingVencido({ vence: futuro, usado: false }), false);
  assert.strictEqual(m.pairingVencido({ vence: pasado, usado: false }), true);
  assert.strictEqual(m.pairingVencido({ vence: futuro, usado: true }), true);
});
