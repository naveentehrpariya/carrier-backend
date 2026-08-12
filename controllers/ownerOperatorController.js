const mongoose = require('mongoose');
const https = require('https');
const puppeteer = require('puppeteer');
const { launchBrowser } = require('../utils/puppeteer');

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const catchAsync = require('../utils/catchAsync');
const JSONerror = require('../utils/jsonErrorHandler');
const logger = require('../utils/logger');
const OwnerOperator = require('../db/OwnerOperator');
const OwnerOperatorSalary = require('../db/OwnerOperatorSalary');
const OwnerOperatorFinancialRecord = require('../db/OwnerOperatorFinancialRecord');
const OwnerAdjustment = require('../db/OwnerAdjustment');
const ConversionRate = require('../db/ConversionRate');
const Order = require('../db/Order');
const Truck = require('../db/Truck');
const Trip = require('../db/Trip');
const DriverProfile = require('../db/DriverProfile');
const Users = require('../db/Users');
const { logActivity, logChange } = require('../utils/activityLogger');
const { MI_PER_KM, kmToMiles, normalizeTripMiles, deriveTripMiles, pickDriverRate, getDriverRateCurrency } = require('../utils/distance');
const { SUPPORTED_CURRENCIES, normalizeCurrency, buildDateRange, getFxRatesMap, convertAmount } = require('../utils/fx');
const { legKey, buildOrderLegs, ownerOrderMatch } = require('../utils/ownerSettlement');
const {
  round2,
  EPSILON,
  ADJUSTMENT_CATEGORIES,
  categoryLabel,
  isValidCategory,
  sumAdjustments,
  computeSalaryTotals,
  resolveBasePayable,
  applyLedgerToSalary,
} = require('../utils/ownerSalaryMath');

function getTenantId(req) {
  return req.tenantId || req.user?.tenantId || null;
}

function normalizeCompanyId(req) {
  const raw = req.user?.company?._id || req.user?.company;
  if (!raw) return null;
  const s = String(raw);
  if (!mongoose.Types.ObjectId.isValid(s)) return null;
  return new mongoose.Types.ObjectId(s);
}

function hasOwnerOperatorAccess(req) {
  return (
    req.user?.is_admin === 1 ||
    req.user?.permissions?.includes('accounting') ||
    req.user?.permissions?.includes('subadmin')
  );
}

function normalizeDeletedFilter() {
  return { $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }] };
}

// ---------------------------------------------------------------------------
// Adjustment ledger (OwnerAdjustment) — the source of truth for a payslip's
// manualAddition / manualDeduction. Those two columns are DERIVED and recomputed
// through applyLedgerToSalary on every write; nothing may assign them directly.
// ---------------------------------------------------------------------------

function loadLedger(tenantId, ownerOperatorId, month, year) {
  return OwnerAdjustment.find({
    tenantId,
    ownerOperator: ownerOperatorId,
    month: Number(month),
    year: Number(year),
    ...normalizeDeletedFilter(),
  })
    .sort({ date: 1, createdAt: 1 })
    .lean();
}

// Recompute a payslip from its ledger and persist. `fxMap` is optional — passed in when
// the caller already built one for the same month/currency, otherwise loaded here.
async function recomputeSalaryFromLedger(tenantId, salary, fxMap = null) {
  const currency = normalizeCurrency(salary?.currency, 'USD');
  // ensureMonthlyFxRates, not getFxRatesMap: a month with no stored rate would otherwise
  // convert a foreign-currency line at 1:1 and quietly understate the deduction.
  const map = fxMap || (await ensureMonthlyFxRates(tenantId, salary.month, salary.year, currency, SUPPORTED_CURRENCIES));
  const ledger = await loadLedger(tenantId, salary.ownerOperator, salary.month, salary.year);
  const { totals, adjustments } = applyLedgerToSalary(salary, ledger, map);
  if (typeof salary.save === 'function') await salary.save();
  return { totals, adjustments, ledger };
}

// The immediately previous month only — a skipped month must not resurrect an old balance
// (same carry-forward semantics as the driver payslip).
function previousMonthOf(month, year) {
  return {
    month: Number(month) === 1 ? 12 : Number(month) - 1,
    year: Number(month) === 1 ? Number(year) - 1 : Number(year),
  };
}

// Copy the previous month's `recurring` rows into this month. Insurance, escrow and a
// lease payment repeat every month; retyping them was the single most common reason a
// payslip went out wrong. Idempotent: a template is never cloned twice into one month.
async function syncRecurringAdjustments(tenantId, ownerOperatorId, month, year, userId) {
  const prev = previousMonthOf(month, year);
  const templates = await OwnerAdjustment.find({
    tenantId,
    ownerOperator: ownerOperatorId,
    month: prev.month,
    year: prev.year,
    recurring: true,
    ...normalizeDeletedFilter(),
  }).lean();
  if (!templates.length) return 0;

  const rootId = (t) => String(t.recurringSourceId || t._id);
  const existing = await OwnerAdjustment.find({
    tenantId,
    ownerOperator: ownerOperatorId,
    month: Number(month),
    year: Number(year),
    recurringSourceId: { $in: templates.map((t) => t.recurringSourceId || t._id) },
  })
    .select('recurringSourceId')
    .lean();
  const already = new Set(existing.map((r) => String(r.recurringSourceId)));

  const toCreate = templates
    .filter((t) => !already.has(rootId(t)))
    .map((t) => ({
      tenantId,
      company: t.company || null,
      ownerOperator: ownerOperatorId,
      salary: null,
      month: Number(month),
      year: Number(year),
      kind: t.kind,
      category: t.category,
      amount: t.amount,
      currency: t.currency,
      // Deliberately NOT copying amountInSalaryCurrency/fxRate — this month converts at
      // this month's rate, and a stale snapshot would silently reuse last month's FX.
      date: null,
      notes: t.notes,
      reference: t.reference,
      recurring: true,
      recurringSourceId: t.recurringSourceId || t._id,
      createdBy: userId || t.createdBy || null,
    }));
  if (!toCreate.length) return 0;
  await OwnerAdjustment.insertMany(toCreate);
  return toCreate.length;
}

// Mirror a ledger row into OwnerOperatorFinancialRecord so the owner's financial history
// (and the existing statement/summary screens) keep showing adjustments alongside
// settlements and payments. The ledger stays authoritative; this row is a projection.
async function mirrorAdjustmentRecord(req, tenantId, salary, adjustment, mode = 'create') {
  const payload = {
    tenantId,
    company: adjustment.company || null,
    ownerOperator: adjustment.ownerOperator,
    salary: salary?._id || null,
    type: 'ADJUSTMENT',
    amount: Number(adjustment.amountInSalaryCurrency || adjustment.amount || 0),
    currency: adjustment.salaryCurrency || adjustment.currency || 'USD',
    month: adjustment.month,
    year: adjustment.year,
    paymentStatus: salary?.paymentStatus === 'owed' ? 'pending' : (salary?.paymentStatus || 'pending'),
    date: adjustment.date || null,
    notes: adjustment.notes || '',
    meta: {
      adjustmentId: adjustment._id,
      expenseType: adjustment.kind,
      category: adjustment.category,
      categoryLabel: categoryLabel(adjustment.kind, adjustment.category),
      effect: adjustment.kind === 'addition' ? 'credit' : 'debit',
      inputAmount: Number(adjustment.amount || 0),
      inputCurrency: adjustment.currency || 'USD',
      conversionRate: Number(adjustment.fxRate || 1),
      reference: adjustment.reference || '',
    },
    createdBy: req.user?._id,
  };
  if (mode === 'create') {
    await OwnerOperatorFinancialRecord.create(payload);
    return;
  }
  await OwnerOperatorFinancialRecord.updateOne(
    { tenantId, 'meta.adjustmentId': adjustment._id, type: 'ADJUSTMENT' },
    { $set: payload },
    { upsert: true }
  );
}

async function generateOwnerOperatorId(tenantId) {
  let attempts = 0;
  while (attempts < 6) {
    attempts += 1;
    const candidate = `OO${String(Date.now()).slice(-6)}${Math.floor(100 + Math.random() * 900)}`;
    const exists = await OwnerOperator.findOne({ tenantId, ownerOperatorId: candidate }).lean();
    if (!exists) return candidate;
  }
  throw new Error('Failed to generate unique owner operator id');
}


// Resolve an owner-operated order's amounts for a payslip/statement.
// Order price/settle/profit come from the exact typed values (input_*) in the order's
// input_currency, so payslips match the order list/detail screens. The driver deduction
// has no input snapshot, so it stays in base USD (revenue_currency). Payable is recomputed
// in the target currency because settle and deduction may convert from different sources.
// The average per-mile rate to PRINT: the driver's own contracted rate, in the currency they are
// paid in — not the USD-normalized figure, which is a derived number nobody agreed to. Falls back
// to the USD weighting for legacy aggregates that carry no native breakdown.
function resolveDriverAvgRate(ded, fallbackCurrency) {
  const miles = Number(ded?.miles || 0);
  const native = ded?.deductionByCurrency instanceof Map ? ded.deductionByCurrency : null;
  if (miles > 0 && native && native.size === 1) {
    const [cur, amt] = Array.from(native.entries())[0];
    return { rate: Number(amt) / miles, currency: cur };
  }
  return {
    rate: miles > 0 ? Number((ded?.weightedRateMiles || 0) / miles) : 0,
    currency: fallbackCurrency,
  };
}

function resolveOwnerOrderAmounts(o, ded, targetCurrency, fxRatesMap) {
  const priceSourceCurrency = normalizeCurrency(o?.input_currency || o?.revenue_currency, targetCurrency);
  const deductionSourceCurrency = normalizeCurrency(o?.revenue_currency, targetCurrency);
  const hasInput = Number(o?.input_total_amount) > 0;
  const hasInputSettle = Number(o?.input_settle_amount) > 0;
  const originalDeduction = Number(ded?.deduction || 0);
  // Mixed-owner order: this owner only earns their legs. `settleOriginal` is their share of the
  // order's settle pot (miles-share or the admin's per-trip override) and `priceRatio` their share
  // of the order revenue. A non-mixed order carries neither, and reads the order's own columns.
  // `settleOriginal` is null on a legacy (non-mixed) leg — and Number(null) is 0, not NaN, so it must
  // be excluded explicitly or every existing payslip would settle at zero.
  const isLeg = ded?.settleOriginal !== null
    && ded?.settleOriginal !== undefined
    && Number.isFinite(Number(ded.settleOriginal));
  const priceRatio = Number.isFinite(Number(ded?.priceRatio)) ? Number(ded.priceRatio) : 1;
  const fullOrderPrice = hasInput ? Number(o.input_total_amount) : Number(o?.total_amount || 0);
  const originalOrderPrice = isLeg ? fullOrderPrice * priceRatio : fullOrderPrice;
  const originalSettleAmount = isLeg
    ? Number(ded.settleOriginal || 0)
    : (hasInputSettle ? Number(o.input_settle_amount) : Number(o?.settle_amount || 0));
  const originalOwnerProfit = (isLeg || (hasInput && hasInputSettle))
    ? (originalOrderPrice - originalSettleAmount)
    : Number(o?.owner_profit || (Number(o?.total_amount || 0) - Number(o?.settle_amount || 0)) || 0);
  const ownerProfitSourceCurrency = (isLeg || (hasInput && hasInputSettle)) ? priceSourceCurrency : deductionSourceCurrency;
  // A leg's settle share is denominated in whatever currency the order's settle pot was typed in.
  const settleSourceCurrency = isLeg
    ? normalizeCurrency(ded?.settleCurrency, priceSourceCurrency)
    : priceSourceCurrency;
  const orderPriceConversion = convertAmount(originalOrderPrice, priceSourceCurrency, targetCurrency, fxRatesMap);
  const settleAmountConversion = convertAmount(originalSettleAmount, settleSourceCurrency, targetCurrency, fxRatesMap);
  const ownerProfitConversion = convertAmount(originalOwnerProfit, ownerProfitSourceCurrency, targetCurrency, fxRatesMap);
  // Convert the driver pay ONCE, from the currency it is owed in. Falling back to the USD column
  // would convert twice (native → USD at build time, USD → target here) through FX pairs that are
  // not exact reciprocals, which is how CA$602.67 of pay reached the statement as CA$601.05.
  const nativeDeduction = ded?.deductionByCurrency instanceof Map ? ded.deductionByCurrency : null;
  const deductionConversion = (nativeDeduction && nativeDeduction.size > 0)
    ? {
        value: Array.from(nativeDeduction.entries()).reduce(
          (sum, [cur, amt]) => sum + Number(convertAmount(amt, cur, targetCurrency, fxRatesMap).value || 0), 0),
        rate: null,
      }
    : convertAmount(originalDeduction, deductionSourceCurrency, targetCurrency, fxRatesMap);
  const orderPrice = Number(orderPriceConversion.value || 0);
  const settleAmount = Number(settleAmountConversion.value || 0);
  const ownerProfit = Number(ownerProfitConversion.value || 0);
  const deduction = Number(deductionConversion.value || 0);
  const payable = settleAmount - deduction;
  const originalPayable = originalSettleAmount - originalDeduction;
  return {
    priceSourceCurrency, deductionSourceCurrency,
    originalOrderPrice, originalSettleAmount, originalOwnerProfit, originalDeduction, originalPayable,
    orderPrice, settleAmount, ownerProfit, deduction, payable,
    orderPriceConversion, settleAmountConversion, ownerProfitConversion, deductionConversion,
  };
}

