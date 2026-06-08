'use strict';

const database = require('./db');

// Plan de cuentas estándar para una PyME argentina (fábrica de alfajores).
// imputable=false son títulos agrupadores (no se pueden usar en asientos).
const PLAN_DEFAULT = [
  { codigo: '1', nombre: 'ACTIVO', tipo: 'activo', imputable: false },
  { codigo: '1.1', nombre: 'Activo corriente', tipo: 'activo', imputable: false },
  { codigo: '1.1.01', nombre: 'Caja', tipo: 'activo', imputable: true },
  { codigo: '1.1.02', nombre: 'Banco cuenta corriente', tipo: 'activo', imputable: true },
  { codigo: '1.1.03', nombre: 'Deudores por ventas', tipo: 'activo', imputable: true },
  { codigo: '1.1.04', nombre: 'IVA crédito fiscal', tipo: 'activo', imputable: true },
  { codigo: '1.1.05', nombre: 'Mercaderías (bienes de cambio)', tipo: 'activo', imputable: true },
  { codigo: '1.2', nombre: 'Activo no corriente', tipo: 'activo', imputable: false },
  { codigo: '1.2.01', nombre: 'Bienes de uso (máquinas/equipos)', tipo: 'activo', imputable: true },
  { codigo: '2', nombre: 'PASIVO', tipo: 'pasivo', imputable: false },
  { codigo: '2.1', nombre: 'Pasivo corriente', tipo: 'pasivo', imputable: false },
  { codigo: '2.1.01', nombre: 'Proveedores', tipo: 'pasivo', imputable: true },
  { codigo: '2.1.02', nombre: 'IVA débito fiscal', tipo: 'pasivo', imputable: true },
  { codigo: '2.1.03', nombre: 'Sueldos a pagar', tipo: 'pasivo', imputable: true },
  { codigo: '2.1.04', nombre: 'Cargas sociales a pagar', tipo: 'pasivo', imputable: true },
  { codigo: '2.1.05', nombre: 'Impuestos a pagar', tipo: 'pasivo', imputable: true },
  { codigo: '3', nombre: 'PATRIMONIO NETO', tipo: 'patrimonio', imputable: false },
  { codigo: '3.1.01', nombre: 'Capital', tipo: 'patrimonio', imputable: true },
  { codigo: '3.1.02', nombre: 'Resultados acumulados', tipo: 'patrimonio', imputable: true },
  { codigo: '4', nombre: 'INGRESOS', tipo: 'ingreso', imputable: false },
  { codigo: '4.1.01', nombre: 'Ventas', tipo: 'ingreso', imputable: true },
  { codigo: '4.1.02', nombre: 'Otros ingresos', tipo: 'ingreso', imputable: true },
  { codigo: '5', nombre: 'GASTOS', tipo: 'gasto', imputable: false },
  { codigo: '5.1.01', nombre: 'Costo de mercadería vendida', tipo: 'gasto', imputable: true },
  { codigo: '5.1.02', nombre: 'Compras de insumos', tipo: 'gasto', imputable: true },
  { codigo: '5.1.03', nombre: 'Sueldos y jornales', tipo: 'gasto', imputable: true },
  { codigo: '5.1.04', nombre: 'Cargas sociales', tipo: 'gasto', imputable: true },
  { codigo: '5.1.05', nombre: 'Alquileres', tipo: 'gasto', imputable: true },
  { codigo: '5.1.06', nombre: 'Servicios (luz/gas/agua/internet)', tipo: 'gasto', imputable: true },
  { codigo: '5.1.07', nombre: 'Fletes y distribución', tipo: 'gasto', imputable: true },
  { codigo: '5.1.08', nombre: 'Impuestos y tasas', tipo: 'gasto', imputable: true },
  { codigo: '5.1.09', nombre: 'Gastos bancarios', tipo: 'gasto', imputable: true },
  { codigo: '5.1.10', nombre: 'Otros gastos', tipo: 'gasto', imputable: true }
];

const TIPOS_VALIDOS = ['activo', 'pasivo', 'patrimonio', 'ingreso', 'gasto'];

const round2 = n => Number((Number(n) || 0).toFixed(2));

