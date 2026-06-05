# Ciclos de precalentado / mantener / mezclado intermitente — Diseño

**Fecha:** 2026-06-05
**Estado:** Aprobado por el usuario

## Objetivo

Sumar tres conductas nuevas a la máquina de templado CacaoIO, parametrizables por receta y mirroreadas CRM↔firmware:

1. **Precalentado de agua solo** — calentar únicamente el agua a una temperatura objetivo y mantenerla, como fase previa opcional, hasta que el operador inicie el derretido.
2. **Mantener** — tras alcanzar el templado, sostener `temp_templado` durante X minutos y luego apagar el proceso avisando al operador.
3. **Mezclado intermitente** — encender el motor revolvedor A segundos cada B minutos, en lugar de operación manual continua.

## Principio rector

La máquina es 100% autónoma. Toda la lógica vive en el firmware y en la receta local; la nube (CRM) sólo edita recetas y observa estado. Las tres conductas se configuran como campos numéricos de la receta, con `0` = desactivado (comportamiento actual preservado).

## Modelo de datos

Cuatro campos nuevos en la receta. Se agregan a `struct Receta` y a `SystemConfig` (firmware) y al documento `receta_templado` (CRM):

| Campo | Default | Semántica |
|---|---|---|
| `temp_precalentado` | `0` | Si `>0`: fase previa, calienta sólo agua a esta °C y la mantiene |
| `tiempo_mantener_min` | `0` | Si `>0`: fase final, mantiene `temp_templado` X minutos, luego apaga + avisa |
| `mezcla_on_seg` (A) | `0` | Segundos de motor ON por ciclo de mezclado |
| `mezcla_periodo_min` (B) | `0` | Período del ciclo en minutos; OFF = `B*60 − A` seg |

Mezclado intermitente activo sólo si `mezcla_on_seg>0 && mezcla_periodo_min>0`; si no, el motor sigue siendo manual (lógica actual, sin tocar).

Flag de estado nuevo en `SystemState` (firmware): `bool aviso_mantener_fin` — análogo a `reinicio_inesperado`. Se expone en `/api/status` y viaja en la telemetría WS hacia el CRM.

## Máquina de estados (`logicaControl`, etapas)

- **etapa 0 — Precalentado** (sólo si `temp_precalentado>0`): controla el agua directamente a `temp_precalentado` con la misma banda muerta de relés (R1/R2/VALVULA), **sin** PID de chocolate. Mantiene la temperatura hasta que el operador envía `iniciar_derretido` → pasa a etapa 1. Si `temp_precalentado=0`, `aplicarReceta` arranca directo en etapa 1.
- **etapa 1 — Derretir:** sin cambios (agua a `temp_derretido` vía PID hasta `t_choco ≥ temp_derretido−0.2` → etapa 2).
- **etapa 2 — Templar:** sin cambios (PID a `temp_templado`). Si `tiempo_mantener_min>0` y `t_choco ≤ temp_templado+0.3`, transición a etapa 3 registrando `mantener_inicio_ms = millis()`.
- **etapa 3 — Mantener** (sólo si `tiempo_mantener_min>0`): sostiene `temp_templado`. Cuando `millis() − mantener_inicio_ms ≥ tiempo_mantener_min*60000`: `proceso_activo=false`, relés OFF, `aviso_mantener_fin=true`, persiste estado. Si `tiempo_mantener_min=0`, etapa 2 sostiene indefinidamente (comportamiento actual).

### Mezclado intermitente (transversal)

En etapas con chocolate (1/2/3, **no** en precalentado), si el mezclado está activo:
- `periodo_ms = mezcla_periodo_min*60000`, `on_ms = mezcla_on_seg*1000`
- `fase = millis() % periodo_ms`; motor deseado = `fase < on_ms`
- guarda `min_temp_motor`: si `t_choco < min_temp_motor`, motor forzado OFF
- sólo escribe el relé del motor cuando el estado deseado cambia (evita parpadeo de escrituras)

Cuando el proceso se detiene (early-return de `logicaControl`), si el mezclado estaba activo y el motor encendido, se apaga el motor. Con mezclado desactivado no se toca el motor (queda manual).

## Disparo del precalentado y limpieza de aviso (control)

`POST /api/control` (firmware) suma:
- `iniciar_derretido: true` → sólo válido desde etapa 0; setea `etapa_actual=1`, `resetPid()`, persiste.
- al reactivar `proceso_activo=true` y en `aplicarReceta`: `aviso_mantener_fin=false`.

## Persistencia

`recetas.json` y `config.json` (firmware) serializan/parsean los 4 campos nuevos con defaults `0`. `aviso_mantener_fin` y `mantener_inicio_ms` son runtime, no se persisten.

## CRM

- `server.js beforeRecetaTemplado`: agrega `num(doc.temp_precalentado,0)`, `num(doc.tiempo_mantener_min,0)`, `num(doc.mezcla_on_seg,0)`, `num(doc.mezcla_periodo_min,0)`.
- `public/js/app.js RES.recetasTemplado.fields`: 4 inputs `number` nuevos.
- `routes/maquinas.js POST /:id/receta`: el `payload` de la `RECETA` WS incluye los 4 campos.
- La `maquinaCard` (frontend) ya muestra `etapa_actual`; el aviso `aviso_mantener_fin` se mostrará como pill de alerta cuando llegue en la telemetría.

## Compatibilidad

Recetas existentes sin los campos nuevos cargan con `0` → conducta idéntica a hoy. Ninguna de las tres funciones altera el flujo derretir→templar cuando está desactivada.
