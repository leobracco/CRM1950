# Modo instalador para probar relays — Diseño

**Fecha:** 2026-06-26
**Autor:** Leonardo Bracco (+ Claude)
**Estado:** Aprobado para planificar

## Objetivo

Agregar un **modo instalador** a la máquina de templado (cacao) que permita probar cada uno de los 6 relays individualmente, sin necesidad de una receta/proceso en curso, para verificar el cableado tras montar o reparar una PCB. Operable tanto desde el **panel web local** de la máquina como desde el **CRM**.

## Motivación

Hoy no se puede probar el cableado de los relays con la máquina vacía:

- Las **resistencias R1/R2 no tienen ningún camino de control manual**: solo las maneja el lazo PID (`logicaControl`), que además **las fuerza a OFF en cada vuelta** mientras no hay proceso activo.
- El **motor (revolvedor)** tiene una protección que **no lo deja arrancar con el chocolate frío** (`min_temp_motor`) — exactamente la condición de una máquina recién instalada y vacía.
- `motor`, `bomba`, `bomba_agua`, `ventilador` solo se pueden tocar a mano si su modo está en MANUAL, y aun así el lazo normal puede pisarlos.

Por eso se necesita un modo dedicado que **suspenda el lazo de control normal** y permita accionar cada relay salteando esos seguros, en un carril aislado que no contamine la lógica de templado real.

## Hardware de referencia (PCB nueva, FW 1.0.3+)

Los 6 relays son **activos-bajos** (`RELAY_ON=LOW`). Pines en `src/relays.h`:

| Relay | Identificador | `#define` | GPIO |
|---|---|---|---|
| Resistencia agua 1 | `r1` | `PIN_RELAY_R1` | 16 |
| Resistencia agua 2 | `r2` | `PIN_RELAY_R2` | 17 |
| Revolvedor (batidor) | `revolvedor` | `PIN_REVOLVEDOR` | 18 |
| Bomba de chocolate | `bomba` | `PIN_BOMBA` | 8 |
| Bomba de agua (recirc.) | `bomba_agua` | `PIN_BOMBA_AGUA` | 9 |
| Ventilador (radiador) | `ventilador` | `PIN_VENTILADOR` | 10 |

Sensores DS18B20 en GPIO 4 (sin relación con este modo).

## Reglas de comportamiento (acordadas)

1. **Operable desde local + CRM.**
2. **Un relay por vez (exclusivo):** al prender uno, se apaga el anterior.
3. **Auto-apagado a los 5 segundos fijos** por relay (timeout no configurable).
4. **Bloqueado si hay receta corriendo** (`proceso_activo == true`): no deja entrar al modo.
5. **Al salir, todos los relays a OFF** y vuelve el lazo de control normal.
6. **Solo rol admin** en el CRM.
7. **No persiste:** un reinicio del firmware sale del modo instalador.
8. **Auto-salida por inactividad:** ~120 s sin comandos en modo instalador → apaga todo y sale solo (red de seguridad ante caída de WiFi).

## Arquitectura

### Firmware (ESP32-S3-DevKitC)

**Estado runtime nuevo** (no se persiste; en boot arranca en false/limpio):

- `state.modo_instalador` (bool) — true mientras el modo está activo.
- `test_relay` (índice/identificador del relay prendido ahora, o "ninguno").
- `test_relay_hasta_ms` (unsigned long) — deadline de auto-apagado del relay activo.
- `instalador_ultimo_cmd_ms` (unsigned long) — para la auto-salida por inactividad.

(Estos tres últimos pueden vivir como estáticos en el módulo `instalador.cpp`; solo `modo_instalador` y el nombre del relay activo se exponen en telemetría.)

**Módulo nuevo `src/instalador.cpp` + `src/instalador.h`:**

- `void aplicarInstalador(JsonObjectConst doc)` — procesa los comandos (ver "Protocolo").
- `void instaladorLoop()` — llamada desde el loop principal: apaga el relay activo al vencer su timeout de 5 s; ejecuta la auto-salida por inactividad a los ~120 s.
- Helper interno `relayPorNombre(const char* nombre)` → pin + puntero al campo `state.*` correspondiente, para que la telemetría refleje el relay accionado.

**Tabla de relays** (nombre → pin → campo de estado):

