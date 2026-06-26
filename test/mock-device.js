'use strict';
// Dispositivo simulado para verificación end-to-end del gateway CRM (sin hardware).
// Uso: node test/mock-device.js <baseHttp> <wsUrl> <codigoPairing>
// Ej:  node test/mock-device.js http://localhost:6001 ws://localhost:6001/device-ws 123456
//
// Nota: este archivo vive en test/ pero NO es un test automático. La guarda de abajo
// evita que `npm test` (node --test) lo ejecute: sin código de pairing sale sin efectos.
const WebSocket = require('ws');

const base = process.argv[2] || 'http://localhost:6001';
const wsUrl = process.argv[3] || 'ws://localhost:6001/device-ws';
const codigo = process.argv[4];

async function main() {
  const r = await fetch(base + '/api/maquinas/pairing', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ codigo, serial: 'MOCK-001', fwVersion: '0.9.0' })
  });
  const cred = await r.json();
  if (!cred.token) { console.error('Pairing falló:', cred); process.exit(1); }
  console.log('Vinculada:', cred.maquinaId);

  const ws = new WebSocket(wsUrl);
  let estado = {
    temp_choco: 30, temp_agua: 40, etapa_actual: 1, motor: false, bomba: false,
    proceso_activo: false, aviso_mantener_fin: false,
    modo_instalador: false, test_relay: '',
    config: {
      perfil: 'Mock Leche', temp_derretido: 45, temp_templado: 27, max_agua: 60, delta_agua: 15,
      temp_precalentado: 0, tiempo_mantener_min: 0, mezcla_on_seg: 0, mezcla_periodo_min: 0
    }
  };

  ws.on('open', () => {
    ws.send(JSON.stringify({ t: 'hello', maquinaId: cred.maquinaId, token: cred.token, serial: 'MOCK-001', fwVersion: '0.9.0', estado }));
    setInterval(() => {
      estado.temp_choco = +(28 + Math.random() * 4).toFixed(1);
      ws.send(JSON.stringify({ t: 'telemetria', estado }));
    }, 2000);
  });
  ws.on('message', raw => {
    const m = JSON.parse(raw.toString());
    if (m.t === 'ping') return ws.send(JSON.stringify({ t: 'pong' }));
    console.log('CMD recibido:', m);
    if (m.t === 'control' && m.payload) Object.assign(estado, m.payload);
    if (m.t === 'receta' && m.payload) { estado.config = { ...estado.config, perfil: m.payload.nombre, ...m.payload }; }
    if (m.t === 'ota') ws.send(JSON.stringify({ t: 'ota_progreso', pct: 100 }));
    if (m.t === 'instalador' && m.payload) {
      const p = m.payload;
      if (p.instalador === 'on') { estado.modo_instalador = true; estado.test_relay = ''; }
      else if (p.instalador === 'off') { estado.modo_instalador = false; estado.test_relay = ''; }
      else if (p.instalador === 'test') { estado.test_relay = p.on ? p.relay : ''; }
      ws.send(JSON.stringify({ t: 'telemetria', estado }));
    }
  });
  ws.on('close', (c, r) => console.log('WS cerrado', c, r.toString()));
}

// Sólo corre cuando se invoca directamente con un código de pairing.
// Bajo `node --test` (sin código) no hace nada, manteniendo la suite verde.
if (require.main === module && codigo) {
  main();
} else if (require.main === module) {
  console.log('Uso: node test/mock-device.js <baseHttp> <wsUrl> <codigoPairing>');
}

module.exports = { main };
