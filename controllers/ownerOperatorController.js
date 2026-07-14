const mongoose = require('mongoose');
const https = require('https');
const puppeteer = require('puppeteer');

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const catchAsync = require('../utils/catchAsync');
const JSONerror = require('../utils/jsonErrorHandler');
const logger = require('../utils/logger');
const OwnerOperator = require('../db/OwnerOperator');
const OwnerOperatorSalary = require('../db/OwnerOperatorSalary');
const OwnerOperatorFinancialRecord = require('../db/OwnerOperatorFinancialRecord');
const ConversionRate = require('../db/ConversionRate');
const Order = require('../db/Order');
const Truck = require('../db/Truck');
const Trip = require('../db/Trip');
const DriverProfile = require('../db/DriverProfile');
const Users = require('../db/Users');
const { logActivity } = require('../utils/activityLogger');
const { MI_PER_KM, kmToMiles, normalizeTripMiles, deriveTripMiles, pickDriverRate, getDriverRateCurrency } = require('../utils/distance');
const { SUPPORTED_CURRENCIES, normalizeCurrency, buildDateRange, getFxRatesMap, convertAmount } = require('../utils/fx');
const { legKey, buildOrderLegs, ownerOrderMatch } = require('../utils/ownerSettlement');

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
  const deductionConversion = convertAmount(originalDeduction, deductionSourceCurrency, targetCurrency, fxRatesMap);
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
    .select('order miles totalDistance total_km distance_unit rate_per_mile drivers driver truck settle_amount')
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
  });

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
    list.forEach((driverId) => {
      const profile = profileMap.get(String(driverId));
      // trip.rate_per_mile is snapshotted from this driver's profile, so it shares its currency.
      const rate = rateToUsd(pickDriverRate(profile, isTeam, trip.rate_per_mile), profile, orderId);
      tripDeduction += (miles / count) * rate;
      tripWeightedRateMiles += (miles / count) * rate;
    });
    const current = byOrder.get(orderId) || emptyAgg();
    current.deduction += tripDeduction;
    current.miles += miles;
    current.weightedRateMiles += tripWeightedRateMiles;
    if (isTeam) current.teamSegments += 1;
    else current.soloSegments += 1;
    list.forEach((driverId) => current.drivers.add(driverId));
    byOrder.set(orderId, current);
    byTrip.set(String(trip._id), {
      deduction: tripDeduction,
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
      .select('serial_no order_status order_type total_amount settle_amount owner_profit input_total_amount input_currency revenue_currency createdAt pickup_date delivery_date customer truck shipping_details')
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
        const originalDriverAvgRate = Number(ded?.miles || 0) > 0 ? Number((ded?.weightedRateMiles || 0) / (ded?.miles || 1)) : 0;
        const driverAvgRate = Number(convertAmount(originalDriverAvgRate, deductionSourceCurrency, targetCurrency, fxRatesMap).value || 0);
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
            .select('currency dueAmount')
            .lean()
        : null;
      const existingSalaryCurrency = normalizeCurrency(existingSalary?.currency, targetCurrency);
      const previousSalaryCurrency = normalizeCurrency(previousSalary?.currency, targetCurrency);
      const convertedExistingPaid = convertAmount(Number(existingSalary?.paidAmount || 0), existingSalaryCurrency, targetCurrency, fxRatesMap).value;
      const convertedExistingManualDeduction = convertAmount(Number(existingSalary?.manualDeduction || 0), existingSalaryCurrency, targetCurrency, fxRatesMap).value;
      const convertedExistingManualAddition = convertAmount(Number(existingSalary?.manualAddition || 0), existingSalaryCurrency, targetCurrency, fxRatesMap).value;
      const autoPreviousDue = convertAmount(Number(previousSalary?.dueAmount || 0), previousSalaryCurrency, targetCurrency, fxRatesMap).value;
      const previousDueAdded = ownerAdjustments?.previousDueAdded !== undefined
        ? Number(ownerAdjustments?.previousDueAdded || 0)
        : (includePreviousDue ? Number(autoPreviousDue || 0) : 0);
      const manualDeduction =
        ownerAdjustments?.manualDeduction !== undefined
          ? Number(ownerAdjustments?.manualDeduction || 0)
          : Number(convertedExistingManualDeduction || 0);
      const manualAddition =
        ownerAdjustments?.manualAddition !== undefined
          ? Number(ownerAdjustments?.manualAddition || 0)
          : Number(convertedExistingManualAddition || 0);
      const finalPayable = basePayable - totalDriverDeduction + previousDueAdded + manualAddition - manualDeduction;
      const paidAmount = Number(convertedExistingPaid || 0);
      const dueAmount = Math.max(finalPayable - paidAmount, 0);
      const paymentStatus = (dueAmount === 0 && finalPayable > 0) ? 'paid' : (paidAmount > 0 ? 'partial' : 'pending');
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
        manualDeduction,
        manualAddition,
        finalPayable,
        dueAmount,
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

      await OwnerOperatorFinancialRecord.create({
        tenantId,
        company: req.user?.company?._id || req.user?.company || null,
        ownerOperator: owner._id,
        salary: salary._id,
        type: 'SALARY_GENERATED',
        amount: finalPayable,
        currency: salary.currency || req.tenant?.billing?.currency || 'USD',
        month: range.month,
        year: range.year,
        paymentStatus: salary.paymentStatus,
        notes: `Monthly salary generated for ${range.month}/${range.year}`,
        meta: {
          totalOrderValue,
          totalSettleAmount,
          totalOwnerProfit,
          totalDriverDeduction,
          basePayable,
          previousDueAdded,
          manualDeduction,
          manualAddition,
        },
        createdBy: req.user?._id,
      });

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
    if (paymentStatus && ['pending', 'partial', 'paid'].includes(paymentStatus)) filter.paymentStatus = paymentStatus;
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

    if (!Array.isArray(salary?.orderBreakdown)) {
      return res.json({ status: true, salary });
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

    return res.json({ status: true, salary: enrichedSalary });
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
    const manualDeduction = Number(convertAmount(salary?.manualDeduction, salaryCurrency, targetCurrency, fxRatesMap).value || 0);
    const manualAddition = Number(convertAmount(salary?.manualAddition, salaryCurrency, targetCurrency, fxRatesMap).value || 0);
    const finalPayable = basePayable - totalDriverDeduction + previousDueAdded + manualAddition - manualDeduction;
    const paidAmount = Number(convertAmount(salary?.paidAmount, salaryCurrency, targetCurrency, fxRatesMap).value || 0);
    const dueAmount = Math.max(finalPayable - paidAmount, 0);

    const records = await OwnerOperatorFinancialRecord.find({
      tenantId,
      ownerOperator: owner._id,
      month: range.month,
      year: range.year,
      type: { $in: ['SALARY_PAYMENT', 'ADJUSTMENT'] },
    })
      .sort({ createdAt: -1 })
      .lean();

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

    const recordsHtml = (records || []).map((r) => {
      const expenseType = String(r?.meta?.expenseType || '').toLowerCase();
      const typeLabel = r.type === 'SALARY_PAYMENT'
        ? 'Payment'
        : r.type === 'DRIVER_DEDUCTION'
          ? 'Driver Ded.'
          : (expenseType === 'deduction' ? 'Deduction' : 'Addition');
      const isDeduction = r.type === 'DRIVER_DEDUCTION' || (r.type === 'ADJUSTMENT' && expenseType === 'deduction');
      const isPayment = r.type === 'SALARY_PAYMENT';
      const signed = isDeduction
        ? -Math.abs(Number(r?.amount || 0))
        : (isPayment ? Math.abs(Number(r?.amount || 0)) : Number(r?.amount || 0));
      const isNeg = signed < 0;
      return `
        <tr>
          <td style="font-family:'Courier New',monospace;font-size:9px">${safe(fmtDate(r?.date || r?.createdAt))}</td>
          <td>${safe(typeLabel)}</td>
          <td class="num" style="color:${isNeg ? '#dc2626' : '#065f46'};font-weight:700;font-family:'Courier New',monospace">${isNeg ? `-${safe(fmtMoney(Math.abs(signed)))}` : `+${safe(fmtMoney(Math.abs(signed)))}`}</td>
          <td style="font-size:9px;color:#64748b">${safe(String(r?.notes || '').slice(0, 30))}</td>
        </tr>
      `;
    }).join('');

    const payPeriodFrom = new Date(range.year, range.month - 1, 1);
    const payPeriodTo = new Date(range.year, range.month, 0);
    const paymentNo = salary?._id ? String(salary._id).slice(-6) : '';
    const lastPaymentRecord = (records || []).find((r) => r.type === 'SALARY_PAYMENT');
    const paymentDate = lastPaymentRecord?.createdAt || null;
    const stmtNo = `OOS-${String(salary._id).slice(-8).toUpperCase()}`;
    const payStatus = String(salary?.paymentStatus || 'pending');
    const statusLabel = payStatus === 'paid' ? 'PAID' : payStatus === 'partial' ? 'PARTIAL' : 'PENDING';
    const statusColor = payStatus === 'paid' ? '#4ade80' : payStatus === 'partial' ? '#fbbf24' : '#f87171';

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
                  ${manualAddition > 0 ? `<tr><td class="lbl">Manual Addition</td><td class="amt green">+ ${safe(fmtMoney(manualAddition))}</td></tr>` : ''}
                  ${manualDeduction > 0 ? `<tr><td class="lbl">Manual Deduction</td><td class="amt red">&#8722; ${safe(fmtMoney(manualDeduction))}</td></tr>` : ''}
                  <tr class="net-row"><td class="lbl">Net Payable</td><td class="amt">${safe(fmtMoney(finalPayable))}</td></tr>
                  <tr><td class="lbl">Amount Paid</td><td class="amt green">&#8722; ${safe(fmtMoney(paidAmount))}</td></tr>
                </tbody>
              </table>
              <div class="balance-due">
                <div>
                  <div class="balance-lbl">Balance Due</div>
                  ${paymentDate ? `<div class="balance-sub">Last payment: ${safe(fmtDate(paymentDate))}</div>` : ''}
                </div>
                <div class="balance-amt">${safe(fmtMoney(dueAmount))}</div>
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

    const fs = require('fs');
    const chromePaths = [
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium-browser',
      '/usr/bin/chromium',
      '/snap/bin/chromium',
    ];
    const systemChrome = chromePaths.find((p) => fs.existsSync(p));
    browser = await puppeteer.launch({
      headless: true,
      executablePath: systemChrome || undefined,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'load', timeout: 20000 }).catch(() => {});
    const pdfBuffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '10mm', bottom: '10mm', left: '12mm', right: '12mm' },
    });

    const safeOwner = String(owner?.fullName || 'owner').replace(/[^a-z0-9-_]+/gi, '_');
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

    await OwnerOperatorFinancialRecord.deleteMany({ tenantId, salary: salary._id });
    await OwnerOperatorSalary.deleteOne({ _id: salary._id, tenantId });

    logActivity(req, {
      action: 'OWNER_OPERATOR_SALARY_REMOVED',
      module: 'owner-operators',
      description: `Removed owner operator payslip (${salary.month}/${salary.year})`,
      resourceId: salary._id,
      details: {
        ownerOperator: salary.ownerOperator,
        month: salary.month,
        year: salary.year,
      },
    });

    return res.json({ status: true, message: 'Payslip removed successfully' });
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
    const amount = Number(req.body?.amount || 0);
    const notes = String(req.body?.notes || '').trim();
    if (amount <= 0) return res.status(400).json({ status: false, message: 'Payment amount should be greater than 0' });
    const salaryCurrency = normalizeCurrency(salary?.currency, req.tenant?.billing?.currency || 'USD');
    const inputCurrency = normalizeCurrency(req.body?.currency, salaryCurrency);
    const fxRatesMap = await getFxRatesMap(tenantId, salary.month, salary.year, salaryCurrency);
    const convertedAmount = Number(convertAmount(amount, inputCurrency, salaryCurrency, fxRatesMap).value || 0);
    if (convertedAmount <= 0) return res.status(400).json({ status: false, message: 'Converted payment amount should be greater than 0' });

    // Clamp paid to payable so overpayment can't inflate the paid total / reporting.
    const finalPayable = Number(salary.finalPayable || 0);
    const nextPaid = Math.min(Number(salary.paidAmount || 0) + convertedAmount, Math.max(finalPayable, 0));
    salary.paidAmount = nextPaid;
    salary.dueAmount = Math.max(finalPayable - nextPaid, 0);
    if (salary.dueAmount === 0 && finalPayable > 0) salary.paymentStatus = 'paid';
    else if (salary.paidAmount > 0) salary.paymentStatus = 'partial';
    else salary.paymentStatus = 'pending';
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
      paymentStatus: salary.paymentStatus,
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

    logActivity(req, {
      action: 'PAYMENT',
      module: 'payment',
      description: `Updated owner operator salary payment (${salary.month}/${salary.year})`,
      resourceId: salary._id,
      details: { amount: convertedAmount, inputAmount: amount, inputCurrency, paidAmount: salary.paidAmount, dueAmount: salary.dueAmount },
    });

    return res.json({ status: true, salary, message: 'Salary payment updated' });
  } catch (err) {
    JSONerror(res, err, next);
    logger(err);
  }
});

