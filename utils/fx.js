// Shared currency + month-range helpers used by owner-operator and driver salary flows.
const ConversionRate = require('../db/ConversionRate');

const SUPPORTED_CURRENCIES = new Set(['CAD', 'USD', 'INR']);

function normalizeCurrency(value, fallback = 'USD') {
  const code = String(value || fallback).trim().toUpperCase();
  const normalizedFallback = String(fallback || 'USD').toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) return normalizedFallback;
  if (!SUPPORTED_CURRENCIES.has(code)) return normalizedFallback;
  return code;
}

function buildDateRange(month, year) {
  const m = Number(month);
  const y = Number(year);
  if (!m || !y || m < 1 || m > 12 || y < 2000 || y > 9999) return null;
  const from = new Date(y, m - 1, 1, 0, 0, 0, 0);
  const to = new Date(y, m, 0, 23, 59, 59, 999);
  return { from, to, month: m, year: y };
}

// Map of sourceCurrency -> rate for converting INTO targetCurrency for the given month/year.
async function getFxRatesMap(tenantId, month, year, targetCurrency) {
  const target = normalizeCurrency(targetCurrency, 'USD');
  const rows = await ConversionRate.find({
    tenantId,
    month: Number(month),
    year: Number(year),
    targetCurrency: target,
  })
    .select('sourceCurrency targetCurrency rate')
    .lean();
  const map = new Map([[target, 1]]);
  (rows || []).forEach((row) => {
    const source = normalizeCurrency(row?.sourceCurrency, target);
    const rate = Number(row?.rate || 0);
    if (rate > 0) map.set(source, rate);
  });
  return map;
}

// Convert amount from source -> target using a prebuilt fx map. Returns { value, rate }.
function convertAmount(amount, sourceCurrency, targetCurrency, fxMap) {
  const source = normalizeCurrency(sourceCurrency, targetCurrency);
  const target = normalizeCurrency(targetCurrency, 'USD');
  const numeric = Number(amount || 0);
  if (source === target) return { value: numeric, rate: 1 };
  const directRate = Number(fxMap?.get(source) || 0);
  if (directRate > 0) return { value: numeric * directRate, rate: directRate };
  return { value: numeric, rate: 1 };
}

module.exports = {
  SUPPORTED_CURRENCIES,
  normalizeCurrency,
  buildDateRange,
  getFxRatesMap,
  convertAmount,
};
