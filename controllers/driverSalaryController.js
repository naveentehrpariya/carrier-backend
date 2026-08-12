const mongoose = require('mongoose');
const puppeteer = require('puppeteer');
const { launchBrowser } = require('../utils/puppeteer');
const fs = require('fs');
const path = require('path');

const catchAsync = require('../utils/catchAsync');
const JSONerror = require('../utils/jsonErrorHandler');
const logger = require('../utils/logger');
const Trip = require('../db/Trip');
const Order = require('../db/Order');
const Users = require('../db/Users');
const DriverProfile = require('../db/DriverProfile');
const DriverDeduction = require('../db/DriverDeduction');
const DriverSalary = require('../db/DriverSalary');
const DriverPayment = require('../db/DriverPayment');
const { logActivity, logChange } = require('../utils/activityLogger');
const { round2, EPSILON, computePayslipTotals, previousMonthOf } = require('../utils/payslipMath');
const { MI_PER_KM, deriveTripMiles, pickDriverRate, getDriverRateCurrency } = require('../utils/distance');
const { normalizeCurrency, buildDateRange, getFxRatesMap, convertAmount, missingFxSources } = require('../utils/fx');
const { ensureMonthlyFxRates } = require('./ownerOperatorController');

function getTenantId(req) {
  return req.tenantId || req.user?.tenantId || null;
}

// Payslips default to the currency the driver is actually paid in, not the tenant's billing
// currency — the caller can still ask for any currency explicitly.
async function resolveSalaryCurrency(req, tenantId, driverId, requested) {
  if (requested) return normalizeCurrency(requested, 'USD');
  const profile = await DriverProfile.findOne({ tenantId, user: driverId }).select('rateCurrency').lean();
  return normalizeCurrency(getDriverRateCurrency(profile), req.tenant?.billing?.currency || 'USD');
}

// buildDriverSalaryPayload refuses to guess when a month's FX rate is absent — surface that as a
// 400 instead of letting it fall through to the generic 500 handler.
function isFxMissing(err) {
  return err?.code === 'fx_missing';
}

function hasDriverSalaryAccess(req) {
  return (
    req.user?.is_admin === 1 ||
    Number(req.user?.role) === 3 ||
    req.user?.permissions?.includes('accounting') ||
    req.user?.permissions?.includes('subadmin')
  );
}

const safe = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

// Per-order trip pay for one driver in a date range. Mirrors getDriverTripSummary math
// (real miles from order.totalDistance KM, per-driver share, team/solo rate).
// All money here is in the driver's locked rateCurrency — NOT necessarily USD.
async function computeDriverTripPay(tenantId, driverId, range) {
  const driverObjId = new mongoose.Types.ObjectId(driverId);
  const driverProfile = await DriverProfile.findOne({ tenantId, user: driverId }).lean();
  const rateCurrency = getDriverRateCurrency(driverProfile);
  const soloRate = Number(driverProfile?.ratePerMileSolo ?? driverProfile?.ratePerMile ?? 0) || 0;
  const teamRate = Number(driverProfile?.ratePerMileTeam ?? driverProfile?.ratePerMile ?? 0) || 0;
  const cityRate = Number(driverProfile?.cityHoursRate ?? 0) || 0;

  // All trips this driver is on (any date).
  const driverTrips = await Trip.find({
    tenantId, deletedAt: null,
    $or: [{ drivers: driverObjId }, { driver: driverObjId }],
  })
    .select('order drivers driver totalDistance miles total_km distance_unit rate_per_mile rate_currency trip_no start_stop_index end_stop_index start_location end_location')
    .lean();

  // Attribute pay to the ORDER's month (matches owner-operator cost attribution, so the same
  // order's driver pay lands in the same period on every screen — not trip.createdAt).
  const candidateOrderIds = [...new Set(driverTrips.map((t) => String(t.order)).filter(Boolean))];
  const orderRows = await Order.find({
    tenantId, _id: { $in: candidateOrderIds },
    createdAt: { $gte: range.from, $lte: range.to },
  })
    .select('_id serial_no totalDistance shipping_details')
    .lean();
  const orderKmMap = new Map(orderRows.map((o) => [String(o._id), Number(o?.totalDistance || 0)]));
  const orderSerialMap = new Map(orderRows.map((o) => [String(o._id), o?.serial_no ?? null]));
  const orderStopsMap = new Map(orderRows.map((o) => [
    String(o._id),
    (Array.isArray(o?.shipping_details) ? o.shipping_details : []).flatMap((b) => (Array.isArray(b?.locations) ? b.locations : [])),
  ]));

  // The stop a leg starts/ends at, by position. `Trip.start_location` is a denormalized string kept
  // for legacy rows; the order's own stop is the one that also carries the date.
  const stopAt = (orderId, index, fallbackText) => {
    const stops = orderStopsMap.get(orderId) || [];
    const stop = Number.isInteger(index) && index >= 0 && index < stops.length ? stops[index] : null;
    const text = String(stop?.location || stop?.address || fallbackText || '').trim();
    const city = String(stop?.city || '').trim();
    return {
      label: text || city || '',
      date: stop?.date || stop?.pickup_date || stop?.delivery_date || stop?.datetime || null,
    };
  };
  const inMonth = new Set(orderRows.map((o) => String(o._id)));

  // Denominator = sum of ALL trips' raw distance per in-month order (proportioning weight).
  // Must include trips this driver is NOT on, else a driver on a subset of segments is over-paid.
  const allOrderTrips = inMonth.size
    ? await Trip.find({ tenantId, deletedAt: null, order: { $in: [...inMonth] } })
        .select('order totalDistance miles total_km').lean()
    : [];
  const orderRawTotal = new Map();
  allOrderTrips.forEach((t) => {
    const oid = String(t.order);
    const raw = Math.max(Number(t.totalDistance || t.miles || t.total_km || 0), 0);
    orderRawTotal.set(oid, Number(orderRawTotal.get(oid) || 0) + raw);
  });

  const byOrderMap = new Map();
  let totalTrips = 0, totalMiles = 0, totalKm = 0, totalPay = 0;
  driverTrips.forEach((t) => {
    const oid = String(t.order);
    if (!inMonth.has(oid)) return; // only orders created in the window
    const list = Array.isArray(t.drivers) && t.drivers.length > 0
      ? t.drivers.map(String)
      : (t.driver ? [String(t.driver)] : []);
    const count = Math.max(list.length, 1);
    const isTeam = count > 1;
    const tripMiles = deriveTripMiles(t, orderKmMap.get(oid), orderRawTotal.get(oid));
    const myMiles = tripMiles / count;
    const myKm = myMiles / MI_PER_KM;
    // `trip.rate_per_mile` is a snapshot taken in `trip.rate_currency`. A driver whose pay currency
    // was switched later (the USD→CAD move) has old trips still stamped USD, and reading that 0.39
    // as though it were CAD underpays them ~30%. When the snapshot's currency doesn't match the
    // currency this payslip is computed in, drop the override and use the profile's current rate —
    // which is exactly the converted equivalent of what they were promised.
    // A trip with NO rate_currency is legacy: the field was added later and everything before it
    // was USD. Defaulting to the driver's CURRENT currency instead would silently re-badge an old
    // USD 0.39 snapshot as CAD 0.39 — the exact underpayment this guard exists to stop.
    const tripRateCurrency = String(t.rate_currency || 'USD').toUpperCase();
    const overrideUsable = tripRateCurrency === rateCurrency;
    const rate = pickDriverRate(driverProfile, isTeam, overrideUsable ? t.rate_per_mile : 0);
    const myPay = myMiles * rate;

    totalTrips += 1; totalMiles += myMiles; totalKm += myKm; totalPay += myPay;

    const cur = byOrderMap.get(oid) || {
      order: t.order, serial_no: orderSerialMap.get(oid),
      trips: 0, miles: 0, km: 0, pay: 0, rateUsed: 0, rateType: 'solo',
      _firstTripNo: null, _lastTripNo: null,
      pickupLocation: '', deliveryLocation: '', pickupDate: null, deliveryDate: null,
    };
    cur.trips += 1; cur.miles += myMiles; cur.km += myKm; cur.pay += myPay;

    // Route = where THIS driver's legs begin and end on the order. Two legs of the same order for
    // the same driver collapse into one run, so take the earliest leg's start and the latest one's
    // end rather than repeating the order's own pickup/delivery.
    const tripNo = Number(t.trip_no || 0);
    if (cur._firstTripNo === null || tripNo <= cur._firstTripNo) {
      const from = stopAt(oid, t.start_stop_index, t.start_location);
      cur._firstTripNo = tripNo;
      cur.pickupLocation = from.label;
      cur.pickupDate = from.date;
    }
    if (cur._lastTripNo === null || tripNo >= cur._lastTripNo) {
      const to = stopAt(oid, t.end_stop_index, t.end_location);
      cur._lastTripNo = tripNo;
      cur.deliveryLocation = to.label;
      cur.deliveryDate = to.date;
    }
    cur.rateUsed = Math.max(cur.rateUsed, rate);
    cur.rateType = isTeam ? 'team' : (cur.rateType === 'team' ? 'team' : 'solo');
    byOrderMap.set(oid, cur);
  });

  return {
    rateCurrency,
    soloRate, teamRate, cityRate,
    totalTrips, totalMiles, totalKm, totalPay,
    byOrder: Array.from(byOrderMap.values()).sort((a, b) => b.trips - a.trips),
  };
}
exports.computeDriverTripPay = computeDriverTripPay;

