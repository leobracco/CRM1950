'use strict';
const test = require('node:test');
const assert = require('node:assert');
const gw = require('../lib/cloudGateway');

function fakeSocket() {
  return { sent: [], send(s) { this.sent.push(s); }, readyState: 1 };
}

test('registrar y enviar comando a máquina online', () => {
  gw._reset();
  const s = fakeSocket();
  gw._register('maquina:1', s);
  assert.strictEqual(gw.online('maquina:1'), true);
  const ok = gw.enviar('maquina:1', { t: 'ping' });
  assert.strictEqual(ok, true);
  assert.deepStrictEqual(JSON.parse(s.sent[0]), { t: 'ping' });
});

test('enviar a máquina offline devuelve false', () => {
  gw._reset();
  assert.strictEqual(gw.online('maquina:x'), false);
  assert.strictEqual(gw.enviar('maquina:x', { t: 'ping' }), false);
});

test('desregistrar deja la máquina offline', () => {
  gw._reset();
  const s = fakeSocket();
  gw._register('maquina:2', s);
  gw._unregister('maquina:2', s);
  assert.strictEqual(gw.online('maquina:2'), false);
});

test('suscriptor SSE recibe broadcast', () => {
  gw._reset();
  const recibidos = [];
  const sub = { write: (s) => recibidos.push(s) };
  gw.addSseSubscriber(sub);
  gw.broadcast({ maquinaId: 'maquina:1', online: true });
  assert.match(recibidos[0], /maquina:1/);
  assert.match(recibidos[0], /^data: /);
});
