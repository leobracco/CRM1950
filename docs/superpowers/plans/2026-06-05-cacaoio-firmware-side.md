# Integración CacaoIO — Lado Firmware (ESP32-S3) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hacer que el firmware CacaoIO mantenga su AP local siempre encendido y autónomo, se conecte además al WiFi de la fábrica (STA), se vincule al CRM con un código, mantenga un WebSocket saliente para control/recetas en vivo, y aplique actualizaciones OTA enviadas por el CRM.

**Architecture:** Modo `WIFI_AP_STA` permanente: AP `CacaoIO` (panel local intacto) + STA hacia la red de la fábrica. Un módulo `cloud` abre un WebSocket cliente seguro hacia `wss://leonardobracco.com/device-ws`, se autentica con `{maquinaId, token}` y rutea comandos entrantes a las **mismas funciones** que usa la API HTTP local. Un módulo `ota` descarga e instala binarios verificados por sha256 usando la partición OTA dual. El control del proceso (`logicaControl()`) sigue corriendo en el loop cooperativo, totalmente independiente de la nube.

**Tech Stack:** PlatformIO/Arduino · ESP32-S3-DevKitC-1 N8 (8MB, sin PSRAM) · ESPAsyncWebServer · ArduinoJson 7 · `links2004/WebSockets` · `Update.h` + `HTTPClient`/`WiFiClientSecure` (ESP32 core) · LittleFS.

**Ubicación del proyecto firmware:** `G:\LeonardoBracco\Productos\Cacao.io\Software\Firmware_Embebido\ESP32-S3-DevKitC`

---

## Notas de contexto para el implementador

- **Verificación = hardware + serial.** No hay test runner para firmware. Cada tarea se valida **flasheando** la placa (`pio run -t upload`) y leyendo el **monitor serie** (`pio device monitor`, 115200), más observar la máquina en el CRM. Los "Expected" describen líneas esperadas en el serial.
- **El control nunca depende de la nube.** No tocar `control.cpp` (`logicaControl`). El módulo `cloud` es opcional y no bloqueante: si no hay WiFi/CRM, reintenta en silencio.
- **El AP `CacaoIO` no se apaga nunca.** Pasamos de `WIFI_AP` a `WIFI_AP_STA`. El panel local (`data/index.html`) y el portal cautivo siguen igual.
- **Provisioning autocontenido:** se sirve una página `/setup` desde PROGMEM (no se modifica el panel grande `data/index.html`). Ahí se cargan SSID + clave + código de vinculación.
- **Constantes del CRM** (host, puerto, paths) van en `config.h` como `#define`.
- **El contrato de control no cambia:** los comandos del CRM traen el mismo JSON que hoy acepta `/api/control`. Refactorizamos para que HTTP y WS llamen una sola función compartida.
- **Convención de commits:** mensajes cortos en español imperativo.

---

## Estructura de archivos (lado firmware)

| Archivo | Responsabilidad |
|---|---|
| `platformio.ini` (modificar) | Agregar `links2004/WebSockets` a `lib_deps`. |
| `src/config.h` (modificar) | Campos de credenciales (wifi/token/maquinaId/serial) + `#define` del CRM. |
| `src/persistence.h/.cpp` (modificar) | Guardar/cargar `creds.json` (wifi, token, maquinaId). |
| `src/network.h/.cpp` (modificar) | `WIFI_AP_STA`, conexión STA, helpers de estado de red. |
| `src/api.h/.cpp` (modificar) | Extraer `aplicarControl()`/`upsertReceta()` reutilizables; endpoints `/api/red`, `/setup`. |
| `src/cloud.h/.cpp` (crear) | Cliente WebSocket, hello/telemetría, ruteo de comandos, heartbeat. |
| `src/ota.h/.cpp` (crear) | Descarga HTTPS + verificación sha256 + `Update.h`. |
| `src/pairing.h/.cpp` (crear) | POST al CRM `/api/maquinas/pairing`, guarda credenciales. |
| `src/main.cpp` (modificar) | `cloudBegin()`/`cloudLoop()`, `otaLoop()`. |

---

## Task 1: Dependencia WebSocket y verificación de particiones OTA

**Files:**
- Modify: `platformio.ini:19-23`

- [ ] **Step 1: Agregar la librería WebSocket cliente**

En `platformio.ini`, ampliar `lib_deps`:
```ini
lib_deps =
    mathieucarbou/ESPAsyncWebServer @ ^3.3.2
    bblanchon/ArduinoJson @ ^7.0.0
    paulstoffregen/OneWire @ ^2.3.8
    milesburton/DallasTemperature @ ^3.11.0
    links2004/WebSockets @ ^2.6.1
```

- [ ] **Step 2: Verificar que la tabla de particiones tiene doble app (OTA)**

