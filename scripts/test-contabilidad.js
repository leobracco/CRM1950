'use strict';

// Test standalone de la lógica pura de contabilidad (no toca CouchDB).
// Correr: node scripts/test-contabilidad.js
const assert = require('assert');
const { validarAsiento, naturaleza, saldoSegunNaturaleza } = require('../lib/contabilidad');

const cuentas = {
  '1.1.01': { tipo: 'activo', imputable: true, activa: true },   // Caja
  '4.1.01': { tipo: 'ingreso', imputable: true, activa: true },  // Ventas
  '1': { tipo: 'activo', imputable: false, activa: true },       // título agrupador
  '5.1.05': { tipo: 'gasto', imputable: true, activa: false }    // Alquileres desactivada
};

let pass = 0, fail = 0;
function check(nombre, fn) {
  try { fn(); pass += 1; console.log('  ok  -', nombre); }
  catch (e) { fail += 1; console.log('  FAIL-', nombre, '::', e.message); }
}
function throws(fn, frag) {
  try { fn(); throw new Error('no lanzó error'); }
  catch (e) {
    assert.strictEqual(e.statusCode, 400, 'esperaba statusCode 400');
    if (frag) assert.ok(e.message.toLowerCase().includes(frag.toLowerCase()), `mensaje no contiene "${frag}": ${e.message}`);
  }
}

// 1) Asiento balanceado válido
check('asiento balanceado válido', () => {
  const r = validarAsiento({ renglones: [
    { cuentaCodigo: '1.1.01', debe: 100, haber: 0 },
    { cuentaCodigo: '4.1.01', debe: 0, haber: 100 }
  ] }, cuentas);
  assert.strictEqual(r.sumaDebe, 100);
  assert.strictEqual(r.sumaHaber, 100);
});

// 2) Asiento desbalanceado
check('asiento desbalanceado lanza 400', () => {
  throws(() => validarAsiento({ renglones: [
    { cuentaCodigo: '1.1.01', debe: 100, haber: 0 },
    { cuentaCodigo: '4.1.01', debe: 0, haber: 90 }
  ] }, cuentas), 'balancea');
});

// 3) Cuenta inexistente
check('cuenta inexistente lanza 400', () => {
  throws(() => validarAsiento({ renglones: [
    { cuentaCodigo: '9.9.99', debe: 100, haber: 0 },
    { cuentaCodigo: '4.1.01', debe: 0, haber: 100 }
  ] }, cuentas), 'no existe');
});

// 4) Renglón con debe y haber a la vez
check('renglón con debe y haber lanza 400', () => {
  throws(() => validarAsiento({ renglones: [
    { cuentaCodigo: '1.1.01', debe: 100, haber: 50 },
    { cuentaCodigo: '4.1.01', debe: 0, haber: 50 }
  ] }, cuentas), 'a la vez');
});

// 5) Cuenta no imputable (título)
check('cuenta no imputable lanza 400', () => {
  throws(() => validarAsiento({ renglones: [
    { cuentaCodigo: '1', debe: 100, haber: 0 },
    { cuentaCodigo: '4.1.01', debe: 0, haber: 100 }
  ] }, cuentas), 'imputable');
});

// 6) Cuenta desactivada
check('cuenta desactivada lanza 400', () => {
  throws(() => validarAsiento({ renglones: [
    { cuentaCodigo: '5.1.05', debe: 100, haber: 0 },
    { cuentaCodigo: '4.1.01', debe: 0, haber: 100 }
  ] }, cuentas), 'desactivada');
});

// 7) Naturaleza y saldo
check('naturaleza y saldo correctos', () => {
  assert.strictEqual(naturaleza('activo'), 'deudora');
  assert.strictEqual(naturaleza('ingreso'), 'acreedora');
  assert.strictEqual(saldoSegunNaturaleza('activo', 100, 30), 70);   // deudora
  assert.strictEqual(saldoSegunNaturaleza('ingreso', 30, 100), 70);  // acreedora
});

console.log(`\n${fail === 0 ? 'OK' : 'CON ERRORES'}: ${pass}/${pass + fail}`);
process.exit(fail === 0 ? 0 : 1);
