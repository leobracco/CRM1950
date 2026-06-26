'use strict';
const test = require('node:test');
const assert = require('node:assert');
const gw = require('../lib/cloudGateway');
const proto = require('../lib/protocol');

function fakeSocket() {
  return { sent: [], send(s) { this.sent.push(s); }, readyState: 1 };
}

test('proto.INSTALADOR es "instalador"', () => {
  assert.strictEqual(proto.INSTALADOR, 'instalador');
});

test('gateway envía comando instalador a máquina online', () => {
  gw._reset();
  const s = fakeSocket();
  gw._register('maquina:1', s);
  const ok = gw.enviar('maquina:1', { t: proto.INSTALADOR, payload: { instalador: 'test', relay: 'r1', on: true } });
  assert.strictEqual(ok, true);
  assert.deepStrictEqual(JSON.parse(s.sent[0]), {
    t: 'instalador',
    payload: { instalador: 'test', relay: 'r1', on: true }
  });
});

test('enviar instalador a máquina offline devuelve false', () => {
  gw._reset();
  assert.strictEqual(gw.enviar('maquina:x', { t: proto.INSTALADOR, payload: { instalador: 'on' } }), false);
});
