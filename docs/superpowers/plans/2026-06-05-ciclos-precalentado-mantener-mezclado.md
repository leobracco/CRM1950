# Ciclos precalentado / mantener / mezclado — Plan de implementación

> Ejecución inline (tareas fuertemente acopladas: struct → persistencia → api → control comparten los 4 campos).

**Goal:** Sumar precalentado de agua, fase de mantener temporizada con apaga+avisa, y mezclado intermitente, parametrizados por receta y mirroreados CRM↔firmware.

**Tech:** Firmware ESP32-S3 (Arduino/PlatformIO, ArduinoJson, LittleFS) + CRM Node/Express.

---

## Firmware

### Tarea F1 — `config.h`: campos en Receta, SystemConfig, SystemState

- `struct Receta`: agregar `float temp_precalentado=0; float tiempo_mantener_min=0; float mezcla_on_seg=0; float mezcla_periodo_min=0;`
- `struct SystemConfig`: agregar las mismas 4 (con default 0) después de `delta_agua`/`min_temp_motor`.
- `struct SystemState`: agregar `bool aviso_mantener_fin=false;`
- Global runtime en control: `extern unsigned long mantener_inicio_ms;` (definir en config.cpp = 0).

### Tarea F2 — `persistence.cpp`: serializar/parsear

- `guardarConfiguracion`/`cargarConfiguracion`: leer/escribir los 4 campos de cfg (default 0 al cargar).
- `guardarRecetas`/`cargarRecetas`: leer/escribir los 4 campos por receta (`r["campo"] | 0` al cargar).

### Tarea F3 — `api.cpp`

- `recetas_get`: exponer los 4 campos por receta.
- `recetas_post_body`: `recetas[idx].campo = doc["campo"] | recetas[idx].campo;` para los 4.
- `status_get`: exponer `aviso_mantener_fin` y, en `config`, los 4 campos.
- `control_post_body`:
  - `iniciar_derretido`: si `true` y `etapa_actual==0` → `etapa_actual=1; resetPid(); guardarStateRuntime();`
  - al setear `proceso_activo=true` → `state.aviso_mantener_fin=false;`

### Tarea F4 — `control.cpp`: máquina de estados

- `aplicarReceta`: copiar los 4 campos a cfg; `etapa_actual = (recetas[idx].temp_precalentado>0) ? 0 : 1;` `state.aviso_mantener_fin=false; mantener_inicio_ms=0;`
- `logicaControl`:
  - early-return (proceso parado/error/sensor): además, si mezclado activo y `state.motor`, apagar motor.
  - etapa 0: target = `cfg.temp_precalentado` sobre el agua (sin PID choco); aplicar banda muerta de relés usando `state.t_agua` vs target; NO transiciona sola; `return` antes del bloque PID.
  - etapa 2→3: si `tiempo_mantener_min>0 && etapa==2 && t_choco<=temp_templado+0.3` → `etapa=3; mantener_inicio_ms=millis();`
  - etapa 3 expiración: `if (etapa==3 && millis()-mantener_inicio_ms >= tiempo_mantener_min*60000UL)` → relés OFF, `proceso_activo=false`, `aviso_mantener_fin=true`, persistir, `return`.
  - mezclado intermitente: tras el bloque de relés, si etapa∈{1,2,3} y `mezcla_on_seg>0 && mezcla_periodo_min>0`, calcular motor deseado y escribir relé sólo si cambia, respetando `min_temp_motor`.

## CRM

### Tarea C1 — `server.js beforeRecetaTemplado`

Agregar:
```js
doc.temp_precalentado = num(doc.temp_precalentado, 0);
doc.tiempo_mantener_min = num(doc.tiempo_mantener_min, 0);
doc.mezcla_on_seg = num(doc.mezcla_on_seg, 0);
doc.mezcla_periodo_min = num(doc.mezcla_periodo_min, 0);
```

### Tarea C2 — `public/js/app.js RES.recetasTemplado.fields`

Agregar 4 fields number: temp_precalentado (Precalentado agua °C, 0=off), tiempo_mantener_min (Mantener min, 0=off), mezcla_on_seg (Mezcla ON seg, 0=continuo), mezcla_periodo_min (Mezcla período min).

### Tarea C3 — `routes/maquinas.js POST /:id/receta`

Destructurar y reenviar los 4 campos en el `payload`.

## Verificación

- CRM: `npm test` sigue verde; POST receta-templado con campos nuevos persiste y vuelve coerced.
- Firmware: compila (`pio run`); precalentado mantiene agua sin PID choco; mantener apaga+avisa al expirar; mezclado cicla A/B respetando min_temp_motor; receta vieja (campos ausentes) = conducta actual.