function buildFxMonthEndDate(year, month) {
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

async function fetchHistoricalFxRate(sourceCurrency, targetCurrency, month, year) {
  const source = normalizeCurrency(sourceCurrency, 'USD');
  const target = normalizeCurrency(targetCurrency, 'USD');
  if (source === target) return 1;
  const date = buildFxMonthEndDate(year, month);
  const url = `https://api.frankfurter.app/${date}?from=${source}&to=${target}`;
  const payload = await fetchJsonFromUrl(url);
  const rate = Number(payload?.rates?.[target] || 0);
  if (!Number.isFinite(rate) || rate <= 0) return null;
  return rate;
}

async function ensureMonthlyFxRates(tenantId, month, year, targetCurrency, sourceCurrencies = [], userId = null) {
  const target = normalizeCurrency(targetCurrency, 'CAD');
  const sources = Array.from(
    new Set((sourceCurrencies || []).map((c) => normalizeCurrency(c, target)).filter((c) => c && c !== target))
  );
  if (sources.length === 0) return getFxRatesMap(tenantId, month, year, target);

  const existingRows = await ConversionRate.find({
    tenantId,
    month: Number(month),
    year: Number(year),
    targetCurrency: target,
    sourceCurrency: { $in: sources },
  })
    .select('sourceCurrency rate')
    .lean();
  const existing = new Map(existingRows.map((r) => [normalizeCurrency(r?.sourceCurrency, target), Number(r?.rate || 0)]));

  for (const source of sources) {
    const hasRate = Number(existing.get(source) || 0) > 0;
    if (hasRate) continue;
    try {
      const rate = await fetchHistoricalFxRate(source, target, month, year);
      if (!rate || rate <= 0) continue;
      await ConversionRate.findOneAndUpdate(
        { tenantId, month: Number(month), year: Number(year), sourceCurrency: source, targetCurrency: target },
        {
          tenantId,
          month: Number(month),
          year: Number(year),
          sourceCurrency: source,
          targetCurrency: target,
          rate,
          updatedBy: userId || null,
          $setOnInsert: { createdBy: userId || null },
        },
        { upsert: true, new: true }
      );
    } catch (err) {
      // Keep conversion resilient: unresolved pair will fallback to 1
    }
  }

  return getFxRatesMap(tenantId, month, year, target);
}
exports.ensureMonthlyFxRates = ensureMonthlyFxRates;

// Driver pay charged back against an owner-operator's orders.
//
// Every caller (and resolveOwnerOrderAmounts) treats the returned `deduction` as base USD, in the
// order's revenue_currency. But a driver's rates are stored in whatever currency they were hired
// at, so a CAD driver's raw pay is NOT USD. We normalize each driver's pay to USD here, using the
// FX of the month the ORDER was created in — that keeps the owner-side conversion chain untouched
// and pins the rate to the period the cost belongs to (orders may span months).
async function buildOrderDriverDeductions(tenantId, orderIds) {
  const emptyResult = { byOrder: new Map(), byOwnerOrder: new Map(), soloTotal: 0, teamTotal: 0 };
  if (!Array.isArray(orderIds) || orderIds.length === 0) return emptyResult;

  const trips = await Trip.find({
    tenantId,
    order: { $in: orderIds },
    deletedAt: null,
  })
    .select('order miles totalDistance total_km distance_unit rate_per_mile rate_currency drivers driver truck settle_amount')
    .lean();
  const orderRows = await Order.find({
    tenantId,
    _id: { $in: orderIds },
  })
    .select('_id totalDistance createdAt isMixedOwner ownerOperator ownerOperators settle_amount input_settle_amount input_currency revenue_currency total_amount input_total_amount fx_to_usd')
    .lean();
  const truckIds = [...new Set((trips || []).map((t) => String(t.truck || '')).filter(Boolean))];
  const truckRows = truckIds.length > 0
    ? await Truck.find({ tenantId, _id: { $in: truckIds } }).select('ownerOperated ownerOperator').lean()
    : [];
  const truckMap = new Map((truckRows || []).map((t) => [String(t._id), t]));
  const orderDistanceKmMap = new Map(
    (orderRows || []).map((o) => [String(o._id), Number(o?.totalDistance || 0)])
  );
  const orderMonthMap = new Map(
    (orderRows || []).map((o) => {
      const d = o?.createdAt ? new Date(o.createdAt) : new Date();
      return [String(o._id), { month: d.getMonth() + 1, year: d.getFullYear() }];
    })
  );
  const orderTripDistanceTotals = new Map();
  (trips || []).forEach((trip) => {
    const orderId = String(trip.order);
    const rawDistance = Number(trip.totalDistance || trip.miles || trip.total_km || 0);
    orderTripDistanceTotals.set(orderId, Number(orderTripDistanceTotals.get(orderId) || 0) + Math.max(rawDistance, 0));
  });

  const driverIdSet = new Set();
  (trips || []).forEach((trip) => {
    const list = Array.isArray(trip.drivers) && trip.drivers.length > 0 ? trip.drivers : trip.driver ? [trip.driver] : [];
    list.forEach((id) => driverIdSet.add(String(id)));
  });

  const driverProfiles = await DriverProfile.find({
    tenantId,
    user: { $in: Array.from(driverIdSet).map((id) => new mongoose.Types.ObjectId(id)) },
  })
    .select('user rateCurrency ratePerMile ratePerMileSolo ratePerMileTeam')
    .lean();
  const profileMap = new Map(driverProfiles.map((p) => [String(p.user), p]));

  // Only fetch FX for the months that actually carry a non-USD driver — the common all-USD tenant
  // does zero extra queries.
  const usdFxByMonth = new Map(); // "m-y" -> Map<sourceCurrency, rateToUsd>
  const nonUsdCurrencies = [...new Set(
    driverProfiles.map(getDriverRateCurrency).filter((c) => c !== 'USD')
  )];
  if (nonUsdCurrencies.length > 0) {
    const monthKeys = new Map();
    orderMonthMap.forEach((my) => monthKeys.set(`${my.month}-${my.year}`, my));
    for (const [key, my] of monthKeys) {
      // ensureMonthlyFxRates (not getFxRatesMap) — a month with no stored rate would otherwise make
      // convertAmount fall back to 1:1 and charge the owner a CAD number as if it were USD.
      usdFxByMonth.set(key, await ensureMonthlyFxRates(tenantId, my.month, my.year, 'USD', nonUsdCurrencies));
    }
  }
  const rateToUsd = (rate, profile, orderId) => {
    const source = getDriverRateCurrency(profile);
    if (source === 'USD') return rate;
    const my = orderMonthMap.get(orderId);
    const fx = my ? usdFxByMonth.get(`${my.month}-${my.year}`) : null;
    return Number(convertAmount(rate, source, 'USD', fx).value || 0);
  };

  const emptyAgg = () => ({
    deduction: 0,
    soloSegments: 0,
    teamSegments: 0,
    drivers: new Set(),
    miles: 0,
    weightedRateMiles: 0,
    // Driver pay in the currency it is actually owed in, keyed by currency code. `deduction` above
    // is the same money normalized to USD for the settlement math. The stored monthly FX pairs are
    // NOT exact reciprocals (Aug 2026: USD→CAD 1.402359 × CAD→USD 0.711173 = 0.99732), so a
    // CAD→USD→CAD round trip loses 0.27% — CA$602.67 of driver pay printed as CA$601.05. Keeping
    // the native amount lets the display convert ONCE, or not at all when it's already the target.
    deductionByCurrency: new Map(),
  });

  const addNative = (agg, currency, amount) => {
    if (!(Number(amount) > 0)) return;
    const cur = normalizeCurrency(currency, 'USD');
    agg.deductionByCurrency.set(cur, Number(agg.deductionByCurrency.get(cur) || 0) + Number(amount));
  };

  const byOrder = new Map();
  const byTrip = new Map(); // tripId -> driver-pay aggregate for that single trip
  let soloTotal = 0;
  let teamTotal = 0;
  (trips || []).forEach((trip) => {
    const list = Array.isArray(trip.drivers) && trip.drivers.length > 0 ? trip.drivers.map(String) : trip.driver ? [String(trip.driver)] : [];
    if (list.length === 0) return;
    const count = Math.max(list.length, 1);
    const isTeam = count > 1;
    const orderId = String(trip.order);
    const orderDistanceKm = Number(orderDistanceKmMap.get(orderId) || 0);
    const orderRawTotal = Number(orderTripDistanceTotals.get(orderId) || 0);
    const miles = deriveTripMiles(trip, orderDistanceKm, orderRawTotal);
    let tripDeduction = 0;
    let tripWeightedRateMiles = 0;
    const tripNative = new Map(); // currency -> driver pay in that currency
    list.forEach((driverId) => {
      const profile = profileMap.get(String(driverId));
      // trip.rate_per_mile is snapshotted in trip.rate_currency. That is normally this driver's
      // pay currency — but a driver moved to another currency later (the USD→CAD switch) leaves old
      // trips stamped USD, and reading that number as CAD would underpay the deduction ~30%. When
      // the snapshot's currency doesn't match the profile's, fall back to the profile's own rate.
      // No rate_currency ⇒ legacy row, which predates the field and was always USD.
      const snapshotCurrency = String(trip.rate_currency || 'USD').toUpperCase();
      const overrideUsable = snapshotCurrency === getDriverRateCurrency(profile);
      const nativeRate = pickDriverRate(profile, isTeam, overrideUsable ? trip.rate_per_mile : 0);
      const nativeCurrency = normalizeCurrency(getDriverRateCurrency(profile), 'USD');
      const rate = rateToUsd(nativeRate, profile, orderId);
      tripDeduction += (miles / count) * rate;
      tripWeightedRateMiles += (miles / count) * rate;
      tripNative.set(
        nativeCurrency,
        Number(tripNative.get(nativeCurrency) || 0) + (miles / count) * nativeRate
      );
    });
    const current = byOrder.get(orderId) || emptyAgg();
    tripNative.forEach((amt, cur) => addNative(current, cur, amt));
    current.deduction += tripDeduction;
    current.miles += miles;
    current.weightedRateMiles += tripWeightedRateMiles;
    if (isTeam) current.teamSegments += 1;
    else current.soloSegments += 1;
    list.forEach((driverId) => current.drivers.add(driverId));
    byOrder.set(orderId, current);
    byTrip.set(String(trip._id), {
      deduction: tripDeduction,
      deductionByCurrency: tripNative,
      miles,
      weightedRateMiles: tripWeightedRateMiles,
      isTeam,
      drivers: list,
    });
    if (isTeam) teamTotal += tripDeduction;
    else soloTotal += tripDeduction;
  });

  // Per-(order, owner) legs. A non-mixed order yields one leg holding the whole order — identical
  // numbers to the old order-level math, so already-generated payslips don't move.
  const tripsByOrder = new Map();
  (trips || []).forEach((t) => {
    const list = tripsByOrder.get(String(t.order)) || [];
    list.push(t);
    tripsByOrder.set(String(t.order), list);
  });

  const byOwnerOrder = new Map();
  (orderRows || []).forEach((order) => {
    const orderId = String(order._id);
    const orderTrips = tripsByOrder.get(orderId) || [];
    const { legs } = buildOrderLegs({ order, trips: orderTrips, truckMap });
    legs.forEach((leg, ownerId) => {
      const agg = emptyAgg();
      leg.tripIds.forEach((tripId) => {
        const t = byTrip.get(String(tripId));
        if (!t) return;
        agg.deduction += t.deduction;
        (t.deductionByCurrency || new Map()).forEach((amt, cur) => addNative(agg, cur, amt));
        agg.miles += t.miles;
        agg.weightedRateMiles += t.weightedRateMiles;
        if (t.isTeam) agg.teamSegments += 1;
        else agg.soloSegments += 1;
        t.drivers.forEach((d) => agg.drivers.add(String(d)));
      });
      byOwnerOrder.set(legKey(orderId, ownerId), {
        ...agg,
        settleOriginal: leg.settleOriginal,
        settleCurrency: leg.settleCurrency,
        priceRatio: leg.priceRatio,
        isMixedOwner: !!order.isMixedOwner,
        legMiles: leg.miles,
      });
    });
  });

  return { byOrder, byOwnerOrder, soloTotal, teamTotal };
}

// Driver-pay aggregate for one owner's legs of an order. Falls back to the order-level aggregate for
// orders that predate mixed splits (or carry no owner at all).
function ownerOrderDeduction(deds, orderId, ownerId) {
  if (!ownerId) return deds?.byOrder?.get(String(orderId));
  return deds?.byOwnerOrder?.get(legKey(orderId, ownerId)) || deds?.byOrder?.get(String(orderId));
}

// The order is settled to this owner outright, or the owner runs one leg of a mixed split.
function orderHasOwner(o, ownerId) {
  if (!ownerId) return false;
  if (String(o?.ownerOperator || '') === String(ownerId)) return true;
  return (o?.ownerOperators || []).some((id) => String(id) === String(ownerId));
}

// Owner-order columns every settlement screen needs (mixed-split fields included).
const OWNER_ORDER_FIELDS =
  'serial_no customer_order_no ownerOperator ownerOperators isMixedOwner total_amount settle_amount owner_profit revenue_currency input_total_amount input_settle_amount input_currency fx_to_usd totalDistance driver_assignment_mode';

exports.ownerOperatorListings = catchAsync(async (req, res, next) => {
  try {
    if (!hasOwnerOperatorAccess(req)) {
      return res.status(403).json({ status: false, message: 'You are not allowed to access owner operators' });
    }
    const tenantId = getTenantId(req);
    if (!tenantId) return res.status(400).json({ status: false, message: 'Tenant context is required' });
    const companyId = normalizeCompanyId(req);
    const { search, status, sortBy = 'createdAt', sortOrder = 'desc' } = req.query;

    const filter = { tenantId, ...normalizeDeletedFilter() };
    if (companyId) filter.company = companyId;
    if (status === 'active' || status === 'inactive') filter.status = status;
    if (search && String(search).trim().length > 0) {
      const q = escapeRegex(String(search).trim());
      filter.$and = filter.$and || [];
      filter.$and.push({
        $or: [
          { fullName: { $regex: q, $options: 'i' } },
          { companyName: { $regex: q, $options: 'i' } },
          { email: { $regex: q, $options: 'i' } },
          { phone: { $regex: q, $options: 'i' } },
          { ownerOperatorId: { $regex: q, $options: 'i' } },
        ],
      });
    }

    const sort = {};
    sort[sortBy] = String(sortOrder).toLowerCase() === 'asc' ? 1 : -1;
    const lists = await OwnerOperator.find(filter).sort(sort).lean();
    return res.json({ status: true, lists, totalDocuments: lists.length });
  } catch (err) {
    JSONerror(res, err, next);
    logger(err);
  }
});

exports.activeOwnerOperators = catchAsync(async (req, res, next) => {
  try {
    const tenantId = getTenantId(req);
    if (!tenantId) return res.status(400).json({ status: false, message: 'Tenant context is required' });
    const companyId = normalizeCompanyId(req);
    const filter = { tenantId, status: 'active', ...normalizeDeletedFilter() };
    if (companyId) filter.company = companyId;
    const lists = await OwnerOperator.find(filter).select('fullName companyName ownerOperatorId email phone').sort({ fullName: 1 }).lean();
    return res.json({ status: true, lists });
  } catch (err) {
    JSONerror(res, err, next);
    logger(err);
  }
});

exports.addOwnerOperator = catchAsync(async (req, res, next) => {
  try {
    if (!hasOwnerOperatorAccess(req)) {
      return res.status(403).json({ status: false, message: 'You are not allowed to create owner operators' });
    }
    const tenantId = getTenantId(req);
    if (!tenantId) return res.status(400).json({ status: false, message: 'Tenant context is required' });
    const { fullName, companyName, phone, email, address, country, state, city, zipcode, notes, status } = req.body;
    if (!fullName || !phone || !email) {
      return res.status(400).json({ status: false, message: 'Full name, phone and email are required' });
    }

    const ownerCompanyId = req.user?.company?._id || req.user?.company || null;
    const exists = await OwnerOperator.findOne({
      tenantId,
      ...(ownerCompanyId ? { company: ownerCompanyId } : {}),
      email: String(email).trim().toLowerCase(),
      ...normalizeDeletedFilter(),
    }).lean();
    if (exists) return res.status(400).json({ status: false, message: 'Owner operator with this email already exists' });

    const ownerOperatorId = await generateOwnerOperatorId(tenantId);
    const ownerOperator = await OwnerOperator.create({
      tenantId,
      company: req.user?.company?._id || req.user?.company || null,
      ownerOperatorId,
      fullName: String(fullName).trim(),
      companyName: String(companyName || '').trim(),
      phone: String(phone).trim(),
      email: String(email).trim().toLowerCase(),
      address: String(address || '').trim(),
      country: String(country || '').trim(),
      state: String(state || '').trim(),
      city: String(city || '').trim(),
      zipcode: String(zipcode || '').trim(),
      notes: String(notes || '').trim(),
      status: status === 'inactive' ? 'inactive' : 'active',
      createdBy: req.user?._id,
      updatedBy: req.user?._id,
    });

    logActivity(req, {
      action: 'CREATE',
      module: 'employee',
      description: `Added owner operator "${ownerOperator.fullName}"`,
      resourceId: ownerOperator._id,
      resourceName: ownerOperator.fullName,
    });
    return res.status(201).json({ status: true, ownerOperator, message: 'Owner operator created' });
  } catch (err) {
    JSONerror(res, err, next);
    logger(err);
  }
});

exports.ownerOperatorDetail = catchAsync(async (req, res, next) => {
  try {
    if (!hasOwnerOperatorAccess(req)) {
      return res.status(403).json({ status: false, message: 'You are not allowed to view owner operators' });
    }
    const tenantId = getTenantId(req);
    const companyId = normalizeCompanyId(req);
    const filter = { _id: req.params.id, tenantId, ...normalizeDeletedFilter() };
    if (companyId) filter.company = companyId;
    const ownerOperator = await OwnerOperator.findOne(filter).lean();
    if (!ownerOperator) return res.status(404).json({ status: false, message: 'Owner operator not found' });

    // Trucks linked to this owner operator
    const trucks = await Truck.find({
      tenantId,
      ownerOperator: ownerOperator._id,
      ...normalizeDeletedFilter(),
    })
      .sort({ createdAt: -1 })
      .lean();

    // Orders involving this owner operator: explicitly linked (owner-operated order flow),
    // OR order-level truck is one of this owner's trucks, OR a trip segment uses the truck.
    const truckIds = trucks.map((t) => t._id).filter(Boolean);
    let tripOrderIds = [];
    if (truckIds.length) {
      tripOrderIds = await Trip.distinct('order', {
        tenantId,
        truck: { $in: truckIds },
        deletedAt: null,
      });
    }
    const orders = await Order.find({
      tenantId,
      // $and, not two sibling $or keys — the second would silently replace the deleted-filter one.
      $and: [
        normalizeDeletedFilter(),
        {
          $or: [
            { ownerOperator: ownerOperator._id },
            { ownerOperators: ownerOperator._id },
            ...(truckIds.length ? [{ truck: { $in: truckIds } }] : []),
            ...(tripOrderIds.length ? [{ _id: { $in: tripOrderIds } }] : []),
          ],
        },
      ],
    })
      .select('serial_no order_status order_type total_amount settle_amount owner_profit input_total_amount input_settle_amount input_currency revenue_currency createdAt pickup_date delivery_date customer truck shipping_details')
      .populate('customer', 'name company_name')
      .populate('truck', 'make model truckNumber unitNumber plateNumber')
      .sort({ createdAt: -1 })
      .lean();

    return res.json({ status: true, ownerOperator, trucks, orders });
  } catch (err) {
    JSONerror(res, err, next);
    logger(err);
  }
});

exports.updateOwnerOperator = catchAsync(async (req, res, next) => {
  try {
    if (!hasOwnerOperatorAccess(req)) {
      return res.status(403).json({ status: false, message: 'You are not allowed to update owner operators' });
    }
    const tenantId = getTenantId(req);
    if (!tenantId) return res.status(400).json({ status: false, message: 'Tenant context is required' });
    const { fullName, companyName, phone, email, address, country, state, city, zipcode, notes, status } = req.body;
    if (!fullName || !phone || !email) {
      return res.status(400).json({ status: false, message: 'Full name, phone and email are required' });
    }

    const conflict = await OwnerOperator.findOne({
      _id: { $ne: req.params.id },
      tenantId,
      email: String(email).trim().toLowerCase(),
      ...normalizeDeletedFilter(),
    }).lean();
    if (conflict) return res.status(400).json({ status: false, message: 'Another owner operator already uses this email' });

    const ownerOperator = await OwnerOperator.findOneAndUpdate(
      { _id: req.params.id, tenantId, ...normalizeDeletedFilter() },
      {
        fullName: String(fullName).trim(),
        companyName: String(companyName || '').trim(),
        phone: String(phone).trim(),
        email: String(email).trim().toLowerCase(),
        address: String(address || '').trim(),
        country: String(country || '').trim(),
        state: String(state || '').trim(),
        city: String(city || '').trim(),
        zipcode: String(zipcode || '').trim(),
        notes: String(notes || '').trim(),
        status: status === 'inactive' ? 'inactive' : 'active',
        updatedBy: req.user?._id,
      },
      { new: true }
    );
    if (!ownerOperator) return res.status(404).json({ status: false, message: 'Owner operator not found' });

    logActivity(req, {
      action: 'UPDATE',
      module: 'employee',
      description: `Updated owner operator "${ownerOperator.fullName}"`,
      resourceId: ownerOperator._id,
      resourceName: ownerOperator.fullName,
    });
    return res.json({ status: true, ownerOperator, message: 'Owner operator updated' });
  } catch (err) {
    JSONerror(res, err, next);
    logger(err);
  }
});

exports.removeOwnerOperator = catchAsync(async (req, res, next) => {
  try {
    if (!hasOwnerOperatorAccess(req)) {
      return res.status(403).json({ status: false, message: 'You are not allowed to remove owner operators' });
    }
    const tenantId = getTenantId(req);
    const companyId = normalizeCompanyId(req);
    const filter = { _id: req.params.id, tenantId, ...normalizeDeletedFilter() };
    if (companyId) filter.company = companyId;
    const ownerOperator = await OwnerOperator.findOne(filter);
    if (!ownerOperator) return res.status(404).json({ status: false, message: 'Owner operator not found' });

    const assignedTruck = await Truck.findOne({
      tenantId,
      ownerOperated: true,
      ownerOperator: ownerOperator._id,
      ...normalizeDeletedFilter(),
    }).lean();
    if (assignedTruck) {
      return res.status(400).json({
        status: false,
        message: 'Owner operator is assigned to truck(s). Unassign before delete.',
      });
    }

    // Orders keep the owner on them after the owner record is gone — their settlement is then owed
    // to somebody who no longer appears in any list, and the owner statement cannot be produced.
    // Prod carries 4 such orders. Removing is still allowed; it just has to be a decision.
    if (!req.query?.force) {
      const orderCount = await Order.countDocuments({
        tenantId,
        ...ownerOrderMatch([ownerOperator._id]),
        $and: [normalizeDeletedFilter()],
      });
      if (orderCount > 0) {
        return res.status(409).json({
          status: false,
          code: 'owner_in_use',
          orders: orderCount,
          message: `${ownerOperator.fullName || 'This owner operator'} is still on ${orderCount} order${orderCount === 1 ? '' : 's'}. Removing them leaves those settlements with no owner.`,
        });
      }
    }

    ownerOperator.deletedAt = new Date();
    ownerOperator.status = 'inactive';
    ownerOperator.updatedBy = req.user?._id;
    await ownerOperator.save({ validateBeforeSave: false });

    logActivity(req, {
      action: 'DELETE',
      module: 'employee',
      description: `Removed owner operator "${ownerOperator.fullName}"`,
      resourceId: ownerOperator._id,
      resourceName: ownerOperator.fullName,
    });
    return res.json({ status: true, message: 'Owner operator removed' });
  } catch (err) {
    JSONerror(res, err, next);
    logger(err);
  }
});

exports.getMonthlyFxRates = catchAsync(async (req, res, next) => {
  try {
    if (!hasOwnerOperatorAccess(req)) {
      return res.status(403).json({ status: false, message: 'You are not allowed to access FX rates' });
    }
    const tenantId = getTenantId(req);
    const { month, year, targetCurrency } = req.query || {};
    const range = buildDateRange(month, year);
    if (!range) return res.status(400).json({ status: false, message: 'Valid month and year are required' });
    const target = normalizeCurrency(targetCurrency, req.tenant?.billing?.currency || 'USD');
    const fxMap = await getFxRatesMap(tenantId, range.month, range.year, target);
    return res.json({
      status: true,
      month: range.month,
      year: range.year,
      targetCurrency: target,
      rates: Object.fromEntries(fxMap.entries()),
    });
  } catch (err) {
    JSONerror(res, err, next);
    logger(err);
  }
});

exports.saveMonthlyFxRates = catchAsync(async (req, res, next) => {
  try {
    if (!hasOwnerOperatorAccess(req)) {
      return res.status(403).json({ status: false, message: 'You are not allowed to save FX rates' });
    }
    const tenantId = getTenantId(req);
    const { month, year, targetCurrency, rates } = req.body || {};
    const range = buildDateRange(month, year);
    if (!range) return res.status(400).json({ status: false, message: 'Valid month and year are required' });
    if (!rates || typeof rates !== 'object') {
      return res.status(400).json({ status: false, message: 'rates object is required' });
    }

    const target = normalizeCurrency(targetCurrency, req.tenant?.billing?.currency || 'USD');

    // An FX row is the highest-leverage number in the system: it is read retroactively by every
    // report, payslip and settlement that converts through that month. Changing one rewrites
    // history everywhere at once, so the old rates are captured before the upsert.
    const priorRows = await ConversionRate.find({
      tenantId, month: range.month, year: range.year, targetCurrency: target,
    }).lean();
    const priorRates = Object.fromEntries(priorRows.map((r) => [r.sourceCurrency, r.rate]));

    const ops = Object.entries(rates).map(async ([sourceCurrency, rawRate]) => {
      const source = normalizeCurrency(sourceCurrency, target);
      if (source === target) return null;
      const rate = Number(rawRate || 0);
      if (!Number.isFinite(rate) || rate <= 0) return null;
      return ConversionRate.findOneAndUpdate(
        { tenantId, month: range.month, year: range.year, sourceCurrency: source, targetCurrency: target },
        {
          tenantId,
          month: range.month,
          year: range.year,
          sourceCurrency: source,
          targetCurrency: target,
          rate,
          updatedBy: req.user?._id,
          $setOnInsert: { createdBy: req.user?._id },
        },
        { upsert: true, new: true }
      );
    });
    await Promise.all(ops);

    const fxMap = await getFxRatesMap(tenantId, range.month, range.year, target);

    logChange(req, {
      model: 'ConversionRate',
      module: 'settings',
      action: 'UPDATE',
      before: { rates: priorRates },
      after: { rates: Object.fromEntries(fxMap.entries()) },
      fields: ['rates'],
      resourceId: `fx-${range.year}-${range.month}-${target}`,
      resourceName: `FX rates ${range.month}/${range.year} → ${target}`,
      description: `Saved FX rates for ${range.month}/${range.year} (target ${target})`,
      // Always worth an admin's attention, even when a rate is re-saved unchanged.
      logUnchanged: true,
      critical: true,
    });

    return res.json({
      status: true,
      message: 'FX rates saved',
      month: range.month,
      year: range.year,
      targetCurrency: target,
      rates: Object.fromEntries(fxMap.entries()),
    });
  } catch (err) {
    JSONerror(res, err, next);
    logger(err);
  }
});

exports.autoSyncMonthlyFxRates = catchAsync(async (req, res, next) => {
  try {
    if (!hasOwnerOperatorAccess(req)) {
      return res.status(403).json({ status: false, message: 'You are not allowed to sync FX rates' });
    }
    const tenantId = getTenantId(req);
    const { month, year, targetCurrency, sourceCurrencies = [] } = req.body || {};
    const range = buildDateRange(month, year);
    if (!range) return res.status(400).json({ status: false, message: 'Valid month and year are required' });
    const target = normalizeCurrency(targetCurrency, req.tenant?.billing?.currency || 'USD');
    const desiredSources = Array.isArray(sourceCurrencies) && sourceCurrencies.length > 0
      ? sourceCurrencies
      : ['USD', 'CAD', 'INR'];
    const fxMap = await ensureMonthlyFxRates(
      tenantId,
      range.month,
      range.year,
      target,
      desiredSources,
      req.user?._id
    );

    return res.json({
      status: true,
      message: 'FX rates auto-synced',
      month: range.month,
      year: range.year,
      targetCurrency: target,
      rates: Object.fromEntries(fxMap.entries()),
    });
  } catch (err) {
    JSONerror(res, err, next);
    logger(err);
  }
});

exports.generateMonthlySalary = catchAsync(async (req, res, next) => {
  try {
    if (!hasOwnerOperatorAccess(req)) {
      return res.status(403).json({ status: false, message: 'You are not allowed to generate owner operator salary' });
    }
    const tenantId = getTenantId(req);
    if (!tenantId) return res.status(400).json({ status: false, message: 'Tenant context is required' });
    const companyId = normalizeCompanyId(req);
    const { month, year, ownerOperatorId, adjustments = {}, includePreviousDue = true, payoutCurrency } = req.body || {};
    const range = buildDateRange(month, year);
    if (!range) return res.status(400).json({ status: false, message: 'Valid month and year are required' });
    const targetCurrency = normalizeCurrency(payoutCurrency, req.tenant?.billing?.currency || 'USD');

    const ownerFilter = { tenantId, ...normalizeDeletedFilter() };
    if (companyId) ownerFilter.company = companyId;
    if (ownerOperatorId) ownerFilter._id = ownerOperatorId;
    const ownerOperators = await OwnerOperator.find(ownerFilter).lean();
    if (!ownerOperators.length) {
      return res.json({ status: true, message: 'No owner operators found for salary generation', salaries: [] });
    }

    const ownerIds = ownerOperators.map((o) => o._id);
    const orders = await Order.find({
      tenantId,
      order_type: 'regular',
      isOwnerOperatedTruck: true,
      createdAt: { $gte: range.from, $lte: range.to },
      $and: [ownerOrderMatch(ownerIds), normalizeDeletedFilter()],
    })
      .select(OWNER_ORDER_FIELDS)
      .lean();
    // Auto-seed any missing month FX rates so amounts never silently convert 1:1.
    const fxRatesMap = await ensureMonthlyFxRates(tenantId, range.month, range.year, targetCurrency, ['USD', 'CAD', 'INR'], req.user?._id);
    const orderIds = orders.map((o) => o._id);

    const deds = await buildOrderDriverDeductions(tenantId, orderIds);
    const { soloTotal, teamTotal } = deds;
    const salaries = [];
    for (const owner of ownerOperators) {
      const ownerOrders = orders.filter((o) => orderHasOwner(o, owner._id));
      const breakdown = ownerOrders.map((o) => {
        const ded = ownerOrderDeduction(deds, o._id, owner._id);
        const amounts = resolveOwnerOrderAmounts(o, ded, targetCurrency, fxRatesMap);
        const {
          deductionSourceCurrency, priceSourceCurrency,
          originalDeduction, originalOrderPrice, originalSettleAmount, originalOwnerProfit, originalPayable,
          orderPrice, settleAmount, ownerProfit, deduction, payable, ownerProfitConversion,
        } = amounts;
        let driverRateType = 'none';
        if ((ded?.soloSegments || 0) > 0 && (ded?.teamSegments || 0) > 0) driverRateType = 'mixed';
        else if ((ded?.teamSegments || 0) > 0) driverRateType = 'team';
        else if ((ded?.soloSegments || 0) > 0) driverRateType = 'solo';
        const avg = resolveDriverAvgRate(ded, deductionSourceCurrency);
        const originalDriverAvgRate = avg.rate;
        const driverRateCurrencyCode = avg.currency;
        const driverAvgRate = Number(convertAmount(originalDriverAvgRate, driverRateCurrencyCode, targetCurrency, fxRatesMap).value || 0);
        return {
          order: o._id,
          serial_no: o.serial_no || null,
          customer_order_no: o.customer_order_no || null,
          orderPrice,
          settleAmount,
          ownerProfit,
          driverDeduction: deduction,
          payable,
          sourceCurrency: priceSourceCurrency,
          targetCurrency,
          fxRate: Number(ownerProfitConversion.rate || 1),
          originalOrderPrice,
          originalSettleAmount,
          originalOwnerProfit,
          originalDriverDeduction: originalDeduction,
          originalPayable,
          originalDriverAvgRate,
          driverCount: ded?.drivers?.size || 0,
          driverRateType,
          driverMiles: Number(ded?.miles || 0),
          driverAvgRate,
          // The currency `originalDriverAvgRate` is actually denominated in. Printing only the
          // converted, 2-decimal rate makes the row fail its own arithmetic (0.55 × 1095.76 is
          // not 599.29) — the real rate is 0.3900 USD. Show the source, like every other money
          // field on this statement.
          driverRateCurrency: driverRateCurrencyCode,
        };
      });

      const totalOrderValue = breakdown.reduce((acc, b) => acc + Number(b.orderPrice || 0), 0);
      const totalSettleAmount = breakdown.reduce((acc, b) => acc + Number(b.settleAmount || 0), 0);
      const totalDriverDeduction = breakdown.reduce((acc, b) => acc + Number(b.driverDeduction || 0), 0);
      const totalOwnerProfit = breakdown.reduce((acc, b) => acc + Number(b.ownerProfit || 0), 0);
      const basePayable = totalSettleAmount;
      const existingSalary = await OwnerOperatorSalary.findOne({
        tenantId,
        ownerOperator: owner._id,
        month: range.month,
        year: range.year,
      })
        .select('currency paidAmount previousDueAdded manualDeduction manualAddition')
        .lean();
      const ownerAdjustments = ownerOperatorId
        ? adjustments
        : (adjustments[String(owner._id)] || {});
      // Insurance/escrow/lease repeat every month. Materialize last month's recurring rows
      // into this one BEFORE the ledger is summed, so the payslip is complete on generate
      // instead of waiting for someone to remember.
      await syncRecurringAdjustments(tenantId, owner._id, range.month, range.year, req.user?._id);
      // Immediately previous month only (not any prior month) so a skipped/old due isn't
      // repeatedly carried forward. Matches the driver salary carry-forward semantics.
      const prevRange = buildDateRange(range.month === 1 ? 12 : range.month - 1, range.month === 1 ? range.year - 1 : range.year);
      const previousSalary = prevRange
        ? await OwnerOperatorSalary.findOne({
            tenantId,
            ownerOperator: owner._id,
            month: prevRange.month,
            year: prevRange.year,
          })
            .select('currency dueAmount owedAmount')
            .lean()
        : null;
      const existingSalaryCurrency = normalizeCurrency(existingSalary?.currency, targetCurrency);
      const previousSalaryCurrency = normalizeCurrency(previousSalary?.currency, targetCurrency);
      // Paid-to-date is stored in the payslip's own currency. Regenerating in a different
      // currency used to rewrite `currency` while leaving `paidAmount` untouched, so a
      // USD 1,000 payment silently became CAD 1,000. It is converted and REWRITTEN below.
      const convertedExistingPaid = round2(
        convertAmount(Number(existingSalary?.paidAmount || 0), existingSalaryCurrency, targetCurrency, fxRatesMap).value
      );
      const autoPreviousDue = round2(
        convertAmount(Number(previousSalary?.dueAmount || 0), previousSalaryCurrency, targetCurrency, fxRatesMap).value
      );
      // Last month's negative balance follows the owner forward — otherwise a month whose
      // deductions exceeded earnings was quietly forgiven at month end.
      const autoPreviousOwed = round2(
        convertAmount(Number(previousSalary?.owedAmount || 0), previousSalaryCurrency, targetCurrency, fxRatesMap).value
      );
      const previousDueAdded = ownerAdjustments?.previousDueAdded !== undefined
        ? Math.max(round2(ownerAdjustments.previousDueAdded), 0)
        : (includePreviousDue ? autoPreviousDue : 0);
      const previousOwedDeducted = includePreviousDue ? autoPreviousOwed : 0;

      // Manual addition/deduction come ONLY from the itemized ledger. They are never read
      // back off the previous salary document and never accepted from the request — that
      // is what let the scalar totals and the line items disagree.
      const ledgerRows = await loadLedger(tenantId, owner._id, range.month, range.year);
      const ledgerSums = sumAdjustments(ledgerRows, targetCurrency, fxRatesMap);
      const totals = computeSalaryTotals({
        basePayable,
        totalDriverDeduction,
        previousDueAdded,
        previousOwedDeducted,
        manualAddition: ledgerSums.addition,
        manualDeduction: ledgerSums.deduction,
        paidAmount: convertedExistingPaid,
      });
      const { manualAddition, manualDeduction, finalPayable, dueAmount, owedAmount, overpaidAmount, paymentStatus } = totals;
      const paidAmount = totals.paidAmount;
      const salaryData = {
        tenantId,
        company: req.user?.company?._id || req.user?.company || null,
        ownerOperator: owner._id,
        month: range.month,
        year: range.year,
        currency: targetCurrency,
        totalOrders: breakdown.length,
        totalOrderValue,
        totalSettleAmount,
        totalOwnerProfit,
        totalDriverDeduction,
        basePayable,
        previousDueAdded,
        previousOwedDeducted,
        manualDeduction,
        manualAddition,
        finalPayable,
        // Rewritten in the new currency. Omitting it is what re-labelled an old payment.
        paidAmount,
        dueAmount,
        owedAmount,
        overpaidAmount,
        paymentStatus,
        orderBreakdown: breakdown,
        generatedAt: new Date(),
        generatedBy: req.user?._id,
      };

      const salary = await OwnerOperatorSalary.findOneAndUpdate(
        { tenantId, ownerOperator: owner._id, month: range.month, year: range.year },
        salaryData,
        { upsert: true, new: true }
      );

      // Link the month's ledger rows to the payslip and re-snapshot their converted value
      // in the payslip's (possibly new) currency. Without this the rows keep last
      // generation's currency and the statement lists numbers that don't sum to the total.
      if (ledgerRows.length) {
        const decorated = new Map(ledgerSums.rows.map((r) => [String(r._id), r]));
        await Promise.all(
          ledgerRows.map((row) => {
            const dec = decorated.get(String(row._id));
            return OwnerAdjustment.updateOne(
              { _id: row._id, tenantId },
              {
                $set: {
                  salary: salary._id,
                  amountInSalaryCurrency: Number(dec?.convertedAmount || 0),
                  salaryCurrency: targetCurrency,
                  fxRate: Number(dec?.appliedFxRate || 1),
                },
              }
            );
          })
        );
      }

      // Upsert, not create: regenerating a payslip used to append another SALARY_GENERATED
      // row every time, so the owner's financial summary counted the same month N times.
      await OwnerOperatorFinancialRecord.updateOne(
        { tenantId, salary: salary._id, type: 'SALARY_GENERATED' },
        {
          $set: {
            company: req.user?.company?._id || req.user?.company || null,
            ownerOperator: owner._id,
            amount: finalPayable,
            currency: salary.currency || req.tenant?.billing?.currency || 'USD',
            month: range.month,
            year: range.year,
            paymentStatus: salary.paymentStatus === 'owed' ? 'pending' : salary.paymentStatus,
            notes: `Monthly salary generated for ${range.month}/${range.year}`,
            meta: {
              totalOrderValue,
              totalSettleAmount,
              totalOwnerProfit,
              totalDriverDeduction,
              basePayable,
              previousDueAdded,
              previousOwedDeducted,
              manualDeduction,
              manualAddition,
              owedAmount,
              overpaidAmount,
            },
            createdBy: req.user?._id,
          },
        },
        { upsert: true }
      );

      salaries.push(salary);
    }

    logActivity(req, {
      action: 'PAYMENT',
      module: 'payment',
      description: `Generated owner operator salary for ${range.month}/${range.year}`,
      details: { ownerOperatorCount: ownerOperators.length, soloTotal, teamTotal },
    });

    return res.json({ status: true, message: 'Owner operator salary generated', salaries });
  } catch (err) {
    JSONerror(res, err, next);
    logger(err);
  }
});

exports.salaryListings = catchAsync(async (req, res, next) => {
  try {
    if (!hasOwnerOperatorAccess(req)) {
      return res.status(403).json({ status: false, message: 'You are not allowed to access salary data' });
    }
    const tenantId = getTenantId(req);
    const companyId = normalizeCompanyId(req);
    const { month, year, ownerOperatorId, paymentStatus } = req.query;
    const filter = { tenantId };
    if (companyId) filter.company = companyId;
    if (month) filter.month = Number(month);
    if (year) filter.year = Number(year);
    if (ownerOperatorId) filter.ownerOperator = ownerOperatorId;
    if (paymentStatus && ['pending', 'partial', 'paid', 'owed'].includes(paymentStatus)) filter.paymentStatus = paymentStatus;
    const lists = await OwnerOperatorSalary.find(filter)
      .populate('ownerOperator', 'fullName companyName ownerOperatorId status')
      .sort({ year: -1, month: -1, createdAt: -1 })
      .lean();

    // Backward compatibility: old salary records may not have driverMiles/driverAvgRate in breakdown
    const allOrderIds = Array.from(
      new Set(
        (lists || [])
          .flatMap((salary) => (salary?.orderBreakdown || []).map((b) => b?.order).filter(Boolean))
          .map((id) => String(id))
      )
    );
    const fallbackDeds = allOrderIds.length > 0 ? await buildOrderDriverDeductions(tenantId, allOrderIds) : null;
    const orderMetaRows = allOrderIds.length > 0
      ? await Order.find({ tenantId, _id: { $in: allOrderIds } })
          .select('_id serial_no customer_order_no')
          .lean()
      : [];
    const orderMetaMap = new Map(
      (orderMetaRows || []).map((o) => [String(o._id), { serial_no: o.serial_no || null, customer_order_no: o.customer_order_no || null }])
    );

    const enrichedLists = (lists || []).map((salary) => {
      if (!Array.isArray(salary.orderBreakdown)) return salary;
      return {
        ...salary,
        orderBreakdown: salary.orderBreakdown.map((b) => {
          const hasMiles = b?.driverMiles !== undefined && b?.driverMiles !== null && Number(b?.driverMiles || 0) > 0;
          const hasRate = b?.driverAvgRate !== undefined && b?.driverAvgRate !== null && Number(b?.driverAvgRate || 0) > 0;
          if (hasMiles && hasRate) return b;
          const ownerId = salary?.ownerOperator?._id || salary?.ownerOperator;
          const ded = ownerOrderDeduction(fallbackDeds, b?.order || '', ownerId);
          const meta = orderMetaMap.get(String(b?.order || '')) || {};
          const fallbackMiles = Number(ded?.miles || 0);
          const fallbackRate = fallbackMiles > 0 ? Number((ded?.weightedRateMiles || 0) / fallbackMiles) : 0;
          return {
            ...b,
            serial_no: b?.serial_no || meta?.serial_no || null,
            customer_order_no: b?.customer_order_no || meta?.customer_order_no || null,
            driverMiles: hasMiles ? Number(b?.driverMiles || 0) : fallbackMiles,
            driverAvgRate: hasRate ? Number(b?.driverAvgRate || 0) : fallbackRate,
          };
        }),
      };
    });
    return res.json({ status: true, lists: enrichedLists, totalDocuments: lists.length });
  } catch (err) {
    JSONerror(res, err, next);
    logger(err);
  }
});

exports.salaryDetail = catchAsync(async (req, res, next) => {
  try {
    if (!hasOwnerOperatorAccess(req)) {
      return res.status(403).json({ status: false, message: 'You are not allowed to access salary data' });
    }
    const tenantId = getTenantId(req);
    const companyId = normalizeCompanyId(req);
    const filter = { tenantId, _id: req.params.id };
    if (companyId) filter.company = companyId;
    const salary = await OwnerOperatorSalary.findOne(filter)
      .populate('ownerOperator', 'fullName companyName ownerOperatorId status phone email address')
      .lean();
    if (!salary) return res.status(404).json({ status: false, message: 'Payslip not found' });

    // The itemized ledger travels with the payslip so no screen ever has to invent a row
    // to explain a total (the old UI synthesized fake lines when the scalar had no items).
    const salaryCurrency = normalizeCurrency(salary?.currency, req.tenant?.billing?.currency || 'USD');
    const ledgerFx = await getFxRatesMap(tenantId, salary.month, salary.year, salaryCurrency);
    const ledgerRows = await loadLedger(tenantId, salary.ownerOperator?._id || salary.ownerOperator, salary.month, salary.year);
    const ledgerSums = sumAdjustments(ledgerRows, salaryCurrency, ledgerFx);
    const payments = await OwnerOperatorFinancialRecord.find({ tenantId, salary: salary._id, type: 'SALARY_PAYMENT' })
      .sort({ createdAt: -1 })
      .lean();
    const adjustmentPayload = {
      adjustments: ledgerSums.rows,
      adjustmentTotals: {
        addition: ledgerSums.addition,
        deduction: ledgerSums.deduction,
        net: round2(ledgerSums.addition - ledgerSums.deduction),
      },
      payments,
      categories: ADJUSTMENT_CATEGORIES,
    };

    if (!Array.isArray(salary?.orderBreakdown)) {
      return res.json({ status: true, salary, ...adjustmentPayload });
    }

    const orderIds = Array.from(new Set((salary?.orderBreakdown || []).map((b) => b?.order).filter(Boolean).map((id) => String(id))));
    const fallbackDeds = orderIds.length > 0 ? await buildOrderDriverDeductions(tenantId, orderIds) : null;
    const orderMetaRows = orderIds.length > 0
      ? await Order.find({ tenantId, _id: { $in: orderIds } })
          .select('_id serial_no customer_order_no')
          .lean()
      : [];
    const orderMetaMap = new Map(
      (orderMetaRows || []).map((o) => [String(o._id), { serial_no: o.serial_no || null, customer_order_no: o.customer_order_no || null }])
    );
    const enrichedSalary = {
      ...salary,
      orderBreakdown: (salary?.orderBreakdown || []).map((b) => {
        const hasMiles = b?.driverMiles !== undefined && b?.driverMiles !== null && Number(b?.driverMiles || 0) > 0;
        const hasRate = b?.driverAvgRate !== undefined && b?.driverAvgRate !== null && Number(b?.driverAvgRate || 0) > 0;
        if (hasMiles && hasRate && b?.serial_no && b?.customer_order_no) return b;
        const ownerId = salary?.ownerOperator?._id || salary?.ownerOperator;
        const ded = ownerOrderDeduction(fallbackDeds, b?.order || '', ownerId);
        const meta = orderMetaMap.get(String(b?.order || '')) || {};
        const fallbackMiles = Number(ded?.miles || 0);
        const fallbackRate = fallbackMiles > 0 ? Number((ded?.weightedRateMiles || 0) / fallbackMiles) : 0;
        return {
          ...b,
          serial_no: b?.serial_no || meta?.serial_no || null,
          customer_order_no: b?.customer_order_no || meta?.customer_order_no || null,
          driverMiles: hasMiles ? Number(b?.driverMiles || 0) : fallbackMiles,
          driverAvgRate: hasRate ? Number(b?.driverAvgRate || 0) : fallbackRate,
        };
      }),
    };

    return res.json({ status: true, salary: enrichedSalary, ...adjustmentPayload });
  } catch (err) {
    JSONerror(res, err, next);
    logger(err);
  }
});

exports.salaryStatementPdf = catchAsync(async (req, res, next) => {
  let browser = null;
  try {
    if (!hasOwnerOperatorAccess(req)) {
      return res.status(403).json({ status: false, message: 'You are not allowed to access salary data' });
    }
    const tenantId = getTenantId(req);
    const companyId = normalizeCompanyId(req);
    const filter = { tenantId, _id: req.params.id };
    if (companyId) filter.company = companyId;
    const salary = await OwnerOperatorSalary.findOne(filter)
      .populate('ownerOperator', 'fullName companyName ownerOperatorId status phone email address')
      .lean();
    if (!salary) return res.status(404).json({ status: false, message: 'Payslip not found' });

    const includePreviousDueParam = req.query?.includePreviousDue;
    const shouldIncludePrevDue =
      includePreviousDueParam === 'true' ||
      includePreviousDueParam === true ||
      (includePreviousDueParam === undefined && Number(salary?.previousDueAdded || 0) > 0);

    const payoutCurrency = req.query?.payoutCurrency || salary?.currency || req.tenant?.billing?.currency || 'USD';
    const targetCurrency = normalizeCurrency(payoutCurrency, salary?.currency || req.tenant?.billing?.currency || 'USD');
    const range = buildDateRange(salary.month, salary.year);
    if (!range) return res.status(400).json({ status: false, message: 'Invalid month/year on salary record' });

    let companyLogoUrl = req.tenant?.settings?.customizations?.theme?.logo || '';
    if (companyId) {
      const Company = require('../db/Company');
      const companyDoc = await Company.findOne({ _id: companyId, tenantId }).lean();
      if (companyDoc && (companyDoc.pdf_logo || companyDoc.logo)) {
        companyLogoUrl = companyDoc.pdf_logo || companyDoc.logo;
      }
    }
    
    if (!companyLogoUrl) {
      // No company logo uploaded — embed the bundled default logo as a base64 data URI so it
      // always renders in the PDF (no dependency on DOMAIN_URL being reachable from puppeteer).
      try {
        const fs = require('fs');
        const path = require('path');
        const logoBuf = fs.readFileSync(path.join(__dirname, '..', 'assets', 'logo.png'));
        companyLogoUrl = `data:image/png;base64,${logoBuf.toString('base64')}`;
      } catch (e) {
        const domainUrl = process.env.DOMAIN_URL || 'http://localhost:3000';
        companyLogoUrl = `${domainUrl}/logo.png`;
      }
    }

    const owner = salary?.ownerOperator;
    if (!owner?._id) return res.status(400).json({ status: false, message: 'Owner operator not found on salary record' });

    const orders = await Order.find({
      tenantId,
      order_type: 'regular',
      isOwnerOperatedTruck: true,
      createdAt: { $gte: range.from, $lte: range.to },
      $and: [ownerOrderMatch([owner._id]), normalizeDeletedFilter()],
    })
      .select(`${OWNER_ORDER_FIELDS} shipping_details truck createdAt`)
      .populate('truck', 'plateNumber unitNumber')
      .lean();

    const fxRatesMap = await getFxRatesMap(tenantId, range.month, range.year, targetCurrency);
    const orderIds = orders.map((o) => o._id);
    const deds = await buildOrderDriverDeductions(tenantId, orderIds);

    const allDriverIds = new Set();
    deds.byOrder.forEach((v) => v.drivers.forEach((id) => allDriverIds.add(String(id))));
    const driverDocs = allDriverIds.size > 0
      ? await Users.find({ _id: { $in: Array.from(allDriverIds) } }, { _id: 1, name: 1 }).lean()
      : [];
    const driverNameMap = new Map(driverDocs.map((u) => [String(u._id), u.name || '']));

    const orderBreakdown = orders.map((o) => {
      const ded = ownerOrderDeduction(deds, o._id, owner._id);
      const amounts = resolveOwnerOrderAmounts(o, ded, targetCurrency, fxRatesMap);
      const driverNames = Array.from(ded?.drivers || []).map((id) => driverNameMap.get(String(id)) || '').filter(Boolean);
      return {
        order: o._id,
        serial_no: o.serial_no || null,
        customer_order_no: o.customer_order_no || null,
        shipping_details: Array.isArray(o.shipping_details) ? o.shipping_details : [],
        truck: o.truck || null,
        orderCreatedAt: o.createdAt || null,
        driverNames,
        driverMiles: Number(ded?.miles || 0),
        isMixedOwner: !!o.isMixedOwner,
        orderPrice: amounts.orderPrice,
        settleAmount: amounts.settleAmount,
        ownerProfit: amounts.ownerProfit,
        driverDeduction: amounts.deduction,
        payable: amounts.payable,
      };
    });

    const salaryCurrency = normalizeCurrency(salary?.currency, targetCurrency);
    const basePayableFromBreakdown = orderBreakdown.reduce((a, x) => a + Number(x.settleAmount || 0), 0);
    const totalDriverDeductionFromBreakdown = orderBreakdown.reduce((a, x) => a + Number(x.driverDeduction || 0), 0);
    const basePayable = salary?.basePayable != null
      ? Number(convertAmount(salary.basePayable, salaryCurrency, targetCurrency, fxRatesMap).value || 0)
      : basePayableFromBreakdown;
    const totalDriverDeduction = salary?.totalDriverDeduction != null
      ? Number(convertAmount(salary.totalDriverDeduction, salaryCurrency, targetCurrency, fxRatesMap).value || 0)
      : totalDriverDeductionFromBreakdown;

    let autoPreviousDue = 0;
    if (salary?.previousDueAdded != null) {
      autoPreviousDue = Number(convertAmount(salary.previousDueAdded, salaryCurrency, targetCurrency, fxRatesMap).value || 0);
    } else {
      const previousSalary = await OwnerOperatorSalary.findOne({
        tenantId,
        ownerOperator: owner._id,
        $or: [
          { year: { $lt: range.year } },
          { year: range.year, month: { $lt: range.month } },
        ],
      })
        .sort({ year: -1, month: -1 })
        .select('currency dueAmount')
        .lean();
      if (previousSalary) {
        const previousSalaryCurrency = normalizeCurrency(previousSalary.currency, targetCurrency);
        autoPreviousDue = Number(convertAmount(previousSalary.dueAmount, previousSalaryCurrency, targetCurrency, fxRatesMap).value || 0);
      }
    }

    const previousDueAdded = shouldIncludePrevDue ? autoPreviousDue : 0;
    const previousOwedDeducted = shouldIncludePrevDue
      ? Number(convertAmount(salary?.previousOwedDeducted, salaryCurrency, targetCurrency, fxRatesMap).value || 0)
      : 0;

    // Additions/deductions are printed line by line from the ledger, converted into the
    // payout currency — the same rows the totals are summed from. The old statement
    // printed one lump "Manual Deduction" figure and listed the underlying records at
    // their UNCONVERTED amounts, so the lines and the total disagreed whenever the payout
    // currency differed from the payslip currency.
    const ledgerRows = await loadLedger(tenantId, owner._id, range.month, range.year);
    const ledgerSums = sumAdjustments(ledgerRows, targetCurrency, fxRatesMap);
    const adjustmentLines = ledgerSums.rows;
    const manualAddition = ledgerSums.addition;
    const manualDeduction = ledgerSums.deduction;

    const pdfTotals = computeSalaryTotals({
      basePayable,
      totalDriverDeduction,
      previousDueAdded,
      previousOwedDeducted,
      manualAddition,
      manualDeduction,
      paidAmount: Number(convertAmount(salary?.paidAmount, salaryCurrency, targetCurrency, fxRatesMap).value || 0),
    });
    const finalPayable = pdfTotals.finalPayable;
    const paidAmount = pdfTotals.paidAmount;
    const dueAmount = pdfTotals.dueAmount;
    const owedAmount = pdfTotals.owedAmount;
    const overpaidAmount = pdfTotals.overpaidAmount;

    const paymentRecords = await OwnerOperatorFinancialRecord.find({
      tenantId,
      ownerOperator: owner._id,
      month: range.month,
      year: range.year,
      type: 'SALARY_PAYMENT',
    })
      .sort({ createdAt: -1 })
      .lean();
    // Payment rows are stored in the payslip currency; convert them into the payout
    // currency so every number on the page is denominated the same way.
    const records = paymentRecords.map((r) => ({
      ...r,
      amount: round2(convertAmount(Number(r.amount || 0), normalizeCurrency(r.currency, salaryCurrency), targetCurrency, fxRatesMap).value),
      currency: targetCurrency,
    }));

    const companyName = String(req.tenant?.settings?.customizations?.branding?.companyName || req.tenant?.name || 'Company');
    const companyAddress = String(req.tenant?.contactInfo?.address || '').trim();
    const companyEmail = String(req.tenant?.contactInfo?.adminEmail || '').trim();
    const companyPhone = String(req.tenant?.contactInfo?.phone || '').trim();
    const companyLogo = companyLogoUrl;

    const fmtMoney = (n) => new Intl.NumberFormat('en-CA', { style: 'currency', currency: targetCurrency }).format(Number(n || 0));
    const fmtDate = (d) => {
      if (!d) return '-';
      const dt = d instanceof Date ? d : new Date(d);
      if (Number.isNaN(dt.getTime())) return '-';
      return dt.toLocaleDateString('en-CA');
    };
    const safe = (v) => String(v == null ? '' : v)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');

    const routeLabel = (shipping) => {
      const blocks = Array.isArray(shipping) ? shipping : [];
      const locs = blocks.flatMap((b) => Array.isArray(b?.locations) ? b.locations : []);
      const pickup = locs.find((l) => String(l?.type || '').toLowerCase() === 'pickup') || locs[0] || null;
      const delivery = [...locs].reverse().find((l) => String(l?.type || '').toLowerCase() === 'delivery') || locs[locs.length - 1] || null;
      const pickupCity = pickup?.location || pickup?.address || '';
      const deliveryCity = delivery?.location || delivery?.address || '';
      const pickupDate = pickup?.date || pickup?.pickup_date || pickup?.datetime || null;
      const deliveryDate = delivery?.date || delivery?.delivery_date || delivery?.datetime || null;
      return {
        pickupText: `${fmtDate(pickupDate)}  ${String(pickupCity || '').trim()}`.trim(),
        deliveryText: `${fmtDate(deliveryDate)}  ${String(deliveryCity || '').trim()}`.trim(),
      };
    };

    const orderRowsHtml = orderBreakdown
      .map((r) => {
        const route = routeLabel(r?.shipping_details);
        const truckUnit = r?.truck?.unitNumber || '';
        const truckPlate = r?.truck?.plateNumber || '';
        const truckCell = truckUnit
          ? `<span style="font-weight:700">${safe(truckUnit)}</span>${truckPlate ? `<br/><span style="font-size:8px;color:#64748b">${safe(truckPlate)}</span>` : ''}`
          : (truckPlate ? safe(truckPlate) : '&mdash;');
        const driverDed = Number(r?.driverDeduction || 0);
        return `
          <tr>
            <td style="font-family:'Courier New',monospace;font-weight:700;color:#1e40af">${safe(r?.serial_no || '&mdash;')}</td>
            <td style="font-family:'Courier New',monospace">${safe(r?.customer_order_no || '&mdash;')}</td>
            <td>${truckCell}</td>
            <td>${safe(route.pickupText)}</td>
            <td>${safe(route.deliveryText)}</td>
            <td class="num" style="font-family:'Courier New',monospace">&mdash;</td>
            <td class="num" style="color:#1e40af;font-weight:700;font-family:'Courier New',monospace">${safe(fmtMoney(r?.settleAmount || 0))}</td>
            <td class="num" style="color:${driverDed > 0 ? '#dc2626' : '#94a3b8'};font-family:'Courier New',monospace">${driverDed > 0 ? `-${safe(fmtMoney(driverDed))}` : '&mdash;'}${r?.driverNames?.length ? `<br/><span style="font-size:8px;color:#64748b;font-weight:400">${safe(r.driverNames.join(', '))}</span>` : ''}</td>
          </tr>
        `;
      })
      .join('');

    // One row per real thing that happened this month: every adjustment line (with its own
    // category and reason) and every payment. A reader must be able to see WHY a deduction
    // exists, not just that the payout shrank.
    const ledgerHtml = adjustmentLines.map((a) => {
      const isDeduction = a.kind === 'deduction';
      const typed = Number(a.amount || 0);
      const shown = Number(a.convertedAmount || 0);
      const showOriginal = String(a.currency || '').toUpperCase() !== String(targetCurrency).toUpperCase() && typed > 0;
      return `
        <tr>
          <td style="font-family:'Courier New',monospace;font-size:9px">${safe(fmtDate(a?.date || a?.createdAt))}</td>
          <td><span style="font-weight:700">${safe(a.categoryLabel || 'Other')}</span>${a.recurring ? '<span style="font-size:7px;color:#64748b;border:1px solid #cbd5e1;border-radius:3px;padding:0 3px;margin-left:4px">MONTHLY</span>' : ''}</td>
          <td class="num" style="color:${isDeduction ? '#dc2626' : '#065f46'};font-weight:700;font-family:'Courier New',monospace">
            ${isDeduction ? '-' : '+'}${safe(fmtMoney(shown))}
            ${showOriginal ? `<div style="font-size:7px;color:#94a3b8;font-weight:400">${safe(String(a.currency).toUpperCase())} ${safe(typed.toFixed(2))} @ ${safe(Number(a.appliedFxRate || 1).toFixed(4))}</div>` : ''}
          </td>
          <td style="font-size:9px;color:#64748b">${safe(String(a?.notes || '').slice(0, 60))}${a?.reference ? ` <span style="color:#94a3b8">(${safe(String(a.reference).slice(0, 20))})</span>` : ''}</td>
        </tr>
      `;
    }).join('');

    const recordsHtml = ledgerHtml + (records || []).map((r) => `
        <tr>
          <td style="font-family:'Courier New',monospace;font-size:9px">${safe(fmtDate(r?.date || r?.createdAt))}</td>
          <td>Payment</td>
          <td class="num" style="color:#0f172a;font-weight:700;font-family:'Courier New',monospace">${safe(fmtMoney(Math.abs(Number(r?.amount || 0))))}</td>
          <td style="font-size:9px;color:#64748b">${safe(String(r?.notes || '').slice(0, 60))}</td>
        </tr>
      `).join('');

    // The summary lists adjustments BY CATEGORY, not as one "Manual Deduction" lump. An
    // owner reading a smaller payout has to be able to see it was insurance + an advance,
    // without cross-referencing the transaction table.
    const summaryAdjustmentRows = (() => {
      const groups = new Map();
      adjustmentLines.forEach((a) => {
        const key = `${a.kind}|${a.category}`;
        const prev = groups.get(key) || { kind: a.kind, label: a.categoryLabel, amount: 0, count: 0 };
        prev.amount += Number(a.convertedAmount || 0);
        prev.count += 1;
        groups.set(key, prev);
      });
      return Array.from(groups.values())
        .sort((a, b) => (a.kind === b.kind ? b.amount - a.amount : a.kind === 'addition' ? -1 : 1))
        .map((g) => {
          const isAdd = g.kind === 'addition';
          const label = g.count > 1 ? `${g.label} (${g.count})` : g.label;
          return `<tr><td class="lbl">${safe(label)}</td><td class="amt ${isAdd ? 'green' : 'red'}">${isAdd ? '+' : '&#8722;'} ${safe(fmtMoney(g.amount))}</td></tr>`;
        })
        .join('');
    })();

    const payPeriodFrom = new Date(range.year, range.month - 1, 1);
    const payPeriodTo = new Date(range.year, range.month, 0);
    const paymentNo = salary?._id ? String(salary._id).slice(-6) : '';
    const lastPaymentRecord = (records || []).find((r) => r.type === 'SALARY_PAYMENT');
    const paymentDate = lastPaymentRecord?.createdAt || null;
    const stmtNo = `OOS-${String(salary._id).slice(-8).toUpperCase()}`;
    const payStatus = String(pdfTotals.paymentStatus || salary?.paymentStatus || 'pending');
    const STATUS_META = {
      paid: { label: 'PAID', color: '#4ade80' },
      partial: { label: 'PARTIAL', color: '#fbbf24' },
      // Deductions exceeded earnings — the owner carries a balance TO the company.
      owed: { label: 'BALANCE OWED', color: '#fb7185' },
      pending: { label: 'PENDING', color: '#f87171' },
    };
    const statusLabel = (STATUS_META[payStatus] || STATUS_META.pending).label;
    const statusColor = (STATUS_META[payStatus] || STATUS_META.pending).color;

    const html = `
      <!doctype html>
      <html>
        <head>
          <meta charset="utf-8" />
          <style>
            @page { size: A4; margin: 0; }
            html, body { padding: 0; margin: 0; background: #fff; }
            body { font-family: Arial, Helvetica, sans-serif; font-size: 11px; color: #0f172a; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
            * { box-sizing: border-box; }

            .header { background: linear-gradient(135deg, #1e3a5f 0%, #1e40af 100%); padding: 22px 28px 20px; display: flex; justify-content: space-between; align-items: flex-start; gap: 20px; }
            .header-left { flex: 1; }
            .header-right { flex-shrink: 0; text-align: right; }
            .company-name { font-size: 20px; font-weight: 900; color: #fff; letter-spacing: 1.5px; line-height: 1; margin-bottom: 4px; }
            .accent-bar { width: 36px; height: 3px; background: #f59e0b; border-radius: 2px; margin-bottom: 8px; }
            .company-info { color: #93c5fd; font-size: 10px; line-height: 1.7; }
            .stmt-title-1 { font-size: 24px; font-weight: 900; color: #fff; letter-spacing: 1px; line-height: 1; }
            .stmt-title-2 { font-size: 24px; font-weight: 900; color: #f59e0b; letter-spacing: 1px; line-height: 1; margin-bottom: 12px; }
            .stmt-box { background: rgba(255,255,255,0.12); border-radius: 8px; padding: 8px 12px; min-width: 200px; }
            .stmt-row { display: flex; justify-content: space-between; margin-bottom: 4px; align-items: center; }
            .stmt-row:last-child { margin-bottom: 0; }
            .stmt-label { font-size: 9px; color: #93c5fd; font-weight: 600; }
            .stmt-val { font-size: 10px; color: #fff; font-family: "Courier New", monospace; font-weight: 700; }

            .from-to { display: flex; border-bottom: 1px solid #e2e8f0; }
            .from-box { flex: 1; padding: 16px 22px; border-right: 1px solid #e2e8f0; }
            .to-box { flex: 1; padding: 16px 22px; background: #f0f7ff; }
            .box-label { font-size: 8px; font-weight: 800; color: #64748b; letter-spacing: 1.5px; text-transform: uppercase; margin-bottom: 8px; }
            .to-box .box-label { color: #1e3a5f; }
            .company-title { font-size: 13px; font-weight: 800; color: #0f172a; margin-bottom: 3px; }
            .owner-name { font-size: 16px; font-weight: 900; color: #0f172a; margin-bottom: 2px; }
            .owner-id { display: inline-block; font-size: 9px; font-weight: 700; color: #1e40af; background: #dbeafe; padding: 2px 8px; border-radius: 12px; margin-bottom: 6px; font-family: "Courier New", monospace; }
            .info-line { font-size: 10px; color: #475569; margin-top: 2px; }
            .period-pill { margin-top: 10px; padding: 6px 10px; background: #f8fafc; border-radius: 5px; border-left: 3px solid #1e3a5f; }
            .period-lbl { font-size: 9px; color: #64748b; }
            .period-val { font-size: 10px; font-weight: 700; color: #1e3a5f; font-family: "Courier New", monospace; }

            .section { padding: 14px 22px 0; }
            .section-title { font-size: 9px; font-weight: 800; color: #1e3a5f; letter-spacing: 1.5px; text-transform: uppercase; margin-bottom: 8px; display: flex; align-items: center; gap: 7px; }
            .section-bar { display: inline-block; width: 4px; height: 13px; background: #1e3a5f; border-radius: 2px; vertical-align: middle; margin-right: 5px; }

            table.orders { width: 100%; border-collapse: collapse; }
            table.orders th { background: #1e3a5f; color: #fff; font-size: 9px; font-weight: 700; padding: 7px 8px; border: 1px solid #1e3a5f; text-align: left; white-space: nowrap; }
            table.orders td { font-size: 9px; padding: 6px 8px; border: 1px solid #e2e8f0; vertical-align: top; color: #0f172a; }
            table.orders tbody tr:nth-child(even) td { background: #f8fafc; }
            table.orders tfoot td { background: #eef2ff; font-weight: 800; border-top: 2px solid #1e3a5f; color: #1e3a5f; font-size: 10px; }
            table.orders .num { text-align: right; white-space: nowrap; font-family: "Courier New", monospace; }
            thead { display: table-header-group; }
            tr { break-inside: avoid; page-break-inside: avoid; }

            .lower { display: flex; padding: 14px 22px; gap: 0; border-top: 1px solid #f1f5f9; margin-top: 12px; }
            .lower-left { flex: 1; padding-right: 18px; }
            .lower-right { flex: 1; padding-left: 18px; border-left: 1px solid #e2e8f0; }

            table.records { width: 100%; border-collapse: collapse; }
            table.records th { background: #374151; color: #fff; font-size: 9px; font-weight: 700; padding: 6px 8px; border: 1px solid #374151; text-align: left; }
            table.records td { font-size: 9px; padding: 6px 8px; border: 1px solid #e2e8f0; vertical-align: top; color: #0f172a; }
            table.records tbody tr:nth-child(even) td { background: #f9fafb; }
            table.records .num { text-align: right; white-space: nowrap; font-family: "Courier New", monospace; }

            table.summary { width: 100%; border-collapse: collapse; }
            table.summary td { padding: 6px 9px; font-size: 10px; border-bottom: 1px solid #f1f5f9; }
            table.summary .lbl { color: #475569; }
            table.summary .amt { text-align: right; font-family: "Courier New", monospace; font-weight: 700; white-space: nowrap; }
            .net-row td { background: #f0f7ff !important; font-weight: 800 !important; font-size: 12px !important; color: #1e3a5f !important; border-top: 2px solid #1e3a5f !important; border-bottom: 2px solid #1e3a5f !important; padding: 8px 9px !important; }

            .balance-due { margin-top: 10px; background: linear-gradient(135deg, #1e3a5f 0%, #1e40af 100%); border-radius: 8px; padding: 13px 15px; display: flex; justify-content: space-between; align-items: center; }
            .balance-lbl { color: #93c5fd; font-size: 8px; font-weight: 700; letter-spacing: 1.5px; text-transform: uppercase; }
            .balance-sub { color: #93c5fd; font-size: 8px; margin-top: 2px; opacity: 0.7; }
            .balance-amt { color: #f59e0b; font-size: 20px; font-weight: 900; font-family: "Courier New", monospace; }

            .footer { background: #f8fafc; border-top: 1px solid #e2e8f0; padding: 10px 28px; display: flex; justify-content: space-between; align-items: center; margin-top: 8px; }
            .footer-txt { font-size: 8px; color: #94a3b8; }
            .mono { font-family: "Courier New", monospace; }
            .blue { color: #1e40af; font-weight: 700; }
            .red { color: #dc2626; font-weight: 700; }
            .green { color: #065f46; font-weight: 700; }
          </style>
        </head>
        <body>

          <!-- Header -->
          <div class="header">
            <div class="header-left">
              ${companyLogo ? `<img src="${safe(companyLogo)}" alt="Logo" style="max-height:48px;max-width:180px;display:block;margin-bottom:12px;object-fit:contain;filter:brightness(0) invert(1);" />` : `<div class="company-name">${safe(companyName)}</div>`}
              <div class="accent-bar"></div>
              <div class="company-info">
                ${companyAddress ? `<div>${safe(companyAddress)}</div>` : ''}
                ${companyPhone ? `<div>Tel: ${safe(companyPhone)}</div>` : ''}
                ${companyEmail ? `<div>${safe(companyEmail)}</div>` : ''}
              </div>
            </div>
            <div class="header-right">
              <div style="font-size:9px;color:#93c5fd;letter-spacing:3px;font-weight:700;text-transform:uppercase;margin-bottom:3px;">Owner Operator</div>
              <div class="stmt-title-1">PAYMENT</div>
              <div class="stmt-title-2">STATEMENT</div>
              <div class="stmt-box">
                <div class="stmt-row"><span class="stmt-label">STATEMENT #</span><span class="stmt-val">${safe(stmtNo)}</span></div>
                <div class="stmt-row"><span class="stmt-label">DATE</span><span class="stmt-val">${safe(fmtDate(new Date()))}</span></div>
                <div class="stmt-row"><span class="stmt-label">PERIOD</span><span class="stmt-val">${safe(new Date(range.year, range.month - 1, 1).toLocaleString('en-US', { month: 'short', year: 'numeric' }))}</span></div>
                <div class="stmt-row"><span class="stmt-label">STATUS</span><span class="stmt-val" style="color:${statusColor}">${safe(statusLabel)}</span></div>
              </div>
            </div>
          </div>

          <!-- FROM / PAY TO -->
          <div class="from-to">
            <div class="from-box">
              <div class="box-label">From</div>
              <div class="company-title">${safe(companyName)}</div>
              ${companyAddress ? `<div class="info-line">${safe(companyAddress)}</div>` : ''}
              ${companyPhone ? `<div class="info-line">Tel: ${safe(companyPhone)}</div>` : ''}
              ${companyEmail ? `<div class="info-line">${safe(companyEmail)}</div>` : ''}
              <div class="period-pill">
                <div class="period-lbl">Pay Period</div>
                <div class="period-val">${safe(fmtDate(payPeriodFrom))} &mdash; ${safe(fmtDate(payPeriodTo))}</div>
              </div>
            </div>
            <div class="to-box">
              <div class="box-label">Pay To</div>
              <div class="owner-name">${safe(owner?.fullName || '')}</div>
              ${owner?.companyName ? `<div style="font-size:11px;font-weight:600;color:#334155;margin-bottom:4px;">${safe(owner.companyName)}</div>` : ''}
              <div class="owner-id">ID: ${safe(owner?.ownerOperatorId || '-')}</div>
              ${owner?.address ? `<div class="info-line">${safe(owner.address)}</div>` : ''}
              ${owner?.email ? `<div class="info-line">${safe(owner.email)}</div>` : ''}
              ${owner?.phone ? `<div class="info-line">${safe(owner.phone)}</div>` : ''}
            </div>
          </div>

          <!-- Order Breakdown -->
          <div class="section">
            <div class="section-title">
              <span class="section-bar"></span>
              Order Breakdown &mdash; ${safe(new Date(range.year, range.month - 1, 1).toLocaleString('en-US', { month: 'short', year: 'numeric' }))}
              &nbsp;<span style="font-size:9px;font-weight:600;color:#64748b;">(${orderBreakdown.length} orders)</span>
            </div>
            <table class="orders">
              <thead>
                <tr>
                  <th style="width:6%">Trip #</th>
                  <th style="width:10%">Invoice #</th>
                  <th style="width:8%">Truck</th>
                  <th style="width:22%">Pickup</th>
                  <th style="width:22%">Delivery</th>
                  <th class="num" style="width:7%">Miles</th>
                  <th class="num" style="width:12%">Settlement</th>
                  <th class="num" style="width:13%">Driver Cost</th>
                </tr>
              </thead>
              <tbody>
                ${orderRowsHtml || '<tr><td colspan="8" style="text-align:center;color:#94a3b8;padding:14px;font-style:italic;">No orders found for this period</td></tr>'}
              </tbody>
              <tfoot>
                <tr>
                  <td colspan="5">TOTAL</td>
                  <td class="num mono">${safe(String(orderBreakdown.reduce((s, r) => s + Number(r?.driverMiles || 0), 0).toFixed(0)))}</td>
                  <td class="num mono blue">${safe(fmtMoney(basePayable))}</td>
                  <td class="num mono red">${totalDriverDeduction > 0 ? `-${safe(fmtMoney(totalDriverDeduction))}` : '&mdash;'}</td>
                </tr>
              </tfoot>
            </table>
          </div>

          <!-- Lower: Records + Summary -->
          <div class="lower">
            <div class="lower-left">
              <div class="section-title" style="color:#374151;">
                <span class="section-bar" style="background:#374151;"></span>
                Transaction Records
              </div>
              <table class="records">
                <thead>
                  <tr>
                    <th style="width:25%">Date</th>
                    <th style="width:28%">Type</th>
                    <th class="num" style="width:28%">Amount</th>
                    <th style="width:19%">Notes</th>
                  </tr>
                </thead>
                <tbody>
                  ${recordsHtml || '<tr><td colspan="4" style="text-align:center;color:#94a3b8;padding:12px;font-style:italic;">No records</td></tr>'}
                </tbody>
              </table>
            </div>

            <div class="lower-right">
              <div class="section-title">
                <span class="section-bar"></span>
                Earnings Summary
              </div>
              <table class="summary">
                <tbody>
                  <tr><td class="lbl">Gross Settlement</td><td class="amt">${safe(fmtMoney(basePayable))}</td></tr>
                  <tr><td class="lbl">Driver Salary Deduction</td><td class="amt red">&#8722; ${safe(fmtMoney(totalDriverDeduction))}</td></tr>
                  ${previousDueAdded > 0 ? `<tr><td class="lbl">Previous Month Due</td><td class="amt green">+ ${safe(fmtMoney(previousDueAdded))}</td></tr>` : ''}
                  ${previousOwedDeducted > 0 ? `<tr><td class="lbl">Previous Month Balance Owed</td><td class="amt red">&#8722; ${safe(fmtMoney(previousOwedDeducted))}</td></tr>` : ''}
                  ${summaryAdjustmentRows}
                  <tr class="net-row"><td class="lbl">Net Payable</td><td class="amt">${safe(fmtMoney(finalPayable))}</td></tr>
                  <tr><td class="lbl">Amount Paid</td><td class="amt green">&#8722; ${safe(fmtMoney(paidAmount))}</td></tr>
                </tbody>
              </table>
              <div class="balance-due"${owedAmount > 0 ? ' style="background:#7f1d1d"' : ''}>
                <div>
                  <div class="balance-lbl">${owedAmount > 0 ? 'Balance Owed to Company' : 'Balance Due'}</div>
                  ${paymentDate ? `<div class="balance-sub">Last payment: ${safe(fmtDate(paymentDate))}</div>` : ''}
                  ${owedAmount > 0 ? '<div class="balance-sub">Deductions exceeded earnings &mdash; carried to next month</div>' : ''}
                  ${overpaidAmount > 0 ? `<div class="balance-sub">Overpaid by ${safe(fmtMoney(overpaidAmount))} &mdash; recoverable</div>` : ''}
                </div>
                <div class="balance-amt">${safe(fmtMoney(owedAmount > 0 ? owedAmount : dueAmount))}</div>
              </div>
              ${paymentNo ? `<div style="margin-top:6px;font-size:8px;color:#94a3b8;text-align:right;font-family:'Courier New',monospace;">Receipt: ${safe(paymentNo)}</div>` : ''}
            </div>
          </div>

          <!-- Footer -->
          <div class="footer">
            <div class="footer-txt">${safe(stmtNo)} &bull; ${safe(new Date(range.year, range.month - 1, 1).toLocaleString('en-US', { month: 'long', year: 'numeric' }))} &bull; Generated ${safe(fmtDate(new Date()))}</div>
            <div class="footer-txt">Computer-generated statement &mdash; No signature required</div>
          </div>

        </body>
      </html>
    `;

    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'load', timeout: 20000 }).catch(() => {});
    const pdfBuffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '10mm', bottom: '10mm', left: '12mm', right: '12mm' },
    });

    const safeOwner = String(owner?.fullName || 'owner').replace(/[^a-z0-9-_]+/gi, '_');

    logActivity(req, {
      action: 'DOWNLOAD',
      module: 'payment',
      description: `Downloaded owner operator statement for "${owner?.fullName || 'owner'}" (${range.month}/${range.year})`,
      resourceId: owner?._id || null,
      resourceName: owner?.fullName || 'owner',
      details: { month: range.month, year: range.year },
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="OwnerOperator_Statement_${safeOwner}_${range.month}_${range.year}.pdf"`);
    return res.status(200).send(Buffer.from(pdfBuffer));
  } catch (err) {
    JSONerror(res, err, next);
    logger(err);
  } finally {
    try {
      if (browser) await browser.close();
    } catch (e) {
    }
  }
});

