# Diseño: Multi-empresa (multi-tenant) para el ERP 1950

**Fecha:** 2026-06-06
**Estado:** Aprobado (pendiente de plan de implementación)

## Objetivo

Convertir el ERP/CRM —hoy mono-empresa— en un sistema **multi-empresa (multi-tenant)**: cada empresa ingresa con sus usuarios y ve únicamente sus propios datos (recetas, ventas, compras, clientes, proveedores, insumos, productos, máquinas, lotes, procesos, etc.). Un **superadmin** (el proveedor del sistema) administra todas las empresas.

## Decisiones tomadas (confirmadas con el usuario)

1. **Relación usuarios↔empresa:** 1 usuario pertenece a 1 empresa. Existe un rol global **`superadmin`** (sin empresa) que ve y administra todas.
2. **Aislamiento:** una sola base CouchDB; cada documento lleva un campo **`empresaId`**. Aislamiento lógico controlado por un punto central de filtrado (no una base por empresa).
3. **Datos actuales:** se **arranca limpio** (no hay migración de los datos de la Fábrica 1950; son de prueba). Hay que re-vincular la máquina después.
4. **Firmware/OTA:** **global, gestionado solo por el superadmin**. Las empresas no ven ni suben binarios.
5. **Branding en rótulos/trazabilidad:** sale **de los datos de cada empresa** (razón social, CUIT, etc.). Cada empresa luce como propia.

## Arquitectura general

```
Request → sesión {usuario, rol, empresaId}
        → middleware tenant: calcula req.empresaId
        → rutas/crud: scopean toda lectura/escritura por req.empresaId
        → db: índices type+empresaId; IDs namespaceados por empresa
```

- **Tenant resolver (middleware):** después de `requireAuth`, un middleware setea `req.empresaId`:
  - Usuario normal → `req.empresaId = session.user.empresaId`.
  - Superadmin → `req.empresaId` = la "empresa activa" guardada en la sesión (`session.empresaActiva`, seteada con `POST /api/empresa-activa`); si no eligió ninguna, las vistas de negocio le piden elegir una. (Fuente única: la sesión; el frontend no manda la empresa por header.)
- **Punto único de scoping:** el filtrado por empresa vive en `lib/db.js` + `lib/crud.js`, no repartido por cada ruta. Las rutas hechas a mano (`compras`, `ventas`, `fabricacion`, `lotes`, `etiquetas`, `movimientos`, `dashboard`, `procesos`, `maquinas`) reciben `req.empresaId` y lo pasan a los helpers.

## Modelo de datos

### Nueva entidad `empresa`
- `type: "empresa"`, `_id: empresa:<slug>` (slug derivado del nombre, único).
- Campos: `nombre` (fantasía), `razonSocial`, `cuit`, `domicilio`, `localidad`, `email`, `telefono`, `activo` (bool), `creado`, `actualizado`.
- Reemplaza el uso de `cfg.empresa` (config.js) en rótulos y trazabilidad: ese objeto pasa a ser **fallback** únicamente.

### Campo `empresaId` en todos los docs de negocio
Tipos afectados: `insumo`, `producto`, `receta`, `receta_templado`, `cliente`, `proveedor`, `compra`, `venta`, `orden`, `lote`, `movimiento`, `maquina`, `procterm`, `counter`.
- No lo llevan: `empresa` (es la raíz), `user` (lleva `empresaId` para indicar pertenencia; el superadmin lo tiene vacío/`null`), `firmware` (global).

### IDs namespaceados por empresa
Para que no colisionen en la base compartida:
- `insumo:<empresaId>:HAR`, `producto:<empresaId>:<codigo>`, `receta:<empresaId>:<codigo>`, etc.
- Correlativos: `venta:<empresaId>:000007`, `compra:<empresaId>:...`, `orden:<empresaId>:...`, `lote:<empresaId>:<codigo>`.
- Counters por empresa: `counter:<empresaId>:venta`, `counter:<empresaId>:compra`, etc. Cada empresa arranca sus correlativos (FV/OC/OF) en 1.
- `nextSeq(key)` pasa a `nextSeq(empresaId, key)` → doc `counter:<empresaId>:<key>`.

> **Nota sobre `<empresaId>` en IDs:** se usa el slug de la empresa (la parte después de `empresa:`), no el prefijo completo, para mantener los IDs legibles (`venta:fabrica-1950:000007`).

### Índices Mango nuevos (lib/db.js)
- `idx-type-empresa` → `['type', 'empresaId']`
- `idx-type-empresa-codigo` → `['type', 'empresaId', 'codigo']`
- `idx-type-empresa-fecha` → `['type', 'empresaId', 'fecha']`
- Se conservan los índices existentes para las consultas globales del superadmin y para `firmware`/`user`.