| `relay` | pin | campo state |
|---|---|---|
| `r1` | `PIN_RELAY_R1` | `state.r1` |
| `r2` | `PIN_RELAY_R2` | `state.r2` |
| `revolvedor` | `PIN_REVOLVEDOR` | `state.motor` |
| `bomba` | `PIN_BOMBA` | `state.bomba` |
| `bomba_agua` | `PIN_BOMBA_AGUA` | `state.bomba_agua` |
| `ventilador` | `PIN_VENTILADOR` | `state.ventilador` |

**`logicaControl()` (control.cpp):** agregar al inicio
```cpp
if (state.modo_instalador) return;
```
para que el lazo no toque ningún relay mientras el modo está activo.

**Entrada/salida:**
- Entrar: si `proceso_activo` → no hace nada (log "instalador rechazado: proceso activo"). Si no, `modo_instalador=true`, apaga los 6 relays, `test_relay=ninguno`.
- Probar: solo si `modo_instalador`. Apaga el `test_relay` actual (si hay y es distinto), escribe el relay pedido (ON/OFF) actualizando su campo `state.*`, y si `on=true` arma `test_relay_hasta_ms = millis()+5000`.
- Salir: apaga los 6 relays, `modo_instalador=false`, `resetPid()`, `test_relay=ninguno`.
- Cualquier comando válido actualiza `instalador_ultimo_cmd_ms`.

**`main.cpp` (loop principal):** llamar `instaladorLoop()` cada vuelta (antes o después de `logicaControl()`; como el lazo se cortocircuita en modo instalador, el orden es indistinto).

**`FW_VERSION`** (config.h): subir a `"1.0.4"`.

### Protocolo (transporte)

Comando dedicado, separado del control normal. Mismo JSON en HTTP local y WebSocket:

```json
{ "instalador": "on" }                                  // entrar
{ "instalador": "off" }                                 // salir
{ "instalador": "test", "relay": "r1", "on": true }     // probar relay (exclusivo, 5 s)
{ "instalador": "test", "relay": "r1", "on": false }    // apagar antes del timeout
```

**HTTP local (api.cpp):** `POST /api/instalador` con el body JSON → `aplicarInstalador(body)` → responde `{"status":"ok"}` (o `{"status":"proceso_activo"}` si rechaza la entrada).

**WebSocket (cloud.cpp `procesarComando`):** nuevo caso
```cpp
else if (strcmp(t, "instalador") == 0) {
    if (!doc["payload"].isNull()) aplicarInstalador(doc["payload"].as<JsonObjectConst>());
    enviarMensaje("telemetria");
}
```

**Telemetría / status:** agregar en `construirEstado` (cloud.cpp) y `status_get` (api.cpp):
- `modo_instalador` (bool)
- `test_relay` (string: nombre del relay prendido, o `""`)

### CRM (App_PC/CRM)

**`lib/protocol.js`:** nueva constante
```js
INSTALADOR: 'instalador',   // { t, payload: { instalador, relay, on } }
```

**`routes/maquinas.js`:** nueva ruta análoga a `/control`:
```js
// Modo instalador: probar relays individualmente (admin; tarea de técnico).
router.post('/:id/instalador', auth.requireRole('admin'), async (req, res) => {
  try {
    const doc = await database.get(req.params.id);
    if (!req.esSuperadmin && doc.empresaId !== req.empresaId) return res.status(404).json({ error: 'No encontrada' });
  } catch (e) { return res.status(404).json({ error: 'No encontrada' }); }
  if (!gw.online(req.params.id)) return res.status(409).json({ error: 'Máquina desconectada' });
  const ok = gw.enviar(req.params.id, { t: proto.INSTALADOR, payload: req.body || {} });
  res.json({ ok });
});
```

