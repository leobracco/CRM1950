'use strict';

const { WebSocketServer } = require('ws');
const proto = require('./protocol');
const maquinas = require('./maquinas');
const database = require('./db');

// Registro en memoria: maquinaId -> socket
const sockets = new Map();
// Suscriptores SSE (objetos response de Express)
const sseSubs = new Set();

function _reset() { sockets.clear(); sseSubs.clear(); }
function _register(id, socket) { sockets.set(id, socket); }
function _unregister(id, socket) { if (sockets.get(id) === socket) sockets.delete(id); }

function online(id) { return sockets.has(id); }

function enviar(id, msg) {
  const s = sockets.get(id);
  if (!s || s.readyState !== 1) return false;
  s.send(JSON.stringify(msg));
  return true;
}

function addSseSubscriber(res) {
  sseSubs.add(res);
}
function removeSseSubscriber(res) {
  sseSubs.delete(res);
}
function broadcast(obj) {
  const payload = `data: ${JSON.stringify(obj)}\n\n`;
  for (const res of sseSubs) {
    try { res.write(payload); } catch (e) { sseSubs.delete(res); }
  }
}

// Persiste estado de la máquina y avisa a los navegadores por SSE.
async function actualizarMaquina(id, patch) {
  for (let i = 0; i < 3; i++) {
    try {
      const doc = await database.tryGet(id);
      if (!doc) break;
      Object.assign(doc, patch);
      await database.raw().insert(doc);
      break;
    } catch (e) {
      if (e.statusCode === 409) continue; // conflicto: reintentar con doc fresco
      break; // no-db u otro error: no romper el gateway
    }
  }
  broadcast({ maquinaId: id, ...patch });
}

// Maneja un mensaje entrante ya parseado de un dispositivo autenticado.
async function _onMessage(id, ip, msg) {
  switch (msg.t) {
    case proto.HELLO:
    case proto.TELEMETRIA:
      await actualizarMaquina(id, {
        online: true, ultimoVisto: new Date().toISOString(), ip,
        estado: msg.estado || {}, fwVersion: msg.fwVersion || undefined,
        recetaActiva: (msg.estado && msg.estado.config && msg.estado.config.perfil) || undefined
      });
      break;
    case proto.OTA_PROGRESO:
      broadcast({ maquinaId: id, otaPct: msg.pct });
      break;
    case proto.PONG:
      break;
    default:
      break;
  }
}

// Engancha el upgrade WebSocket sobre el http.Server de Express.
function attach(httpServer) {
  const wss = new WebSocketServer({ server: httpServer, path: proto.WS_PATH });

  wss.on('connection', (ws, req) => {
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim();
    let id = null;
    let autenticado = false;

    const authTimer = setTimeout(() => { if (!autenticado) ws.close(4001, 'sin auth'); }, 5000);

    ws.on('message', async (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      if (!autenticado) {
        if (msg.t !== proto.HELLO || !msg.maquinaId || !msg.token) { ws.close(4001, 'hello requerido'); return; }
        const doc = await database.tryGet(msg.maquinaId);
        if (!doc || !doc.tokenHash || !(await maquinas.verifyToken(msg.token, doc.tokenHash))) {
          ws.close(4003, 'token invalido'); return;
        }
        autenticado = true;
        id = msg.maquinaId;
        clearTimeout(authTimer);
        _register(id, ws);
        await _onMessage(id, ip, msg);
        return;
      }
      await _onMessage(id, ip, msg);
    });

    ws.on('close', async () => {
      clearTimeout(authTimer);
      if (id) { _unregister(id, ws); await actualizarMaquina(id, { online: false, ultimoVisto: new Date().toISOString() }); }
    });
    ws.on('error', () => { /* el close limpia */ });
  });

  // Heartbeat: ping a todos los dispositivos conectados.
  setInterval(() => {
    for (const id of sockets.keys()) enviar(id, { t: proto.PING });
  }, proto.HEARTBEAT_MS);

  return wss;
}

module.exports = {
  attach, online, enviar, addSseSubscriber, removeSseSubscriber, broadcast,
  _reset, _register, _unregister
};