// Sum DriverDeduction rows (per-date) in range. city_hours -> cityPay/hours; deduct -> deductions.
// Rows carry their own snapshotted `currency`, so totals stay bucketed per source currency and the
// caller converts each bucket — summing them raw would add CAD to USD.
async function computeDriverDeductions(tenantId, driverId, range) {
  const rows = await DriverDeduction.find({
    tenantId,
    driver: driverId,
    deletedAt: null,
    date: { $gte: range.from, $lte: range.to },
  }).lean();
  let cityHours = 0;
  const byCurrency = new Map(); // currency -> { cityPay, deductionTotal, additionTotal }
  rows.forEach((d) => {
    const amt = Number(d.amount || 0);
    const cur = normalizeCurrency(d.currency, 'USD');
    const bucket = byCurrency.get(cur) || { cityPay: 0, deductionTotal: 0, additionTotal: 0 };
    if (d.type === 'city_hours') {
      cityHours += Number(d.hours || 0);
      bucket.cityPay += amt;
    } else if (d.direction === 'add') {
      bucket.additionTotal += amt;
    } else {
      bucket.deductionTotal += amt;
    }
    byCurrency.set(cur, bucket);
  });
  return { cityHours, byCurrency };
}

// Build the full (currency-converted) salary payload for a driver/month.
async function buildDriverSalaryPayload(req, tenantId, driverId, range, targetCurrency, opts = {}) {
  const tp = await computeDriverTripPay(tenantId, driverId, range);
  const dd = await computeDriverDeductions(tenantId, driverId, range);

  // Everything that needs converting INTO targetCurrency: the driver's own pay currency, the
  // currencies its deduction rows were entered in, plus the currencies of the records we carry
  // forward (previous month's due, this month's saved manual/paid figures).
  const existing = await DriverSalary.findOne({ tenantId, driver: driverId, month: range.month, year: range.year }).lean();
  const prevRange = buildDateRange(range.month === 1 ? 12 : range.month - 1, range.month === 1 ? range.year - 1 : range.year);
  const prev = prevRange
    ? await DriverSalary.findOne({ tenantId, driver: driverId, month: prevRange.month, year: prevRange.year }).select('currency dueAmount owedAmount').lean()
    : null;

  const fxSources = [
    tp.rateCurrency,
    ...dd.byCurrency.keys(),
    ...(existing ? [normalizeCurrency(existing.currency, targetCurrency)] : []),
    ...(prev ? [normalizeCurrency(prev.currency, targetCurrency)] : []),
  ];
  // Auto-seed any missing month FX so conversion never silently falls back to 1:1.
  const fxRatesMap = await ensureMonthlyFxRates(tenantId, range.month, range.year, targetCurrency, fxSources, req.user?._id);

  // If a rate still can't be resolved, refuse rather than emit a payslip that quietly treats
  // (say) 1 CAD as 1 USD. Missing FX is a data problem, not a rounding problem.
  const missing = missingFxSources(fxSources, targetCurrency, fxRatesMap);
  if (missing.length > 0) {
    const err = new Error(
      `No ${range.month}/${range.year} conversion rate for ${missing.join(', ')} → ${targetCurrency}. Add the monthly rate before generating this payslip.`
    );
    err.code = 'fx_missing';
    throw err;
  }

  const fromRate = (amount) => Number(convertAmount(amount, tp.rateCurrency, targetCurrency, fxRatesMap).value || 0);
  // Sum each deduction bucket in its own currency, then convert.
  let cityPay = 0, deductionTotal = 0, perDateAddition = 0;
  dd.byCurrency.forEach((bucket, cur) => {
    cityPay += Number(convertAmount(bucket.cityPay, cur, targetCurrency, fxRatesMap).value || 0);
    deductionTotal += Number(convertAmount(bucket.deductionTotal, cur, targetCurrency, fxRatesMap).value || 0);
    perDateAddition += Number(convertAmount(bucket.additionTotal, cur, targetCurrency, fxRatesMap).value || 0);
  });

  const tripPay = fromRate(tp.totalPay);

  const orderBreakdown = tp.byOrder.map((b) => {
    const conv = convertAmount(b.pay, tp.rateCurrency, targetCurrency, fxRatesMap);
    return {
      order: b.order, serial_no: b.serial_no, trips: b.trips,
      miles: b.miles, km: b.km, rateType: b.rateType,
      rateUsed: b.rateUsed, pay: Number(conv.value || 0), originalPay: b.pay,
      fxRate: Number(conv.rate || 1),
      pickupLocation: b.pickupLocation || '',
      deliveryLocation: b.deliveryLocation || '',
      pickupDate: b.pickupDate || null,
      deliveryDate: b.deliveryDate || null,
    };
  });

  // Existing saved record (preserve manual fields + paid on re-generate, like owner).
  const existingCur = normalizeCurrency(existing?.currency, targetCurrency);
  // Paid-to-date is stored in the payslip's own currency. Regenerating in another currency
  // must convert it, or a USD 1,000 payment silently becomes CAD 1,000.
  const existPaid = convertAmount(Number(existing?.paidAmount || 0), existingCur, targetCurrency, fxRatesMap).value;

  // Previous month's carry-forward — the unpaid balance, and the negative balance.
  const prevCur = normalizeCurrency(prev?.currency, targetCurrency);
  const autoPrevDue = convertAmount(Number(prev?.dueAmount || 0), prevCur, targetCurrency, fxRatesMap).value;
  const autoPrevOwed = convertAmount(Number(prev?.owedAmount || 0), prevCur, targetCurrency, fxRatesMap).value;

  const includePreviousDue = opts.includePreviousDue !== false;
  const previousDueAdded = opts.previousDueAdded !== undefined
    ? Math.max(round2(opts.previousDueAdded), 0)
    : (includePreviousDue ? round2(autoPrevDue) : 0);
  const previousOwedDeducted = includePreviousDue ? round2(autoPrevOwed) : 0;

  // Additions and deductions come ONLY from the itemized DriverDeduction rows. The old
  // `manualAddition`/`manualDeduction` scalars were a second channel with no line item
  // behind them — a payslip could show a deduction nothing explained. They are frozen at 0.
  const additionTotal = perDateAddition;
  const manualAddition = 0;
  const manualDeduction = 0;

  const basePayable = round2(tripPay + cityPay - deductionTotal);
  const totals = computePayslipTotals({
    basePayable,
    previousDueAdded,
    previousOwedDeducted,
    additions: additionTotal,
    deductions: 0,
    paidAmount: opts.paidAmount !== undefined ? Number(opts.paidAmount || 0) : Number(existPaid || 0),
  });
  const { finalPayable, paidAmount, dueAmount, owedAmount, overpaidAmount, paymentStatus } = totals;

  return {
    tenantId,
    company: req.user?.company?._id || req.user?.company || null,
    driver: driverId,
    month: range.month,
    year: range.year,
    currency: targetCurrency,
    rateCurrency: tp.rateCurrency,
    soloRate: tp.soloRate, teamRate: tp.teamRate, cityRate: tp.cityRate,
    totalTrips: tp.totalTrips, totalMiles: tp.totalMiles, totalKm: tp.totalKm,
    tripPay, cityHours: dd.cityHours, cityPay, deductionTotal, additionTotal,
    basePayable, previousDueAdded, previousOwedDeducted, manualDeduction, manualAddition,
    finalPayable, paidAmount, dueAmount, owedAmount, overpaidAmount, paymentStatus,
    orderBreakdown,
    generatedAt: new Date(),
    generatedBy: req.user?._id,
  };
}

