'use strict';

const express = require('express');
const QRCode = require('qrcode');
const database = require('../lib/db');
const cfg = require('../config');

const router = express.Router();

function baseUrl(req) {
  return `${req.protocol}://${req.get('host')}`;
}
async function qr(text) {
  return QRCode.toDataURL(text, { margin: 1, width: 240, errorCorrectionLevel: 'M' });
}

// Rótulo de producto para un lote (datos para impresión)
// GET /api/etiquetas/rotulo/:loteId
router.get('/rotulo/:loteId', async (req, res) => {
  try {
    const lote = await database.get(req.params.loteId);
    if (!req.esSuperadmin && lote.empresaId !== req.empresaId) return res.status(404).json({ error: 'No encontrado' });
    const producto = await database.get(lote.productoId);

    // Ingredientes: del producto, o derivados de la receta de la orden
    let ingredientes = producto.ingredientes || '';
    if (!ingredientes && lote.ordenId) {
      const orden = await database.tryGet(lote.ordenId);
      if (orden?.recetaId) {
        const receta = await database.tryGet(orden.recetaId);
        if (receta) ingredientes = (receta.items || []).map(i => i.descripcion || i.insumoId).join(', ');
      }
    }

    const empresa = req.empresaId ? (await database.tryGet(database.empresaDocId(req.empresaId))) || cfg.empresa : cfg.empresa;
    const url = `${baseUrl(req)}/t/${lote.codigo}`;
    res.json({
      empresa,
      producto: {
        nombre: producto.nombre, codigo: producto.codigo,
        pesoNeto: producto.pesoNeto || '', ean: producto.ean || '',
        conservacion: producto.conservacion || 'Conservar en lugar fresco y seco.',
        nutricional: producto.nutricional || null,
        sellos: producto.sellos || [],
        leyendas: producto.leyendas || []
      },
      ingredientes,
      lote: {
        codigo: lote.codigo,
        elaboracion: lote.fechaElaboracion,
        vencimiento: lote.fechaVencimiento
      },
      qr: await qr(url),
      url
    });
  } catch (e) { res.status(404).json({ error: 'No encontrado: ' + e.message }); }
});

// Números de serie identificatorios por unidad
// GET /api/etiquetas/serie/:loteId?desde=1&cantidad=12
router.get('/serie/:loteId', async (req, res) => {
  try {
    const lote = await database.get(req.params.loteId);
    if (!req.esSuperadmin && lote.empresaId !== req.empresaId) return res.status(404).json({ error: 'No encontrado' });
    const desde = Math.max(1, parseInt(req.query.desde || '1', 10));
    const cantidad = Math.min(500, parseInt(req.query.cantidad || lote.cantidad || 12, 10));
    const series = [];
    for (let i = 0; i < cantidad; i++) {
      const corr = String(desde + i).padStart(5, '0');
      const serie = `1950-${lote.codigo}-${corr}`;
      const url = `${baseUrl(req)}/t/${lote.codigo}?s=${corr}`;
      series.push({ serie, corr, qr: await qr(url) });
    }
    res.json({ lote: { codigo: lote.codigo, productoNombre: lote.productoNombre }, series });
  } catch (e) { res.status(404).json({ error: 'No encontrado: ' + e.message }); }
});

// Etiqueta de envío. POST /api/etiquetas/envio { ventaId? | destinatario,direccion,... }
router.post('/envio', async (req, res) => {
  try {
    let data = { ...req.body };
    if (req.body.ventaId) {
      const venta = await database.get(req.body.ventaId);
      if (!req.esSuperadmin && venta.empresaId !== req.empresaId) return res.status(404).json({ error: 'No encontrado' });
      const cli = venta.clienteId ? await database.tryGet(venta.clienteId) : null;
      data = {
        ventaId: venta._id, numero: venta.numero,
        destinatario: cli?.nombre || 'Cliente',
        direccion: cli?.direccion || '', localidad: cli?.localidad || '',
        cp: cli?.cp || '', telefono: cli?.telefono || '',
        bultos: req.body.bultos || 1, peso: req.body.peso || '',
        obs: req.body.obs || venta.obs || ''
      };
    }
    const empresa = req.empresaId ? (await database.tryGet(database.empresaDocId(req.empresaId))) || cfg.empresa : cfg.empresa;
    const tracking = data.ventaId || `ENV-${Date.now()}`;
    const url = `${baseUrl(req)}/t/envio/${encodeURIComponent(tracking)}`;
    res.json({
      remitente: empresa,
      envio: { ...data, tracking },
      qr: await qr(url)
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