Run:
```bash
pio pkg exec -- python -c "import os,glob;print('busca default_8MB.csv en el core')"
```
Luego confirmar que `default_8MB.csv` define `app0`/`ota_0` y `app1`/`ota_1` (el default de arduino-esp32 los trae). Si por algún motivo no, cambiar a una tabla con dos particiones `app` `ota_0`/`ota_1` y `spiffs` para LittleFS.
Expected: existen particiones `ota_0` y `ota_1` → OTA viable.

- [ ] **Step 3: Compilar para bajar las dependencias**

Run:
```bash
cd "G:/LeonardoBracco/Productos/Cacao.io/Software/Firmware_Embebido/ESP32-S3-DevKitC"
pio run
```
Expected: compila sin errores; `WebSockets` se descarga en `.pio/libdeps`.

- [ ] **Step 4: Commit**

```bash
git add platformio.ini
git commit -m "agrega libreria websocket cliente para canal nube"
```

---

## Task 2: Credenciales persistentes y constantes del CRM

**Files:**
- Modify: `src/config.h`
- Modify: `src/persistence.h`
- Modify: `src/persistence.cpp`

- [ ] **Step 1: Agregar `#define` del CRM y struct de credenciales en `config.h`**

Después de `#define MAX_RECETAS 10`, agregar:
```cpp
// --- Servidor CRM en la nube ---
#define CRM_HOST     "leonardobracco.com"
#define CRM_PORT     443
#define CRM_WS_PATH  "/device-ws"
#define CRM_PAIRING_PATH "/api/maquinas/pairing"
#define FW_VERSION   "1.0.0"

// Credenciales de red y vínculo con el CRM (creds.json).
struct NetCreds
{
    String wifi_ssid;
    String wifi_pass;
    String maquina_id;   // "maquina:<uuid>" devuelto por el CRM
    String token;        // token permanente devuelto por el CRM
    String serial;       // derivado de la MAC, estable
    bool   vinculada = false;
};
```

Y al final, junto a los otros `extern`:
```cpp
extern NetCreds creds;
```

- [ ] **Step 2: Definir el global `creds` en `config.cpp`**

En `src/config.cpp`, junto a las demás definiciones de globals (`SystemConfig cfg;` etc.), agregar:
```cpp
NetCreds creds;
```

- [ ] **Step 3: Declarar funciones de persistencia de credenciales en `persistence.h`**

Agregar:
```cpp
void guardarCreds();
void cargarCreds();
```

- [ ] **Step 4: Implementar persistencia de credenciales en `persistence.cpp`**

Agregar al final del archivo:
```cpp
// ============================================================
// CREDENCIALES DE RED / CRM
// ============================================================
void guardarCreds()
{
    File file = LittleFS.open("/creds.json", "w");
    if (!file) return;
    JsonDocument doc;
    doc["wifi_ssid"]  = creds.wifi_ssid;
    doc["wifi_pass"]  = creds.wifi_pass;
    doc["maquina_id"] = creds.maquina_id;
    doc["token"]      = creds.token;
    doc["vinculada"]  = creds.vinculada;
    serializeJson(doc, file);
    file.close();
}

void cargarCreds()
{
    // Serial estable derivado de la MAC (siempre disponible).
    uint8_t mac[6]; WiFi.macAddress(mac);
    char s[18];
    snprintf(s, sizeof(s), "CIO-%02X%02X%02X", mac[3], mac[4], mac[5]);
    creds.serial = s;

    if (!LittleFS.exists("/creds.json")) return;
    File file = LittleFS.open("/creds.json", "r");
    if (!file) return;
    JsonDocument doc;
    if (deserializeJson(doc, file) != DeserializationError::Ok) { file.close(); return; }
    file.close();
    creds.wifi_ssid  = doc["wifi_ssid"].as<String>();
    creds.wifi_pass  = doc["wifi_pass"].as<String>();
    creds.maquina_id = doc["maquina_id"].as<String>();
    creds.token      = doc["token"].as<String>();
    creds.vinculada  = doc["vinculada"] | false;
}
```
(Requiere `#include <WiFi.h>` arriba en `persistence.cpp`.)

- [ ] **Step 5: Cargar credenciales en el arranque**

En `src/main.cpp`, dentro del `if (fs_ok) { ... }`, agregar `cargarCreds();` después de `cargarConfiguracion();`:
```cpp
        cargarConfiguracion();
        cargarCreds();
        cargarRecetas();
        cargarStateRuntime();
        initDatalog();
```

- [ ] **Step 6: Compilar y verificar**

Run:
```bash
pio run
```
Expected: compila sin errores.

- [ ] **Step 7: Commit**

```bash
git add src/config.h src/config.cpp src/persistence.h src/persistence.cpp src/main.cpp
git commit -m "credenciales persistentes (creds.json) y constantes del CRM"
```

---

## Task 3: WIFI_AP_STA permanente + conexión STA

**Files:**
- Modify: `src/network.h`
- Modify: `src/network.cpp`

- [ ] **Step 1: Declarar helpers de estado STA en `network.h`**

