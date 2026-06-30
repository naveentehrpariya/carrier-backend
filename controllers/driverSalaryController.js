const mongoose = require('mongoose');
const puppeteer = require('puppeteer');
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
const { logActivity } = require('../utils/activityLogger');
const { MI_PER_KM, deriveTripMiles, pickDriverRate } = require('../utils/distance');
const { normalizeCurrency, buildDateRange, getFxRatesMap, convertAmount } = require('../utils/fx');
const { ensureMonthlyFxRates } = require('./ownerOperatorController');

function getTenantId(req) {
  return req.tenantId || req.user?.tenantId || null;
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
// (real miles from order.totalDistance KM, per-driver share, team/solo rate). USD.
async function computeDriverTripPay(tenantId, driverId, range) {
  const driverObjId = new mongoose.Types.ObjectId(driverId);
  const driverProfile = await DriverProfile.findOne({ tenantId, user: driverId }).lean();
  const soloRate = Number(driverProfile?.ratePerMileSolo ?? driverProfile?.ratePerMile ?? 0) || 0;
  const teamRate = Number(driverProfile?.ratePerMileTeam ?? driverProfile?.ratePerMile ?? 0) || 0;
  const cityRate = Number(driverProfile?.cityHoursRate ?? 0) || 0;

  // All trips this driver is on (any date).
  const driverTrips = await Trip.find({
    tenantId, deletedAt: null,
    $or: [{ drivers: driverObjId }, { driver: driverObjId }],
  })
    .select('order drivers driver totalDistance miles total_km distance_unit rate_per_mile')
    .lean();

  // Attribute pay to the ORDER's month (matches owner-operator cost attribution, so the same
  // order's driver pay lands in the same period on every screen — not trip.createdAt).
  const candidateOrderIds = [...new Set(driverTrips.map((t) => String(t.order)).filter(Boolean))];
  const orderRows = await Order.find({
    tenantId, _id: { $in: candidateOrderIds },
    createdAt: { $gte: range.from, $lte: range.to },
  })
    .select('_id serial_no totalDistance')
    .lean();
  const orderKmMap = new Map(orderRows.map((o) => [String(o._id), Number(o?.totalDistance || 0)]));
  const orderSerialMap = new Map(orderRows.map((o) => [String(o._id), o?.serial_no ?? null]));
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
  let totalTrips = 0, totalMiles = 0, totalKm = 0, totalPayUsd = 0;
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
    const rate = pickDriverRate(driverProfile, isTeam, t.rate_per_mile);
    const myPay = myMiles * rate;

    totalTrips += 1; totalMiles += myMiles; totalKm += myKm; totalPayUsd += myPay;

    const cur = byOrderMap.get(oid) || {
      order: t.order, serial_no: orderSerialMap.get(oid),
      trips: 0, miles: 0, km: 0, payUsd: 0, rateUsed: 0, rateType: 'solo',
    };
    cur.trips += 1; cur.miles += myMiles; cur.km += myKm; cur.payUsd += myPay;
    cur.rateUsed = Math.max(cur.rateUsed, rate);
    cur.rateType = isTeam ? 'team' : (cur.rateType === 'team' ? 'team' : 'solo');
    byOrderMap.set(oid, cur);
  });

  return {
    soloRate, teamRate, cityRate,
    totalTrips, totalMiles, totalKm, totalPayUsd,
    byOrder: Array.from(byOrderMap.values()).sort((a, b) => b.trips - a.trips),
  };
}
exports.computeDriverTripPay = computeDriverTripPay;

// Sum DriverDeduction rows (per-date) in range. city_hours -> cityPay/hours; deduct -> deductions. USD.
async function computeDriverDeductions(tenantId, driverId, range) {
  const rows = await DriverDeduction.find({
    tenantId,
    driver: driverId,
    deletedAt: null,
    date: { $gte: range.from, $lte: range.to },
  }).lean();
  let cityHours = 0, cityPay = 0, deductionTotal = 0, additionTotal = 0;
  rows.forEach((d) => {
    const amt = Number(d.amount || 0);
    if (d.type === 'city_hours') {
      cityHours += Number(d.hours || 0);
      cityPay += amt;
    } else if (d.direction === 'add') {
      additionTotal += amt;
    } else {
      deductionTotal += amt;
    }
  });
  return { cityHours, cityPay, deductionTotal, additionTotal };
}