exports.updateSalaryAdjustments = catchAsync(async (req, res, next) => {
  try {
    if (!hasOwnerOperatorAccess(req)) {
      return res.status(403).json({ status: false, message: 'You are not allowed to update salary adjustments' });
    }
    const tenantId = getTenantId(req);
    const salary = await OwnerOperatorSalary.findOne({ _id: req.params.id, tenantId });
    if (!salary) return res.status(404).json({ status: false, message: 'Salary record not found' });

    const previousDueAdded = Number(req.body?.previousDueAdded || 0);
    const manualDeduction = Number(req.body?.manualDeduction || 0);
    const manualAddition = Number(req.body?.manualAddition || 0);
    const notes = String(req.body?.notes || '').trim();

    const basePayable = Number(
      salary.basePayable != null
        ? salary.basePayable
        : (salary.totalSettleAmount != null ? salary.totalSettleAmount : (Number(salary.totalOwnerProfit || 0) - Number(salary.totalDriverDeduction || 0)))
    );
    const totalDriverDeduction = Number(salary.totalDriverDeduction || 0);
    const finalPayable = basePayable - totalDriverDeduction + previousDueAdded + manualAddition - manualDeduction;
    const paidAmount = Number(salary.paidAmount || 0);
    const dueAmount = Math.max(finalPayable - paidAmount, 0);

    salary.basePayable = basePayable;
    salary.previousDueAdded = previousDueAdded;
    salary.manualDeduction = manualDeduction;
    salary.manualAddition = manualAddition;
    salary.finalPayable = finalPayable;
    salary.dueAmount = dueAmount;
    if (dueAmount === 0) salary.paymentStatus = 'paid';
    else if (paidAmount > 0) salary.paymentStatus = 'partial';
    else salary.paymentStatus = 'pending';
    if (notes) salary.notes = notes;
    await salary.save();

    return res.json({ status: true, salary, message: 'Salary adjustments updated' });
  } catch (err) {
    JSONerror(res, err, next);
    logger(err);
  }
});

