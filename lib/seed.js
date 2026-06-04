'use strict';

const database = require('./db');
const auth = require('./auth');
const cfg = require('../config');

async function ensureAdmin() {
  const id = auth.userDocId(cfg.bootstrapAdmin.usuario);
  if (await database.tryGet(id)) return;
  await auth.crearUsuario(cfg.bootstrapAdmin);
  console.log('[seed] Usuario admin creado.');
}

async function ensureSampleData() {
  const productos = await database.findByType('producto', { limit: 1 });
  if (productos.length) return; // ya hay datos

  const now = new Date().toISOString();
  const docs = [
    // Proveedor / Cliente
    { _id: 'proveedor:DLC', type: 'proveedor', codigo: 'DLC', nombre: 'Lácteos del Areco', cuit: '30-11111111-1', telefono: '02326-000000', localidad: 'San Antonio de Areco', creado: now },
    { _id: 'cliente:KIO', type: 'cliente', codigo: 'KIO', nombre: 'Kiosco La Esquina', cuit: '20-22222222-2', direccion: 'Av. Mitre 100', localidad: 'San Antonio de Areco', cp: '2760', telefono: '02326-111111', creado: now },

    // Insumos
    { _id: 'insumo:HAR', type: 'insumo', codigo: 'HAR', nombre: 'Harina de maíz (maicena)', unidad: 'kg', stock: 50, stockMin: 10, costoUnit: 1200, proveedorId: null, creado: now },
    { _id: 'insumo:DDL', type: 'insumo', codigo: 'DDL', nombre: 'Dulce de leche repostero', unidad: 'kg', stock: 30, stockMin: 8, costoUnit: 3500, proveedorId: 'proveedor:DLC', creado: now },
    { _id: 'insumo:COB', type: 'insumo', codigo: 'COB', nombre: 'Baño de repostería chocolate', unidad: 'kg', stock: 20, stockMin: 5, costoUnit: 4200, proveedorId: null, creado: now },
    { _id: 'insumo:MAN', type: 'insumo', codigo: 'MAN', nombre: 'Manteca', unidad: 'kg', stock: 15, stockMin: 4, costoUnit: 5200, proveedorId: 'proveedor:DLC', creado: now },
    { _id: 'insumo:AZU', type: 'insumo', codigo: 'AZU', nombre: 'Azúcar', unidad: 'kg', stock: 40, stockMin: 10, costoUnit: 900, proveedorId: null, creado: now },
    { _id: 'insumo:COCO', type: 'insumo', codigo: 'COCO', nombre: 'Coco rallado', unidad: 'kg', stock: 8, stockMin: 3, costoUnit: 3800, proveedorId: null, creado: now },

    // Productos
    {
      _id: 'producto:ALF-MAIC', type: 'producto', codigo: 'ALF-MAIC',
      nombre: 'Alfajor de Maicena', categoria: 'Alfajor', stock: 0,
      precio: 950, costoUnit: 0, vidaUtilDias: 60, pesoNeto: '50 g',
      ean: '7790000000017', conservacion: 'Conservar en lugar fresco y seco.',
      ingredientes: 'Harina de maíz, dulce de leche, manteca, azúcar, coco rallado, huevo, esencia de vainilla.',
      nutricional: { porcion: '1 unidad (50 g)', porciones: '1', kcal: 210, carbohidratos: 28, azucares: 18, proteinas: 2.5, grasas: 9, grasasSat: 5, sodio: 95, fibra: 0.5 },
      sellos: ['azucares', 'grasas-saturadas'], leyendas: [], creado: now
    },
    {
      _id: 'producto:ALF-CHOC', type: 'producto', codigo: 'ALF-CHOC',
      nombre: 'Alfajor de Chocolate', categoria: 'Alfajor', stock: 0,
      precio: 1100, costoUnit: 0, vidaUtilDias: 90, pesoNeto: '55 g',
      ean: '7790000000024', conservacion: 'Conservar en lugar fresco y seco, lejos de la luz.',
      ingredientes: 'Harina de maíz, dulce de leche, baño de repostería de chocolate, manteca, azúcar, cacao, huevo.',
      nutricional: { porcion: '1 unidad (55 g)', porciones: '1', kcal: 245, carbohidratos: 31, azucares: 22, proteinas: 3, grasas: 12, grasasSat: 7, sodio: 110, fibra: 1 },
      sellos: ['azucares', 'grasas-saturadas', 'calorias'], leyendas: [], creado: now
    },

    // Receta (rinde 100 unidades)
    {
      _id: 'receta:ALF-MAIC', type: 'receta', codigo: 'R-MAIC',
      nombre: 'Receta Alfajor de Maicena', productoId: 'producto:ALF-MAIC', rinde: 100,
      items: [
        { insumoId: 'insumo:HAR', descripcion: 'Harina de maíz (maicena)', cantidad: 3.5 },
        { insumoId: 'insumo:DDL', descripcion: 'Dulce de leche repostero', cantidad: 2.5 },
        { insumoId: 'insumo:MAN', descripcion: 'Manteca', cantidad: 1.2 },
        { insumoId: 'insumo:AZU', descripcion: 'Azúcar', cantidad: 1.0 },
        { insumoId: 'insumo:COCO', descripcion: 'Coco rallado', cantidad: 0.4 }
      ],
      creado: now
    }
  ];

  for (const d of docs) await database.insert(d);
  console.log('[seed] Datos de ejemplo cargados.');
}

module.exports = { ensureAdmin, ensureSampleData };

// Permite ejecutar `npm run seed`
if (require.main === module) {
  (async () => {
    await database.init();
    await ensureAdmin();
    await ensureSampleData();
    process.exit(0);
  })();
}