// Naturaleza del saldo: deudora (activo/gasto) o acreedora (pasivo/patrimonio/ingreso).
function naturaleza(tipo) {
  return (tipo === 'activo' || tipo === 'gasto') ? 'deudora' : 'acreedora';
}

// Saldo de una cuenta según su naturaleza (deudora: debe-haber; acreedora: haber-debe).
function saldoSegunNaturaleza(tipo, debe, haber) {
  return naturaleza(tipo) === 'deudora' ? round2(debe - haber) : round2(haber - debe);
}

// Valida un asiento de doble partida. Lanza Error con statusCode 400 si no cumple.
// cuentasPorCodigo: { [codigo]: { tipo, imputable, activa } }
function validarAsiento(doc, cuentasPorCodigo) {
  const err = msg => { const e = new Error(msg); e.statusCode = 400; return e; };
  const renglones = Array.isArray(doc.renglones) ? doc.renglones : [];
  if (renglones.length < 2) throw err('El asiento necesita al menos dos renglones');

  let sumaDebe = 0, sumaHaber = 0;
  for (const r of renglones) {
    const debe = Number(r.debe || 0);
    const haber = Number(r.haber || 0);
    if (!r.cuentaCodigo) throw err('Hay un renglón sin cuenta');
    if (debe < 0 || haber < 0) throw err('Los importes no pueden ser negativos');
    if (debe > 0 && haber > 0) throw err('Un renglón no puede tener debe y haber a la vez');
    if (debe === 0 && haber === 0) throw err('Cada renglón debe tener un importe en debe o en haber');
    const cuenta = cuentasPorCodigo[r.cuentaCodigo];
    if (!cuenta) throw err(`La cuenta ${r.cuentaCodigo} no existe`);
    if (cuenta.activa === false) throw err(`La cuenta ${r.cuentaCodigo} está desactivada`);
    if (!cuenta.imputable) throw err(`La cuenta ${r.cuentaCodigo} es un título agrupador, no es imputable`);
    sumaDebe += debe;
    sumaHaber += haber;
  }
  if (round2(sumaDebe) <= 0) throw err('El asiento no tiene importe');
  if (round2(sumaDebe) !== round2(sumaHaber)) {
    throw err(`El asiento no balancea: debe ${round2(sumaDebe)} ≠ haber ${round2(sumaHaber)}`);
  }
  return { sumaDebe: round2(sumaDebe), sumaHaber: round2(sumaHaber) };
}

// Crea las cuentas de PLAN_DEFAULT que falten para la empresa. Idempotente.
async function sembrarPlan(empresaId) {
  if (!empresaId) throw new Error('sembrarPlan requiere empresaId');
  let creadas = 0;
  for (const c of PLAN_DEFAULT) {
    const _id = `cuenta:${empresaId}:${c.codigo}`;
    if (await database.tryGet(_id)) continue;
    await database.insert({
      _id, type: 'cuenta', empresaId,
      codigo: c.codigo, nombre: c.nombre, tipo: c.tipo,
      imputable: c.imputable, activa: true,
      creado: new Date().toISOString(), actualizado: new Date().toISOString()
    });
    creadas += 1;
  }
  return creadas;
}

// Recorre los asientos de la empresa y calcula el saldo de una cuenta (con filtro de fechas opcional).
async function saldoCuenta(empresaId, codigo, { desde, hasta } = {}) {
  const asientos = await database.findByType('asiento', { limit: 20000, empresaId });
  let debe = 0, haber = 0;
  for (const a of asientos) {
    if (desde && (a.fecha || '') < desde) continue;
    if (hasta && (a.fecha || '') > hasta + '\uffff') continue;
    for (const r of (a.renglones || [])) {
      if (r.cuentaCodigo !== codigo) continue;
      debe += Number(r.debe || 0);
      haber += Number(r.haber || 0);
    }
  }
  return { debe: round2(debe), haber: round2(haber) };
}

module.exports = {
  PLAN_DEFAULT, TIPOS_VALIDOS, round2,
  naturaleza, saldoSegunNaturaleza,
  validarAsiento, sembrarPlan, saldoCuenta
};