exports.addSalaryExpense = catchAsync(async (req, res, next) => {
  try {
    if (!hasOwnerOperatorAccess(req)) {
      return res.status(403).json({ status: false, message: 'You are not allowed to add salary expenses' });
    }
    const tenantId = getTenantId(req);
    const salary = await OwnerOperatorSalary.findOne({ _id: req.params.id, tenantId });
    if (!salary) return res.status(404).json({ status: false, message: 'Salary record not found' });

    const expenseType = String(req.body?.expenseType || '').toLowerCase();
    const amount = Number(req.body?.amount || 0);
    const notes = String(req.body?.notes || '').trim();
    const entryDate = req.body?.date ? new Date(req.body.date) : null;
    if (entryDate && Number.isNaN(entryDate.getTime())) {
      return res.status(400).json({ status: false, message: 'Invalid date' });
    }
    if (!['addition', 'deduction'].includes(expenseType)) {
      return res.status(400).json({ status: false, message: 'expenseType must be addition or deduction' });
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ status: false, message: 'Valid amount is required' });
    }
    if (!notes) {
      return res.status(400).json({ status: false, message: 'Notes are required' });
    }
    const salaryCurrency = normalizeCurrency(salary?.currency, req.tenant?.billing?.currency || 'USD');
    const inputCurrency = normalizeCurrency(req.body?.currency, salaryCurrency);
    const fxRatesMap = await getFxRatesMap(tenantId, salary.month, salary.year, salaryCurrency);
    const convertedAmount = Number(convertAmount(amount, inputCurrency, salaryCurrency, fxRatesMap).value || 0);
    if (!Number.isFinite(convertedAmount) || convertedAmount <= 0) {
      return res.status(400).json({ status: false, message: 'Converted amount is invalid' });
    }

    if (expenseType === 'addition') salary.manualAddition = Number(salary.manualAddition || 0) + convertedAmount;
    else salary.manualDeduction = Number(salary.manualDeduction || 0) + convertedAmount;

    const basePayable = Number(
      salary.basePayable != null
        ? salary.basePayable
        : (salary.totalSettleAmount != null ? salary.totalSettleAmount : (Number(salary.totalOwnerProfit || 0) - Number(salary.totalDriverDeduction || 0)))
    );
    const finalPayable =
      basePayable -
      Number(salary.totalDriverDeduction || 0) +
      Number(salary.previousDueAdded || 0) +
      Number(salary.manualAddition || 0) -
      Number(salary.manualDeduction || 0);
    const paidAmount = Number(salary.paidAmount || 0);
    const dueAmount = Math.max(finalPayable - paidAmount, 0);
    salary.basePayable = basePayable;
    salary.finalPayable = finalPayable;
    salary.dueAmount = dueAmount;
    if (dueAmount === 0) salary.paymentStatus = 'paid';
    else if (paidAmount > 0) salary.paymentStatus = 'partial';
    else salary.paymentStatus = 'pending';
    await salary.save();

    await OwnerOperatorFinancialRecord.create({
      tenantId,
      company: req.user?.company?._id || req.user?.company || null,
      ownerOperator: salary.ownerOperator,
      salary: salary._id,
      type: 'ADJUSTMENT',
      amount: convertedAmount,
      currency: salaryCurrency,
      month: salary.month,
      year: salary.year,
      paymentStatus: salary.paymentStatus,
      date: entryDate,
      notes,
      meta: {
        expenseType,
        effect: expenseType === 'addition' ? 'credit' : 'debit',
        inputAmount: amount,
        inputCurrency,
        conversionRate: Number(convertAmount(1, inputCurrency, salaryCurrency, fxRatesMap).value || 1),
      },
      createdBy: req.user?._id,
    });

    return res.json({ status: true, salary, message: 'Expense added successfully' });
  } catch (err) {
    JSONerror(res, err, next);
    logger(err);
  }
});

