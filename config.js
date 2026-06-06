'use strict';

// Configuración central (sobreescribible por variables de entorno)
module.exports = {
  port: parseInt(process.env.PORT || '3000', 10),

  // URL pública del CRM (la usa el firmware para descargar binarios OTA).
  publicUrl: process.env.PUBLIC_URL || 'https://leonardobracco.com',

  // URL completa de CouchDB con credenciales de admin.
  // Ej: http://admin:password@127.0.0.1:5984
  couchUrl: process.env.COUCH_URL || 'http://admin:password@127.0.0.1:5984',

  // Nombre de la base (patrón single-DB con discriminador "type")
  dbName: process.env.DB_NAME || 'erp1950',

  sessionSecret: process.env.SESSION_SECRET || 'cambiar-este-secreto-en-produccion-1950',

  // Análisis IA de curvas de temperatura (Google Gemini, free tier).
  // Key gratuita en https://aistudio.google.com/apikey
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  geminiModel: process.env.GEMINI_MODEL || 'gemini-2.0-flash',

  // Usuario admin que se crea automáticamente si la base está vacía
  bootstrapAdmin: {
    usuario: process.env.ADMIN_USER || 'admin',
    password: process.env.ADMIN_PASS || 'admin1950',
    nombre: 'Administrador',
    rol: 'admin'
  },

  // Datos de la empresa para rótulos/etiquetas (CAA / Ley 27.642)
  empresa: {
    razonSocial: 'Fábrica de Alfajores 1950 S.R.L.',
    marca: '1950',
    rne: 'RNE 00-000000',
    cuit: '30-00000000-0',
    direccion: 'San Antonio de Areco, Buenos Aires, Argentina',
    contacto: 'ventas@alfajores1950.com'
  }
};