exports.removeSalarySlip = catchAsync(async (req, res, next) => {
  try {
    if (!hasOwnerOperatorAccess(req)) {
      return res.status(403).json({ status: false, message: 'You are not allowed to remove payslips' });
    }
    const tenantId = getTenantId(req);
    const salary = await OwnerOperatorSalary.findOne({ _id: req.params.id, tenantId });
    if (!salary) return res.status(404).json({ status: false, message: 'Payslip not found' });

    // Deleting a payslip must not erase the owner's adjustment ledger — an advance the
    // owner was handed in cash is a fact about the month, not about the document. The rows
    // are unlinked and survive; regenerating the payslip picks them up again.
    const unlinked = await OwnerAdjustment.updateMany(
      { tenantId, salary: salary._id },
      { $set: { salary: null } }
    );
    await OwnerOperatorFinancialRecord.deleteMany({ tenantId, salary: salary._id, type: { $ne: 'ADJUSTMENT' } });
    await OwnerOperatorFinancialRecord.updateMany(
      { tenantId, salary: salary._id, type: 'ADJUSTMENT' },
      { $set: { salary: null } }
    );
    await OwnerOperatorSalary.deleteOne({ _id: salary._id, tenantId });

    logChange(req, {
      model: 'OwnerOperatorSalary',
      module: 'payment',
      action: 'DELETE',
      before: salary.toObject(),
      after: null,
      logUnchanged: true,
      // Deleting a payslip that money has already moved against rewrites reported figures.
      critical: Number(salary.paidAmount || 0) > 0,
      description: `Removed owner operator payslip (${salary.month}/${salary.year})`,
      resourceId: salary._id,
      resourceName: `Owner statement ${salary.month}/${salary.year}`,
      details: {
        ownerOperator: salary.ownerOperator,
        month: salary.month,
        year: salary.year,
        finalPayable: salary.finalPayable,
        paidAmount: salary.paidAmount,
        currency: salary.currency,
        adjustmentsKept: unlinked?.modifiedCount || 0,
      },
    });

    return res.json({
      status: true,
      message: unlinked?.modifiedCount
        ? `Payslip removed. ${unlinked.modifiedCount} adjustment line(s) kept for the month.`
        : 'Payslip removed successfully',
    });
  } catch (err) {
    JSONerror(res, err, next);
    logger(err);
  }
});

