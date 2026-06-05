# Integración máquina CacaoIO (ESP32-S3) ↔ CRM 1950

**Fecha:** 2026-06-05
**Estado:** Diseño aprobado — pendiente de plan de implementación

## Objetivo

Permitir, desde el CRM 1950 (Node/Express + CouchDB, cloud en
`leonardobracco.com:6001`), controlar a distancia la máquina de baño/templado de
chocolate **CacaoIO** (firmware ESP32-S3, PlatformIO/Arduino): ver estado en
vivo, enviar comandos de control, cargar recetas de templado y actualizar el
firmware por OTA. La máquina debe conectarse al WiFi de la fábrica para salir a
internet hacia el CRM.

Se modifican **ambos** lados (CRM y firmware) para que sean compatibles.

## Principio rector: la nube es un agregado, no una dependencia

La máquina **opera de forma 100 % autónoma**. La pérdida de internet, del WiFi de
la fábrica o del CRM **no debe afectar** el control del proceso ni el acceso del
personal en planta.

- `logicaControl()` corre en el loop cooperativo (cada 1 s) independiente de la
  nube. Si no hay conexión, la máquina sigue templando igual.
- El **Access Point local `CacaoIO` queda siempre encendido** (modo
  `WIFI_AP_STA`): el personal siempre puede conectarse al AP y usar el panel web
  local actual, con o sin internet.
- El módulo de nube es opcional y silencioso: si no conecta, reintenta en
  segundo plano sin impactar el control ni el panel local.

## Decisiones de diseño (acordadas)

| Tema | Decisión |
|---|---|
| Conectividad | **Nube**: el firmware en STA inicia conexión saliente al CRM. No se abren puertos en la fábrica. |
| Tiempo real | **WebSocket** persistente máquina→CRM. |
| Acceso local | **AP siempre encendido** (`WIFI_AP_STA`), panel local intacto. Control autónomo. |
| Alta de máquina | Portal AP `CacaoIO` para cargar WiFi + **código de vinculación** generado por el CRM. |
| Flota | **Varias máquinas**; sección "Máquinas" en el CRM. |
| OTA | Admin **sube `.bin`** al CRM y **empuja** a cada máquina (control manual de versión). |
| Recetas | Sección **"Recetas de templado" separada** de las recetas de alfajor. |
| Canal nube | **Gateway WebSocket dentro del propio CRM** (librería `ws` sobre el proceso Express, TLS vía nginx). Sin infraestructura nueva. |
| Conflicto local vs nube | **Último comando gana**; sin "modo nube" que trabe al operario. |

## Arquitectura

```
┌─────────────┐   wss://leonardobracco.com/device-ws   ┌──────────────────────────┐
│ Máquina ESP │ ─────────(saliente, token)───────────▶ │   CRM (Express, pm2 6001) │
│  CacaoIO    │ ◀────────comandos / OTA ─────────────  │  ┌─ ws gateway (lib ws)  │
│ AP+STA      │   telemetría (temp/estado) cada 2s      │  ├─ REST /api/maquinas   │
│ siempre AP  │                                         │  ├─ CouchDB (docs)        │
└─────────────┘                                         │  └─ /firmware/*.bin (disk)│
       ▲ AP local siempre activo (panel web actual)     └──────────────────────────┘
       │                                                          ▲ nginx TLS
   Personal en planta ──HTTP LAN──▶ panel local         Navegador admin ──REST/SSE──▶ CRM
```

- La máquina **siempre inicia** la conexión saliente; el CRM mantiene un mapa en
  memoria `maquinaId → socket`.
- El navegador admin nunca habla directo con la máquina: manda al CRM por REST y
  el CRM reenvía por WS. La UI se refresca en vivo por **SSE**
  (`/api/maquinas/stream`), coherente con el front vanilla actual.
- Local (AP) y nube (WS) terminan en **las mismas funciones internas** de
  control → mismo estado y relés.

## Modelo de datos (CouchDB, patrón `type`)

- `type:'maquina'` → `{ _id:'maquina:<uuid>', nombre, serial, tokenHash, online,
  ultimoVisto, ip, fwVersion, estado:{…última telemetría…}, recetaActiva, creado }`
- `type:'receta_templado'` → `{ _id, nombre, temp_derretido, temp_templado,
  max_agua, delta_agua }` (espejo exacto de `struct Receta` del firmware)
- `type:'firmware'` → `{ _id, version, archivo:'/firmware/cacaoio-<ver>.bin',
  sha256, tamano, notas, subido }` (el `.bin` va a disco, no a Couch)
- `type:'pairing'` → código de un solo uso, TTL 10 min `{ codigo, usado, vence }`

Añadir índices Mango en `lib/db.js` para los nuevos `type`.

## Flujos

### Alta de máquina (pairing)

1. CRM (admin) → "Máquinas" → **Vincular nueva** → genera código de 6 dígitos
   (doc `pairing`, TTL 10 min).
2. El personal se conecta al AP `CacaoIO` y en el portal carga: SSID + clave del
   WiFi de la fábrica + el código.
3. La máquina guarda WiFi en `config.json`, reinicia en STA y hace **un POST
   HTTPS** a `/api/maquinas/pairing` con `{codigo, serial, fwVersion}`.
4. El CRM valida el código, crea el doc `maquina`, devuelve un **token
   permanente**. La máquina lo guarda; de ahí en más se conecta al WS con ese
   token. El código queda quemado.

### Control en vivo

