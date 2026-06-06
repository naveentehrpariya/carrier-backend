const mongoose = require('mongoose');
const https = require('https');
const puppeteer = require('puppeteer');
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
const { logActivity } = require('../utils/activityLogger');
const SUPPORTED_CURRENCIES = new Set(['CAD', 'USD', 'INR']);

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

function buildDateRange(month, year) {
  const m = Number(month);
  const y = Number(year);
  if (!m || !y || m < 1 || m > 12 || y < 2000 || y > 9999) return null;
  const from = new Date(y, m - 1, 1, 0, 0, 0, 0);
  const to = new Date(y, m, 0, 23, 59, 59, 999);
  return { from, to, month: m, year: y };
}

function normalizeCurrency(value, fallback = 'CAD') {
  const code = String(value || fallback).trim().toUpperCase();
  const normalizedFallback = String(fallback || 'CAD').toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) return normalizedFallback;
  if (!SUPPORTED_CURRENCIES.has(code)) return normalizedFallback;
  return code;
}

async function getFxRatesMap(tenantId, month, year, targetCurrency) {
  const target = normalizeCurrency(targetCurrency, 'CAD');
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

function convertAmount(amount, sourceCurrency, targetCurrency, fxMap) {
  const source = normalizeCurrency(sourceCurrency, targetCurrency);
  const target = normalizeCurrency(targetCurrency, 'CAD');
  const numeric = Number(amount || 0);
  if (source === target) return { value: numeric, rate: 1 };
  const directRate = Number(fxMap?.get(source) || 0);
  if (directRate > 0) return { value: numeric * directRate, rate: directRate };
  return { value: numeric, rate: 1 };
}

function normalizeTripMiles(trip) {
  const unit = String(trip?.distance_unit || '').toLowerCase();
  const milesField = Number(trip?.miles || 0);
  const totalDistanceField = Number(trip?.totalDistance || 0);
  const totalKmField = Number(trip?.total_km || 0);

  // If trip distance is stored in KM, convert to miles no matter which numeric field carries value.
  if (unit === 'km') {
    const kmValue = totalKmField > 0 ? totalKmField : (totalDistanceField > 0 ? totalDistanceField : milesField);
    return kmValue > 0 ? kmValue / 1.60934 : 0;
  }

  // For MI, prefer explicit miles first.
  if (unit === 'mi') {
    if (milesField > 0) return milesField;
    if (totalDistanceField > 0) return totalDistanceField;
    if (totalKmField > 0) return totalKmField / 1.60934;
    return 0;
  }

  // Unknown/missing unit (legacy data):
  // Prefer explicit miles. If unavailable, prefer total_km converted to miles.
  // Keep totalDistance as the final fallback because some old records stored km there.
  if (milesField > 0) return milesField;
  if (totalKmField > 0) return totalKmField / 1.60934;
  if (totalDistanceField > 0) return totalDistanceField;
  return 0;
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

async function buildOrderDriverDeductions(tenantId, orderIds) {
  const emptyResult = { byOrder: new Map(), soloTotal: 0, teamTotal: 0 };
  if (!Array.isArray(orderIds) || orderIds.length === 0) return emptyResult;

  const trips = await Trip.find({
    tenantId,
    order: { $in: orderIds },
    deletedAt: null,
  })
    .select('order miles totalDistance total_km distance_unit rate_per_mile drivers driver')
    .lean();
  const orderRows = await Order.find({
    tenantId,
    _id: { $in: orderIds },
  })
    .select('_id totalDistance')
    .lean();
  const orderDistanceKmMap = new Map(
    (orderRows || []).map((o) => [String(o._id), Number(o?.totalDistance || 0)])
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
    .select('user ratePerMile ratePerMileSolo ratePerMileTeam')
    .lean();
  const profileMap = new Map(driverProfiles.map((p) => [String(p.user), p]));

  const byOrder = new Map();
  let soloTotal = 0;
  let teamTotal = 0;
  (trips || []).forEach((trip) => {
    const list = Array.isArray(trip.drivers) && trip.drivers.length > 0 ? trip.drivers.map(String) : trip.driver ? [String(trip.driver)] : [];
    if (list.length === 0) return;
    const count = Math.max(list.length, 1);
    const isTeam = count > 1;
    const orderId = String(trip.order);
    const rawDistance = Number(trip.totalDistance || trip.miles || trip.total_km || 0);
    const orderDistanceKm = Number(orderDistanceKmMap.get(orderId) || 0);
    const orderDistanceMiles = orderDistanceKm > 0 ? orderDistanceKm * 0.6214 : 0;
    const orderRawTotal = Number(orderTripDistanceTotals.get(orderId) || 0);
    const miles = orderDistanceMiles > 0 && orderRawTotal > 0
      ? (Math.max(rawDistance, 0) / orderRawTotal) * orderDistanceMiles
      : normalizeTripMiles(trip);
    let tripDeduction = 0;
    let tripWeightedRateMiles = 0;
    list.forEach((driverId) => {
      const profile = profileMap.get(String(driverId));
      const soloRate = Number(profile?.ratePerMileSolo ?? profile?.ratePerMile ?? 0) || 0;
      const teamRate = Number(profile?.ratePerMileTeam ?? profile?.ratePerMile ?? 0) || 0;
      const profileRate = isTeam ? teamRate : soloRate;
      const rate = Number(trip.rate_per_mile || 0) > 0 ? Number(trip.rate_per_mile || 0) : profileRate;
      tripDeduction += (miles / count) * rate;
      tripWeightedRateMiles += (miles / count) * rate;
    });
    const current = byOrder.get(orderId) || {
      deduction: 0,
      soloSegments: 0,
      teamSegments: 0,
      drivers: new Set(),
      miles: 0,
      weightedRateMiles: 0,
    };
    current.deduction += tripDeduction;
    current.miles += miles;
    current.weightedRateMiles += tripWeightedRateMiles;
    if (isTeam) current.teamSegments += 1;
    else current.soloSegments += 1;
    list.forEach((driverId) => current.drivers.add(driverId));
    byOrder.set(orderId, current);
    if (isTeam) teamTotal += tripDeduction;
    else soloTotal += tripDeduction;
  });

  return { byOrder, soloTotal, teamTotal };
}

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
      const q = String(search).trim();
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
    const { fullName, companyName, phone, email, address, notes, status } = req.body;
    if (!fullName || !phone || !email) {
      return res.status(400).json({ status: false, message: 'Full name, phone and email are required' });
    }

    const exists = await OwnerOperator.findOne({
      tenantId,
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
    return res.json({ status: true, ownerOperator });
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
    const { fullName, companyName, phone, email, address, notes, status } = req.body;
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
    const target = normalizeCurrency(targetCurrency, req.tenant?.billing?.currency || 'CAD');
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

    const target = normalizeCurrency(targetCurrency, req.tenant?.billing?.currency || 'CAD');
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
    const target = normalizeCurrency(targetCurrency, req.tenant?.billing?.currency || 'CAD');
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
    const targetCurrency = normalizeCurrency(payoutCurrency, req.tenant?.billing?.currency || 'CAD');

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
      ownerOperator: { $in: ownerIds },
      createdAt: { $gte: range.from, $lte: range.to },
      ...normalizeDeletedFilter(),
    })
      .select('serial_no customer_order_no ownerOperator total_amount settle_amount owner_profit revenue_currency driver_assignment_mode')
      .lean();
    const fxRatesMap = await getFxRatesMap(tenantId, range.month, range.year, targetCurrency);
    const orderIds = orders.map((o) => o._id);

    const { byOrder, soloTotal, teamTotal } = await buildOrderDriverDeductions(tenantId, orderIds);
    const salaries = [];
    for (const owner of ownerOperators) {
      const ownerOrders = orders.filter((o) => String(o.ownerOperator) === String(owner._id));
      const breakdown = ownerOrders.map((o) => {
        const ded = byOrder.get(String(o._id));
        const sourceCurrency = normalizeCurrency(o?.revenue_currency, targetCurrency);
        const originalDeduction = Number(ded?.deduction || 0);
        const originalOrderPrice = Number(o.total_amount || 0);
        const originalSettleAmount = Number(o.settle_amount || 0);
        const originalOwnerProfit = Number(o.owner_profit || originalOrderPrice - originalSettleAmount || 0);
        const originalPayable = originalSettleAmount - originalDeduction;
        const orderPriceConversion = convertAmount(originalOrderPrice, sourceCurrency, targetCurrency, fxRatesMap);
        const settleAmountConversion = convertAmount(originalSettleAmount, sourceCurrency, targetCurrency, fxRatesMap);
        const ownerProfitConversion = convertAmount(originalOwnerProfit, sourceCurrency, targetCurrency, fxRatesMap);
        const deductionConversion = convertAmount(originalDeduction, sourceCurrency, targetCurrency, fxRatesMap);
        const payableConversion = convertAmount(originalPayable, sourceCurrency, targetCurrency, fxRatesMap);
        const orderPrice = Number(orderPriceConversion.value || 0);
        const settleAmount = Number(settleAmountConversion.value || 0);
        const ownerProfit = Number(ownerProfitConversion.value || 0);
        const deduction = Number(deductionConversion.value || 0);
        const payable = Number(payableConversion.value || 0);
        let driverRateType = 'none';
        if ((ded?.soloSegments || 0) > 0 && (ded?.teamSegments || 0) > 0) driverRateType = 'mixed';
        else if ((ded?.teamSegments || 0) > 0) driverRateType = 'team';
        else if ((ded?.soloSegments || 0) > 0) driverRateType = 'solo';
        const originalDriverAvgRate = Number(ded?.miles || 0) > 0 ? Number((ded?.weightedRateMiles || 0) / (ded?.miles || 1)) : 0;
        const driverAvgRate = Number(convertAmount(originalDriverAvgRate, sourceCurrency, targetCurrency, fxRatesMap).value || 0);
        return {
          order: o._id,
          serial_no: o.serial_no || null,
          customer_order_no: o.customer_order_no || null,
          orderPrice,
          settleAmount,
          ownerProfit,
          driverDeduction: deduction,
          payable,
          sourceCurrency,
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
      const paymentStatus = dueAmount === 0 ? 'paid' : (paidAmount > 0 ? 'partial' : 'pending');
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
        currency: salary.currency || req.tenant?.billing?.currency || 'CAD',
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
      .populate('ownerOperator', 'fullName ownerOperatorId status')
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
    const fallbackMap = allOrderIds.length > 0 ? (await buildOrderDriverDeductions(tenantId, allOrderIds)).byOrder : new Map();
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
          const ded = fallbackMap.get(String(b?.order || ''));
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
      .populate('ownerOperator', 'fullName ownerOperatorId status phone email address')
      .lean();
    if (!salary) return res.status(404).json({ status: false, message: 'Payslip not found' });

    if (!Array.isArray(salary?.orderBreakdown)) {
      return res.json({ status: true, salary });
    }

    const orderIds = Array.from(new Set((salary?.orderBreakdown || []).map((b) => b?.order).filter(Boolean).map((id) => String(id))));
    const fallbackMap = orderIds.length > 0 ? (await buildOrderDriverDeductions(tenantId, orderIds)).byOrder : new Map();
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
        const ded = fallbackMap.get(String(b?.order || ''));
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
      .populate('ownerOperator', 'fullName ownerOperatorId status phone email address')
      .lean();
    if (!salary) return res.status(404).json({ status: false, message: 'Payslip not found' });

    const includePreviousDueParam = req.query?.includePreviousDue;
    const shouldIncludePrevDue =
      includePreviousDueParam === 'true' ||
      includePreviousDueParam === true ||
      (includePreviousDueParam === undefined && Number(salary?.previousDueAdded || 0) > 0);

    const payoutCurrency = req.query?.payoutCurrency || salary?.currency || req.tenant?.billing?.currency || 'CAD';
    const targetCurrency = normalizeCurrency(payoutCurrency, salary?.currency || req.tenant?.billing?.currency || 'CAD');
    const range = buildDateRange(salary.month, salary.year);
    if (!range) return res.status(400).json({ status: false, message: 'Invalid month/year on salary record' });

    let companyLogoUrl = req.tenant?.settings?.customizations?.theme?.logo || '';
    if (companyId) {
      const Company = require('../db/Company');
      const companyDoc = await Company.findById(companyId).lean();
      if (companyDoc && (companyDoc.pdf_logo || companyDoc.logo)) {
        companyLogoUrl = companyDoc.pdf_logo || companyDoc.logo;
      }
    }
    
    if (!companyLogoUrl) {
      const domainUrl = process.env.DOMAIN_URL || 'http://localhost:3000';
      companyLogoUrl = `${domainUrl}/logo.png`;
    }

    const owner = salary?.ownerOperator;
    if (!owner?._id) return res.status(400).json({ status: false, message: 'Owner operator not found on salary record' });

    const orders = await Order.find({
      tenantId,
      order_type: 'regular',
      isOwnerOperatedTruck: true,
      ownerOperator: owner._id,
      createdAt: { $gte: range.from, $lte: range.to },
      ...normalizeDeletedFilter(),
    })
      .select('serial_no customer_order_no total_amount settle_amount owner_profit revenue_currency shipping_details truck input_total_amount input_currency createdAt')
      .populate('truck', 'plateNumber unitNumber')
      .lean();

    const fxRatesMap = await getFxRatesMap(tenantId, range.month, range.year, targetCurrency);
    const orderIds = orders.map((o) => o._id);
    const { byOrder } = await buildOrderDriverDeductions(tenantId, orderIds);

    const orderBreakdown = orders.map((o) => {
      const ded = byOrder.get(String(o._id));
      const sourceCurrency = normalizeCurrency(o?.revenue_currency, targetCurrency);
      const originalOrderPrice = Number(o.total_amount || 0);
      const originalSettleAmount = Number(o.settle_amount || 0);
      const originalOwnerProfit = Number(o.owner_profit || originalOrderPrice - originalSettleAmount || 0);
      const originalDriverDeduction = Number(ded?.deduction || 0);
      const originalPayable = originalSettleAmount - originalDriverDeduction;
      return {
        order: o._id,
        serial_no: o.serial_no || null,
        customer_order_no: o.customer_order_no || null,
        shipping_details: Array.isArray(o.shipping_details) ? o.shipping_details : [],
        truck: o.truck || null,
        orderCreatedAt: o.createdAt || null,
        orderPrice: Number(convertAmount(originalOrderPrice, sourceCurrency, targetCurrency, fxRatesMap).value || 0),
        settleAmount: Number(convertAmount(originalSettleAmount, sourceCurrency, targetCurrency, fxRatesMap).value || 0),
        ownerProfit: Number(convertAmount(originalOwnerProfit, sourceCurrency, targetCurrency, fxRatesMap).value || 0),
        driverDeduction: Number(convertAmount(originalDriverDeduction, sourceCurrency, targetCurrency, fxRatesMap).value || 0),
        payable: Number(convertAmount(originalPayable, sourceCurrency, targetCurrency, fxRatesMap).value || 0),
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
        const truckNo = r?.truck?.unitNumber || r?.truck?.plateNumber || '';
        return `
          <tr>
            <td>${safe(r?.serial_no || '')}</td>
            <td>${safe(r?.customer_order_no || '')}</td>
            <td>${safe(truckNo)}</td>
            <td>${safe(route.pickupText)}</td>
            <td>${safe(route.deliveryText)}</td>
            <td class="num">${safe(fmtMoney(r?.settleAmount || 0))}</td>
            <td class="num">${safe(fmtMoney(r?.driverDeduction || 0))}</td>
            <td class="num strong">${safe(fmtMoney((Number(r?.settleAmount || 0) - Number(r?.driverDeduction || 0))))}</td>
          </tr>
        `;
      })
      .join('');

    const recordsHtml = (records || []).map((r) => {
      const expenseType = String(r?.meta?.expenseType || '').toLowerCase();
      const typeLabel = r.type === 'SALARY_PAYMENT'
        ? 'Payment'
        : (expenseType === 'deduction' ? 'Deduction' : 'Addition');
      const signed = r.type === 'SALARY_PAYMENT'
        ? Math.abs(Number(r?.amount || 0))
        : (expenseType === 'deduction' ? -Math.abs(Number(r?.amount || 0)) : Math.abs(Number(r?.amount || 0)));
      const prefix = signed < 0 ? '-' : '+';
      return `
        <tr>
          <td>${safe(fmtDate(r?.createdAt))}</td>
          <td>${safe(`${range.month}/${range.year}`)}</td>
          <td>${safe(typeLabel)}</td>
          <td class="num">${safe(`${prefix}${fmtMoney(Math.abs(signed))}`)}</td>
          <td>${safe(String(r?.paymentStatus || salary?.paymentStatus || 'pending'))}</td>
          <td>${safe(String(r?.notes || ''))}</td>
        </tr>
      `;
    }).join('');

    const payPeriodFrom = new Date(range.year, range.month - 1, 1);
    const payPeriodTo = new Date(range.year, range.month, 0);
    const paymentNo = salary?._id ? String(salary._id).slice(-6) : '';

    const html = `
      <!doctype html>
      <html>
        <head>
          <meta charset="utf-8" />
          <style>
            @page { size: A4; margin: 12mm; }
            html, body { padding: 0; margin: 0; }
            body { font-family: Arial, Helvetica, sans-serif; font-size: 12px; color: #0f172a; }
            .row { display: flex; justify-content: space-between; gap: 16px; }
            .col { flex: 1; min-width: 0; }
            h1 { font-size: 22px; margin: 0; }
            h2 { font-size: 14px; margin: 0 0 6px 0; }
            .muted { color: #334155; }
            .box { border: 1px solid #e5e7eb; border-radius: 10px; padding: 12px; }
            .mt { margin-top: 14px; }
            .kv { margin: 2px 0; }
            table { width: 100%; border-collapse: collapse; }
            th, td { border: 1px solid #e5e7eb; padding: 6px 8px; vertical-align: top; }
            th { background: #e6fbff; text-align: left; font-weight: 700; }
            thead { display: table-header-group; }
            tr { break-inside: avoid; page-break-inside: avoid; }
            .num { text-align: right; white-space: nowrap; }
            .strong { font-weight: 700; }
            .section-title { font-size: 16px; font-weight: 700; margin: 0 0 8px 0; }
          </style>
        </head>
        <body>
          <div class="row">
            <div class="col">
              ${companyLogo ? `<img src="${safe(companyLogo)}" alt="Logo" style="max-height: 60px; max-width: 200px; margin-bottom: 12px; display: block;" />` : ''}
              <div class="kv strong">PRO # CMC${safe(orderBreakdown[0]?.serial_no || '')}</div>
              <div class="kv muted">Date: ${safe(fmtDate(new Date()))}</div>
              <div class="kv muted">Pay Period: ${safe(fmtDate(payPeriodFrom))} to ${safe(fmtDate(payPeriodTo))}</div>
              <div class="kv muted">Statement: ${safe(new Date(range.year, range.month - 1, 1).toLocaleString('en-US', { month: 'short', year: 'numeric' }))}</div>
            </div>
            <div class="col" style="text-align:right">
              <h1>Payment Statement</h1>
              <div class="strong">${safe(companyName)}</div>
              ${companyAddress ? `<div class="muted">${safe(companyAddress)}</div>` : ''}
              ${companyEmail ? `<div class="muted">${safe(companyEmail)}</div>` : ''}
              ${companyPhone ? `<div class="muted">PH: ${safe(companyPhone)}</div>` : ''}
            </div>
          </div>

          <div class="row mt">
            <div class="col box">
              <h2>Payment Details</h2>
              <div class="kv muted">Payment #: <span class="strong">${safe(paymentNo || '-')}</span></div>
              <div class="kv muted">Cheque #: <span class="strong">-</span></div>
              <div class="kv muted">Date: <span class="strong">${safe('-')}</span></div>
              <div class="kv muted">Employee Code: <span class="strong">${safe(owner?.ownerOperatorId || '-')}</span></div>
              <div class="kv muted">Amount: <span class="strong">${safe(fmtMoney(finalPayable))}</span></div>
            </div>
            <div class="col box">
              <h2>Pay To</h2>
              <div class="kv strong" style="font-size: 16px;">${safe(owner?.fullName || '')}</div>
              ${owner?.address ? `<div class="kv muted">${safe(owner.address)}</div>` : ''}
              ${owner?.email ? `<div class="kv muted">Email: <span class="strong">${safe(owner.email)}</span></div>` : ''}
              ${owner?.phone ? `<div class="kv muted">Phone: <span class="strong">${safe(owner.phone)}</span></div>` : ''}
            </div>
          </div>

          <div class="mt">
            <table>
              <thead>
                <tr>
                  <th style="width: 7%;">Trip#</th>
                  <th style="width: 12%;">Sett. Inv.#</th>
                  <th style="width: 8%;">Truck#</th>
                  <th style="width: 26%;">Pickup</th>
                  <th style="width: 26%;">Delivery</th>
                  <th class="num" style="width: 7%;">Settle</th>
                  <th class="num" style="width: 7%;">Driver</th>
                  <th class="num" style="width: 7%;">Final</th>
                </tr>
              </thead>
              <tbody>
                ${orderRowsHtml || '<tr><td colspan="8" class="num">—</td></tr>'}
              </tbody>
              <tfoot>
                <tr>
                  <td colspan="5" class="strong">Total</td>
                  <td class="num strong">${safe(fmtMoney(basePayable))}</td>
                  <td class="num strong">${safe(fmtMoney(totalDriverDeduction))}</td>
                  <td class="num strong">${safe(fmtMoney(basePayable - totalDriverDeduction))}</td>
                </tr>
              </tfoot>
            </table>
          </div>

          <div class="mt">
            <div class="section-title">Records (Deductions / Additions / Payments)</div>
            <table>
              <thead>
                <tr>
                  <th style="width: 14%;">Date</th>
                  <th style="width: 10%;">Month</th>
                  <th style="width: 16%;">Type</th>
                  <th class="num" style="width: 14%;">Amount</th>
                  <th style="width: 12%;">Status</th>
                  <th style="width: 34%;">Notes</th>
                </tr>
              </thead>
              <tbody>
                ${recordsHtml || '<tr><td colspan="6" class="num">—</td></tr>'}
              </tbody>
            </table>
          </div>

          <div class="mt">
            <table>
              <thead>
                <tr>
                  <th style="width: 60%;">Summary</th>
                  <th class="num" style="width: 40%;">Amount</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>Settlement Total</td>
                  <td class="num">${safe(fmtMoney(basePayable))}</td>
                </tr>
                <tr>
                  <td>Driver Salary Deduction</td>
                  <td class="num">-${safe(fmtMoney(totalDriverDeduction))}</td>
                </tr>
                ${previousDueAdded > 0 ? `
                  <tr>
                    <td>Previous Month Due (Carry Forward)</td>
                    <td class="num">${safe(fmtMoney(previousDueAdded))}</td>
                  </tr>
                ` : ''}
                ${manualAddition > 0 ? `
                  <tr>
                    <td>Manual Addition</td>
                    <td class="num">${safe(fmtMoney(manualAddition))}</td>
                  </tr>
                ` : ''}
                ${manualDeduction > 0 ? `
                  <tr>
                    <td>Manual Deduction</td>
                    <td class="num">-${safe(fmtMoney(manualDeduction))}</td>
                  </tr>
                ` : ''}
                <tr>
                  <td class="strong">Net Pay</td>
                  <td class="num strong">${safe(fmtMoney(finalPayable))}</td>
                </tr>
                <tr>
                  <td class="muted">Paid</td>
                  <td class="num muted">${safe(fmtMoney(paidAmount))}</td>
                </tr>
                <tr>
                  <td class="muted">Due</td>
                  <td class="num muted">${safe(fmtMoney(dueAmount))}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </body>
      </html>
    `;

    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const pdfBuffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      preferCSSPageSize: true,
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
    const salaryCurrency = normalizeCurrency(salary?.currency, req.tenant?.billing?.currency || 'CAD');
    const inputCurrency = normalizeCurrency(req.body?.currency, salaryCurrency);
    const fxRatesMap = await getFxRatesMap(tenantId, salary.month, salary.year, salaryCurrency);
    const convertedAmount = Number(convertAmount(amount, inputCurrency, salaryCurrency, fxRatesMap).value || 0);
    if (convertedAmount <= 0) return res.status(400).json({ status: false, message: 'Converted payment amount should be greater than 0' });

    const nextPaid = Number(salary.paidAmount || 0) + convertedAmount;
    const dueAmount = Number(salary.finalPayable || 0) - nextPaid;
    salary.paidAmount = nextPaid;
    salary.dueAmount = Math.max(dueAmount, 0);
    if (salary.dueAmount === 0) salary.paymentStatus = 'paid';
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
    if (!['addition', 'deduction'].includes(expenseType)) {
      return res.status(400).json({ status: false, message: 'expenseType must be addition or deduction' });
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ status: false, message: 'Valid amount is required' });
    }
    if (!notes) {
      return res.status(400).json({ status: false, message: 'Notes are required' });
    }
    const salaryCurrency = normalizeCurrency(salary?.currency, req.tenant?.billing?.currency || 'CAD');
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
    const targetCurrency = normalizeCurrency(payoutCurrency, req.tenant?.billing?.currency || 'CAD');

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
    const ownerOrders = await Order.find(orderFilter).select('ownerOperator truck total_amount settle_amount owner_profit revenue_currency').lean();
    const fxRatesMap = range ? await getFxRatesMap(tenantId, range.month, range.year, targetCurrency) : new Map([[targetCurrency, 1]]);
    const ownerOrderCount = ownerOrders.length;
    const totalOrderValue = ownerOrders.reduce((acc, o) => {
      const sourceCurrency = normalizeCurrency(o?.revenue_currency, targetCurrency);
      return acc + Number(convertAmount(o.total_amount, sourceCurrency, targetCurrency, fxRatesMap).value || 0);
    }, 0);
    const totalSettleAmount = ownerOrders.reduce((acc, o) => {
      const sourceCurrency = normalizeCurrency(o?.revenue_currency, targetCurrency);
      return acc + Number(convertAmount(o.settle_amount, sourceCurrency, targetCurrency, fxRatesMap).value || 0);
    }, 0);
    const totalOwnerProfit = ownerOrders.reduce((acc, o) => {
      const sourceCurrency = normalizeCurrency(o?.revenue_currency, targetCurrency);
      return acc + Number(convertAmount(o.owner_profit, sourceCurrency, targetCurrency, fxRatesMap).value || 0);
    }, 0);

    const ownerDocs = await OwnerOperator.find({ tenantId, ...normalizeDeletedFilter() })
      .select('fullName ownerOperatorId status')
      .lean();
    const ownerPerfMap = new Map(
      ownerDocs.map((o) => [
        String(o._id),
        { orders: 0, revenue: 0, settleAmount: 0, ownerProfit: 0, driverDeduction: 0, finalPayable: 0 },
      ])
    );
    ownerOrders.forEach((o) => {
      const key = String(o.ownerOperator || '');
      if (!key) return;
      const cur = ownerPerfMap.get(key) || {
        orders: 0,
        revenue: 0,
        settleAmount: 0,
        ownerProfit: 0,
        driverDeduction: 0,
        finalPayable: 0,
      };
      cur.orders += 1;
      const sourceCurrency = normalizeCurrency(o?.revenue_currency, targetCurrency);
      cur.revenue += Number(convertAmount(o.total_amount, sourceCurrency, targetCurrency, fxRatesMap).value || 0);
      cur.settleAmount += Number(convertAmount(o.settle_amount, sourceCurrency, targetCurrency, fxRatesMap).value || 0);
      cur.ownerProfit += Number(convertAmount(o.owner_profit, sourceCurrency, targetCurrency, fxRatesMap).value || 0);
      ownerPerfMap.set(key, cur);
    });
    const ownerOrderIds = ownerOrders.map((o) => o._id);
    const { byOrder, soloTotal, teamTotal } = await buildOrderDriverDeductions(tenantId, ownerOrderIds);
    const convertedTeamTotal = ownerOrders.reduce((acc, o) => {
      const ded = byOrder.get(String(o._id));
      const orderSourceCurrency = normalizeCurrency(o?.revenue_currency, targetCurrency);
      const isTeamOrder = Number(ded?.teamSegments || 0) > 0;
      if (!isTeamOrder) return acc;
      return acc + Number(convertAmount(Number(ded?.deduction || 0), orderSourceCurrency, targetCurrency, fxRatesMap).value || 0);
    }, 0);
    const convertedSoloTotal = ownerOrders.reduce((acc, o) => {
      const ded = byOrder.get(String(o._id));
      const orderSourceCurrency = normalizeCurrency(o?.revenue_currency, targetCurrency);
      const isSoloOnly = Number(ded?.teamSegments || 0) === 0 && Number(ded?.soloSegments || 0) > 0;
      if (!isSoloOnly) return acc;
      return acc + Number(convertAmount(Number(ded?.deduction || 0), orderSourceCurrency, targetCurrency, fxRatesMap).value || 0);
    }, 0);
    ownerOrders.forEach((o) => {
      const key = String(o.ownerOperator || '');
      if (!key) return;
      const cur = ownerPerfMap.get(key);
      if (!cur) return;
      const ded = byOrder.get(String(o._id));
      const sourceCurrency = normalizeCurrency(o?.revenue_currency, targetCurrency);
      const deduction = Number(convertAmount(Number(ded?.deduction || 0), sourceCurrency, targetCurrency, fxRatesMap).value || 0);
      const ownerProfit = Number(convertAmount(o.owner_profit, sourceCurrency, targetCurrency, fxRatesMap).value || 0);
      cur.driverDeduction += deduction;
      cur.finalPayable += ownerProfit - deduction;
      ownerPerfMap.set(key, cur);
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
    const targetCurrency = normalizeCurrency(payoutCurrency, salaryDoc?.currency || req.tenant?.billing?.currency || 'CAD');

    const owner = await OwnerOperator.findOne({ _id: ownerOperatorId, tenantId, ...normalizeDeletedFilter() })
      .select('fullName ownerOperatorId status phone email address')
      .lean();
    if (!owner) return res.status(404).json({ status: false, message: 'Owner operator not found' });

    const orders = await Order.find({
      tenantId,
      order_type: 'regular',
      isOwnerOperatedTruck: true,
      ownerOperator: ownerOperatorId,
      createdAt: { $gte: range.from, $lte: range.to },
      ...normalizeDeletedFilter(),
    })
      .select('serial_no customer_order_no total_amount settle_amount owner_profit revenue_currency shipping_details truck input_total_amount input_currency createdAt')
      .populate('truck', 'plateNumber unitNumber')
      .lean();
    const fxRatesMap = await getFxRatesMap(tenantId, range.month, range.year, targetCurrency);
    const orderIds = orders.map((o) => o._id);
    const { byOrder } = await buildOrderDriverDeductions(tenantId, orderIds);

    const orderBreakdown = orders.map((o) => {
      const ded = byOrder.get(String(o._id));
      const sourceCurrency = normalizeCurrency(o?.revenue_currency, targetCurrency);
      const originalOrderPrice = Number(o.total_amount || 0);
      const originalSettleAmount = Number(o.settle_amount || 0);
      const originalOwnerProfit = Number(o.owner_profit || originalOrderPrice - originalSettleAmount || 0);
      const originalDriverDeduction = Number(ded?.deduction || 0);
      const originalPayable = originalSettleAmount - originalDriverDeduction;
      const orderPrice = Number(convertAmount(originalOrderPrice, sourceCurrency, targetCurrency, fxRatesMap).value || 0);
      const settleAmount = Number(convertAmount(originalSettleAmount, sourceCurrency, targetCurrency, fxRatesMap).value || 0);
      const ownerProfit = Number(convertAmount(originalOwnerProfit, sourceCurrency, targetCurrency, fxRatesMap).value || 0);
      const driverDeduction = Number(convertAmount(originalDriverDeduction, sourceCurrency, targetCurrency, fxRatesMap).value || 0);
      const payable = Number(convertAmount(originalPayable, sourceCurrency, targetCurrency, fxRatesMap).value || 0);
      let driverRateType = 'none';
      if ((ded?.soloSegments || 0) > 0 && (ded?.teamSegments || 0) > 0) driverRateType = 'mixed';
      else if ((ded?.teamSegments || 0) > 0) driverRateType = 'team';
      else if ((ded?.soloSegments || 0) > 0) driverRateType = 'solo';
      const originalDriverAvgRate = Number(ded?.miles || 0) > 0 ? Number((ded?.weightedRateMiles || 0) / (ded?.miles || 1)) : 0;
      const driverAvgRate = Number(convertAmount(originalDriverAvgRate, sourceCurrency, targetCurrency, fxRatesMap).value || 0);
      return {
        order: o._id,
        serial_no: o.serial_no || null,
        customer_order_no: o.customer_order_no || null,
        shipping_details: Array.isArray(o.shipping_details) ? o.shipping_details : [],
        truck: o.truck || null,
        orderCreatedAt: o.createdAt || null,
        input_total_amount: Number(o.input_total_amount || 0),
        input_currency: normalizeCurrency(o.input_currency, sourceCurrency),
        orderPrice,
        settleAmount,
        ownerProfit,
        driverDeduction,
        payable,
        sourceCurrency,
        targetCurrency,
        fxRate: Number(convertAmount(1, sourceCurrency, targetCurrency, fxRatesMap).value || 1),
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
    const paymentStatus = dueAmount === 0 ? 'paid' : (paidAmount > 0 ? 'partial' : 'pending');

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