## Capa de datos (lib/db.js, lib/crud.js)

- `findByType(type, { empresaId, ...extra })`: si viene `empresaId`, agrega `empresaId` al selector. Si no (consulta de superadmin global), no filtra.
- `crud(type, opts)`:
  - GET list → `findByType(type, { empresaId: req.empresaId })`.
  - GET/:id, PUT/:id, DELETE/:id → tras `get`, **verifican** que `doc.empresaId === req.empresaId` (salvo superadmin); si no, 404 (no 403, para no revelar existencia).
  - POST → inyecta `empresaId: req.empresaId` y namespacea el `_id` con el slug de la empresa.
- `nextSeq(empresaId, key)`: counter por empresa.

## Auth (lib/auth.js, server.js)

- **Roles:** `superadmin` (global), `admin` (de una empresa), `operario` (de una empresa). `requireRole` se mantiene; se agrega `requireSuperadmin`.
- **userDocId:** sigue siendo `user:<usuario>`. **El nombre de usuario es único en todo el sistema** (no por empresa), para que el login siga recibiendo solo usuario+clave y resuelva el doc sin saber la empresa. Implicación: dos empresas **no** pueden tener ambas un usuario llamado "admin"; el admin inicial de cada empresa se nombra de forma única (p. ej. `admin.<slug>` o un email). El doc `user` lleva `empresaId` y `rol`.
- **Login:** valida usuario/clave; además, si el usuario pertenece a una empresa **suspendida** (`empresa.activo === false`), rechaza el login. La sesión guarda `empresaId`.
- **`/api/me`** devuelve también `empresaId` y, para superadmin, la `empresaActiva` y la lista de empresas (o se expone aparte).
- **Gestión de usuarios:** crear/editar usuario queda restringido al `admin` de la propia empresa (scopeado) y al superadmin. Un admin solo administra usuarios de su empresa.

## Gestión de empresas (rutas nuevas + UI)

- `routes/empresas.js` (solo superadmin): CRUD de `empresa` + al crear, generar su primer usuario `admin`.
  - `GET /api/empresas` (lista, superadmin).
  - `POST /api/empresas` → crea empresa + usuario admin inicial (`{ empresa..., adminUsuario, adminPassword }`).
  - `PUT /api/empresas/:id` → editar datos / suspender (`activo`).
- `POST /api/empresa-activa` (superadmin): setea `session.empresaActiva` para trabajar como una empresa.
- `GET /api/empresa` (existente): pasa a devolver los datos de **la empresa del contexto** (`req.empresaId`), no `cfg.empresa`.

## Máquinas, gateway y procesos

- **Pairing:** el código de 6 dígitos lo genera el `admin` de una empresa (ya existe `POST /api/maquinas/pairing-code`, ahora scopeado a `req.empresaId`). El doc del código y la `maquina` resultante llevan `empresaId`. La máquina queda atada a esa empresa.
- **Token de máquina:** identifica a la máquina; de la máquina se deriva su `empresaId`.
- **Gateway WebSocket (lib/cloudGateway.js):** al recibir `hello`/`telemetria`, además de actualizar la máquina, escribe la muestra de proceso (`procterm`) con la `empresaId` de la máquina (vía `lib/procesos.js`, que recibe `empresaId`). Así cada empresa ve solo sus máquinas y curvas.
- **Listados de máquinas/procesos:** scopeados por `req.empresaId`.

## Firmware (global)

- `firmware` **no** lleva `empresaId`. Las rutas de subir/listar/borrar binarios se restringen a `requireSuperadmin`.
- La nav "Firmware" pasa de `data-admin` a `data-superadmin`.
- El servido estático `/firmware` (descarga OTA del dispositivo) sigue público e igual.

## Trazabilidad pública y branding

- El **código de lote** se namespacea por empresa (`lote:<slug>:<codigo>`), quedando único globalmente.
- `/t/:codigo` (público): busca el lote; de su `empresaId` carga el doc `empresa` y usa **su** razón social/CUIT en `publicTrace(...)`, con `cfg.empresa` como fallback.
- **Etiquetas/rótulos (routes/etiquetas.js):** los datos de marca (razón social, CUIT, domicilio) salen del doc `empresa` del contexto, no de `cfg.empresa`.

## Frontend (public/js/app.js, index.html)