```cpp
#pragma once
#include <Arduino.h>
#include <IPAddress.h>

void networkBegin();
void networkLoop();              // procesa DNS captive + reintenta STA
IPAddress    networkIP();        // IP del AP
const char  *networkHostname();

bool       staConectada();       // true si la STA tiene IP
IPAddress  staIP();
void       staConfigurar(const String &ssid, const String &pass); // guarda y reconecta
```

- [ ] **Step 2: Reescribir `network.cpp` para AP+STA**

```cpp
#include "network.h"
#include "config.h"
#include "persistence.h"
#include <WiFi.h>
#include <ESPmDNS.h>
#include <DNSServer.h>

static DNSServer dns;
static const IPAddress AP_IP(192, 168, 10, 1);
static const char *HOSTNAME = "cacaoio";
static unsigned long lastStaTry = 0;

static void intentarSTA()
{
    if (creds.wifi_ssid.isEmpty()) return;
    Serial.printf("[STA] Conectando a '%s'...\n", creds.wifi_ssid.c_str());
    WiFi.begin(creds.wifi_ssid.c_str(), creds.wifi_pass.c_str());
}

void networkBegin()
{
    WiFi.mode(WIFI_AP_STA);      // AP siempre + STA hacia la fabrica
    WiFi.setSleep(false);

    IPAddress gw(192, 168, 10, 1), sn(255, 255, 255, 0);
    WiFi.softAPConfig(AP_IP, gw, sn);
    WiFi.softAP("CacaoIO", "Saulino2026", 1, 0, 4);
    delay(200);

    if (MDNS.begin(HOSTNAME)) MDNS.addService("http", "tcp", 80);

    dns.setErrorReplyCode(DNSReplyCode::NoError);
    dns.start(53, "*", AP_IP);

    intentarSTA();

    Serial.println(F("=================================================="));
    Serial.println(F("  PANEL CACAOIO  (AP siempre encendido)"));
    Serial.printf( "  AP    :  http://%s   (CacaoIO / Saulino2026)\n", AP_IP.toString().c_str());
    Serial.printf( "  mDNS  :  http://%s.local\n", HOSTNAME);
    Serial.println(F("=================================================="));
}

void networkLoop()
{
    dns.processNextRequest();

    // Reintento de STA cada 15s si está caída y hay credenciales.
    if (!creds.wifi_ssid.isEmpty() && WiFi.status() != WL_CONNECTED && millis() - lastStaTry > 15000) {
        lastStaTry = millis();
        intentarSTA();
    }
}

IPAddress   networkIP()       { return AP_IP; }
const char *networkHostname() { return HOSTNAME; }

bool       staConectada()     { return WiFi.status() == WL_CONNECTED; }
IPAddress  staIP()            { return WiFi.localIP(); }

void staConfigurar(const String &ssid, const String &pass)
{
    creds.wifi_ssid = ssid;
    creds.wifi_pass = pass;
    guardarCreds();
    WiFi.disconnect();
    intentarSTA();
}
```

- [ ] **Step 3: Flashear y verificar AP + STA**

Run:
```bash
pio run -t upload && pio device monitor
```
Expected en serial: "PANEL CACAOIO (AP siempre encendido)". El AP `CacaoIO` sigue visible y el panel local abre en `http://192.168.10.1`. Si ya hay credenciales guardadas, aparece "[STA] Conectando a '...'" y luego una IP de la red de la fábrica.

- [ ] **Step 4: Commit**

```bash
git add src/network.h src/network.cpp
git commit -m "modo AP+STA permanente con reconexion STA"
```

---

## Task 4: Refactor de control/receta reutilizable + endpoints de red

**Files:**
- Modify: `src/api.h`
- Modify: `src/api.cpp`

Objetivo: que el comando llegue por HTTP (local) o por WS (nube) y ejecute **la misma** lógica.

- [ ] **Step 1: Declarar las funciones compartidas en `api.h`**

Agregar (con `#include <ArduinoJson.h>` si hace falta):
```cpp
#include <ArduinoJson.h>
// Aplica un comando de control (mismo formato que POST /api/control).
void aplicarControl(JsonObjectConst doc);
// Inserta/actualiza una receta por nombre (mismo formato que POST /api/recetas).
bool upsertReceta(JsonObjectConst doc);
```

- [ ] **Step 2: Extraer `aplicarControl()` en `api.cpp`**

