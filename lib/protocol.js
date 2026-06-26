'use strict';

// Tipos de mensaje del canal WebSocket CRM <-> máquina CacaoIO.
// El campo discriminador en cada mensaje JSON es "t".
module.exports = {
  // Dispositivo -> CRM
  HELLO: 'hello',           // { t, maquinaId, token, serial, fwVersion, estado }
  TELEMETRIA: 'telemetria', // { t, ...status... }
  PONG: 'pong',             // { t }
  OTA_PROGRESO: 'ota_progreso', // { t, pct }

  // CRM -> dispositivo
  CONTROL: 'control',       // { t, payload: {...mismo JSON que /api/control...} }
  RECETA: 'receta',         // { t, payload: {nombre, temp_derretido, temp_templado, max_agua, delta_agua, temp_precalentado, tiempo_mantener_min, mezcla_on_seg, mezcla_periodo_min} }
  INSTALADOR: 'instalador', // { t, payload: { instalador, relay, on } }
  OTA: 'ota',               // { t, url, version, sha256 }
  PING: 'ping',             // { t }

  WS_PATH: '/device-ws',
  HEARTBEAT_MS: 20000       // intervalo de ping del servidor a cada dispositivo
};
