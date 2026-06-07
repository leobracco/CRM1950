'use strict';

const database = require('./db');
const auth = require('./auth');
const cfg = require('../config');

async function ensureSuperadmin() {
  const id = auth.userDocId(cfg.bootstrapAdmin.usuario);
  if (await database.tryGet(id)) return;
  await auth.crearUsuario({ ...cfg.bootstrapAdmin, empresaId: null });
  console.log('[seed] Usuario superadmin creado.');
}

module.exports = { ensureSuperadmin };

// Permite ejecutar `npm run seed`
if (require.main === module) {
  (async () => {
    await database.init();
    await ensureSuperadmin();
    process.exit(0);
  })();
}