// Build the full (currency-converted) salary payload for a driver/month.
async function buildDriverSalaryPayload(req, tenantId, driverId, range, targetCurrency, opts = {}) {
  // Auto-seed missing month FX (driver pay is USD) so it never silently converts 1:1.
  const fxRatesMap = await ensureMonthlyFxRates(tenantId, range.month, range.year, targetCurrency, ['USD'], req.user?._id);
  const toTarget = (usd) => Number(convertAmount(usd, 'USD', targetCurrency, fxRatesMap).value || 0);

  const tp = await computeDriverTripPay(tenantId, driverId, range);
  const dd = await computeDriverDeductions(tenantId, driverId, range);

  const tripPay = toTarget(tp.totalPayUsd);
  const cityPay = toTarget(dd.cityPay);
  const deductionTotal = toTarget(dd.deductionTotal);
  const perDateAddition = toTarget(dd.additionTotal);

  const orderBreakdown = tp.byOrder.map((b) => {
    const conv = convertAmount(b.payUsd, 'USD', targetCurrency, fxRatesMap);
    return {
      order: b.order, serial_no: b.serial_no, trips: b.trips,
      miles: b.miles, km: b.km, rateType: b.rateType,
      rateUsed: b.rateUsed, pay: Number(conv.value || 0), originalPay: b.payUsd,
      fxRate: Number(conv.rate || 1),
    };
  });

  // Existing saved record (preserve manual fields + paid on re-generate, like owner).
  const existing = await DriverSalary.findOne({ tenantId, driver: driverId, month: range.month, year: range.year }).lean();
  const existingCur = normalizeCurrency(existing?.currency, targetCurrency);
  const existPaid = convertAmount(Number(existing?.paidAmount || 0), existingCur, targetCurrency, fxRatesMap).value;
  const existManualDed = convertAmount(Number(existing?.manualDeduction || 0), existingCur, targetCurrency, fxRatesMap).value;
  const existManualAdd = convertAmount(Number(existing?.manualAddition || 0), existingCur, targetCurrency, fxRatesMap).value;

  // Previous month's due carry-forward.
  const prevRange = buildDateRange(range.month === 1 ? 12 : range.month - 1, range.month === 1 ? range.year - 1 : range.year);
  const prev = prevRange
    ? await DriverSalary.findOne({ tenantId, driver: driverId, month: prevRange.month, year: prevRange.year }).select('currency dueAmount').lean()
    : null;
  const prevCur = normalizeCurrency(prev?.currency, targetCurrency);
  const autoPrevDue = convertAmount(Number(prev?.dueAmount || 0), prevCur, targetCurrency, fxRatesMap).value;

  const includePreviousDue = opts.includePreviousDue !== false;
  const previousDueAdded = opts.previousDueAdded !== undefined
    ? Number(opts.previousDueAdded || 0)
    : (includePreviousDue ? Number(autoPrevDue || 0) : 0);
  // Per-date additions are their own channel (always counted). manualAddition is a separate
  // admin-entered field (preserved across re-generate) — the two never collide.
  const additionTotal = perDateAddition;
  const manualAddition = opts.manualAddition !== undefined
    ? Number(opts.manualAddition || 0)
    : Number(existManualAdd || 0);
  const manualDeduction = opts.manualDeduction !== undefined
    ? Number(opts.manualDeduction || 0)
    : Number(existManualDed || 0);

  const basePayable = tripPay + cityPay - deductionTotal;
  const finalPayable = basePayable + previousDueAdded + additionTotal + manualAddition - manualDeduction;
  const paidAmount = opts.paidAmount !== undefined ? Number(opts.paidAmount || 0) : Number(existPaid || 0);
  const dueAmount = Math.max(finalPayable - paidAmount, 0);
  const paymentStatus = dueAmount === 0 && finalPayable > 0 ? 'paid' : (paidAmount > 0 ? 'partial' : 'pending');

  return {
    tenantId,
    company: req.user?.company?._id || req.user?.company || null,
    driver: driverId,
    month: range.month,
    year: range.year,
    currency: targetCurrency,
    soloRate: tp.soloRate, teamRate: tp.teamRate, cityRate: tp.cityRate,
    totalTrips: tp.totalTrips, totalMiles: tp.totalMiles, totalKm: tp.totalKm,
    tripPay, cityHours: dd.cityHours, cityPay, deductionTotal, additionTotal,
    basePayable, previousDueAdded, manualDeduction, manualAddition,
    finalPayable, paidAmount, dueAmount, paymentStatus,
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

    const targetCurrency = normalizeCurrency(req.body?.currency, req.tenant?.billing?.currency || 'USD');
    const payload = await buildDriverSalaryPayload(req, tenantId, driverId, range, targetCurrency, {
      includePreviousDue: req.body?.includePreviousDue,
      previousDueAdded: req.body?.previousDueAdded,
      manualDeduction: req.body?.manualDeduction,
      manualAddition: req.body?.manualAddition,
      paidAmount: req.body?.paidAmount,
    });

    const salary = await DriverSalary.findOneAndUpdate(
      { tenantId, driver: driverId, month: range.month, year: range.year },
      payload,
      { upsert: true, new: true }
    );

    logActivity(req, {
      action: 'PAYMENT', module: 'payment',
      description: `Generated driver salary for ${range.month}/${range.year}`,
      details: { driverId, finalPayable: payload.finalPayable },
    });

    return res.json({ status: true, message: 'Driver salary generated', salary });
  } catch (err) {
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
    const targetCurrency = normalizeCurrency(req.query?.currency, req.tenant?.billing?.currency || 'USD');

    const saved = await DriverSalary.findOne({ tenantId, driver: driverId, month: range.month, year: range.year }).lean();
    if (saved && normalizeCurrency(saved.currency, targetCurrency) === targetCurrency) {
      return res.json({ status: true, saved: true, salary: saved });
    }
    // Live preview (not yet generated, or different currency requested)
    const preview = await buildDriverSalaryPayload(req, tenantId, driverId, range, targetCurrency, {});
    return res.json({ status: true, saved: false, salary: preview });
  } catch (err) {
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

    if (req.body?.manualDeduction !== undefined) salary.manualDeduction = Number(req.body.manualDeduction || 0);
    if (req.body?.manualAddition !== undefined) salary.manualAddition = Number(req.body.manualAddition || 0);
    if (req.body?.previousDueAdded !== undefined) salary.previousDueAdded = Number(req.body.previousDueAdded || 0);
    if (req.body?.notes !== undefined) salary.notes = String(req.body.notes || '');

    salary.finalPayable = salary.basePayable + salary.previousDueAdded + Number(salary.additionTotal || 0) + salary.manualAddition - salary.manualDeduction;
    // Clamp paid to payable so totals can't be inflated by overpayment.
    if (req.body?.paidAmount !== undefined) {
      salary.paidAmount = Math.min(Math.max(Number(req.body.paidAmount || 0), 0), Math.max(salary.finalPayable, 0));
    }
    salary.dueAmount = Math.max(salary.finalPayable - salary.paidAmount, 0);
    salary.paymentStatus = salary.dueAmount === 0 && salary.finalPayable > 0
      ? 'paid' : (salary.paidAmount > 0 ? 'partial' : 'pending');
    await salary.save();

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
    const targetCurrency = normalizeCurrency(req.query?.currency, req.tenant?.billing?.currency || 'USD');

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
      company = await Company.findById(companyId).lean();
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
    const rows = (salary.orderBreakdown || []).map((b) => `
      <tr>
        <td>#${safe(b.serial_no ?? '—')}</td>
        <td style="text-transform:uppercase;">${safe(b.rateType)}</td>
        <td style="text-align:right;">${Number(b.miles || 0).toFixed(2)} mi (${Number(b.km || 0).toFixed(2)} km)</td>
        <td style="text-align:right;">${fmt(b.rateUsed)}/mi</td>
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

        <table>
          <thead><tr><th>Order</th><th>Type</th><th style="text-align:right;">Distance</th><th style="text-align:right;">Rate</th><th style="text-align:right;">Pay</th></tr></thead>
          <tbody>${rows || `<tr><td colspan="5" style="text-align:center;color:#94a3b8;">No trips this period</td></tr>`}</tbody>
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

    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'load', timeout: 20000 }).catch(() => {});
    const pdfBuffer = await page.pdf({ format: 'A4', printBackground: true, margin: { top: 0, bottom: 0, left: 0, right: 0 } });
    await browser.close();
    browser = null;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="Driver_Statement_${safe(driver.name || 'driver')}_${range.month}_${range.year}.pdf"`);
    return res.end(pdfBuffer);
  } catch (err) {
    if (browser) { try { await browser.close(); } catch (e) { /* noop */ } }
    JSONerror(res, err, next);
    logger(err);
  }
});
