'use strict';

// Migración single-empresa -> multi-empresa.
// Estampa empresaId en los datos viejos (que no lo tienen), crea el doc de la
// empresa, migra los contadores correlativos a su namespace y promueve al
// usuario admin existente a superadmin.
//
// Uso:
//   node scripts/migrar-multiempresa.js                 (DRY-RUN: muestra qué haría)
//   node scripts/migrar-multiempresa.js --si            (APLICA los cambios)
//   node scripts/migrar-multiempresa.js --si --slug=mi-empresa --nombre="Mi Empresa"
//
// Es idempotente: correrlo dos veces no duplica ni rompe nada.

const database = require('../lib/db');
const cfg = require('../config');

const args = process.argv.slice(2);
const APPLY = args.includes('--si');
const getArg = (k, d) => {
  const a = args.find(x => x.startsWith(`--${k}=`));
  return a ? a.slice(k.length + 3) : d;
};

const SLUG = getArg('slug', 'fabrica-1950');
const NOMBRE = getArg('nombre', 'Fábrica de Alfajores 1950');
const ADMIN_USER = (process.env.ADMIN_USER || cfg.bootstrapAdmin.usuario || 'admin').toLowerCase();

// Tipos de negocio que deben quedar scopeados a la empresa.
const TIPOS_NEGOCIO = ['cliente', 'proveedor', 'insumo', 'producto', 'receta',
  'compra', 'venta', 'orden', 'lote', 'movimiento', 'maquina', 'procterm'];
// Claves de contador con correlativo por empresa.
const CLAVES_COUNTER = ['venta', 'compra', 'orden', 'movimiento'];

function log(...a) { console.log(...a); }

(async () => {
  const ok = await database.init();
  if (!ok) { console.error('No se pudo conectar a CouchDB. Abortando.'); process.exit(1); }
  const db = database.raw();

  log(`\n=== Migración multi-empresa ===`);
  log(`Empresa destino: ${SLUG}  (${NOMBRE})`);
  log(`Admin a promover: ${ADMIN_USER}`);
  log(APPLY ? '>> MODO APLICAR (--si)\n' : '>> DRY-RUN (sin --si: no se escribe nada)\n');

  let cambios = 0;

  // 1) Empresa raíz
  const empId = database.empresaDocId(SLUG);
  const empExistente = await database.tryGet(empId);
  if (empExistente) {
    log(`Empresa ${empId} ya existe; no se recrea.`);
  } else {
    const empresa = {
      _id: empId, type: 'empresa',
      nombre: NOMBRE, razonSocial: cfg.empresa.razonSocial || NOMBRE,
      cuit: cfg.empresa.cuit || '', domicilio: cfg.empresa.direccion || '',
      localidad: '', email: cfg.empresa.contacto || '', telefono: '',
      activo: true, creado: new Date().toISOString(), actualizado: new Date().toISOString()
    };
    log(`+ Crear empresa ${empId}`);
    if (APPLY) await db.insert(empresa);
    cambios++;
  }

  // 2) Estampar empresaId en datos de negocio sin empresa
  for (const tipo of TIPOS_NEGOCIO) {
    const docs = await database.find({ selector: { type: tipo }, limit: 100000 });
    let n = 0;
    for (const d of docs) {
      if (d.empresaId === SLUG) continue;          // ya migrado
      if (d.empresaId && d.empresaId !== SLUG) {
        log(`  ! ${d._id} tiene empresaId="${d.empresaId}" (distinto); se omite`);
        continue;
      }
      d.empresaId = SLUG;
      if (APPLY) await db.insert(d);
      n++; cambios++;
    }
    if (n) log(`~ ${tipo}: ${n} doc(s) estampados con empresaId=${SLUG}`);
  }

  // 3) Migrar contadores correlativos a counter:<slug>:<key>
  for (const key of CLAVES_COUNTER) {
    const viejoId = `counter:${key}`;
    const nuevoId = `counter:${SLUG}:${key}`;
    const viejo = await database.tryGet(viejoId);
    if (!viejo) continue;
    const yaNuevo = await database.tryGet(nuevoId);
    const valor = Math.max(viejo.value || 0, yaNuevo ? (yaNuevo.value || 0) : 0);
    log(`~ counter ${viejoId}(${viejo.value}) -> ${nuevoId}(${valor})`);
    if (APPLY) {
      await db.insert({ _id: nuevoId, type: 'counter', value: valor, empresaId: SLUG, _rev: yaNuevo ? yaNuevo._rev : undefined });
      await db.destroy(viejo._id, viejo._rev);
    }
    cambios++;
  }

  // 4) Promover admin a superadmin
  const adminId = `user:${ADMIN_USER}`;
  const admin = await database.tryGet(adminId);
  if (!admin) {
    log(`  ! No existe ${adminId}; no se promueve ningún usuario.`);
  } else if (admin.rol === 'superadmin' && (admin.empresaId == null)) {
    log(`Usuario ${adminId} ya es superadmin; sin cambios.`);
  } else {
    log(`~ ${adminId}: rol "${admin.rol}" -> "superadmin", empresaId -> null`);
    admin.rol = 'superadmin';
    admin.empresaId = null;
    admin.actualizado = new Date().toISOString();
    if (APPLY) await db.insert(admin);
    cambios++;
  }

  log(`\n${APPLY ? 'Aplicados' : 'Pendientes (dry-run)'}: ${cambios} cambio(s).`);
  if (!APPLY && cambios) log('Volvé a correr con --si para aplicar.');
  process.exit(0);
})().catch(e => { console.error('Error en migración:', e); process.exit(1); });