- **Contexto de empresa:** `app.js` guarda `empresaActual` (del `/api/me`). El contexto del superadmin vive en la sesión del server (no se manda por header).
- **Superadmin:** selector de empresa en la barra superior (carga `/api/empresas`); al elegir, hace `POST /api/empresa-activa` (setea `session.empresaActiva`) y recarga la vista. Nueva vista **Empresas** (`data-superadmin`) para crear/editar/suspender.
- **Usuario normal:** sin selector; ve fija su empresa. Las vistas de negocio no cambian de aspecto, solo muestran datos filtrados.
- Nav: ítems `data-superadmin` (Empresas, Firmware) visibles solo para superadmin; `data-admin` se mantiene para admin de empresa.

## Arranque limpio

- **Script de wipe** (`npm run wipe` o similar): borra todos los docs de negocio (todo lo que tenga `empresaId`) + counters + `empresa`. Conserva (o recrea) el `superadmin`. Es destructivo y solo se corre a mano.
- **`lib/seed.js`:** deja de cargar la Fábrica 1950 de ejemplo (`ensureSampleData` se elimina o queda detrás de un flag). `ensureAdmin` pasa a `ensureSuperadmin` (crea el superadmin inicial con las credenciales bootstrap).
- Tras el wipe: el superadmin entra, crea la primera empresa real + su usuario admin, y desde esa empresa se genera el código y se re-vincula la máquina.

## Archivos afectados (mapa)

- `config.js` — `empresa` global pasa a fallback; (opcional) credenciales bootstrap del superadmin.
- `lib/db.js` — índices nuevos; `findByType` con `empresaId`; `nextSeq(empresaId, key)`.
- `lib/crud.js` — scoping por `req.empresaId` en list/get/put/delete; inyección de `empresaId` + namespacing de `_id` en POST.
- `lib/auth.js` — rol `superadmin`, `requireSuperadmin`, `empresaId` en sesión/login, login bloqueado si empresa suspendida.
- `lib/seed.js` — `ensureSuperadmin`; sin sample data.
- `lib/stock.js` — `movimiento`/`ajustarStock` propagan `empresaId`.
- `lib/maquinas.js` — pairing asocia `empresaId`; verifyToken expone la `empresaId` de la máquina.
- `lib/cloudGateway.js` — pasa `empresaId` de la máquina a `procesos`.
- `lib/procesos.js` — `registrarMuestra(empresaId, ...)`; docs `procterm` con `empresaId`.
- `routes/*.js` — todas las rutas hechas a mano usan `req.empresaId`; `firmware` → `requireSuperadmin`.
- `routes/empresas.js` — **nuevo**: CRUD de empresas + alta de admin inicial.
- `server.js` — middleware tenant tras `requireAuth`; montar `/api/empresas`; `publicTrace` usa el doc `empresa`; `/api/empresa` por contexto.
- `public/index.html` — nav `data-superadmin` (Empresas, Firmware).
- `public/js/app.js` — contexto de empresa, header `X-Empresa-Id`, selector de empresa (superadmin), vista Empresas.
- `scripts/wipe.js` (o `lib/`) — **nuevo**: limpieza de datos.

## Manejo de errores y casos borde

- **Acceso cruzado:** un usuario que pide un `_id` de otra empresa recibe **404** (no se revela existencia). Vale para GET/PUT/DELETE y para rutas a mano.
- **Superadmin sin empresa activa:** las vistas de negocio le muestran "Elegí una empresa"; las de gestión (Empresas, Firmware) funcionan sin empresa activa.
- **Empresa suspendida:** sus usuarios no pueden loguear; sus máquinas siguen reportando pero la UI no es accesible (decisión: no cortar telemetría para no perder datos; solo bloquear acceso humano).
- **Colisión de slug de empresa:** validar unicidad al crear; si choca, sufijo numérico.
- **Counters concurrentes por empresa:** se mantiene el retry de 409 ya existente, ahora por `counter:<slug>:<key>`.

## Testing / verificación (manual, no hay suite automatizada)

1. Crear dos empresas A y B con un admin cada una.
2. Cargar insumos/productos/recetas/ventas en A; loguear como B y verificar que **no** aparece nada de A en ningún listado ni por `_id` directo (404).
3. Verificar correlativos independientes (FV de A y de B ambos empiezan en 1).
4. Vincular una máquina desde A; confirmar que sus procesos/curvas solo se ven en A.
5. Como superadmin, alternar empresa activa y ver que el contexto cambia; subir un firmware y confirmar que es visible para máquinas de ambas.
6. Generar un rótulo y abrir `/t/<lote>`: debe mostrar la marca de la empresa dueña.

## Fuera de alcance (YAGNI)

- Facturación/planes/límites por empresa.
- Usuario perteneciente a varias empresas (se descartó: 1 usuario = 1 empresa).
- Migración de datos existentes (se arranca limpio).
- Una base CouchDB por empresa (se eligió campo `empresaId`).
- Personalización visual (logos/colores) más allá de los datos de marca en rótulos.
