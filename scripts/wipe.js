'use strict';

// Borra TODOS los documentos de negocio (deja índices de diseño _design intactos).
// Uso: node scripts/wipe.js --si
// Requiere CouchDB accesible (config.js / COUCH_URL).

const database = require('../lib/db');

async function main() {
  if (!process.argv.includes('--si')) {
    console.log('Esto BORRA todos los datos. Reejecutá con: node scripts/wipe.js --si');
    process.exit(1);
  }
  const ok = await database.init();
  if (!ok) { console.error('No hay CouchDB.'); process.exit(1); }
  const db = database.raw();
  const all = await db.list({ include_docs: false });
  const dels = all.rows
    .filter(r => !r.id.startsWith('_design/'))
    .map(r => ({ _id: r.id, _rev: r.value.rev, _deleted: true }));
  if (!dels.length) { console.log('Base ya vacía.'); return; }
  await db.bulk({ docs: dels });
  console.log(`Borrados ${dels.length} documentos.`);
}

main().catch(e => { console.error(e); process.exit(1); });