exports.updateSalaryPayment = catchAsync(async (req, res, next) => {
  try {
    if (!hasOwnerOperatorAccess(req)) {
      return res.status(403).json({ status: false, message: 'You are not allowed to update salary payment' });
    }
    const tenantId = getTenantId(req);
    const salary = await OwnerOperatorSalary.findOne({ _id: req.params.id, tenantId });
    if (!salary) return res.status(404).json({ status: false, message: 'Salary record not found' });
    const beforeSalary = salary.toObject();
    const amount = Number(req.body?.amount || 0);
    const notes = String(req.body?.notes || '').trim();
    if (amount <= 0) return res.status(400).json({ status: false, message: 'Payment amount should be greater than 0' });
    const salaryCurrency = normalizeCurrency(salary?.currency, req.tenant?.billing?.currency || 'USD');
    const inputCurrency = normalizeCurrency(req.body?.currency, salaryCurrency);
    const fxRatesMap = await getFxRatesMap(tenantId, salary.month, salary.year, salaryCurrency);
    const convertedAmount = Number(convertAmount(amount, inputCurrency, salaryCurrency, fxRatesMap).value || 0);
    if (convertedAmount <= 0) return res.status(400).json({ status: false, message: 'Converted payment amount should be greater than 0' });

    const finalPayable = round2(salary.finalPayable);
    const alreadyPaid = round2(salary.paidAmount);
    const nextPaid = round2(alreadyPaid + convertedAmount);
    const payableFloor = Math.max(finalPayable, 0);

    // The old code silently clamped paid to payable: type 5,000 against a 3,000 due and the
    // API recorded 3,000 and answered "updated". The excess is now refused unless the caller
    // says it is intentional (an on-purpose advance against next month), and then it is
    // recorded as `overpaidAmount` rather than thrown away.
    if (nextPaid - payableFloor > EPSILON && !req.body?.allowOverpay) {
      return res.status(409).json({
        status: false,
        code: 'overpayment',
        message: `That is more than the ${salaryCurrency} ${(payableFloor - alreadyPaid).toFixed(2)} still owed on this payslip.`,
        dueAmount: round2(Math.max(payableFloor - alreadyPaid, 0)),
        excess: round2(nextPaid - payableFloor),
        currency: salaryCurrency,
      });
    }

    const totals = computeSalaryTotals({
      basePayable: resolveBasePayable(salary),
      totalDriverDeduction: salary.totalDriverDeduction,
      previousDueAdded: salary.previousDueAdded,
      previousOwedDeducted: salary.previousOwedDeducted,
      manualAddition: salary.manualAddition,
      manualDeduction: salary.manualDeduction,
      paidAmount: nextPaid,
    });
    salary.paidAmount = totals.paidAmount;
    salary.dueAmount = totals.dueAmount;
    salary.owedAmount = totals.owedAmount;
    salary.overpaidAmount = totals.overpaidAmount;
    salary.paymentStatus = totals.paymentStatus;
    await salary.save();

    await OwnerOperatorFinancialRecord.create({
      tenantId,
      company: req.user?.company?._id || req.user?.company || null,
      ownerOperator: salary.ownerOperator,
      salary: salary._id,
      type: 'SALARY_PAYMENT',
      amount: convertedAmount,
      currency: salaryCurrency,
      month: salary.month,
      year: salary.year,
      // OwnerOperatorFinancialRecord has no 'owed' state — map it to pending so the
      // financial-history row still saves.
      paymentStatus: salary.paymentStatus === 'owed' ? 'pending' : salary.paymentStatus,
      notes,
      meta: {
        inputAmount: amount,
        inputCurrency,
        conversionRate: Number(convertAmount(1, inputCurrency, salaryCurrency, fxRatesMap).value || 1),
        paidAmount: salary.paidAmount,
        dueAmount: salary.dueAmount,
      },
      createdBy: req.user?._id,
    });

    logChange(req, {
      model: 'OwnerOperatorSalary',
      module: 'payment',
      action: 'PAYMENT',
      before: beforeSalary,
      after: salary.toObject(),
      logUnchanged: true,
      description: `Updated owner operator salary payment (${salary.month}/${salary.year})`,
      resourceId: salary._id,
      resourceName: `Owner statement ${salary.month}/${salary.year}`,
      // The typed amount and its currency are recorded next to the converted figure — the same
      // rule as input_total_amount on an order: never keep only the converted number.
      details: { amount: convertedAmount, inputAmount: amount, inputCurrency, notes },
    });

    return res.json({ status: true, salary, message: 'Salary payment updated' });
  } catch (err) {
    JSONerror(res, err, next);
    logger(err);
  }
});