// POST /driver/:driverId/salary/generate  { month, year, currency, includePreviousDue, manualDeduction, manualAddition, paidAmount }
exports.generateDriverSalary = catchAsync(async (req, res, next) => {
  try {
    if (!hasDriverSalaryAccess(req)) {
      return res.status(403).json({ status: false, message: 'You are not allowed to manage driver salary' });
    }
    const tenantId = getTenantId(req);
    const { driverId } = req.params;
    const range = buildDateRange(req.body?.month, req.body?.year);
    if (!range) return res.status(400).json({ status: false, message: 'Valid month and year are required' });
    const driver = await Users.findOne({ _id: driverId, tenantId }).lean();
    if (!driver) return res.status(404).json({ status: false, message: 'Driver not found' });

    const targetCurrency = await resolveSalaryCurrency(req, tenantId, driverId, req.body?.currency);
    // Insurance, escrow and a lease payment repeat every month. Materialize last month's
    // recurring rows BEFORE the payslip is built, so it is complete on generate instead of
    // waiting for someone to remember.
    const copied = await syncRecurringDeductions(tenantId, driverId, range.month, range.year, req.user?._id);
    const payload = await buildDriverSalaryPayload(req, tenantId, driverId, range, targetCurrency, {
      includePreviousDue: req.body?.includePreviousDue,
      previousDueAdded: req.body?.previousDueAdded,
      paidAmount: req.body?.paidAmount,
    });

    const salary = await DriverSalary.findOneAndUpdate(
      { tenantId, driver: driverId, month: range.month, year: range.year },
      payload,
      { upsert: true, new: true }
    );
    if (copied) {
      logActivity(req, {
        action: 'CREATE', module: 'payroll',
        description: `Carried ${copied} recurring deduction line(s) into ${range.month}/${range.year}`,
        details: { driverId, copied },
      });
    }

    logActivity(req, {
      action: 'PAYMENT', module: 'payment',
      description: `Generated driver salary for ${range.month}/${range.year}`,
      details: { driverId, finalPayable: payload.finalPayable },
    });

    return res.json({ status: true, message: 'Driver salary generated', salary });
  } catch (err) {
    if (isFxMissing(err)) return res.status(400).json({ status: false, code: 'fx_missing', message: err.message });
    JSONerror(res, err, next);
    logger(err);
  }
});

