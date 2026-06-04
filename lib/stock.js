'use strict';

const database = require('./db');

// Ajusta el stock de un artículo (insumo/producto) con reintento por conflicto.
async function ajustarStock(articuloId, delta) {
  for (let i = 0; i < 6; i++) {
    try {
      const doc = await database.get(articuloId);
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
async function movimiento({ articuloId, articuloTipo, cantidad, motivo, refType, refId, lote, costoUnit, usuario }) {
  const seq = await database.nextSeq('movimiento');
  const mov = {
    _id: `mov:${String(seq).padStart(8, '0')}`,
    type: 'movimiento',
    fecha: new Date().toISOString(),
    articuloId, articuloTipo,
    cantidad: Number(cantidad),
    motivo, refType, refId,
    lote: lote || null,
    costoUnit: costoUnit != null ? Number(costoUnit) : null,
    usuario: usuario || null
  };
  await database.insert(mov);
  const nuevoStock = await ajustarStock(articuloId, cantidad);
  return { mov, stock: nuevoStock };
}

module.exports = { ajustarStock, movimiento };