exports.updateSalaryExpense = catchAsync(async (req, res, next) => {
  try {
    if (!hasOwnerOperatorAccess(req)) {
      return res.status(403).json({ status: false, message: 'You are not allowed to update salary expenses' });
    }
    const tenantId = getTenantId(req);
    const record = await OwnerOperatorFinancialRecord.findOne({
      _id: req.params.id,
      tenantId,
      type: 'ADJUSTMENT',
    });
    if (!record) return res.status(404).json({ status: false, message: 'Expense record not found' });

    const amount = Number(req.body?.amount || 0);
    const notes = String(req.body?.notes || '').trim();
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ status: false, message: 'Valid amount is required' });
    }
    if (!notes) return res.status(400).json({ status: false, message: 'Notes are required' });

    const expenseType = String(record?.meta?.expenseType || '').toLowerCase();
    if (!['addition', 'deduction'].includes(expenseType)) {
      return res.status(400).json({ status: false, message: 'Only adjustment expenses can be edited' });
    }
    const salary = await OwnerOperatorSalary.findOne({ _id: record.salary, tenantId });
    if (!salary) return res.status(404).json({ status: false, message: 'Salary record not found' });

    const prevAmount = Number(record.amount || 0);
    const delta = amount - prevAmount;
    if (expenseType === 'addition') salary.manualAddition = Number(salary.manualAddition || 0) + delta;
    else salary.manualDeduction = Number(salary.manualDeduction || 0) + delta;

    const basePayable = Number(
      salary.basePayable != null
        ? salary.basePayable
        : (salary.totalSettleAmount != null ? salary.totalSettleAmount : (Number(salary.totalOwnerProfit || 0) - Number(salary.totalDriverDeduction || 0)))
    );
    const finalPayable =
      basePayable -
      Number(salary.totalDriverDeduction || 0) +
      Number(salary.previousDueAdded || 0) +
      Number(salary.manualAddition || 0) -
      Number(salary.manualDeduction || 0);
    const paidAmount = Number(salary.paidAmount || 0);
    const dueAmount = Math.max(finalPayable - paidAmount, 0);
    salary.basePayable = basePayable;
    salary.finalPayable = finalPayable;
    salary.dueAmount = dueAmount;
    if (dueAmount === 0) salary.paymentStatus = 'paid';
    else if (paidAmount > 0) salary.paymentStatus = 'partial';
    else salary.paymentStatus = 'pending';
    await salary.save();

    record.amount = amount;
    record.notes = notes;
    if (req.body?.date) {
      const entryDate = new Date(req.body.date);
      if (!Number.isNaN(entryDate.getTime())) record.date = entryDate;
    }
    record.paymentStatus = salary.paymentStatus;
    record.meta = { ...(record.meta || {}), updatedAt: new Date() };
    await record.save();

    return res.json({ status: true, salary, record, message: 'Expense updated successfully' });
  } catch (err) {
    JSONerror(res, err, next);
    logger(err);
  }
});