// GET /driver/:driverId/salary?month&year&currency  -> saved record if present, else live preview
exports.getDriverSalary = catchAsync(async (req, res, next) => {
  try {
    if (!hasDriverSalaryAccess(req)) {
      return res.status(403).json({ status: false, message: 'You are not allowed to view driver salary' });
    }
    const tenantId = getTenantId(req);
    const { driverId } = req.params;
    const range = buildDateRange(req.query?.month, req.query?.year);
    if (!range) return res.status(400).json({ status: false, message: 'Valid month and year are required' });
    const targetCurrency = await resolveSalaryCurrency(req, tenantId, driverId, req.query?.currency);

    const saved = await DriverSalary.findOne({ tenantId, driver: driverId, month: range.month, year: range.year }).lean();
    if (saved && normalizeCurrency(saved.currency, targetCurrency) === targetCurrency) {
      return res.json({ status: true, saved: true, salary: saved });
    }
    // Live preview (not yet generated, or different currency requested)
    const preview = await buildDriverSalaryPayload(req, tenantId, driverId, range, targetCurrency, {});
    return res.json({ status: true, saved: false, salary: preview });
  } catch (err) {
    if (isFxMissing(err)) return res.status(400).json({ status: false, code: 'fx_missing', message: err.message });
    JSONerror(res, err, next);
    logger(err);
  }
});

// GET /driver/:driverId/salary/history
exports.getDriverSalaryHistory = catchAsync(async (req, res, next) => {
  try {
    if (!hasDriverSalaryAccess(req)) {
      return res.status(403).json({ status: false, message: 'You are not allowed to view driver salary' });
    }
    const tenantId = getTenantId(req);
    const { driverId } = req.params;
    const lists = await DriverSalary.find({ tenantId, driver: driverId })
      .sort({ year: -1, month: -1 })
      .lean();
    return res.json({ status: true, lists });
  } catch (err) {
    JSONerror(res, err, next);
    logger(err);
  }
});

// GET /driver/salaries/list?month&year — all generated payslips of the tenant for one period
exports.listDriverSalaries = catchAsync(async (req, res, next) => {
  try {
    if (!hasDriverSalaryAccess(req)) {
      return res.status(403).json({ status: false, message: 'You are not allowed to view driver salary' });
    }
    const tenantId = getTenantId(req);
    if (!tenantId) {
      return res.status(400).json({ status: false, message: 'Tenant context is required' });
    }
    const month = parseInt(req.query.month, 10);
    const year = parseInt(req.query.year, 10);
    if (!month || !year || month < 1 || month > 12) {
      return res.status(400).json({ status: false, message: 'Valid month and year are required' });
    }
    const lists = await DriverSalary.find({ tenantId, month, year })
      .populate('driver', 'name corporateID email')
      .sort({ createdAt: -1 })
      .lean();
    return res.json({ status: true, lists });
  } catch (err) {
    JSONerror(res, err, next);
    logger(err);
  }
});

// PUT /driver/:driverId/salary/:salaryId  { paidAmount, manualDeduction, manualAddition, notes }
exports.updateDriverSalary = catchAsync(async (req, res, next) => {
  try {
    if (!hasDriverSalaryAccess(req)) {
      return res.status(403).json({ status: false, message: 'You are not allowed to manage driver salary' });
    }
    const tenantId = getTenantId(req);
    const { driverId, salaryId } = req.params;
    const salary = await DriverSalary.findOne({ _id: salaryId, tenantId, driver: driverId });
    if (!salary) return res.status(404).json({ status: false, message: 'Salary record not found' });

    // A payslip is a settled figure. Manual adjustments and paid amounts are typed by hand with
    // no other record, so the before-image is the only way to tell an entry from an edit.
    const beforeSalary = salary.toObject();

    // Additions and deductions are itemized DriverDeduction rows. Accepting a bare total
    // here is what let a payslip show a deduction with no line item behind it.
    if (req.body?.manualDeduction !== undefined || req.body?.manualAddition !== undefined) {
      return res.status(400).json({
        status: false,
        code: 'use_deduction_ledger',
        message: 'Additions and deductions are itemized. Add them as deduction lines instead of setting a total.',
      });
    }
    if (req.body?.previousDueAdded !== undefined) {
      const prevDue = Number(req.body.previousDueAdded);
      if (!Number.isFinite(prevDue) || prevDue < 0) {
        return res.status(400).json({ status: false, message: 'previousDueAdded cannot be negative' });
      }
      salary.previousDueAdded = round2(prevDue);
    }
    if (req.body?.notes !== undefined) salary.notes = String(req.body.notes || '');

    // Paid is set through the payment endpoints so every change leaves a record. A direct
    // paidAmount write is still honoured for the legacy client, but it can no longer be
    // silently clamped: over-paying is refused unless the caller says it is intentional.
    let nextPaid = round2(salary.paidAmount);
    if (req.body?.paidAmount !== undefined) {
      const typed = Number(req.body.paidAmount);
      if (!Number.isFinite(typed) || typed < 0) {
        return res.status(400).json({ status: false, message: 'Paid amount cannot be negative' });
      }
      nextPaid = round2(typed);
    }

    const totals = computePayslipTotals({
      basePayable: salary.basePayable,
      previousDueAdded: salary.previousDueAdded,
      previousOwedDeducted: salary.previousOwedDeducted,
      additions: salary.additionTotal,
      deductions: 0,
      paidAmount: nextPaid,
    });

    if (totals.overpaidAmount > EPSILON && !req.body?.allowOverpay) {
      return res.status(409).json({
        status: false,
        code: 'overpayment',
        message: `That is more than the ${salary.currency} ${Math.max(totals.finalPayable - round2(salary.paidAmount), 0).toFixed(2)} still owed on this payslip.`,
        dueAmount: round2(Math.max(totals.finalPayable - round2(salary.paidAmount), 0)),
        excess: totals.overpaidAmount,
        currency: salary.currency,
      });
    }

    salary.finalPayable = totals.finalPayable;
    salary.paidAmount = totals.paidAmount;
    salary.dueAmount = totals.dueAmount;
    salary.owedAmount = totals.owedAmount;
    salary.overpaidAmount = totals.overpaidAmount;
    salary.paymentStatus = totals.paymentStatus;
    await salary.save();

    logChange(req, {
      model: 'DriverSalary',
      module: 'payroll',
      before: beforeSalary,
      after: salary.toObject(),
      resourceId: salary._id,
      resourceName: `Driver payslip ${salary.month}/${salary.year}`,
      description: `Updated driver payslip ${salary.month}/${salary.year}`,
      details: { driver: String(driverId), notes: req.body?.notes || '' },
    });

    return res.json({ status: true, message: 'Salary updated', salary });
  } catch (err) {
    JSONerror(res, err, next);
    logger(err);
  }
});