// Catalog for the adjustment form — served from the same table the validator uses, so a
// category the UI offers can never be one the API rejects.
exports.adjustmentCategories = catchAsync(async (req, res) => {
  if (!hasOwnerOperatorAccess(req)) {
    return res.status(403).json({ status: false, message: 'You are not allowed to access salary data' });
  }
  return res.json({ status: true, categories: ADJUSTMENT_CATEGORIES });
});

// GET /owner-operators/adjustments?ownerOperatorId&month&year&currency
// The month's ledger, each row converted into the payslip currency, plus the totals the
// payslip is built from. Works before a payslip exists — an advance can be recorded the
// day it is handed over, not only after month end.
exports.listSalaryAdjustments = catchAsync(async (req, res, next) => {
  try {
    if (!hasOwnerOperatorAccess(req)) {
      return res.status(403).json({ status: false, message: 'You are not allowed to access salary data' });
    }
    const tenantId = getTenantId(req);
    if (!tenantId) return res.status(400).json({ status: false, message: 'Tenant could not be resolved' });
    const { ownerOperatorId } = req.query;
    if (!ownerOperatorId || !mongoose.Types.ObjectId.isValid(String(ownerOperatorId))) {
      return res.status(400).json({ status: false, message: 'A valid ownerOperatorId is required' });
    }
    const month = Number(req.query?.month);
    const year = Number(req.query?.year);
    const range = buildDateRange(month, year);
    if (!range) return res.status(400).json({ status: false, message: 'Valid month and year are required' });

    const salary = await OwnerOperatorSalary.findOne({ tenantId, ownerOperator: ownerOperatorId, month, year })
      .select('currency paymentStatus finalPayable')
      .lean();
    const targetCurrency = normalizeCurrency(
      req.query?.currency || salary?.currency,
      req.tenant?.billing?.currency || 'USD'
    );
    const fxMap = await getFxRatesMap(tenantId, month, year, targetCurrency);
    const ledger = await loadLedger(tenantId, ownerOperatorId, month, year);
    const sums = sumAdjustments(ledger, targetCurrency, fxMap);

    return res.json({
      status: true,
      currency: targetCurrency,
      adjustments: sums.rows,
      totals: { addition: sums.addition, deduction: sums.deduction, net: round2(sums.addition - sums.deduction) },
      categories: ADJUSTMENT_CATEGORIES,
      hasPayslip: !!salary,
    });
  } catch (err) {
    JSONerror(res, err, next);
    logger(err);
  }
});

