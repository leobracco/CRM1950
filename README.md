# 1950 · ERP — Fábrica de Alfajores

Plataforma ERP/CRM con login para gestionar una fábrica de alfajores: stock de insumos, ventas, compras, clientes, proveedores, fabricación con consumo de receta, lotes con trazabilidad, rótulos según CAA / Ley 27.642, números de serie por unidad y etiquetas de envío.

**Stack:** Node.js + Express · CouchDB (patrón single-DB + índices Mango) · HTML/CSS/JS vanilla (SPA, sin frameworks).

---

## Módulos

| Módulo | Qué hace |
|---|---|
| **Tablero** | KPIs: ventas/compras del mes, valor de stock, alertas de stock bajo, lotes por vencer, gráfico de ventas. |
| **Ventas** | Pedidos con ítems, descuenta stock, valida disponibilidad, asigna lote por **FEFO** (vencimiento más próximo). |
| **Compras** | Órdenes de compra que **ingresan stock** de insumos y actualizan el último costo. |
| **Clientes / Proveedores** | Altas, edición, búsqueda. |
| **Fabricación** | Orden de producción: consume insumos según receta (escala por rinde), **genera lote** con vencimiento, produce stock y calcula costo/unidad. |
| **Recetas** | Formulación insumo→cantidad, rinde, costo de lote y costo unitario calculados en vivo. |
| **Productos** | Catálogo: precio, costo, margen, vida útil, EAN, info nutricional y sellos frontales. |
| **Insumos / Stock** | Materias primas, stock mínimo con alerta, **kardex** (movimientos) por artículo. |
| **Lotes / Trazabilidad** | Reporte de **recall**: origen (insumos consumidos) → destino (ventas y clientes del lote). |
| **Etiquetas y Rótulos** | Rótulo imprimible (ingredientes, lote, vto., tabla nutricional, **sellos octogonales Ley 27.642**, QR de trazabilidad), **números de serie** por unidad con QR, y **etiqueta de envío** desde una venta. |

Cada rótulo y unidad lleva un **QR** que apunta a una página pública de trazabilidad (`/t/<lote>`), accesible sin login para el consumidor.

---

## Requisitos

- **Node.js 18+**
- **CouchDB 3.x** corriendo (local o remoto). Descarga: https://couchdb.apache.org/

Al instalar CouchDB se define un usuario administrador. Anotá usuario y contraseña.

---

## Instalación

```bash
npm install
```

Configurá la conexión por variables de entorno (o editá `config.js`):

```bash
# Linux/Mac
export COUCH_URL="http://admin:TU_CLAVE@127.0.0.1:5984"
export SESSION_SECRET="un-secreto-largo-y-aleatorio"

# Windows (PowerShell)
$env:COUCH_URL="http://admin:TU_CLAVE@127.0.0.1:5984"
```

Arrancá:

```bash
npm start
# o, con recarga automática:
npm run dev
```

Abrí **http://localhost:3000**

**Login inicial:** `admin` / `admin1950` — cambialo (variable `ADMIN_PASS` o desde el código) en cuanto entres.

> En el primer arranque, si la base está vacía, se crea el usuario admin y se cargan datos de ejemplo (insumos, 2 productos y una receta) para que puedas probar fabricación y etiquetas enseguida.

---

## Variables de entorno

| Variable | Default | Descripción |
|---|---|---|
| `PORT` | `3000` | Puerto HTTP. |
| `COUCH_URL` | `http://admin:password@127.0.0.1:5984` | URL completa de CouchDB con credenciales. |
| `DB_NAME` | `erp1950` | Nombre de la base. |
| `SESSION_SECRET` | (placeholder) | Secreto de sesión. **Cambiar en producción.** |
| `ADMIN_USER` / `ADMIN_PASS` | `admin` / `admin1950` | Admin que se crea en el primer arranque. |

---

## Estructura

```
erp1950/
├── server.js              # Express, sesiones, montaje de rutas, SPA, /t público
├── config.js              # Configuración (env)
├── lib/
│   ├── db.js              # Conexión CouchDB, índices Mango, helpers, correlativos
│   ├── auth.js            # Login, sesiones, bcrypt, roles
│   ├── crud.js            # Fábrica genérica de CRUD por "type"
│   ├── stock.js           # Kardex + ajuste de existencias
│   └── seed.js            # Usuario admin + datos de ejemplo
├── routes/
│   ├── compras.js  ventas.js  fabricacion.js
│   ├── lotes.js    etiquetas.js  movimientos.js  dashboard.js
└── public/
    ├── index.html        # SPA (login + layout)
    ├── css/styles.css
    └── js/app.js
```

## Modelo de datos (CouchDB)

Una sola base con discriminador `type`: `user`, `cliente`, `proveedor`, `insumo`, `producto`, `receta`, `compra`, `venta`, `orden`, `lote`, `movimiento`, `counter`. Las consultas usan **índices Mango** (`_find`). Los correlativos (OF/OC/FV/lote) se generan con documentos `counter:*` con reintento ante conflictos.

## API (resumen)

```
POST   /api/login            GET /api/me            POST /api/logout
GET/POST/PUT/DELETE  /api/{insumos|productos|recetas|clientes|proveedores}
GET/POST             /api/compras            GET/POST  /api/ventas
GET/POST             /api/fabricacion        GET       /api/movimientos?articuloId=
GET                  /api/lotes              GET       /api/lotes/:id/trazabilidad
GET  /api/etiquetas/rotulo/:loteId
GET  /api/etiquetas/serie/:loteId?cantidad=N
POST /api/etiquetas/envio    { ventaId }
GET  /api/dashboard
GET  /t/:codigoLote          (trazabilidad pública, sin auth)
```

---

## Notas de producción

- Las **sesiones** usan el store en memoria de Express (se reinician al reiniciar el server). Para producción, usar un store persistente (p. ej. `connect-couchdb` o Redis).
- Serví detrás de **HTTPS** (proxy reverso) y poné `cookie.secure = true`.
- Programá **backups** de CouchDB (replicación o snapshots).
- Cambiá `SESSION_SECRET` y la clave del admin.

## Ideas para seguir

- Stock por lote (no solo agregado) y reserva FEFO real con descuento por lote.
- Facturación electrónica AFIP/ARCA (WSFE) y remitos.
- Códigos de barras EAN-13 reales en rótulos.
- Multi-depósito y conteo de inventario.
- Roles más finos (ventas, producción, depósito) ya soportados a nivel sesión.