Mover el cuerpo de `control_post_body` (la parte que muta `cfg`/`state`/relés) a una función nueva, y que el handler HTTP la llame. Agregar antes de `control_post_body`:
```cpp
void aplicarControl(JsonObjectConst doc)
{
    bool changed = false;
    if (!doc["perfil_activo"].isNull())  { cfg.perfil_activo  = doc["perfil_activo"].as<String>();  changed = true; }
    if (!doc["temp_derretido"].isNull()) { cfg.temp_derretido = doc["temp_derretido"].as<float>();  changed = true; }
    if (!doc["temp_templado"].isNull())  { cfg.temp_templado  = doc["temp_templado"].as<float>();   changed = true; }
    if (!doc["max_agua"].isNull())       { cfg.max_agua       = doc["max_agua"].as<float>();        changed = true; }
    if (!doc["delta_agua"].isNull())     { cfg.delta_agua     = doc["delta_agua"].as<float>();      changed = true; }
    if (!doc["min_temp_motor"].isNull()) { cfg.min_temp_motor = doc["min_temp_motor"].as<float>();  changed = true; }
    if (!doc["kp"].isNull())             { cfg.kp = doc["kp"].as<float>(); changed = true; }
    if (!doc["ki"].isNull())             { cfg.ki = doc["ki"].as<float>(); changed = true; }
    if (!doc["kd"].isNull())             { cfg.kd = doc["kd"].as<float>(); changed = true; }

    if (!doc["reiniciar_ciclo"].isNull() && doc["reiniciar_ciclo"].as<bool>()) {
        state.etapa_actual = 1; resetPid(); guardarStateRuntime();
    }
    if (!doc["proceso_activo"].isNull()) {
        proceso_activo = doc["proceso_activo"].as<bool>();
        if (!proceso_activo) {
            relayWrite(PIN_RELAY_R1, false, "R1");
            relayWrite(PIN_RELAY_R2, false, "R2");
            relayWrite(PIN_VALVULA,  false, "VALVULA");
            state.etapa_actual = 1; resetPid();
            Serial.println("[CTRL] Proceso detenido");
        }
        state.reinicio_inesperado = false; guardarStateRuntime();
    }
    if (!doc["motor"].isNull()) {
        bool enc = doc["motor"].as<bool>();
        if (!(enc && !state.error && !isnan(state.t_choco) && state.t_choco < cfg.min_temp_motor)) {
            state.motor = enc;
            relayWrite(PIN_REVOLVEDOR, enc, "MOTOR");
            guardarStateRuntime();
        }
    }
    if (!doc["bomba"].isNull()) {
        state.bomba = doc["bomba"].as<bool>();
        relayWrite(PIN_BOMBA, state.bomba, "BOMBA");
        guardarStateRuntime();
    }
    if (changed) guardarConfiguracion();
}
```
Luego, reemplazar el cuerpo de `control_post_body` para que, tras `deserializeJson`, valide el caso "Chocolate frio" (mantener el 403 HTTP) y delegue el resto:
```cpp
static void control_post_body(AsyncWebServerRequest *request, uint8_t *data, size_t len)
{
    JsonDocument doc;
    if (deserializeJson(doc, data, len) != DeserializationError::Ok) { sendJson(request, 400, "{\"status\":\"error_json\"}"); return; }
    if (!doc["motor"].isNull() && doc["motor"].as<bool>() && !state.error && !isnan(state.t_choco) && state.t_choco < cfg.min_temp_motor) {
        sendJson(request, 403, "{\"status\":\"error\",\"msg\":\"Chocolate frio\"}"); return;
    }
    aplicarControl(doc.as<JsonObjectConst>());
    sendJson(request, 200, "{\"status\":\"ok\"}");
}
```

- [ ] **Step 3: Extraer `upsertReceta()` en `api.cpp`**

Refactorizar `recetas_post_body` para delegar:
```cpp
bool upsertReceta(JsonObjectConst doc)
{
    String nombre = doc["nombre"].as<String>();
    if (nombre.isEmpty()) return false;
    int idx = -1;
    for (int i = 0; i < num_recetas; i++) if (recetas[i].nombre == nombre) { idx = i; break; }
    if (idx == -1) {
        if (num_recetas >= MAX_RECETAS) return false;
        idx = num_recetas++;
    }
    recetas[idx].nombre         = nombre;
    recetas[idx].temp_derretido = doc["temp_derretido"] | recetas[idx].temp_derretido;
    recetas[idx].temp_templado  = doc["temp_templado"]  | recetas[idx].temp_templado;
    recetas[idx].max_agua       = doc["max_agua"]       | recetas[idx].max_agua;
    recetas[idx].delta_agua     = doc["delta_agua"]     | recetas[idx].delta_agua;
    guardarRecetas();
    return true;
}

static void recetas_post_body(AsyncWebServerRequest *request, uint8_t *data, size_t len)
{
    JsonDocument doc;
    if (deserializeJson(doc, data, len) != DeserializationError::Ok) { sendJson(request, 400, "{\"status\":\"error_json\"}"); return; }
    if (!upsertReceta(doc.as<JsonObjectConst>())) { sendJson(request, 400, "{\"status\":\"receta_invalida_o_llena\"}"); return; }
    sendJson(request, 200, "{\"status\":\"ok\"}");
}
```

- [ ] **Step 4: Agregar endpoint de estado de red y página `/setup`**