// Shared validation/normalization for add + update. Returns { error } or { data }.
function parseAdjustmentBody(body, { requireKind = true } = {}) {
  const kind = String(body?.kind || body?.expenseType || '').toLowerCase();
  if (requireKind && !['addition', 'deduction'].includes(kind)) {
    return { error: 'kind must be addition or deduction' };
  }
  const amount = Number(body?.amount);
  // A negative amount typed into a deduction is an addition nobody approved — the old
  // adjustment endpoint accepted it and quietly increased the payout.
  if (!Number.isFinite(amount) || amount <= 0) return { error: 'Amount must be greater than 0' };
  if (amount > 10_000_000) return { error: 'Amount is unrealistically large' };
  const notes = String(body?.notes || '').trim();
  if (!notes) return { error: 'A reason is required for every adjustment' };
  const category = String(body?.category || 'other').toLowerCase();
  if (kind && !isValidCategory(kind, category)) {
    return { error: `"${category}" is not a valid ${kind} category` };
  }
  let date = null;
  if (body?.date) {
    date = new Date(body.date);
    if (Number.isNaN(date.getTime())) return { error: 'Invalid date' };
  }
  return {
    data: {
      kind,
      category,
      amount: round2(amount),
      notes,
      date,
      reference: String(body?.reference || '').trim(),
      recurring: !!body?.recurring,
      attachmentUrl: String(body?.attachmentUrl || '').trim(),
      attachmentName: String(body?.attachmentName || '').trim(),
    },
  };
}

// Resolve the payslip an adjustment settles on (may not exist yet) and the currency the
// row must be snapshotted into.
async function resolveAdjustmentContext(req, tenantId, ownerOperatorId, month, year, inputCurrencyRaw) {
  const salary = await OwnerOperatorSalary.findOne({ tenantId, ownerOperator: ownerOperatorId, month, year });
  const salaryCurrency = normalizeCurrency(
    salary?.currency,
    req.tenant?.billing?.currency || 'USD'
  );
  const inputCurrency = normalizeCurrency(inputCurrencyRaw, salaryCurrency);
  const fxMap = await ensureMonthlyFxRates(tenantId, month, year, salaryCurrency, [inputCurrency], req.user?._id);
  return { salary, salaryCurrency, inputCurrency, fxMap };
}

exports.addSalaryAdjustment = catchAsync(async (req, res, next) => {
  try {
    if (!hasOwnerOperatorAccess(req)) {
      return res.status(403).json({ status: false, message: 'You are not allowed to add adjustments' });
    }
    const tenantId = getTenantId(req);
    if (!tenantId) return res.status(400).json({ status: false, message: 'Tenant could not be resolved' });

    const ownerOperatorId = String(req.body?.ownerOperatorId || '');
    if (!mongoose.Types.ObjectId.isValid(ownerOperatorId)) {
      return res.status(400).json({ status: false, message: 'A valid ownerOperatorId is required' });
    }
    const owner = await OwnerOperator.findOne({ _id: ownerOperatorId, tenantId, ...normalizeDeletedFilter() })
      .select('_id company fullName')
      .lean();
    if (!owner) return res.status(404).json({ status: false, message: 'Owner operator not found' });

    const month = Number(req.body?.month);
    const year = Number(req.body?.year);
    if (!buildDateRange(month, year)) {
      return res.status(400).json({ status: false, message: 'Valid month and year are required' });
    }
    const parsed = parseAdjustmentBody(req.body);
    if (parsed.error) return res.status(400).json({ status: false, message: parsed.error });

    const ctx = await resolveAdjustmentContext(req, tenantId, ownerOperatorId, month, year, req.body?.currency);
    // A payslip already paid in full is a document the owner has been given. Changing it
    // silently is how a settlement dispute starts — require an explicit acknowledgement.
    if (ctx.salary && Number(ctx.salary.paidAmount || 0) > 0 && !req.body?.confirmPaidEdit) {
      return res.status(409).json({
        status: false,
        code: 'payslip_already_paid',
        message: `This payslip already has ${ctx.salaryCurrency} ${Number(ctx.salary.paidAmount || 0).toFixed(2)} recorded as paid. Adding an adjustment changes the amount owed.`,
        paidAmount: Number(ctx.salary.paidAmount || 0),
        currency: ctx.salaryCurrency,
      });
    }

    const conv = convertAmount(parsed.data.amount, ctx.inputCurrency, ctx.salaryCurrency, ctx.fxMap);
    const adjustment = await OwnerAdjustment.create({
      tenantId,
      company: owner.company || normalizeCompanyId(req) || null,
      ownerOperator: ownerOperatorId,
      salary: ctx.salary?._id || null,
      month,
      year,
      ...parsed.data,
      currency: ctx.inputCurrency,
      amountInSalaryCurrency: round2(conv.value),
      salaryCurrency: ctx.salaryCurrency,
      fxRate: Number(conv.rate || 1),
      createdBy: req.user?._id,
    });

    let totals = null;
    if (ctx.salary) {
      const before = ctx.salary.toObject();
      ({ totals } = await recomputeSalaryFromLedger(tenantId, ctx.salary, ctx.fxMap));
      await mirrorAdjustmentRecord(req, tenantId, ctx.salary, adjustment, 'create');
      logChange(req, {
        model: 'OwnerOperatorSalary',
        module: 'payment',
        action: 'UPDATE',
        before,
        after: ctx.salary.toObject(),
        logUnchanged: true,
        critical: Number(ctx.salary.paidAmount || 0) > 0,
        description: `Added ${parsed.data.kind} (${categoryLabel(parsed.data.kind, parsed.data.category)}) to owner payslip ${month}/${year}`,
        resourceId: ctx.salary._id,
        resourceName: `Owner statement ${month}/${year}`,
        details: {
          adjustmentId: adjustment._id,
          kind: parsed.data.kind,
          category: parsed.data.category,
          inputAmount: parsed.data.amount,
          inputCurrency: ctx.inputCurrency,
          amount: round2(conv.value),
          currency: ctx.salaryCurrency,
          notes: parsed.data.notes,
        },
      });
    }

    return res.json({
      status: true,
      message: 'Adjustment added',
      adjustment,
      salary: ctx.salary || null,
      totals,
    });
  } catch (err) {
    JSONerror(res, err, next);
    logger(err);
  }
});

exports.updateSalaryAdjustment = catchAsync(async (req, res, next) => {
  try {
    if (!hasOwnerOperatorAccess(req)) {
      return res.status(403).json({ status: false, message: 'You are not allowed to update adjustments' });
    }
    const tenantId = getTenantId(req);
    if (!tenantId) return res.status(400).json({ status: false, message: 'Tenant could not be resolved' });

    const adjustment = await OwnerAdjustment.findOne({ _id: req.params.id, tenantId, ...normalizeDeletedFilter() });
    if (!adjustment) return res.status(404).json({ status: false, message: 'Adjustment not found' });

    const parsed = parseAdjustmentBody({ ...req.body, kind: req.body?.kind || adjustment.kind });
    if (parsed.error) return res.status(400).json({ status: false, message: parsed.error });

    const ctx = await resolveAdjustmentContext(
      req, tenantId, adjustment.ownerOperator, adjustment.month, adjustment.year, req.body?.currency || adjustment.currency
    );
    if (ctx.salary && Number(ctx.salary.paidAmount || 0) > 0 && !req.body?.confirmPaidEdit) {
      return res.status(409).json({
        status: false,
        code: 'payslip_already_paid',
        message: `This payslip already has ${ctx.salaryCurrency} ${Number(ctx.salary.paidAmount || 0).toFixed(2)} recorded as paid. Editing an adjustment changes the amount owed.`,
        paidAmount: Number(ctx.salary.paidAmount || 0),
        currency: ctx.salaryCurrency,
      });
    }

    const beforeAdjustment = adjustment.toObject();
    const conv = convertAmount(parsed.data.amount, ctx.inputCurrency, ctx.salaryCurrency, ctx.fxMap);
    Object.assign(adjustment, parsed.data, {
      currency: ctx.inputCurrency,
      amountInSalaryCurrency: round2(conv.value),
      salaryCurrency: ctx.salaryCurrency,
      fxRate: Number(conv.rate || 1),
      salary: ctx.salary?._id || adjustment.salary || null,
      updatedBy: req.user?._id,
    });
    await adjustment.save();

    let totals = null;
    if (ctx.salary) {
      const before = ctx.salary.toObject();
      ({ totals } = await recomputeSalaryFromLedger(tenantId, ctx.salary, ctx.fxMap));
      await mirrorAdjustmentRecord(req, tenantId, ctx.salary, adjustment, 'update');
      logChange(req, {
        model: 'OwnerOperatorSalary',
        module: 'payment',
        action: 'UPDATE',
        before,
        after: ctx.salary.toObject(),
        logUnchanged: true,
        critical: Number(ctx.salary.paidAmount || 0) > 0,
        description: `Edited ${adjustment.kind} on owner payslip ${adjustment.month}/${adjustment.year}`,
        resourceId: ctx.salary._id,
        resourceName: `Owner statement ${adjustment.month}/${adjustment.year}`,
        details: {
          adjustmentId: adjustment._id,
          from: { amount: beforeAdjustment.amount, currency: beforeAdjustment.currency, category: beforeAdjustment.category, notes: beforeAdjustment.notes },
          to: { amount: adjustment.amount, currency: adjustment.currency, category: adjustment.category, notes: adjustment.notes },
        },
      });
    }

    return res.json({ status: true, message: 'Adjustment updated', adjustment, salary: ctx.salary || null, totals });
  } catch (err) {
    JSONerror(res, err, next);
    logger(err);
  }
});