- Reutiliza el contrato actual de `/api/control` (motor, bomba, proceso_activo,
  perfil, PID…). Los comandos que viajan por WS son **el mismo JSON** que hoy
  acepta `control_post_body`. **Cero lógica de control nueva en el firmware.**
- Mensajes WS (campo `t`):
  - Máquina→CRM: `{t:'telemetria', …status…}` cada 2 s, `{t:'pong'}`,
    `{t:'ota_progreso', pct}`, `{t:'hello', …estado…}` al (re)conectar.
  - CRM→Máquina: `{t:'control', payload:{…}}`, `{t:'receta', payload:{…}}`,
    `{t:'ota', url, version, sha256}`, `{t:'ping'}`.
- Sección "Máquinas": tarjetas con temp agua/choco, etapa, online/offline, receta
  activa y botones (equivalente al panel local pero desde la nube).

### Recetas de templado

- Sección nueva (CRUD, mismo patrón que las vistas SPA actuales).
- Botón **"Enviar a máquina"** → CRM manda `{t:'receta', payload}` → el firmware
  hace el mismo upsert-por-nombre que ya tiene en `/api/recetas`. Sin cambios de
  modelo en el firmware.

### OTA

1. Admin sube `.bin` (`POST /api/firmware`, multipart) → se guarda en disco + doc
   `firmware` con sha256.
2. En una máquina → "Actualizar" → elegir versión → CRM manda
   `{t:'ota', url, version, sha256}`.
3. El firmware descarga por HTTPS (streaming con `Update.h`), verifica sha256,
   aplica en la partición OTA libre, reporta progreso por WS y reinicia. Si la
   verificación falla, **aborta y conserva la versión vigente**.
4. Al reiniciar reporta `fwVersion` en `hello`; el CRM actualiza el doc.

## Seguridad

- `wss://` (TLS terminado por nginx) + token por-máquina, **guardado hasheado**
  en Couch (igual que las passwords de usuario, bcrypt).
- Endpoints de gestión (`/api/maquinas`, `/api/firmware`, generar pairing) detrás
  de `requireAuth` + `requireRole('admin')`.
- OTA sólo acepta binarios verificados por sha256.

## Manejo de errores y casos borde

- **Máquina offline** → los comandos del CRM devuelven 409 "máquina desconectada"
  (no se encolan; operar máquina caliente debe ser explícito). UI deshabilita
  botones con cartel "operar desde el panel local".
- **Reconexión WS** con backoff exponencial; al reconectar la máquina manda
  `hello` con su estado real y el CRM se re-sincroniza.
- **OTA fallido** → se conserva la versión previa (partición dual); el CRM marca
  "actualización fallida".
- **`reinicio_inesperado`** (ya manejado por el firmware) se propaga a la UI nube
  como alerta.
- **Pérdida total de internet/WiFi** → control autónomo + panel local AP siguen
  funcionando sin degradación.

## Cambios en el firmware

- `network.cpp`: pasar a **`WIFI_AP_STA`** permanente — AP `CacaoIO` siempre
  arriba + STA si hay credenciales guardadas. Portal cautivo y panel local
  **idénticos**. AP nunca se apaga.
- **Nuevo módulo `cloud.cpp/.h`**: cliente WebSocket saliente
  (`links2004/WebSockets`), reconexión con backoff, heartbeat, ruteo de mensajes
  entrantes hacia las funciones de control/receta ya existentes; emisión de
  telemetría. Opcional y no bloqueante.
- **Nuevo módulo `ota.cpp/.h`**: descarga HTTPS + verificación sha256 + aplicación
  con `Update.h`.
- `persistence.cpp`: persistir `wifi_ssid`, `wifi_pass`, `cloud_token`, `serial`
  en `config.json`.
- `main.cpp`: `cloudBegin()` en `setup()`, `cloudLoop()` en el loop cooperativo
  (mantiene el modelo sin-RTOS).
- Portal AP: agregar campos SSID + clave WiFi + código de vinculación.
- `platformio.ini`: sumar `links2004/WebSockets` a `lib_deps`. Verificar que la
  tabla de particiones de 8 MB tenga doble OTA (default 8MB la tiene).

## Cambios en el CRM

- `server.js`: montar el WS gateway (`ws`) sobre el server HTTP existente;
  registrar rutas nuevas.
- **`lib/cloudGateway.js`**: manejo de conexiones de dispositivos, auth por token,
  mapa en memoria `maquinaId → socket`, broadcast a navegadores por SSE.
- **`routes/maquinas.js`**: REST (listar, detalle, comando, enviar-receta,
  generar pairing, lanzar OTA) + endpoint público `POST /pairing` + SSE stream.
- **`routes/firmware.js`**: subir/listar binarios (multer), servir `/firmware/*.bin`.
- **`routes/recetasTemplado.js`**: CRUD genérico con `type:'receta_templado'`.
- `lib/db.js`: índices Mango para `maquina`, `receta_templado`, `firmware`,
  `pairing`.
- Front (`public/index.html`, `js/app.js`, `css/styles.css`): nav en grupo
  "Producción" → "Máquinas" y "Recetas de templado"; vistas y modales siguiendo
  los patrones existentes (`modal()`, `btn()`, `api()`, `toast()`, `esc()`).

## Fuera de alcance (por ahora)

- OTA automático por versión "estable" (se eligió empuje manual).
- Broker MQTT (se eligió gateway WS en el CRM).
- Decremento de stock por receta de templado / integración con producción de
  alfajores.
- Colado/encolado de comandos para máquinas offline.