Incluir arriba `#include "network.h"` (ya está) y agregar dentro de `apiBegin`, antes de `onNotFound`:
```cpp
    // Estado de red / vínculo (lo consume la página /setup)
    server.on("/api/red", HTTP_GET, [](AsyncWebServerRequest *r){
        JsonDocument d;
        d["sta_conectada"] = staConectada();
        d["sta_ip"]        = staConectada() ? staIP().toString() : "";
        d["ssid"]          = creds.wifi_ssid;
        d["vinculada"]     = creds.vinculada;
        d["serial"]        = creds.serial;
        String b; serializeJson(d, b);
        r->send(200, "application/json", b);
    });

    // Página de configuración de red + vínculo (PROGMEM, autocontenida)
    server.on("/setup", HTTP_GET, [](AsyncWebServerRequest *r){
        r->send_P(200, "text/html", SETUP_HTML);
    });
```

- [ ] **Step 5: Definir `SETUP_HTML` en PROGMEM**

Cerca del tope de `api.cpp` (después de los `#include`):
```cpp
static const char SETUP_HTML[] PROGMEM = R"HTML(
<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>CacaoIO · Configuración de red</title>
<body style="font-family:system-ui;max-width:420px;margin:1.5rem auto;padding:0 1rem">
<h2>Conectar a la nube</h2>
<div id="st" style="margin:.5rem 0;color:#555"></div>
<label>Red WiFi (SSID)</label><input id="ssid" style="width:100%;padding:.5rem;margin:.3rem 0">
<label>Contraseña WiFi</label><input id="pass" type="password" style="width:100%;padding:.5rem;margin:.3rem 0">
<label>Código de vinculación (CRM)</label><input id="cod" inputmode="numeric" style="width:100%;padding:.5rem;margin:.3rem 0">
<button onclick="g()" style="width:100%;padding:.7rem;margin-top:.6rem">Guardar y vincular</button>
<p id="msg"></p>
<script>
async function s(){let r=await fetch('/api/red');let d=await r.json();
document.getElementById('st').textContent=(d.sta_conectada?('Conectada a '+d.ssid+' ('+d.sta_ip+')'):'AP local')+(d.vinculada?' · Vinculada':' · Sin vincular')+' · '+d.serial;}
async function g(){let b={ssid:ssid.value,pass:pass.value,codigo:cod.value};
let r=await fetch('/api/vincular',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)});
let d=await r.json();document.getElementById('msg').textContent=d.msg||JSON.stringify(d);s();}
s();setInterval(s,3000);
</script></body>)HTML";
```
(El endpoint `/api/vincular` se registra en la Task 6.)

- [ ] **Step 6: Compilar y verificar**

Run:
```bash
pio run -t upload && pio device monitor
```
Expected: compila y flashea. En el AP, abrir `http://192.168.10.1/setup` muestra el formulario y el estado de red (serial visible). El panel local y `/api/control` siguen funcionando igual.

- [ ] **Step 7: Commit**

```bash
git add src/api.h src/api.cpp
git commit -m "refactor control/receta reutilizable + endpoint red y pagina setup"
```

---

## Task 5: Módulo cloud — WebSocket cliente

**Files:**
- Create: `src/cloud.h`
- Create: `src/cloud.cpp`

- [ ] **Step 1: Crear `src/cloud.h`**

```cpp
#pragma once
#include <Arduino.h>

void cloudBegin();   // inicia el cliente WS si la máquina está vinculada
void cloudLoop();     // bombea el WS + envía telemetría periódica
bool cloudConectado();
```

- [ ] **Step 2: Crear `src/cloud.cpp`**

