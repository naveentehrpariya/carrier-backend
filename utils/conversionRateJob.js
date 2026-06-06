const https = require('https');
const Tenant = require('../db/Tenant');
const ConversionRate = require('../db/ConversionRate');

const SUPPORTED_CURRENCIES = ['CAD', 'USD', 'INR'];

function monthWindow() {
  const now = new Date();
  return { month: now.getMonth() + 1, year: now.getFullYear() };
}

function monthEndDate(year, month) {
  const d = new Date(Number(year), Number(month), 0);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

async function fetchJsonFromUrl(url) {
  if (typeof fetch === 'function') {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(e);
          }
        });
      })
      .on('error', reject);
  });
}

async function fetchRate(sourceCurrency, targetCurrency, month, year) {
  if (sourceCurrency === targetCurrency) return 1;
  const date = monthEndDate(year, month);
  const url = `https://api.frankfurter.app/${date}?from=${sourceCurrency}&to=${targetCurrency}`;
  const payload = await fetchJsonFromUrl(url);
  const rate = Number(payload?.rates?.[targetCurrency] || 0);
  if (!Number.isFinite(rate) || rate <= 0) return null;
  return rate;
}

async function syncTenantRates(tenantId, month, year) {
  for (const targetCurrency of SUPPORTED_CURRENCIES) {
    for (const sourceCurrency of SUPPORTED_CURRENCIES) {
      if (sourceCurrency === targetCurrency) continue;
      try {
        const rate = await fetchRate(sourceCurrency, targetCurrency, month, year);
        if (!rate) continue;
        await ConversionRate.findOneAndUpdate(
          { tenantId, month, year, sourceCurrency, targetCurrency },
          { tenantId, month, year, sourceCurrency, targetCurrency, rate },
          { upsert: true, new: true }
        );
      } catch (e) {
        // Continue with other pairs/tenants even if one fetch fails
      }
    }
  }
}

async function runConversionRateSyncJob() {
  const { month, year } = monthWindow();
  const tenants = await Tenant.find({ status: { $in: ['active', 'trial'] } }).select('tenantId').lean();
  for (const tenant of tenants || []) {
    if (!tenant?.tenantId) continue;
    await syncTenantRates(String(tenant.tenantId), month, year);
  }
}

function startConversionRateJob() {
  runConversionRateSyncJob().catch(() => {});
  const TWELVE_HOURS = 12 * 60 * 60 * 1000;
  setInterval(() => {
    runConversionRateSyncJob().catch(() => {});
  }, TWELVE_HOURS);
}

module.exports = {
  startConversionRateJob,
  runConversionRateSyncJob,
};