exports.removeSalaryAdjustment = catchAsync(async (req, res, next) => {
  try {
    if (!hasOwnerOperatorAccess(req)) {
      return res.status(403).json({ status: false, message: 'You are not allowed to delete adjustments' });
    }
    const tenantId = getTenantId(req);
    if (!tenantId) return res.status(400).json({ status: false, message: 'Tenant could not be resolved' });

    const adjustment = await OwnerAdjustment.findOne({ _id: req.params.id, tenantId, ...normalizeDeletedFilter() });
    if (!adjustment) return res.status(404).json({ status: false, message: 'Adjustment not found' });

    const ctx = await resolveAdjustmentContext(
      req, tenantId, adjustment.ownerOperator, adjustment.month, adjustment.year, adjustment.currency
    );
    if (ctx.salary && Number(ctx.salary.paidAmount || 0) > 0 && !req.body?.confirmPaidEdit) {
      return res.status(409).json({
        status: false,
        code: 'payslip_already_paid',
        message: `This payslip already has ${ctx.salaryCurrency} ${Number(ctx.salary.paidAmount || 0).toFixed(2)} recorded as paid. Removing an adjustment changes the amount owed.`,
        paidAmount: Number(ctx.salary.paidAmount || 0),
        currency: ctx.salaryCurrency,
      });
    }

    // Soft delete: a removed advance must stay auditable. The mirrored financial-history
    // row goes with it so the owner's ledger doesn't show a charge that no longer applies.
    adjustment.deletedAt = new Date();
    adjustment.updatedBy = req.user?._id;
    await adjustment.save();
    await OwnerOperatorFinancialRecord.deleteOne({ tenantId, type: 'ADJUSTMENT', 'meta.adjustmentId': adjustment._id });

    let totals = null;
    if (ctx.salary) {
      const before = ctx.salary.toObject();
      ({ totals } = await recomputeSalaryFromLedger(tenantId, ctx.salary, ctx.fxMap));
      logChange(req, {
        model: 'OwnerOperatorSalary',
        module: 'payment',
        action: 'UPDATE',
        before,
        after: ctx.salary.toObject(),
        logUnchanged: true,
        critical: Number(ctx.salary.paidAmount || 0) > 0,
        description: `Removed ${adjustment.kind} from owner payslip ${adjustment.month}/${adjustment.year}`,
        resourceId: ctx.salary._id,
        resourceName: `Owner statement ${adjustment.month}/${adjustment.year}`,
        details: {
          adjustmentId: adjustment._id,
          kind: adjustment.kind,
          category: adjustment.category,
          amount: adjustment.amount,
          currency: adjustment.currency,
          notes: adjustment.notes,
        },
      });
    }

    return res.json({ status: true, message: 'Adjustment removed', salary: ctx.salary || null, totals });
  } catch (err) {
    JSONerror(res, err, next);
    logger(err);
  }
});

// --- Back-compat shims -----------------------------------------------------
// The old routes wrote the scalar columns directly. They now go through the ledger so an
// older client can never reintroduce the drift.

exports.updateSalaryAdjustments = catchAsync(async (req, res, next) => {
  try {
    if (!hasOwnerOperatorAccess(req)) {
      return res.status(403).json({ status: false, message: 'You are not allowed to update salary adjustments' });
    }
    const tenantId = getTenantId(req);
    if (!tenantId) return res.status(400).json({ status: false, message: 'Tenant could not be resolved' });
    const salary = await OwnerOperatorSalary.findOne({ _id: req.params.id, tenantId });
    if (!salary) return res.status(404).json({ status: false, message: 'Salary record not found' });

    // manualDeduction / manualAddition are derived from the ledger and are refused here on
    // purpose — accepting them is what let the scalar and the itemized rows disagree.
    if (req.body?.manualDeduction !== undefined || req.body?.manualAddition !== undefined) {
      return res.status(400).json({
        status: false,
        code: 'use_adjustment_ledger',
        message: 'Additions and deductions are itemized. Add them as adjustment lines instead of setting a total.',
      });
    }

    const before = salary.toObject();
    if (req.body?.previousDueAdded !== undefined) {
      const prevDue = Number(req.body.previousDueAdded);
      if (!Number.isFinite(prevDue) || prevDue < 0) {
        return res.status(400).json({ status: false, message: 'previousDueAdded cannot be negative' });
      }
      salary.previousDueAdded = round2(prevDue);
    }
    const notes = String(req.body?.notes || '').trim();
    if (notes) salary.notes = notes;

    const { totals } = await recomputeSalaryFromLedger(tenantId, salary);

    logChange(req, {
      model: 'OwnerOperatorSalary',
      module: 'payment',
      action: 'UPDATE',
      before,
      after: salary.toObject(),
      logUnchanged: true,
      critical: Number(salary.paidAmount || 0) > 0,
      description: `Updated owner payslip carry-forward (${salary.month}/${salary.year})`,
      resourceId: salary._id,
      resourceName: `Owner statement ${salary.month}/${salary.year}`,
      details: { previousDueAdded: salary.previousDueAdded, notes },
    });

    return res.json({ status: true, salary, totals, message: 'Salary adjustments updated' });
  } catch (err) {
    JSONerror(res, err, next);
    logger(err);
  }
});

exports.addSalaryExpense = catchAsync(async (req, res, next) => {
  const salary = await OwnerOperatorSalary.findOne({ _id: req.params.id, tenantId: getTenantId(req) })
    .select('ownerOperator month year')
    .lean();
  if (!salary) return res.status(404).json({ status: false, message: 'Salary record not found' });
  req.body = {
    ...req.body,
    ownerOperatorId: String(salary.ownerOperator),
    month: salary.month,
    year: salary.year,
    kind: req.body?.kind || req.body?.expenseType,
    confirmPaidEdit: true,
  };
  return exports.addSalaryAdjustment(req, res, next);
});

exports.updateSalaryExpense = catchAsync(async (req, res, next) => {
  const tenantId = getTenantId(req);
  // Old clients pass the mirrored financial-record id, new ones the ledger id.
  const direct = await OwnerAdjustment.findOne({ _id: req.params.id, tenantId }).select('_id').lean();
  if (!direct) {
    const record = await OwnerOperatorFinancialRecord.findOne({ _id: req.params.id, tenantId, type: 'ADJUSTMENT' })
      .select('meta')
      .lean();
    const mapped = record?.meta?.adjustmentId;
    if (!mapped) {
      return res.status(400).json({
        status: false,
        code: 'legacy_adjustment',
        message: 'This adjustment predates the itemized ledger. Remove it and re-add it as a line item.',
      });
    }
    req.params.id = String(mapped);
  }
  req.body = { ...req.body, confirmPaidEdit: true };
  return exports.updateSalaryAdjustment(req, res, next);
});

exports.removeSalaryExpense = catchAsync(async (req, res, next) => {
  const tenantId = getTenantId(req);
  const direct = await OwnerAdjustment.findOne({ _id: req.params.id, tenantId }).select('_id').lean();
  if (!direct) {
    const record = await OwnerOperatorFinancialRecord.findOne({ _id: req.params.id, tenantId, type: 'ADJUSTMENT' })
      .select('meta')
      .lean();
    const mapped = record?.meta?.adjustmentId;
    if (!mapped) {
      return res.status(400).json({
        status: false,
        code: 'legacy_adjustment',
        message: 'This adjustment predates the itemized ledger and cannot be edited here.',
      });
    }
    req.params.id = String(mapped);
  }
  req.body = { ...req.body, confirmPaidEdit: true };
  return exports.removeSalaryAdjustment(req, res, next);
});

exports.ownerFinancialSummary = catchAsync(async (req, res, next) => {
  try {
    if (!hasOwnerOperatorAccess(req)) {
      return res.status(403).json({ status: false, message: 'You are not allowed to access financial records' });
    }
    const tenantId = getTenantId(req);
    const ownerOperatorId = req.params.ownerOperatorId;
    const ownerOperator = await OwnerOperator.findOne({ _id: ownerOperatorId, tenantId, ...normalizeDeletedFilter() }).lean();
    if (!ownerOperator) return res.status(404).json({ status: false, message: 'Owner operator not found' });

    const records = await OwnerOperatorFinancialRecord.find({
      tenantId,
      ownerOperator: ownerOperatorId,
    })
      .populate('order', 'serial_no total_amount settle_amount owner_profit')
      .populate('salary', 'month year finalPayable paidAmount dueAmount paymentStatus')
      .sort({ createdAt: -1 })
      .lean();

    const salaries = await OwnerOperatorSalary.find({ tenantId, ownerOperator: ownerOperatorId })
      .sort({ year: -1, month: -1 })
      .lean();

    const summary = {
      totalSettlements: records
        .filter((r) => r.type === 'SETTLEMENT')
        .reduce((acc, r) => acc + Number(r.amount || 0), 0),
      totalOwnerProfit: records
        .filter((r) => r.type === 'OWNER_PROFIT')
        .reduce((acc, r) => acc + Number(r.amount || 0), 0),
      totalDriverDeduction: records
        .filter((r) => r.type === 'DRIVER_DEDUCTION')
        .reduce((acc, r) => acc + Number(r.amount || 0), 0),
      totalSalaryGenerated: salaries.reduce((acc, s) => acc + Number(s.finalPayable || 0), 0),
      totalPaid: salaries.reduce((acc, s) => acc + Number(s.paidAmount || 0), 0),
      totalDue: salaries.reduce((acc, s) => acc + Number(s.dueAmount || 0), 0),
    };

    return res.json({ status: true, ownerOperator, summary, records, salaries });
  } catch (err) {
    JSONerror(res, err, next);
    logger(err);
  }
});

exports.reportingOverview = catchAsync(async (req, res, next) => {
  try {
    if (!hasOwnerOperatorAccess(req)) {
      return res.status(403).json({ status: false, message: 'You are not allowed to access reports' });
    }
    const tenantId = getTenantId(req);
    const { month, year, payoutCurrency } = req.query;
    const range = month && year ? buildDateRange(month, year) : null;
    const dateFilter = range ? { createdAt: { $gte: range.from, $lte: range.to } } : {};
    const targetCurrency = normalizeCurrency(payoutCurrency, req.tenant?.billing?.currency || 'USD');

    const ownerCountPromise = OwnerOperator.countDocuments({ tenantId, ...normalizeDeletedFilter() });
    const activeOwnerCountPromise = OwnerOperator.countDocuments({ tenantId, status: 'active', ...normalizeDeletedFilter() });
    const ownerTruckCountPromise = Truck.countDocuments({ tenantId, ownerOperated: true, ...normalizeDeletedFilter() });

    const orderFilter = {
      tenantId,
      order_type: 'regular',
      isOwnerOperatedTruck: true,
      ...normalizeDeletedFilter(),
      ...dateFilter,
    };
    const ownerOrders = await Order.find(orderFilter).select(`${OWNER_ORDER_FIELDS} truck`).lean();
    const fxRatesMap = range ? await getFxRatesMap(tenantId, range.month, range.year, targetCurrency) : new Map([[targetCurrency, 1]]);
    const ownerOrderCount = ownerOrders.length;
    // Driver deductions per order (needed up-front so amounts use the shared resolver below).
    const ownerOrderIds = ownerOrders.map((o) => o._id);
    const deds = await buildOrderDriverDeductions(tenantId, ownerOrderIds);
    const { byOrder, soloTotal, teamTotal } = deds;
    // Resolve every order's amounts once (input-sourced price/settle/profit, USD-sourced deduction)
    // so dashboard totals match the payslip/statement screens. Company-wide totals stay order-level
    // (an order's revenue and settle pot are counted once, however many owners split it).
    const amountsByOrder = new Map(
      ownerOrders.map((o) => [String(o._id), resolveOwnerOrderAmounts(o, byOrder.get(String(o._id)), targetCurrency, fxRatesMap)])
    );
    // Per-owner rollup is leg-level: a mixed order contributes only that owner's legs.
    const ownersOfOrder = (o) => (o?.isMixedOwner
      ? (o?.ownerOperators || []).map(String)
      : (o?.ownerOperator ? [String(o.ownerOperator)] : []));
    const legAmounts = (o, ownerId) =>
      resolveOwnerOrderAmounts(o, ownerOrderDeduction(deds, o._id, ownerId), targetCurrency, fxRatesMap);
    const totalOrderValue = ownerOrders.reduce((acc, o) => acc + Number(amountsByOrder.get(String(o._id))?.orderPrice || 0), 0);
    const totalSettleAmount = ownerOrders.reduce((acc, o) => acc + Number(amountsByOrder.get(String(o._id))?.settleAmount || 0), 0);
    const totalOwnerProfit = ownerOrders.reduce((acc, o) => acc + Number(amountsByOrder.get(String(o._id))?.ownerProfit || 0), 0);

    const ownerDocs = await OwnerOperator.find({ tenantId, ...normalizeDeletedFilter() })
      .select('fullName companyName ownerOperatorId status')
      .lean();
    const ownerPerfMap = new Map(
      ownerDocs.map((o) => [
        String(o._id),
        { orders: 0, revenue: 0, settleAmount: 0, ownerProfit: 0, driverDeduction: 0, finalPayable: 0 },
      ])
    );
    ownerOrders.forEach((o) => {
      ownersOfOrder(o).forEach((key) => {
        const cur = ownerPerfMap.get(key) || {
          orders: 0,
          revenue: 0,
          settleAmount: 0,
          ownerProfit: 0,
          driverDeduction: 0,
          finalPayable: 0,
        };
        cur.orders += 1;
        const amt = legAmounts(o, key);
        cur.revenue += Number(amt?.orderPrice || 0);
        cur.settleAmount += Number(amt?.settleAmount || 0);
        cur.ownerProfit += Number(amt?.ownerProfit || 0);
        ownerPerfMap.set(key, cur);
      });
    });
    const convertedTeamTotal = ownerOrders.reduce((acc, o) => {
      const ded = byOrder.get(String(o._id));
      const isTeamOrder = Number(ded?.teamSegments || 0) > 0;
      if (!isTeamOrder) return acc;
      return acc + Number(amountsByOrder.get(String(o._id))?.deduction || 0);
    }, 0);
    const convertedSoloTotal = ownerOrders.reduce((acc, o) => {
      const ded = byOrder.get(String(o._id));
      const isSoloOnly = Number(ded?.teamSegments || 0) === 0 && Number(ded?.soloSegments || 0) > 0;
      if (!isSoloOnly) return acc;
      return acc + Number(amountsByOrder.get(String(o._id))?.deduction || 0);
    }, 0);
    ownerOrders.forEach((o) => {
      ownersOfOrder(o).forEach((key) => {
        const cur = ownerPerfMap.get(key);
        if (!cur) return;
        const amt = legAmounts(o, key);
        const deduction = Number(amt?.deduction || 0);
        const settleAmount = Number(amt?.settleAmount || 0);
        cur.driverDeduction += deduction;
        // Owner payable = settlement - driver cost (matches generated salary basePayable = settle).
        cur.finalPayable += settleAmount - deduction;
        ownerPerfMap.set(key, cur);
      });
    });

    const ownerMetaMap = new Map(ownerDocs.map((o) => [String(o._id), o]));
    let salaryByOwner = new Map();
    let ledgerByOwner = new Map();
    if (range) {
      const salaryDocs = await OwnerOperatorSalary.find({
        tenantId,
        month: range.month,
        year: range.year,
      })
        .select('ownerOperator currency manualDeduction manualAddition previousDueAdded previousOwedDeducted finalPayable paidAmount dueAmount owedAmount paymentStatus totalDriverDeduction basePayable totalSettleAmount totalOwnerProfit')
        .lean();
      salaryByOwner = new Map(salaryDocs.map((s) => [String(s.ownerOperator), s]));

      // Adjustments exist whether or not a payslip has been generated — an advance handed
      // over on the 3rd must show on the list before month end, not only after someone
      // clicks Generate.
      const ledgerDocs = await OwnerAdjustment.find({
        tenantId,
        month: range.month,
        year: range.year,
        ...normalizeDeletedFilter(),
      }).lean();
      ledgerDocs.forEach((row) => {
        const key = String(row.ownerOperator);
        if (!ledgerByOwner.has(key)) ledgerByOwner.set(key, []);
        ledgerByOwner.get(key).push(row);
      });
    }
    const ownerPerformance = Array.from(ownerPerfMap.entries())
      .map(([id, v]) => {
        const salary = salaryByOwner.get(id);
        const salaryCurrency = normalizeCurrency(salary?.currency, targetCurrency);
        const sums = sumAdjustments(ledgerByOwner.get(id) || [], targetCurrency, fxRatesMap);
        const manualDeduction = sums.deduction;
        const manualAddition = sums.addition;
        const previousDueAdded = Number(convertAmount(salary?.previousDueAdded, salaryCurrency, targetCurrency, fxRatesMap).value || 0);
        const previousOwedDeducted = Number(convertAmount(salary?.previousOwedDeducted, salaryCurrency, targetCurrency, fxRatesMap).value || 0);
        const driverDeduction = Number(v.driverDeduction || 0);
        const totals = computeSalaryTotals({
          // `v.settleAmount` is the gross settlement; `v.finalPayable` already has the
          // driver cost taken off it. basePayable is the gross.
          basePayable: Number(v.settleAmount || 0),
          totalDriverDeduction: driverDeduction,
          previousDueAdded,
          previousOwedDeducted,
          manualAddition,
          manualDeduction,
          paidAmount: Number(convertAmount(salary?.paidAmount, salaryCurrency, targetCurrency, fxRatesMap).value || 0),
        });
        // A generated payslip is a document that has been issued — its own stored figure
        // wins over a live recompute so the list can never contradict the PDF.
        const finalPayable = salary
          ? Number(convertAmount(salary.finalPayable, salaryCurrency, targetCurrency, fxRatesMap).value || 0)
          : totals.finalPayable;
        return {
          ownerOperatorId: id,
          ownerOperatorName: ownerMetaMap.get(id)?.fullName || 'Unknown',
          ownerOperatorCode: ownerMetaMap.get(id)?.ownerOperatorId || '',
          ownerOperatorStatus: ownerMetaMap.get(id)?.status || 'inactive',
          ...v,
          driverDeduction,
          finalPayable,
          manualDeduction,
          manualAddition,
          adjustmentCount: (ledgerByOwner.get(id) || []).length,
          previousDueAdded,
          previousOwedDeducted,
          hasPayslip: !!salary,
          salaryId: salary?._id || null,
          paidAmount: salary ? Number(convertAmount(salary.paidAmount, salaryCurrency, targetCurrency, fxRatesMap).value || 0) : 0,
          dueAmount: salary ? Number(convertAmount(salary.dueAmount, salaryCurrency, targetCurrency, fxRatesMap).value || 0) : totals.dueAmount,
          owedAmount: salary ? Number(convertAmount(salary.owedAmount, salaryCurrency, targetCurrency, fxRatesMap).value || 0) : totals.owedAmount,
          paymentStatus: salary?.paymentStatus || totals.paymentStatus,
        };
      })
      .sort((a, b) => b.ownerProfit - a.ownerProfit);

    const ownerTruckIds = await Truck.find({ tenantId, ownerOperated: true, ...normalizeDeletedFilter() }).select('_id').lean();
    const truckIds = ownerTruckIds.map((t) => t._id);
    const utilAgg = truckIds.length
      ? await Trip.aggregate([
          {
            $match: {
              tenantId,
              truck: { $in: truckIds },
              deletedAt: null,
              ...(range ? { createdAt: { $gte: range.from, $lte: range.to } } : {}),
            },
          },
          {
            $group: {
              _id: '$truck',
              trips: { $sum: 1 },
              tripIds: { $push: '$_id' },
            },
          },
          { $sort: { trips: -1 } },
        ])
      : [];
    // Miles are derived, never summed raw: `$sum: '$miles'` mixes legacy KM rows with real-mile
    // rows, so truck utilization read higher than the payslip the same trips produced.
    const utilTripIds = utilAgg.flatMap((x) => x.tripIds || []);
    const utilMiles = new Map();
    if (utilTripIds.length) {
      const utilTrips = await Trip.find({ tenantId, deletedAt: null, _id: { $in: utilTripIds } })
        .select('truck order totalDistance miles total_km').lean();
      const utilOrderIds = [...new Set(utilTrips.map((t) => String(t.order)).filter(Boolean))];
      const siblings = utilOrderIds.length
        ? await Trip.find({ tenantId, deletedAt: null, order: { $in: utilOrderIds } })
            .select('order totalDistance miles total_km').lean()
        : [];
      const utilOrders = utilOrderIds.length
        ? await Order.find({ tenantId, _id: { $in: utilOrderIds } }).select('_id totalDistance').lean()
        : [];
      const kmByOrder = new Map(utilOrders.map((o) => [String(o._id), Number(o?.totalDistance || 0)]));
      const rawByOrder = new Map();
      siblings.forEach((t) => {
        const oid = String(t.order);
        const raw = Math.max(Number(t.totalDistance || t.miles || t.total_km || 0), 0);
        rawByOrder.set(oid, Number(rawByOrder.get(oid) || 0) + raw);
      });
      utilTrips.forEach((t) => {
        const oid = String(t.order);
        const real = deriveTripMiles(t, kmByOrder.get(oid), rawByOrder.get(oid));
        const key = String(t.truck);
        utilMiles.set(key, Number(utilMiles.get(key) || 0) + Number(real || 0));
      });
    }
    const truckUtilization = utilAgg.map((x) => ({
      truckId: x._id,
      trips: x.trips,
      miles: Number(utilMiles.get(String(x._id)) || 0),
    }));

    const totalDriverDeduction = ownerPerformance.reduce((acc, x) => acc + Number(x.driverDeduction || 0), 0);
    const totalFinalPayable = ownerPerformance.reduce((acc, x) => acc + Number(x.finalPayable || 0), 0);

    const [totalOwnerOperators, activeOwnerOperators, ownerOperatedTrucks] = await Promise.all([
      ownerCountPromise,
      activeOwnerCountPromise,
      ownerTruckCountPromise,
    ]);

    return res.json({
      status: true,
      currency: targetCurrency,
      metrics: {
        totalOwnerOperators,
        activeOwnerOperators,
        ownerOperatedTrucks,
        ownerOperatedOrders: ownerOrderCount,
        totalOrderValue,
        totalSettleAmount,
        totalOwnerProfit,
        totalDriverDeduction,
        totalFinalPayable,
      },
      driverCostAnalysis: {
        soloDriverCost: convertedSoloTotal,
        teamDriverCost: convertedTeamTotal,
        rawSoloDriverCost: soloTotal,
        rawTeamDriverCost: teamTotal,
      },
      ownerPerformance,
      truckUtilization,
    });
  } catch (err) {
    JSONerror(res, err, next);
    logger(err);
  }
});