```cpp
#include "cloud.h"
#include "config.h"
#include "api.h"
#include "network.h"
#include <WebSocketsClient.h>
#include <ArduinoJson.h>

static WebSocketsClient ws;
static bool iniciado = false;
static unsigned long lastTelemetria = 0;

static void enviarHelloOTelemetria(const char *tipo)
{
    JsonDocument d;
    d["t"] = tipo;
    if (String(tipo) == "hello") {
        d["maquinaId"] = creds.maquina_id;
        d["token"]     = creds.token;
        d["serial"]    = creds.serial;
        d["fwVersion"] = FW_VERSION;
    }
    JsonObject e = d["estado"].to<JsonObject>();
    if (isnan(state.t_agua))  e["temp_agua"]  = nullptr; else e["temp_agua"]  = state.t_agua;
    if (isnan(state.t_choco)) e["temp_choco"] = nullptr; else e["temp_choco"] = state.t_choco;
    e["motor"]          = state.motor;
    e["bomba"]          = state.bomba;
    e["proceso_activo"] = proceso_activo;
    e["etapa_actual"]   = state.etapa_actual;
    e["error"]          = state.error;
    JsonObject c = e["config"].to<JsonObject>();
    c["perfil"] = cfg.perfil_activo;
    String buf; serializeJson(d, buf);
    ws.sendTXT(buf);
}

static void onWsEvent(WStype_t type, uint8_t *payload, size_t len)
{
    switch (type) {
        case WStype_CONNECTED:
            Serial.println("[CLOUD] WS conectado, enviando hello");
            enviarHelloOTelemetria("hello");
            break;
        case WStype_DISCONNECTED:
            Serial.println("[CLOUD] WS desconectado");
            break;
        case WStype_TEXT: {
            JsonDocument d;
            if (deserializeJson(d, payload, len) != DeserializationError::Ok) return;
            String t = d["t"].as<String>();
            if (t == "ping") { ws.sendTXT("{\"t\":\"pong\"}"); }
            else if (t == "control") { aplicarControl(d["payload"].as<JsonObjectConst>()); }
            else if (t == "receta")  { upsertReceta(d["payload"].as<JsonObjectConst>()); }
            else if (t == "ota") {
                extern void otaIniciar(const String&, const String&, const String&);
                otaIniciar(d["url"].as<String>(), d["version"].as<String>(), d["sha256"].as<String>());
            }
            break;
        }
        default: break;
    }
}

void cloudBegin()
{
    if (!creds.vinculada || creds.maquina_id.isEmpty() || creds.token.isEmpty()) {
        Serial.println("[CLOUD] Sin vínculo: no se inicia WS");
        return;
    }
    ws.beginSSL(CRM_HOST, CRM_PORT, CRM_WS_PATH);
    ws.onEvent(onWsEvent);
    ws.setReconnectInterval(5000);   // backoff fijo de 5s
    ws.enableHeartbeat(15000, 3000, 2);
    iniciado = true;
    Serial.printf("[CLOUD] WS iniciando hacia wss://%s%s\n", CRM_HOST, CRM_WS_PATH);
}

void cloudLoop()
{
    if (!iniciado) {
        // Si nos vinculamos después de arrancar, iniciar al toque.
        if (creds.vinculada && staConectada()) cloudBegin();
        return;
    }
    ws.loop();
    if (ws.isConnected() && millis() - lastTelemetria > 2000) {
        lastTelemetria = millis();
        enviarHelloOTelemetria("telemetria");
    }
}

bool cloudConectado() { return iniciado && ws.isConnected(); }
```

- [ ] **Step 3: Engancharlo en `main.cpp`**

En `setup()`, después de `apiBegin(server);`, agregar `cloudBegin();`. En `loop()`, después de `networkLoop();`, agregar `cloudLoop();`:
```cpp
void loop()
{
    static unsigned long lastTick = 0, lastLog = 0;
    networkLoop();
    cloudLoop();

    if (millis() - lastTick > 1000) { sensorsTick(); logicaControl(); lastTick = millis(); }
    if (millis() - lastLog > 30000) { registrarDatalog(); lastLog = millis(); }
}
```
(Agregar `#include "cloud.h"` arriba en `main.cpp`. La declaración `extern void otaIniciar(...)` queda resuelta por la Task 7; si se compila esta tarea sola, primero hacer la 7 o agregar un stub temporal — ver nota.)

> **Nota de orden:** `cloud.cpp` referencia `otaIniciar()` de la Task 7. Implementá la Task 7 antes de compilar/flashear esta, o agregá temporalmente un stub `void otaIniciar(const String&,const String&,const String&){}` para compilar la 5 aislada.

- [ ] **Step 4: Commit**

```bash
git add src/cloud.h src/cloud.cpp src/main.cpp
git commit -m "modulo cloud: websocket cliente con hello/telemetria y ruteo de comandos"
```

---

## Task 6: Flujo de pairing con el CRM

**Files:**
- Create: `src/pairing.h`
- Create: `src/pairing.cpp`
- Modify: `src/api.cpp` (registrar `/api/vincular`)

- [ ] **Step 1: Crear `src/pairing.h`**

```cpp
#pragma once
#include <Arduino.h>
// Guarda WiFi, conecta STA y hace el POST de pairing al CRM.
// Devuelve mensaje de resultado para mostrar en /setup.
String vincularConCRM(const String &ssid, const String &pass, const String &codigo);
```

- [ ] **Step 2: Crear `src/pairing.cpp`**

```cpp
#include "pairing.h"
#include "config.h"
#include "network.h"
#include "persistence.h"
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>

String vincularConCRM(const String &ssid, const String &pass, const String &codigo)
{
    staConfigurar(ssid, pass);

    // Esperar conexión STA hasta 15s.
    unsigned long t0 = millis();
    while (!staConectada() && millis() - t0 < 15000) delay(250);
    if (!staConectada()) return "No se pudo conectar al WiFi";

    WiFiClientSecure client;
    client.setInsecure();   // v1: sin pinning de certificado
    HTTPClient http;
    String url = String("https://") + CRM_HOST + CRM_PAIRING_PATH;
    if (!http.begin(client, url)) return "No se pudo abrir la conexión al CRM";
    http.addHeader("Content-Type", "application/json");

    JsonDocument body;
    body["codigo"]    = codigo;
    body["serial"]    = creds.serial;
    body["fwVersion"] = FW_VERSION;
    String out; serializeJson(body, out);

    int code = http.POST(out);
    String resp = http.getString();
    http.end();
    if (code != 200) return String("CRM rechazó el código (") + code + ")";

    JsonDocument rd;
    if (deserializeJson(rd, resp) != DeserializationError::Ok) return "Respuesta inválida del CRM";
    creds.maquina_id = rd["maquinaId"].as<String>();
    creds.token      = rd["token"].as<String>();
    if (creds.maquina_id.isEmpty() || creds.token.isEmpty()) return "El CRM no devolvió credenciales";
    creds.vinculada = true;
    guardarCreds();
    Serial.printf("[PAIR] Vinculada como %s\n", creds.maquina_id.c_str());
    return "¡Vinculada! La máquina aparecerá en el CRM.";
}
```