exports.removeSalaryExpense = catchAsync(async (req, res, next) => {
  try {
    if (!hasOwnerOperatorAccess(req)) {
      return res.status(403).json({ status: false, message: 'You are not allowed to delete salary expenses' });
    }
    const tenantId = getTenantId(req);
    const record = await OwnerOperatorFinancialRecord.findOne({
      _id: req.params.id,
      tenantId,
      type: 'ADJUSTMENT',
    });
    if (!record) return res.status(404).json({ status: false, message: 'Expense record not found' });

    const expenseType = String(record?.meta?.expenseType || '').toLowerCase();
    if (!['addition', 'deduction'].includes(expenseType)) {
      return res.status(400).json({ status: false, message: 'Only adjustment expenses can be deleted' });
    }

    const salary = await OwnerOperatorSalary.findOne({ _id: record.salary, tenantId });
    if (!salary) return res.status(404).json({ status: false, message: 'Salary record not found' });

    const amount = Number(record.amount || 0);
    if (expenseType === 'addition') {
      salary.manualAddition = Math.max(Number(salary.manualAddition || 0) - amount, 0);
    } else {
      salary.manualDeduction = Math.max(Number(salary.manualDeduction || 0) - amount, 0);
    }

    const basePayable = Number(
      salary.basePayable != null
        ? salary.basePayable
        : (salary.totalSettleAmount != null ? salary.totalSettleAmount : (Number(salary.totalOwnerProfit || 0) - Number(salary.totalDriverDeduction || 0)))
    );
    const finalPayable =
      basePayable -
      Number(salary.totalDriverDeduction || 0) +
      Number(salary.previousDueAdded || 0) +
      Number(salary.manualAddition || 0) -
      Number(salary.manualDeduction || 0);
    const paidAmount = Number(salary.paidAmount || 0);
    const dueAmount = Math.max(finalPayable - paidAmount, 0);
    salary.basePayable = basePayable;
    salary.finalPayable = finalPayable;
    salary.dueAmount = dueAmount;
    if (dueAmount === 0) salary.paymentStatus = 'paid';
    else if (paidAmount > 0) salary.paymentStatus = 'partial';
    else salary.paymentStatus = 'pending';
    await salary.save();

    await OwnerOperatorFinancialRecord.deleteOne({ _id: record._id, tenantId });

    return res.json({ status: true, salary, message: 'Expense deleted successfully' });
  } catch (err) {
    JSONerror(res, err, next);
    logger(err);
  }
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
    if (range) {
      const salaryDocs = await OwnerOperatorSalary.find({
        tenantId,
        month: range.month,
        year: range.year,
      })
        .select('ownerOperator currency manualDeduction manualAddition previousDueAdded finalPayable')
        .lean();
      salaryByOwner = new Map(salaryDocs.map((s) => [String(s.ownerOperator), s]));
    }
    const ownerPerformance = Array.from(ownerPerfMap.entries())
      .map(([id, v]) => {
        const salary = salaryByOwner.get(id);
        const salaryCurrency = normalizeCurrency(salary?.currency, targetCurrency);
        const manualDeduction = Number(convertAmount(salary?.manualDeduction, salaryCurrency, targetCurrency, fxRatesMap).value || 0);
        const manualAddition = Number(convertAmount(salary?.manualAddition, salaryCurrency, targetCurrency, fxRatesMap).value || 0);
        const previousDueAdded = Number(convertAmount(salary?.previousDueAdded, salaryCurrency, targetCurrency, fxRatesMap).value || 0);
        const driverDeduction = Number(v.driverDeduction || 0) + manualDeduction;
        const finalPayable = salary
          ? Number(convertAmount(salary.finalPayable, salaryCurrency, targetCurrency, fxRatesMap).value || 0)
          : (Number(v.finalPayable || 0) + previousDueAdded + manualAddition - manualDeduction);
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
          previousDueAdded,
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
              miles: { $sum: { $ifNull: ['$miles', 0] } },
            },
          },
          { $sort: { trips: -1 } },
        ])
      : [];
    const truckUtilization = utilAgg.map((x) => ({ truckId: x._id, trips: x.trips, miles: x.miles }));

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
      const originalDriverAvgRate = Number(ded?.miles || 0) > 0 ? Number((ded?.weightedRateMiles || 0) / (ded?.miles || 1)) : 0;
      const driverAvgRate = Number(convertAmount(originalDriverAvgRate, deductionSourceCurrency, targetCurrency, fxRatesMap).value || 0);
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
    const manualDeduction = Number(convertAmount(salaryDoc?.manualDeduction, salaryCurrency, targetCurrency, fxRatesMap).value || 0);
    const manualAddition = Number(convertAmount(salaryDoc?.manualAddition, salaryCurrency, targetCurrency, fxRatesMap).value || 0);
    
    const finalPayable = basePayable - totalDriverDeduction + previousDueAdded + manualAddition - manualDeduction;
    const paidAmount = Number(convertAmount(salaryDoc?.paidAmount, salaryCurrency, targetCurrency, fxRatesMap).value || 0);
    const dueAmount = Math.max(finalPayable - paidAmount, 0);
    const paymentStatus = (dueAmount === 0 && finalPayable > 0) ? 'paid' : (paidAmount > 0 ? 'partial' : 'pending');

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
      manualDeduction,
      manualAddition,
      finalPayable,
      dueAmount,
      paidAmount,
      paymentStatus,
      orderBreakdown,
    };
    return res.json({ status: true, data: payload });
  } catch (err) {
    JSONerror(res, err, next);
    logger(err);
  }
});