**`public/js/app.js` (panel de máquina):**
- Botón **"🔧 Modo instalador"**, visible solo para admin (`esAdmin()` / rol del usuario). Deshabilitado si `estado.proceso_activo`, con tooltip "Detené el proceso para probar relays".
- Al entrar (`POST /api/maquinas/:id/instalador` con `{instalador:'on'}`): vista de prueba con 6 botones (R1, R2, Revolvedor, Bomba choco, Bomba agua, Ventilador). Tocar uno envía `{instalador:'test', relay, on:true}` y muestra **cuenta regresiva de 5 s**; al vencer (o tocar otro) se apaga. Resaltado exclusivo según `estado.test_relay` (que llega por SSE).
- Mostrar **temp. agua y choco en vivo** durante la prueba (verificación de sensores).
- Botón rojo **"Salir del modo instalador"** → `{instalador:'off'}` y vuelve al panel normal.
- El estado real (`modo_instalador`, `test_relay`) se toma del feed SSE, así dos pantallas quedan sincronizadas. El `data-tgl`/countdown del cliente es solo cosmético; la fuente de verdad es el firmware.

**`data/index.html` (panel local de la máquina):** sección "Modo instalador" equivalente, con los 6 botones + entrar/salir, pegándole a `POST /api/instalador`. Refleja `modo_instalador`/`test_relay` del polling de `/api/status`. (Cambiar `data/` requiere `uploadfs`, que borra LittleFS; los datos sensibles ya viven en NVS, así que es seguro.)

## Casos borde y manejo

- **Entrar con proceso activo:** firmware rechaza (no entra) y CRM/local deshabilitan el botón. Doble barrera.
- **Salir siempre apaga todo**, aunque no haya relay activo.
- **Reinicio del firmware** durante el modo: arranca con `modo_instalador=false` (no persiste) → vuelve al lazo normal.
- **Caída de WiFi / cliente** con un relay prendido: el timeout de 5 s lo apaga; la inactividad de ~120 s saca del modo y apaga todo.
- **Dos clientes (local + CRM) a la vez:** gana el último comando; el estado por telemetría/polling resincroniza ambos. Aceptable.
- **Protección de motor frío:** NO aplica en modo instalador (camino separado de `aplicarControl`), para poder probar el revolvedor en seco.
- **Relay desconocido** en `test`: se ignora (log).

## Pruebas

**CRM (`test/`, hay framework):**
- `routes/maquinas.js` `/:id/instalador`: responde 409 si la máquina está offline; exige rol admin (rechaza operario/producción); con máquina online arma y envía `{t:'instalador', payload}` correcto vía `gw.enviar`.
- Extender `test/mock-device.js` para que el dispositivo simulado acepte el verbo `instalador` y refleje `modo_instalador`/`test_relay` en su telemetría.

**Firmware (sin framework — plan de prueba en banco):**
1. Entrar al modo instalador (sin receta) → confirma que `logicaControl` deja de actuar.
2. Tocar cada relay → escuchar el clic y ver arranque del motor/bomba/ventilador; confirmar que la resistencia conmuta.
3. Confirmar **auto-apagado a los 5 s**.
4. Confirmar **exclusividad** (prender uno apaga el anterior).
5. Intentar entrar con una receta corriendo → **rechazado**.
6. Salir → **todos OFF** y vuelve el lazo normal.
7. Reiniciar la placa en modo instalador → arranca fuera del modo.
8. (Opcional) Cortar WiFi con un relay activo → se apaga a los 5 s; a los ~120 s sale del modo.

## Fuera de alcance (YAGNI)

- Timeout configurable desde la UI (queda fijo en 5 s).
- Probar varios relays en simultáneo.
- Secuencia de auto-test automática (prender los 6 en orden solo). Si se quiere más adelante, es otra iteración.
- Registro/histórico de las pruebas de instalador en el CRM.

## Archivos afectados

**Firmware (ESP32-S3-DevKitC):**
- Crear: `src/instalador.cpp`, `src/instalador.h`
- Modificar: `src/control.cpp` (cortocircuito de `logicaControl`), `src/config.h` (campo `modo_instalador` en `state`, `FW_VERSION`→1.0.4), `src/api.cpp` (`POST /api/instalador` + `modo_instalador`/`test_relay` en status), `src/cloud.cpp` (verbo `instalador` + telemetría), `src/main.cpp` (`instaladorLoop()`), `data/index.html` (UI local)

**CRM (App_PC/CRM):**
- Modificar: `lib/protocol.js` (verbo `INSTALADOR`), `routes/maquinas.js` (ruta `/:id/instalador`), `public/js/app.js` (UI panel), `test/mock-device.js` (verbo simulado)
- Crear: test de la ruta `/:id/instalador`