- [ ] **Step 3: Registrar `/api/vincular` en `api.cpp`**

Incluir `#include "pairing.h"` arriba, y en `apiBegin` (junto al endpoint `/api/red`):
```cpp
    server.on("/api/vincular", HTTP_POST,
        [](AsyncWebServerRequest *r){}, NULL,
        [](AsyncWebServerRequest *r, uint8_t *d, size_t l, size_t, size_t){
            JsonDocument doc;
            if (deserializeJson(doc, d, l) != DeserializationError::Ok) { r->send(400, "application/json", "{\"msg\":\"json invalido\"}"); return; }
            String msg = vincularConCRM(doc["ssid"].as<String>(), doc["pass"].as<String>(), doc["codigo"].as<String>());
            JsonDocument out; out["msg"] = msg;
            String b; serializeJson(out, b);
            r->send(200, "application/json", b);
        });
```

> **Nota:** `vincularConCRM` bloquea hasta 15s esperando la STA. Es aceptable: ocurre una sola vez en el alta, desde el portal. El control del proceso sigue corriendo en el loop una vez que retorna.

- [ ] **Step 4: Flashear y verificar el alta completa**

Pre-requisito: el CRM (Task del plan hermano) corriendo y accesible por HTTPS, y un código de pairing generado en el CRM.
Run:
```bash
pio run -t upload && pio device monitor
```
Pasos: conectarse al AP `CacaoIO` → abrir `http://192.168.10.1/setup` → cargar SSID, clave y el código → "Guardar y vincular".
Expected en serial: "[STA] Conectando...", IP de la fábrica, "[PAIR] Vinculada como maquina:...", luego "[CLOUD] WS conectado, enviando hello". En el CRM la máquina aparece **En línea**.

- [ ] **Step 5: Commit**

```bash
git add src/pairing.h src/pairing.cpp src/api.cpp
git commit -m "flujo de pairing: POST al CRM y guarda token"
```

---

## Task 7: Módulo OTA

**Files:**
- Create: `src/ota.h`
- Create: `src/ota.cpp`
- Modify: `src/main.cpp` (otaLoop)

- [ ] **Step 1: Crear `src/ota.h`**

```cpp
#pragma once
#include <Arduino.h>
// Encola una actualización OTA (la dispara cloud al recibir {t:'ota'}).
void otaIniciar(const String &url, const String &version, const String &sha256);
// Procesa la descarga/instalación fuera del callback del WS.
void otaLoop();
```

- [ ] **Step 2: Crear `src/ota.cpp`**

```cpp
#include "ota.h"
#include "config.h"
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <Update.h>
#include <mbedtls/sha256.h>

static bool pendiente = false;
static String g_url, g_ver, g_sha;

void otaIniciar(const String &url, const String &version, const String &sha256)
{
    g_url = url; g_ver = version; g_sha = sha256;
    pendiente = true;
    Serial.printf("[OTA] Solicitada v%s desde %s\n", version.c_str(), url.c_str());
}

static String toHex(const uint8_t *d, size_t n)
{
    static const char *h = "0123456789abcdef";
    String s; s.reserve(n * 2);
    for (size_t i = 0; i < n; i++) { s += h[d[i] >> 4]; s += h[d[i] & 0xF]; }
    return s;
}

void otaLoop()
{
    if (!pendiente) return;
    pendiente = false;

    WiFiClientSecure client;
    client.setInsecure();
    HTTPClient http;
    if (!http.begin(client, g_url)) { Serial.println("[OTA] No se pudo abrir URL"); return; }
    int code = http.GET();
    if (code != 200) { Serial.printf("[OTA] HTTP %d\n", code); http.end(); return; }

    int total = http.getSize();
    if (total <= 0 || !Update.begin(total)) { Serial.println("[OTA] Update.begin falló"); http.end(); return; }

    mbedtls_sha256_context shaCtx;
    mbedtls_sha256_init(&shaCtx);
    mbedtls_sha256_starts(&shaCtx, 0); // 0 = SHA-256

    WiFiClient *stream = http.getStreamPtr();
    uint8_t buf[1024];
    int leido = 0;
    while (http.connected() && leido < total) {
        size_t avail = stream->available();
        if (avail) {
            int n = stream->readBytes(buf, min(avail, sizeof(buf)));
            mbedtls_sha256_update(&shaCtx, buf, n);
            if (Update.write(buf, n) != (size_t)n) { Serial.println("[OTA] Update.write falló"); Update.abort(); http.end(); return; }
            leido += n;
        } else delay(1);
    }
    http.end();

    uint8_t hash[32];
    mbedtls_sha256_finish(&shaCtx, hash);
    String hex = toHex(hash, 32);
    if (!g_sha.isEmpty() && !hex.equalsIgnoreCase(g_sha)) {
        Serial.printf("[OTA] sha256 NO coincide (esp=%s got=%s) -> abortar\n", g_sha.c_str(), hex.c_str());
        Update.abort();
        return;
    }
    if (!Update.end(true)) { Serial.printf("[OTA] Update.end error: %d\n", Update.getError()); return; }

    Serial.println("[OTA] OK, reiniciando con la nueva versión...");
    delay(500);
    ESP.restart();
}
```