exports.reportingOwnerBreakdown = catchAsync(async (req, res, next) => {
  try {
    if (!hasOwnerOperatorAccess(req)) {
      return res.status(403).json({ status: false, message: 'You are not allowed to access reports' });
    }
    const tenantId = getTenantId(req);
    const { month, year, ownerOperatorId, payoutCurrency, includePreviousDue } = req.query;
    const shouldIncludePrevDue = includePreviousDue === 'true' || includePreviousDue === true;
    const range = buildDateRange(month, year);
    if (!range || !ownerOperatorId) {
      return res.status(400).json({ status: false, message: 'ownerOperatorId, month and year are required' });
    }
    const salaryDoc = await OwnerOperatorSalary.findOne({ tenantId, ownerOperator: ownerOperatorId, month: range.month, year: range.year })
      .select('currency basePayable totalDriverDeduction previousDueAdded manualDeduction manualAddition paidAmount paymentStatus')
      .lean();
    const targetCurrency = normalizeCurrency(payoutCurrency, salaryDoc?.currency || req.tenant?.billing?.currency || 'USD');

    const owner = await OwnerOperator.findOne({ _id: ownerOperatorId, tenantId, ...normalizeDeletedFilter() })
      .select('fullName companyName ownerOperatorId status phone email address')
      .lean();
    if (!owner) return res.status(404).json({ status: false, message: 'Owner operator not found' });

    const orders = await Order.find({
      tenantId,
      order_type: 'regular',
      isOwnerOperatedTruck: true,
      createdAt: { $gte: range.from, $lte: range.to },
      $and: [ownerOrderMatch([ownerOperatorId]), normalizeDeletedFilter()],
    })
      .select(`${OWNER_ORDER_FIELDS} shipping_details truck createdAt`)
      .populate('truck', 'plateNumber unitNumber')
      .lean();
    const fxRatesMap = await getFxRatesMap(tenantId, range.month, range.year, targetCurrency);
    const orderIds = orders.map((o) => o._id);
    const deds = await buildOrderDriverDeductions(tenantId, orderIds);
    const { byOrder } = deds;

    const allDriverIds2 = new Set();
    byOrder.forEach((v) => v.drivers.forEach((id) => allDriverIds2.add(String(id))));
    const driverDocs2 = allDriverIds2.size > 0
      ? await Users.find({ _id: { $in: Array.from(allDriverIds2) } }, { _id: 1, name: 1 }).lean()
      : [];
    const driverNameMap2 = new Map(driverDocs2.map((u) => [String(u._id), u.name || '']));

    const orderBreakdown = orders.map((o) => {
      const ded = ownerOrderDeduction(deds, o._id, ownerOperatorId);
      const amounts = resolveOwnerOrderAmounts(o, ded, targetCurrency, fxRatesMap);
      const {
        priceSourceCurrency, deductionSourceCurrency,
        originalOrderPrice, originalSettleAmount, originalOwnerProfit, originalDeduction: originalDriverDeduction, originalPayable,
        orderPrice, settleAmount, ownerProfit, deduction: driverDeduction, payable,
      } = amounts;
      let driverRateType = 'none';
      if ((ded?.soloSegments || 0) > 0 && (ded?.teamSegments || 0) > 0) driverRateType = 'mixed';
      else if ((ded?.teamSegments || 0) > 0) driverRateType = 'team';
      else if ((ded?.soloSegments || 0) > 0) driverRateType = 'solo';
      const avg = resolveDriverAvgRate(ded, deductionSourceCurrency);
      const originalDriverAvgRate = avg.rate;
      const driverRateCurrencyCode = avg.currency;
      const driverAvgRate = Number(convertAmount(originalDriverAvgRate, driverRateCurrencyCode, targetCurrency, fxRatesMap).value || 0);
      const driverNames = Array.from(ded?.drivers || []).map((id) => driverNameMap2.get(String(id)) || '').filter(Boolean);
      return {
        order: o._id,
        serial_no: o.serial_no || null,
        customer_order_no: o.customer_order_no || null,
        shipping_details: Array.isArray(o.shipping_details) ? o.shipping_details : [],
        truck: o.truck || null,
        orderCreatedAt: o.createdAt || null,
        // On a mixed split this owner only ran part of the load, so the statement shows their leg's
        // share of the order price — not the full order value.
        input_total_amount: Number(originalOrderPrice || 0),
        input_currency: normalizeCurrency(o.input_currency, priceSourceCurrency),
        isMixedOwner: !!o.isMixedOwner,
        legMiles: Number(ded?.legMiles || ded?.miles || 0),
        driverNames,
        orderPrice,
        settleAmount,
        ownerProfit,
        driverDeduction,
        payable,
        sourceCurrency: priceSourceCurrency,
        targetCurrency,
        fxRate: Number(convertAmount(1, priceSourceCurrency, targetCurrency, fxRatesMap).value || 1),
        originalOrderPrice,
        originalSettleAmount,
        originalOwnerProfit,
        originalDriverDeduction,
        originalPayable,
        originalDriverAvgRate,
        driverCount: ded?.drivers?.size || 0,
        driverRateType,
        driverMiles: Number(ded?.miles || 0),
        driverAvgRate,
        driverRateCurrency: driverRateCurrencyCode,
      };
    });
    const salaryCurrency = normalizeCurrency(salaryDoc?.currency, targetCurrency);
    const basePayableFromBreakdown = orderBreakdown.reduce((a, x) => a + Number(x.settleAmount || 0), 0);
    const totalDriverDeductionFromBreakdown = orderBreakdown.reduce((a, x) => a + Number(x.driverDeduction || 0), 0);
    const basePayable = salaryDoc?.basePayable != null
      ? Number(convertAmount(salaryDoc.basePayable, salaryCurrency, targetCurrency, fxRatesMap).value || 0)
      : basePayableFromBreakdown;
    const totalDriverDeduction = salaryDoc?.totalDriverDeduction != null
      ? Number(convertAmount(salaryDoc.totalDriverDeduction, salaryCurrency, targetCurrency, fxRatesMap).value || 0)
      : totalDriverDeductionFromBreakdown;
    
    // Auto calculate previous due if not available in doc
    let autoPreviousDue = 0;
    if (salaryDoc?.previousDueAdded != null) {
      autoPreviousDue = Number(convertAmount(salaryDoc.previousDueAdded, salaryCurrency, targetCurrency, fxRatesMap).value || 0);
    } else {
      const previousSalary = await OwnerOperatorSalary.findOne({
        tenantId,
        ownerOperator: ownerOperatorId,
        $or: [
          { year: { $lt: range.year } },
          { year: range.year, month: { $lt: range.month } },
        ],
      })
      .sort({ year: -1, month: -1 })
      .select('currency dueAmount')
      .lean();
      
      if (previousSalary) {
        const previousSalaryCurrency = normalizeCurrency(previousSalary.currency, targetCurrency);
        autoPreviousDue = Number(convertAmount(previousSalary.dueAmount, previousSalaryCurrency, targetCurrency, fxRatesMap).value || 0);
      }
    }

    const previousDueAdded = shouldIncludePrevDue ? autoPreviousDue : 0;
    const previousOwedDeducted = shouldIncludePrevDue
      ? Number(convertAmount(salaryDoc?.previousOwedDeducted, salaryCurrency, targetCurrency, fxRatesMap).value || 0)
      : 0;

    // This preview is what the screen shows BEFORE a payslip exists, so it must agree with
    // what generate would produce: same ledger, same identity, same status rule.
    const ledgerRows = await loadLedger(tenantId, ownerOperatorId, range.month, range.year);
    const ledgerSums = sumAdjustments(ledgerRows, targetCurrency, fxRatesMap);
    const manualAddition = ledgerSums.addition;
    const manualDeduction = ledgerSums.deduction;

    const previewTotals = computeSalaryTotals({
      basePayable,
      totalDriverDeduction,
      previousDueAdded,
      previousOwedDeducted,
      manualAddition,
      manualDeduction,
      paidAmount: Number(convertAmount(salaryDoc?.paidAmount, salaryCurrency, targetCurrency, fxRatesMap).value || 0),
    });
    const { finalPayable, paidAmount, dueAmount, owedAmount, overpaidAmount, paymentStatus } = previewTotals;

    const payload = {
      ownerOperator: owner,
      month: range.month,
      year: range.year,
      currency: targetCurrency,
      totalOrders: orderBreakdown.length,
      totalOrderValueOriginal: orderBreakdown.reduce((a, x) => a + Number(x.originalOrderPrice || 0), 0),
      totalSettleAmountOriginal: orderBreakdown.reduce((a, x) => a + Number(x.originalSettleAmount || 0), 0),
      totalOwnerProfitOriginal: orderBreakdown.reduce((a, x) => a + Number(x.originalOwnerProfit || 0), 0),
      totalDriverDeductionOriginal: orderBreakdown.reduce((a, x) => a + Number(x.originalDriverDeduction || 0), 0),
      totalOrderValue: orderBreakdown.reduce((a, x) => a + Number(x.orderPrice || 0), 0),
      totalSettleAmount: orderBreakdown.reduce((a, x) => a + Number(x.settleAmount || 0), 0),
      totalOwnerProfit: orderBreakdown.reduce((a, x) => a + Number(x.ownerProfit || 0), 0),
      totalDriverDeduction: orderBreakdown.reduce((a, x) => a + Number(x.driverDeduction || 0), 0),
      basePayable,
      previousDueAdded,
      previousOwedDeducted,
      manualDeduction,
      manualAddition,
      finalPayable,
      dueAmount,
      paidAmount,
      owedAmount,
      overpaidAmount,
      paymentStatus,
      hasPayslip: !!salaryDoc,
      salaryId: salaryDoc?._id || null,
      adjustments: ledgerSums.rows,
      adjustmentTotals: { addition: manualAddition, deduction: manualDeduction, net: round2(manualAddition - manualDeduction) },
      categories: ADJUSTMENT_CATEGORIES,
      orderBreakdown,
    };
    return res.json({ status: true, data: payload });
  } catch (err) {
    JSONerror(res, err, next);
    logger(err);
  }
});

// ---------------------------------------------------------------------------
// Payment corrections.
//
// A payment used to be write-once: a typo'd 5,000 was permanent, and the only way out was
// deleting the whole payslip (which also destroyed the adjustments). Adjustments already
// had edit + delete; payments now do too.
// ---------------------------------------------------------------------------

async function recomputePaidFromDelta(tenantId, salary, delta) {
  const nextPaid = Math.max(round2(Number(salary.paidAmount || 0) + delta), 0);
  const totals = computeSalaryTotals({
    basePayable: resolveBasePayable(salary),
    totalDriverDeduction: salary.totalDriverDeduction,
    previousDueAdded: salary.previousDueAdded,
    previousOwedDeducted: salary.previousOwedDeducted,
    manualAddition: salary.manualAddition,
    manualDeduction: salary.manualDeduction,
    paidAmount: nextPaid,
  });
  salary.paidAmount = totals.paidAmount;
  salary.dueAmount = totals.dueAmount;
  salary.owedAmount = totals.owedAmount;
  salary.overpaidAmount = totals.overpaidAmount;
  salary.paymentStatus = totals.paymentStatus;
  await salary.save();
  return totals;
}

exports.updateSalaryPaymentRecord = catchAsync(async (req, res, next) => {
  try {
    if (!hasOwnerOperatorAccess(req)) {
      return res.status(403).json({ status: false, message: 'You are not allowed to update payments' });
    }
    const tenantId = getTenantId(req);
    if (!tenantId) return res.status(400).json({ status: false, message: 'Tenant could not be resolved' });

    const record = await OwnerOperatorFinancialRecord.findOne({ _id: req.params.id, tenantId, type: 'SALARY_PAYMENT' });
    if (!record) return res.status(404).json({ status: false, message: 'Payment not found' });
    const salary = await OwnerOperatorSalary.findOne({ _id: record.salary, tenantId });
    if (!salary) return res.status(404).json({ status: false, message: 'Payslip not found for this payment' });

    const amount = Number(req.body?.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ status: false, message: 'Payment amount must be greater than 0' });
    }
    const salaryCurrency = normalizeCurrency(salary.currency, req.tenant?.billing?.currency || 'USD');
    const inputCurrency = normalizeCurrency(req.body?.currency || record?.meta?.inputCurrency, salaryCurrency);
    const fxMap = await getFxRatesMap(tenantId, salary.month, salary.year, salaryCurrency);
    const converted = round2(convertAmount(amount, inputCurrency, salaryCurrency, fxMap).value);
    if (converted <= 0) return res.status(400).json({ status: false, message: 'Converted payment amount is invalid' });

    const before = salary.toObject();
    const delta = round2(converted - Number(record.amount || 0));
    const totals = await recomputePaidFromDelta(tenantId, salary, delta);

    record.amount = converted;
    record.currency = salaryCurrency;
    if (req.body?.notes !== undefined) record.notes = String(req.body.notes || '').trim();
    if (req.body?.date) {
      const d = new Date(req.body.date);
      if (!Number.isNaN(d.getTime())) record.date = d;
    }
    record.paymentStatus = totals.paymentStatus === 'owed' ? 'pending' : totals.paymentStatus;
    record.meta = {
      ...(record.meta || {}),
      inputAmount: amount,
      inputCurrency,
      conversionRate: Number(convertAmount(1, inputCurrency, salaryCurrency, fxMap).value || 1),
      correctedAt: new Date(),
    };
    await record.save();

    logChange(req, {
      model: 'OwnerOperatorSalary',
      module: 'payment',
      action: 'PAYMENT',
      before,
      after: salary.toObject(),
      logUnchanged: true,
      // Rewriting a recorded payment changes an already-reported figure.
      critical: true,
      description: `Corrected owner payment on payslip ${salary.month}/${salary.year}`,
      resourceId: salary._id,
      resourceName: `Owner statement ${salary.month}/${salary.year}`,
      details: { paymentId: record._id, delta, amount: converted, inputAmount: amount, inputCurrency, currency: salaryCurrency },
    });

    return res.json({ status: true, message: 'Payment updated', salary, record, totals });
  } catch (err) {
    JSONerror(res, err, next);
    logger(err);
  }
});

exports.removeSalaryPaymentRecord = catchAsync(async (req, res, next) => {
  try {
    if (!hasOwnerOperatorAccess(req)) {
      return res.status(403).json({ status: false, message: 'You are not allowed to delete payments' });
    }
    const tenantId = getTenantId(req);
    if (!tenantId) return res.status(400).json({ status: false, message: 'Tenant could not be resolved' });

    const record = await OwnerOperatorFinancialRecord.findOne({ _id: req.params.id, tenantId, type: 'SALARY_PAYMENT' });
    if (!record) return res.status(404).json({ status: false, message: 'Payment not found' });
    const salary = await OwnerOperatorSalary.findOne({ _id: record.salary, tenantId });
    if (!salary) return res.status(404).json({ status: false, message: 'Payslip not found for this payment' });

    const before = salary.toObject();
    const amount = round2(record.amount);
    const totals = await recomputePaidFromDelta(tenantId, salary, -amount);
    await OwnerOperatorFinancialRecord.deleteOne({ _id: record._id, tenantId });

    logChange(req, {
      model: 'OwnerOperatorSalary',
      module: 'payment',
      action: 'PAYMENT',
      before,
      after: salary.toObject(),
      logUnchanged: true,
      critical: true,
      description: `Reversed owner payment on payslip ${salary.month}/${salary.year}`,
      resourceId: salary._id,
      resourceName: `Owner statement ${salary.month}/${salary.year}`,
      details: { paymentId: record._id, amount, currency: record.currency, notes: record.notes },
    });

    return res.json({ status: true, message: 'Payment reversed', salary, totals });
  } catch (err) {
    JSONerror(res, err, next);
    logger(err);
  }
});
