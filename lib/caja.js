'use strict';

// Caja integrada a la contabilidad: los cobros de ventas y los pagos a
// proveedores generan asientos automáticos de doble partida. El saldo de la
// cuenta Caja sale del mayor; acá solo se emiten los asientos y se actualiza
// el acumulado cobrado/pagado en cada venta/compra.
const database = require('./db');
const contabilidad = require('./contabilidad');

// Códigos del plan de cuentas estándar (lib/contabilidad.js PLAN_DEFAULT).
const CTA = {
  CAJA: '1.1.01',
  DEUDORES: '1.1.03',
  VENTAS: '4.1.01',
  PROVEEDORES: '2.1.01',
  COMPRAS: '5.1.02'
};

const m2 = n => contabilidad.round2(n);
const err400 = msg => { const e = new Error(msg); e.statusCode = 400; return e; };

async function cuentasMap(empresaId) {
  const cuentas = await database.findByType('cuenta', { limit: 5000, empresaId });
  const map = {};
  for (const c of cuentas) map[c.codigo] = c;
  return map;
}

function exigirCuentas(mapa, codigos) {
  const faltan = codigos.filter(c => !mapa[c]);
  if (faltan.length) throw err400(`Faltan cuentas en el plan (${faltan.join(', ')}). Sembrá el plan de cuentas estándar.`);
}

// Crea y persiste un asiento balanceado. renglones: [{cuentaCodigo, debe?, haber?, detalle?}].
async function crearAsiento(empresaId, { fecha, glosa, renglones, origen, ref, usuario }, mapa) {
  const prep = renglones.map(r => ({
    cuentaCodigo: r.cuentaCodigo,
    cuentaNombre: mapa[r.cuentaCodigo] ? mapa[r.cuentaCodigo].nombre : '',
    debe: m2(r.debe || 0),
    haber: m2(r.haber || 0),
    detalle: String(r.detalle || '').slice(0, 200)
  }));
  contabilidad.validarAsiento({ renglones: prep }, mapa);

  const seq = await database.nextSeq(empresaId, 'asiento');
  const numero = `AS-${String(seq).padStart(6, '0')}`;
  return database.insert({
    _id: `asiento:${empresaId}:${String(seq).padStart(6, '0')}`,
    type: 'asiento', empresaId, numero,
    fecha: String(fecha || new Date().toISOString()).slice(0, 10),
    glosa: String(glosa || '').slice(0, 300),
    renglones: prep, origen: origen || 'auto', ref: ref || null,
    usuario,
    creado: new Date().toISOString(), actualizado: new Date().toISOString()
  });
}

// Registra un cobro de venta. Genera (una sola vez) el devengamiento
// Deudores/Ventas y luego el cobro Caja/Deudores. Devuelve la venta actualizada.
async function registrarCobro(empresaId, venta, { monto, fecha, usuario }) {
  monto = m2(monto);
  const total = m2(venta.total);
  const cobrado = m2(venta.cobrado || 0);
  const pendiente = m2(total - cobrado);
  if (monto <= 0) throw err400('El monto debe ser mayor a cero');
  if (monto > pendiente) throw err400(`El cobro supera el pendiente (${pendiente})`);

  const mapa = await cuentasMap(empresaId);
  exigirCuentas(mapa, [CTA.CAJA, CTA.DEUDORES, CTA.VENTAS]);

  if (!venta.asientoVentaId) {
    const dev = await crearAsiento(empresaId, {
      fecha: venta.fecha || fecha,
      glosa: `Venta ${venta.numero}`,
      renglones: [
        { cuentaCodigo: CTA.DEUDORES, debe: total, detalle: venta.numero },
        { cuentaCodigo: CTA.VENTAS, haber: total, detalle: venta.numero }
      ],
      origen: 'venta', ref: venta._id, usuario
    }, mapa);
    venta.asientoVentaId = dev._id;
  }

  const asiento = await crearAsiento(empresaId, {
    fecha,
    glosa: `Cobro ${venta.numero}`,
    renglones: [
      { cuentaCodigo: CTA.CAJA, debe: monto, detalle: venta.numero },
      { cuentaCodigo: CTA.DEUDORES, haber: monto, detalle: venta.numero }
    ],
    origen: 'cobro', ref: venta._id, usuario
  }, mapa);

  venta.cobrado = m2(cobrado + monto);
  venta.estadoCobro = venta.cobrado >= total ? 'cobrada' : 'parcial';
  venta.cobros = venta.cobros || [];
  venta.cobros.push({ fecha: String(fecha || new Date().toISOString()).slice(0, 10), monto, asientoId: asiento._id });
  venta.actualizado = new Date().toISOString();
  await database.raw().insert(venta);
  return venta;
}

// Registra un pago a proveedor. Genera (una sola vez) el devengamiento
// Compras/Proveedores y luego el pago Proveedores/Caja. Devuelve la compra.
async function registrarPago(empresaId, compra, { monto, fecha, usuario }) {
  monto = m2(monto);
  const total = m2(compra.total);
  const pagado = m2(compra.pagado || 0);
  const pendiente = m2(total - pagado);
  if (monto <= 0) throw err400('El monto debe ser mayor a cero');
  if (monto > pendiente) throw err400(`El pago supera el pendiente (${pendiente})`);

  const mapa = await cuentasMap(empresaId);
  exigirCuentas(mapa, [CTA.CAJA, CTA.PROVEEDORES, CTA.COMPRAS]);

  if (!compra.asientoCompraId) {
    const dev = await crearAsiento(empresaId, {
      fecha: compra.fecha || fecha,
      glosa: `Compra ${compra.numero}`,
      renglones: [
        { cuentaCodigo: CTA.COMPRAS, debe: total, detalle: compra.numero },
        { cuentaCodigo: CTA.PROVEEDORES, haber: total, detalle: compra.numero }
      ],
      origen: 'compra', ref: compra._id, usuario
    }, mapa);
    compra.asientoCompraId = dev._id;
  }

  const asiento = await crearAsiento(empresaId, {
    fecha,
    glosa: `Pago ${compra.numero}`,
    renglones: [
      { cuentaCodigo: CTA.PROVEEDORES, debe: monto, detalle: compra.numero },
      { cuentaCodigo: CTA.CAJA, haber: monto, detalle: compra.numero }
    ],
    origen: 'pago', ref: compra._id, usuario
  }, mapa);

  compra.pagado = m2(pagado + monto);
  compra.estadoPago = compra.pagado >= total ? 'pagada' : 'parcial';
  compra.pagos = compra.pagos || [];
  compra.pagos.push({ fecha: String(fecha || new Date().toISOString()).slice(0, 10), monto, asientoId: asiento._id });
  compra.actualizado = new Date().toISOString();
  await database.raw().insert(compra);
  return compra;
}

module.exports = { CTA, registrarCobro, registrarPago };