// GET /driver/:driverId/salary/pdf?month&year&currency
exports.getDriverSalaryPdf = catchAsync(async (req, res, next) => {
  let browser;
  try {
    if (!hasDriverSalaryAccess(req)) {
      return res.status(403).json({ status: false, message: 'You are not allowed to export driver salary' });
    }
    const tenantId = getTenantId(req);
    const { driverId } = req.params;
    const range = buildDateRange(req.query?.month, req.query?.year);
    if (!range) return res.status(400).json({ status: false, message: 'Valid month and year are required' });
    const targetCurrency = await resolveSalaryCurrency(req, tenantId, driverId, req.query?.currency);

    const driver = await Users.findOne({ _id: driverId, tenantId }).lean();
    if (!driver) return res.status(404).json({ status: false, message: 'Driver not found' });

    const saved = await DriverSalary.findOne({ tenantId, driver: driverId, month: range.month, year: range.year }).lean();
    const salary = (saved && normalizeCurrency(saved.currency, targetCurrency) === targetCurrency)
      ? saved
      : await buildDriverSalaryPayload(req, tenantId, driverId, range, targetCurrency, {});

    // Company / default logo
    let companyLogoUrl = req.tenant?.settings?.customizations?.theme?.logo || '';
    const companyId = req.user?.company?._id || req.user?.company || null;
    let company = null;
    if (companyId) {
      const Company = require('../db/Company');
      company = await Company.findOne({ _id: companyId, tenantId }).lean();
      if (company && (company.pdf_logo || company.logo)) companyLogoUrl = company.pdf_logo || company.logo;
    }
    if (!companyLogoUrl) {
      try {
        const logoBuf = fs.readFileSync(path.join(__dirname, '..', 'assets', 'logo.png'));
        companyLogoUrl = `data:image/png;base64,${logoBuf.toString('base64')}`;
      } catch (e) {
        const domainUrl = process.env.DOMAIN_URL || 'http://localhost:3000';
        companyLogoUrl = `${domainUrl}/logo.png`;
      }
    }

    const monthName = new Date(range.year, range.month - 1, 1).toLocaleString('en-US', { month: 'long' });
    const cur = targetCurrency;
    const fmt = (n) => `${cur} ${Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    // rateUsed is the driver's contracted per-mile rate, stated in the currency it was agreed in —
    // showing it in `cur` would print a converted number the driver never signed off on.
    const rateCur = normalizeCurrency(salary.rateCurrency, 'USD');
    const fmtRate = (n) => `${rateCur} ${Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;
    // Same date format as the owner-operator statement — the two documents are read side by side.
    const fmtDate = (d) => {
      if (!d) return '';
      const dt = d instanceof Date ? d : new Date(d);
      if (Number.isNaN(dt.getTime())) return '';
      return dt.toLocaleDateString('en-CA');
    };
    // A stop is stored as one long "street, city, province, postal, country" string. The street and
    // the city are what a driver checks a payslip against; the rest is noise at this width.
    const shortStop = (text) => {
      // Autocomplete often writes the street twice ("1485 Chevrier Blvd, 1485 Chevrier Blvd,
      // Winnipeg, MB…"). Drop repeats before trimming, or the whole cell is one address said twice.
      const seen = new Set();
      const parts = String(text || '').split(',')
        .map((x) => x.trim())
        .filter(Boolean)
        .filter((x) => {
          const key = x.toLowerCase();
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      if (parts.length === 0) return '';
      return parts.slice(0, 2).join(', ');
    };
    const stopCell = (label, date) => {
      const place = shortStop(label);
      if (!place && !date) return '<span class="empty">&mdash;</span>';
      return `<span class="stop">${safe(place || '—')}</span>${date ? `<span class="when">${safe(fmtDate(date))}</span>` : ''}`;
    };

    const rows = (salary.orderBreakdown || []).map((b) => `
      <tr>
        <td class="ord">#${safe(b.serial_no ?? '—')}</td>
        <td style="text-transform:uppercase;">${safe(b.rateType)}</td>
        <td class="route">${stopCell(b.pickupLocation, b.pickupDate)}</td>
        <td class="route">${stopCell(b.deliveryLocation, b.deliveryDate)}</td>
        <td style="text-align:right;">${Number(b.miles || 0).toFixed(2)} mi<span class="when">${Number(b.km || 0).toFixed(2)} km</span></td>
        <td style="text-align:right;">${fmtRate(b.rateUsed)}/mi</td>
        <td style="text-align:right;font-weight:700;">${fmt(b.pay)}</td>
      </tr>`).join('');

    const html = `<!doctype html><html><head><meta charset="utf-8" />
      <style>
        @page { margin: 0; }
        * { box-sizing: border-box; }
        body { font-family: Arial, Helvetica, sans-serif; color: #0f172a; margin: 0; }
        .wrap { padding: 28px 36px; }
        .banner { background: linear-gradient(135deg,#1e3a5f 0%,#1e40af 100%); padding: 26px 36px; color: #fff; display:flex; justify-content:space-between; align-items:flex-start; }
        .banner img { max-height: 50px; max-width: 190px; object-fit: contain; filter: brightness(0) invert(1); margin-bottom: 10px; display:block; }
        .company-name { font-size: 22px; font-weight: 900; letter-spacing: 1.2px; }
        .muted { color:#93c5fd; font-size: 11px; line-height: 1.6; }
        .doctitle { text-align:right; }
        .doctitle .k { font-size:11px; letter-spacing:3px; text-transform:uppercase; color:#93c5fd; font-weight:700; }
        .doctitle .v { font-size:20px; font-weight:900; }
        .cards { display:flex; gap:12px; padding: 20px 36px 4px; flex-wrap:wrap; }
        .card { flex:1; min-width:130px; border:1px solid #e2e8f0; border-radius:10px; padding:12px 14px; }
        .card .l { font-size:10px; text-transform:uppercase; letter-spacing:1px; color:#64748b; }
        .card .n { font-size:17px; font-weight:800; margin-top:4px; }
        table { width: calc(100% - 72px); margin: 14px 36px; border-collapse: collapse; font-size: 12px; }
        th, td { padding: 8px 10px; border-bottom: 1px solid #e2e8f0; text-align:left; }
        th { background:#f1f5f9; font-size:10px; text-transform:uppercase; letter-spacing:.5px; color:#475569; }
        /* Trip table: route cells carry two lines — the place, then the date under it, the same
           way the owner-operator statement prints a stop. Sized down so seven columns still fit A4
           portrait without wrapping the money. */
        table.trips { font-size: 11px; table-layout: fixed; }
        table.trips th, table.trips td { padding: 7px 8px; vertical-align: top; }
        table.trips .ord { font-family: 'Courier New', monospace; font-weight: 700; color: #1e40af; }
        table.trips col.c-ord { width: 8%; }
        table.trips col.c-type { width: 8%; }
        table.trips col.c-route { width: 23%; }
        table.trips col.c-dist { width: 13%; }
        table.trips col.c-rate { width: 12%; }
        table.trips col.c-pay { width: 13%; }
        table.trips .stop { display:block; line-height:1.35; word-break: break-word; }
        table.trips .when { display:block; font-size:9px; color:#64748b; margin-top:2px; letter-spacing:.3px; }
        table.trips .empty { color:#94a3b8; }
        .totals { margin: 8px 36px 24px; width: calc(100% - 72px); }
        .totals td { padding: 6px 10px; font-size: 13px; }
        .totals .grand { font-size: 18px; font-weight: 900; color:#1e40af; }
      </style></head>
      <body>
        <div class="banner">
          <div>
            ${companyLogoUrl ? `<img src="${safe(companyLogoUrl)}" alt="logo" />` : `<div class="company-name">${safe((company?.name || 'COMPANY').toUpperCase())}</div>`}
            <div class="muted">
              ${company?.address ? `<div>${safe(company.address)}</div>` : ''}
              ${company?.phone ? `<div>Tel: ${safe(company.phone)}</div>` : ''}
              ${company?.email ? `<div>${safe(company.email)}</div>` : ''}
            </div>
          </div>
          <div class="doctitle">
            <div class="k">Driver</div>
            <div class="v">PAY <span style="color:#f59e0b;">STATEMENT</span></div>
            <div class="muted">${safe(monthName)} ${range.year}</div>
          </div>
        </div>

        <div class="cards">
          <div class="card"><div class="l">Driver</div><div class="n">${safe(driver.name || '')}</div></div>
          <div class="card"><div class="l">ID</div><div class="n">${safe(driver.corporateID || '—')}</div></div>
          <div class="card"><div class="l">Trips</div><div class="n">${Number(salary.totalTrips || 0)}</div></div>
          <div class="card"><div class="l">Miles</div><div class="n">${Number(salary.totalMiles || 0).toFixed(2)} mi</div></div>
        </div>

        <table class="trips">
          <colgroup>
            <col class="c-ord" /><col class="c-type" /><col class="c-route" /><col class="c-route" />
            <col class="c-dist" /><col class="c-rate" /><col class="c-pay" />
          </colgroup>
          <thead><tr>
            <th>Order</th><th>Type</th><th>Pickup</th><th>Delivery</th>
            <th style="text-align:right;">Distance</th><th style="text-align:right;">Rate</th><th style="text-align:right;">Pay</th>
          </tr></thead>
          <tbody>${rows || `<tr><td colspan="7" style="text-align:center;color:#94a3b8;">No trips this period</td></tr>`}</tbody>
        </table>

        <table class="totals">
          <tr><td>Trip Pay</td><td style="text-align:right;">${fmt(salary.tripPay)}</td></tr>
          <tr><td>City Hours Pay (${Number(salary.cityHours || 0)} hr)</td><td style="text-align:right;">${fmt(salary.cityPay)}</td></tr>
          <tr><td>Deductions</td><td style="text-align:right;color:#dc2626;">- ${fmt(salary.deductionTotal)}</td></tr>
          ${Number(salary.previousDueAdded) ? `<tr><td>Previous Due</td><td style="text-align:right;">${fmt(salary.previousDueAdded)}</td></tr>` : ''}
          ${(Number(salary.additionTotal) + Number(salary.manualAddition)) ? `<tr><td>Additions</td><td style="text-align:right;">${fmt(Number(salary.additionTotal || 0) + Number(salary.manualAddition || 0))}</td></tr>` : ''}
          ${Number(salary.manualDeduction) ? `<tr><td>Manual Deduction</td><td style="text-align:right;color:#dc2626;">- ${fmt(salary.manualDeduction)}</td></tr>` : ''}
          <tr><td class="grand">NET PAYABLE</td><td class="grand" style="text-align:right;">${fmt(salary.finalPayable)}</td></tr>
          ${Number(salary.paidAmount) ? `<tr><td>Paid</td><td style="text-align:right;">${fmt(salary.paidAmount)}</td></tr><tr><td>Due</td><td style="text-align:right;font-weight:700;">${fmt(salary.dueAmount)}</td></tr>` : ''}
        </table>
      </body></html>`;

    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'load', timeout: 20000 }).catch(() => {});
    const pdfBuffer = await page.pdf({ format: 'A4', printBackground: true, margin: { top: 0, bottom: 0, left: 0, right: 0 } });
    await browser.close();
    browser = null;

    logActivity(req, {
      action: 'DOWNLOAD',
      module: 'payroll',
      description: `Downloaded driver payslip for "${driver.name}" (${range.month}/${range.year})`,
      resourceId: driver._id,
      resourceName: driver.name,
      details: { month: range.month, year: range.year },
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="Driver_Statement_${safe(driver.name || 'driver')}_${range.month}_${range.year}.pdf"`);
    return res.end(pdfBuffer);
  } catch (err) {
    if (browser) { try { await browser.close(); } catch (e) { /* noop */ } }
    if (isFxMissing(err)) return res.status(400).json({ status: false, code: 'fx_missing', message: err.message });
    JSONerror(res, err, next);
    logger(err);
  }
});

// ---------------------------------------------------------------------------
// Recurring deduction lines
// ---------------------------------------------------------------------------

// Copy the previous month's `recurring` rows into this month. Idempotent: a template is
// never cloned twice into one month. Auto-generated reimbursement rows are never templates
// — they belong to a specific truck expense.
async function syncRecurringDeductions(tenantId, driverId, month, year, userId) {
  const prev = previousMonthOf(month, year);
  const prevRange = buildDateRange(prev.month, prev.year);
  const range = buildDateRange(month, year);
  if (!prevRange || !range) return 0;

  const templates = await DriverDeduction.find({
    tenantId,
    driver: driverId,
    recurring: true,
    autoSource: null,
    deletedAt: null,
    date: { $gte: prevRange.from, $lte: prevRange.to },
  }).lean();
  if (!templates.length) return 0;

  const rootIds = templates.map((t) => t.recurringSourceId || t._id);
  const existing = await DriverDeduction.find({
    tenantId,
    driver: driverId,
    recurringSourceId: { $in: rootIds },
    date: { $gte: range.from, $lte: range.to },
  }).select('recurringSourceId').lean();
  const already = new Set(existing.map((r) => String(r.recurringSourceId)));

  // Same day-of-month as the template, clamped into the target month (a 31st template must
  // not roll into the next month and land on the wrong payslip).
  const lastDay = new Date(year, month, 0).getDate();
  const toCreate = templates
    .filter((t) => !already.has(String(t.recurringSourceId || t._id)))
    .map((t) => {
      const day = Math.min(new Date(t.date).getDate() || 1, lastDay);
      return {
        tenantId,
        company: t.company || null,
        driver: driverId,
        type: t.type,
        direction: t.direction,
        amount: t.amount,
        currency: t.currency,
        hours: t.hours,
        rate: t.rate,
        description: t.description,
        reference: t.reference,
        date: new Date(year, month - 1, day),
        recurring: true,
        recurringSourceId: t.recurringSourceId || t._id,
        createdBy: userId || t.createdBy || null,
      };
    });
  if (!toCreate.length) return 0;
  await DriverDeduction.insertMany(toCreate);
  return toCreate.length;
}
exports.syncRecurringDeductions = syncRecurringDeductions;

// ---------------------------------------------------------------------------
// Payments
//
// The payslip used to hold one `paidAmount` number with no date, no reference and no way
// to undo a typo. Every payment is now a DriverPayment row; `paidAmount` is their sum.
// ---------------------------------------------------------------------------

async function applyDriverPaidTotal(salary, nextPaid) {
  const totals = computePayslipTotals({
    basePayable: salary.basePayable,
    previousDueAdded: salary.previousDueAdded,
    previousOwedDeducted: salary.previousOwedDeducted,
    additions: salary.additionTotal,
    deductions: 0,
    paidAmount: Math.max(round2(nextPaid), 0),
  });
  salary.finalPayable = totals.finalPayable;
  salary.paidAmount = totals.paidAmount;
  salary.dueAmount = totals.dueAmount;
  salary.owedAmount = totals.owedAmount;
  salary.overpaidAmount = totals.overpaidAmount;
  salary.paymentStatus = totals.paymentStatus;
  await salary.save();
  return totals;
}

// GET /driver/:driverId/salary/:salaryId/payments
exports.listDriverPayments = catchAsync(async (req, res, next) => {
  try {
    if (!hasDriverSalaryAccess(req)) {
      return res.status(403).json({ status: false, message: 'You are not allowed to view driver payments' });
    }
    const tenantId = getTenantId(req);
    if (!tenantId) return res.status(400).json({ status: false, message: 'Tenant could not be resolved' });
    const payments = await DriverPayment.find({ tenantId, salary: req.params.salaryId, driver: req.params.driverId })
      .sort({ date: -1, createdAt: -1 })
      .lean();
    return res.json({ status: true, payments });
  } catch (err) {
    JSONerror(res, err, next);
    logger(err);
  }
});

// POST /driver/:driverId/salary/:salaryId/payment  { amount, currency, notes, date, method, allowOverpay }
exports.addDriverPayment = catchAsync(async (req, res, next) => {
  try {
    if (!hasDriverSalaryAccess(req)) {
      return res.status(403).json({ status: false, message: 'You are not allowed to record driver payments' });
    }
    const tenantId = getTenantId(req);
    if (!tenantId) return res.status(400).json({ status: false, message: 'Tenant could not be resolved' });
    const { driverId, salaryId } = req.params;
    const salary = await DriverSalary.findOne({ _id: salaryId, tenantId, driver: driverId });
    if (!salary) return res.status(404).json({ status: false, message: 'Payslip not found' });

    const typed = Number(req.body?.amount);
    if (!Number.isFinite(typed) || typed <= 0) {
      return res.status(400).json({ status: false, message: 'Payment amount must be greater than 0' });
    }
    let date = null;
    if (req.body?.date) {
      date = new Date(req.body.date);
      if (Number.isNaN(date.getTime())) return res.status(400).json({ status: false, message: 'Invalid date' });
    }

    const salaryCurrency = normalizeCurrency(salary.currency, 'USD');
    const inputCurrency = normalizeCurrency(req.body?.currency, salaryCurrency);
    const fxMap = await ensureMonthlyFxRates(tenantId, salary.month, salary.year, salaryCurrency, [inputCurrency], req.user?._id);
    const conv = convertAmount(typed, inputCurrency, salaryCurrency, fxMap);
    const converted = round2(conv.value);
    if (!(converted > 0)) return res.status(400).json({ status: false, message: 'Converted payment amount is invalid' });

    const alreadyPaid = round2(salary.paidAmount);
    const nextPaid = round2(alreadyPaid + converted);
    const payableFloor = Math.max(round2(salary.finalPayable), 0);
    // Never clamp silently: the excess is either intentional or a typo, and only the person
    // typing it knows which.
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

    const before = salary.toObject();
    const totals = await applyDriverPaidTotal(salary, nextPaid);
    const payment = await DriverPayment.create({
      tenantId,
      company: req.user?.company?._id || req.user?.company || null,
      driver: driverId,
      salary: salary._id,
      month: salary.month,
      year: salary.year,
      amount: converted,
      currency: salaryCurrency,
      inputAmount: round2(typed),
      inputCurrency,
      fxRate: Number(conv.rate || 1),
      date,
      notes: String(req.body?.notes || '').trim(),
      method: String(req.body?.method || '').trim(),
      createdBy: req.user?._id,
    });

    logChange(req, {
      model: 'DriverSalary',
      module: 'payroll',
      action: 'PAYMENT',
      before,
      after: salary.toObject(),
      logUnchanged: true,
      description: `Recorded driver payment on payslip ${salary.month}/${salary.year}`,
      resourceId: salary._id,
      resourceName: `Driver payslip ${salary.month}/${salary.year}`,
      details: {
        paymentId: payment._id, amount: converted, currency: salaryCurrency,
        inputAmount: round2(typed), inputCurrency, notes: payment.notes,
      },
    });

    return res.json({ status: true, message: 'Payment recorded', salary, payment, totals });
  } catch (err) {
    JSONerror(res, err, next);
    logger(err);
  }
});

// POST /driver/:driverId/salary/payment/update/:paymentId
exports.updateDriverPayment = catchAsync(async (req, res, next) => {
  try {
    if (!hasDriverSalaryAccess(req)) {
      return res.status(403).json({ status: false, message: 'You are not allowed to update driver payments' });
    }
    const tenantId = getTenantId(req);
    if (!tenantId) return res.status(400).json({ status: false, message: 'Tenant could not be resolved' });
    const payment = await DriverPayment.findOne({ _id: req.params.paymentId, tenantId });
    if (!payment) return res.status(404).json({ status: false, message: 'Payment not found' });
    const salary = await DriverSalary.findOne({ _id: payment.salary, tenantId });
    if (!salary) return res.status(404).json({ status: false, message: 'Payslip not found for this payment' });

    const typed = Number(req.body?.amount);
    if (!Number.isFinite(typed) || typed <= 0) {
      return res.status(400).json({ status: false, message: 'Payment amount must be greater than 0' });
    }

    const salaryCurrency = normalizeCurrency(salary.currency, 'USD');
    const inputCurrency = normalizeCurrency(req.body?.currency || payment.inputCurrency, salaryCurrency);
    const fxMap = await ensureMonthlyFxRates(tenantId, salary.month, salary.year, salaryCurrency, [inputCurrency], req.user?._id);
    const conv = convertAmount(typed, inputCurrency, salaryCurrency, fxMap);
    const converted = round2(conv.value);
    if (!(converted > 0)) return res.status(400).json({ status: false, message: 'Converted payment amount is invalid' });

    const before = salary.toObject();
    const delta = round2(converted - round2(payment.amount));
    const totals = await applyDriverPaidTotal(salary, round2(salary.paidAmount) + delta);

    payment.amount = converted;
    payment.currency = salaryCurrency;
    payment.inputAmount = round2(typed);
    payment.inputCurrency = inputCurrency;
    payment.fxRate = Number(conv.rate || 1);
    if (req.body?.notes !== undefined) payment.notes = String(req.body.notes || '').trim();
    if (req.body?.method !== undefined) payment.method = String(req.body.method || '').trim();
    if (req.body?.date) {
      const d = new Date(req.body.date);
      if (!Number.isNaN(d.getTime())) payment.date = d;
    }
    payment.updatedBy = req.user?._id;
    await payment.save();

    logChange(req, {
      model: 'DriverSalary',
      module: 'payroll',
      action: 'PAYMENT',
      before,
      after: salary.toObject(),
      logUnchanged: true,
      // Rewriting a recorded payment changes an already-reported figure.
      critical: true,
      description: `Corrected driver payment on payslip ${salary.month}/${salary.year}`,
      resourceId: salary._id,
      resourceName: `Driver payslip ${salary.month}/${salary.year}`,
      details: { paymentId: payment._id, delta, amount: converted, inputAmount: round2(typed), inputCurrency },
    });

    return res.json({ status: true, message: 'Payment updated', salary, payment, totals });
  } catch (err) {
    JSONerror(res, err, next);
    logger(err);
  }
});

// POST /driver/:driverId/salary/payment/remove/:paymentId
exports.removeDriverPayment = catchAsync(async (req, res, next) => {
  try {
    if (!hasDriverSalaryAccess(req)) {
      return res.status(403).json({ status: false, message: 'You are not allowed to delete driver payments' });
    }
    const tenantId = getTenantId(req);
    if (!tenantId) return res.status(400).json({ status: false, message: 'Tenant could not be resolved' });
    const payment = await DriverPayment.findOne({ _id: req.params.paymentId, tenantId });
    if (!payment) return res.status(404).json({ status: false, message: 'Payment not found' });
    const salary = await DriverSalary.findOne({ _id: payment.salary, tenantId });
    if (!salary) return res.status(404).json({ status: false, message: 'Payslip not found for this payment' });

    const before = salary.toObject();
    const amount = round2(payment.amount);
    const totals = await applyDriverPaidTotal(salary, round2(salary.paidAmount) - amount);
    await DriverPayment.deleteOne({ _id: payment._id, tenantId });

    logChange(req, {
      model: 'DriverSalary',
      module: 'payroll',
      action: 'PAYMENT',
      before,
      after: salary.toObject(),
      logUnchanged: true,
      critical: true,
      description: `Reversed driver payment on payslip ${salary.month}/${salary.year}`,
      resourceId: salary._id,
      resourceName: `Driver payslip ${salary.month}/${salary.year}`,
      details: { paymentId: payment._id, amount, currency: payment.currency, notes: payment.notes },
    });

    return res.json({ status: true, message: 'Payment reversed', salary, totals });
  } catch (err) {
    JSONerror(res, err, next);
    logger(err);
  }
});
