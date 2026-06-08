'use strict';

const database = require('./db');

// Ajusta el stock de un artículo (insumo/producto) con reintento por conflicto.
// Si se pasa expectedEmpresaId, valida que el artículo pertenezca a esa empresa
// (defensa en profundidad contra escrituras cross-tenant si una ruta olvida validar).
async function ajustarStock(articuloId, delta, expectedEmpresaId = null) {
  for (let i = 0; i < 6; i++) {
    try {
      const doc = await database.get(articuloId);
      if (expectedEmpresaId && doc.empresaId !== expectedEmpresaId) {
        const e = new Error('Artículo de otra empresa'); e.statusCode = 400; throw e;
      }
      doc.stock = Number((Number(doc.stock || 0) + Number(delta)).toFixed(4));
      doc.actualizado = new Date().toISOString();
      await database.raw().insert(doc);
      return doc.stock;
    } catch (e) {
      if (e.statusCode === 409) continue;
      throw e;
    }
  }
  throw new Error('No se pudo ajustar stock de ' + articuloId);
}

// Registra un movimiento de kardex y aplica el ajuste de stock.
async function movimiento({ empresaId, articuloId, articuloTipo, cantidad, motivo, refType, refId, lote, costoUnit, usuario }) {
  const seq = await database.nextSeq(empresaId, 'movimiento');
  const mov = {
    _id: empresaId ? `mov:${empresaId}:${String(seq).padStart(8, '0')}` : `mov:${String(seq).padStart(8, '0')}`,
    type: 'movimiento',
    empresaId: empresaId || null,
    fecha: new Date().toISOString(),
    articuloId, articuloTipo,
    cantidad: Number(cantidad),
    motivo, refType, refId,
    lote: lote || null,
    costoUnit: costoUnit != null ? Number(costoUnit) : null,
    usuario: usuario || null
  };
  await database.insert(mov);
  const nuevoStock = await ajustarStock(articuloId, cantidad, empresaId || null);
  return { mov, stock: nuevoStock };
}

module.exports = { ajustarStock, movimiento };