- [ ] **Step 3: Engancharlo en `main.cpp`**

Agregar `#include "ota.h"` arriba y `otaLoop();` en el `loop()` después de `cloudLoop();`:
```cpp
    networkLoop();
    cloudLoop();
    otaLoop();
```
(Con la Task 7 implementada, quitar el stub temporal de `otaIniciar` si se agregó en la Task 5.)

- [ ] **Step 4: Flashear y verificar OTA punta a punta**

Pre-requisito: CRM corriendo, máquina vinculada y online; subir un `.bin` (puede ser el mismo firmware recompilado, versión "1.0.1") en el CRM.
Pasos: en el CRM → Máquinas → "Actualizar FW" → elegir la versión → Actualizar.
Expected en serial: "[OTA] Solicitada v1.0.1...", progreso de descarga, "[OTA] OK, reiniciando...". Tras reiniciar, en el CRM la máquina vuelve **En línea** con `fwVersion` actualizado. Si se corrompe el sha, "[OTA] sha256 NO coincide -> abortar" y sigue la versión vieja.

- [ ] **Step 5: Commit**

```bash
git add src/ota.h src/ota.cpp src/main.cpp
git commit -m "ota: descarga https con verificacion sha256 y particion dual"
```

---

## Task 8: Verificación integral de autonomía

**Files:** (sin cambios de código — pruebas de aceptación)

- [ ] **Step 1: Autonomía sin internet**

Con la máquina vinculada y operando, desconectar el WiFi de la fábrica (o apagar el router).
Expected: el serial muestra "[CLOUD] WS desconectado" y reintentos; `logicaControl()` sigue corriendo (las temperaturas y relés siguen gestionándose); el panel local en el AP `CacaoIO` sigue 100% operativo.

- [ ] **Step 2: Acceso por ambos lados**

Con internet restablecido y el WS reconectado: enviar un comando desde el CRM (ej. encender motor) y verificar que el panel local refleja el cambio; luego operar desde el panel local y ver el cambio reflejado en el CRM (último comando gana).
Expected: ambos caminos mutan el mismo estado/relés sin trabarse.

- [ ] **Step 3: Reconexión automática**

Cortar y restablecer la energía de la máquina.
Expected: al volver, reconecta STA, manda `hello`, y el CRM la marca **En línea** con su estado real. Si había proceso activo, se respeta el `reinicio_inesperado` existente (alerta al operador, sin reactivar relés solos).

- [ ] **Step 4: Commit (documentación de aceptación, si aplica)**

Si se agregan notas de verificación al `CLAUDE.md` del firmware, commitearlas:
```bash
git add CLAUDE.md
git commit -m "notas de verificacion de integracion nube"
```

---

## Self-review (cobertura del spec — lado firmware)

- **AP siempre encendido + STA (`WIFI_AP_STA`)** → Task 3. ✔
- **Cliente WebSocket saliente con hello/telemetría/heartbeat** → Task 5. ✔
- **Control y recetas por la nube usando el mismo contrato** → Task 4 (refactor) + Task 5 (ruteo). ✔
- **Pairing portal AP + código → POST al CRM → token** → Tasks 4 (página/setup), 6 (POST). ✔
- **Persistencia de wifi/token/maquinaId/serial** → Task 2. ✔
- **OTA HTTPS con verificación sha256 y partición dual** → Tasks 1 (particiones), 7. ✔
- **Autonomía local: control no depende de la nube; panel local intacto** → Tasks 3, 5 (no bloqueante), 8 (aceptación). ✔
- **Constantes del CRM (`#define`)** → Task 2. ✔

El **lado CRM** (gateway WS, pairing, REST de máquinas, firmware, recetas de templado, UI/SSE) está en el plan hermano `2026-06-05-cacaoio-crm-side.md`. El contrato de mensajes (`lib/protocol.js` en el CRM) y los `#define`/JSON de este plan deben mantenerse en sincronía: tipos `hello/telemetria/pong/ota_progreso` (dispositivo→CRM) y `control/receta/ota/ping` (CRM→dispositivo), path `/device-ws`, autenticación por `{maquinaId, token}`.
```
