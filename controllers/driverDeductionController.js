const DriverDeduction = require('../db/DriverDeduction');
const DriverProfile = require('../db/DriverProfile');
const mongoose = require('mongoose');
const catchAsync = require('../utils/catchAsync');
const JSONerror = require('../utils/jsonErrorHandler');
const { logActivity, logChange } = require('../utils/activityLogger');
const { getDriverRateCurrency } = require('../utils/distance');

const DriverSalary = require('../db/DriverSalary');

// An amount is money. Reject anything that isn't a real, positive number here — the schema's
// `min: 0` only runs on .save(), and updateDeduction goes through findOneAndUpdate, which skips
// validators entirely. A negative "deduction" quietly pays the driver extra.
function parseAmount(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100) / 100;
}

// Editing or deleting a row that a generated payslip already counted silently desyncs that payslip.
// Block it once money has actually been paid against it; otherwise let it through — the payslip is
// regenerated from these rows anyway, and the UI flags it as out of date.
async function assertPayslipEditable(tenantId, driverId, date, { confirm = false } = {}) {
  const when = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(when.getTime())) return null;
  const salary = await DriverSalary.findOne({
    tenantId, driver: driverId, month: when.getMonth() + 1, year: when.getFullYear(),
  }).select('paidAmount paymentStatus month year').lean();
  if (!salary) return null;
  const paid = Number(salary.paidAmount || 0) > 0 || salary.paymentStatus === 'paid';
  if (paid && !confirm) {
    const err = new Error(
      `The ${salary.month}/${salary.year} payslip for this driver has already been paid. `
      + 'Confirm to change it anyway — the payslip must then be regenerated.'
    );
    err.code = 'payslip_paid';
    err.status = 409;
    throw err;
  }
  return salary;
}

const isConfirmed = (req) => String(req.query?.confirm ?? req.body?.confirm ?? '').toLowerCase() === 'true';

function normalizeCompanyId(req) {
  const raw = req.user?.company?._id || req.user?.company;
  if (!raw) return null;
  const s = String(raw);
  if (!mongoose.Types.ObjectId.isValid(s)) return null;
  return new mongoose.Types.ObjectId(s);
}

// GET /driver/:driverId/deductions?from=&to=
exports.getDeductions = catchAsync(async (req, res, next) => {
  try {
    const tenantId = req.tenantId || req.user?.tenantId;
    const { driverId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(driverId)) {
      return res.status(400).json({ status: false, message: 'Invalid driver id' });
    }

    const now = new Date();
    let start, end;
    if (req.query.from && req.query.to) {
      start = new Date(req.query.from);
      end = new Date(req.query.to);
      end.setHours(23, 59, 59, 999);
    } else {
      start = new Date(now.getFullYear(), now.getMonth(), 1);
      end = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
    }

    const deductions = await DriverDeduction.find({
      tenantId,
      driver: driverId,
      deletedAt: null,
      date: { $gte: start, $lte: end }
    }).sort({ date: -1 }).lean();

    // Separate city hours (additions) from deductions
    const cityHours = deductions.filter((d) => d.type === 'city_hours');
    const additions = deductions.filter((d) => d.direction === 'add' && d.type !== 'city_hours');
    const deductionItems = deductions.filter((d) => d.direction === 'deduct');

    const totalCityPay = cityHours.reduce((s, d) => s + Number(d.amount || 0), 0);
    const totalAdditions = additions.reduce((s, d) => s + Number(d.amount || 0), 0);
    const totalDeductions = deductionItems.reduce((s, d) => s + Number(d.amount || 0), 0);

    // Every row carries the currency it was entered in (DriverDeduction.currency). These totals add
    // the raw amounts, which is only meaningful while all the rows share one currency — normally
    // true, since the currency is snapshotted from the driver's locked rate currency. Report what
    // was actually summed so the UI can never present two currencies as one number.
    const currencies = [...new Set(deductions.map((d) => String(d.currency || 'USD').toUpperCase()))];

    // A generated payslip is a snapshot of these rows. If any row was added or edited after it was
    // generated, the statement in the driver's hands no longer matches the ledger on this screen —
    // and nothing said so. Report it; the UI turns it into a "regenerate" prompt.
    const salary = await DriverSalary.findOne({
      tenantId, driver: driverId, month: start.getMonth() + 1, year: start.getFullYear(),
    }).select('generatedAt paidAmount paymentStatus month year finalPayable currency').lean();
    const lastEntryChange = deductions.reduce((latest, d) => {
      const t = new Date(d.updatedAt || d.createdAt || d.date || 0).getTime();
      return t > latest ? t : latest;
    }, 0);
    const payslip = salary ? {
      exists: true,
      month: salary.month,
      year: salary.year,
      generatedAt: salary.generatedAt || null,
      paymentStatus: salary.paymentStatus || 'pending',
      paidAmount: Number(salary.paidAmount || 0),
      currency: salary.currency || null,
      finalPayable: Number(salary.finalPayable || 0),
      stale: !!(salary.generatedAt && lastEntryChange > new Date(salary.generatedAt).getTime()),
    } : { exists: false, stale: false };

    res.json({
      status: true,
      payslip,
      deductions,
      cityHours,
      additions,
      deductionItems,
      totalCityPay,
      totalAdditions,
      totalDeductions,
      currency: currencies[0] || 'USD',
      currencies,
      mixedCurrency: currencies.length > 1,
      netAdjustment: totalCityPay + totalAdditions - totalDeductions
    });
  } catch (err) {
    JSONerror(res, err, next);
  }
});

// POST /driver/:driverId/deduction
exports.addDeduction = catchAsync(async (req, res, next) => {
  try {
    const tenantId = req.tenantId || req.user?.tenantId;
    const { driverId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(driverId)) {
      return res.status(400).json({ status: false, message: 'Invalid driver id' });
    }

    const { type, direction, amount, hours, rate, description, date } = req.body;

    if (!type || !direction || !date) {
      return res.status(400).json({ status: false, message: 'type, direction and date are required' });
    }

    const entryDate = new Date(date);
    if (Number.isNaN(entryDate.getTime())) {
      return res.status(400).json({ status: false, message: 'Enter a valid date' });
    }
    try {
      await assertPayslipEditable(tenantId, driverId, entryDate, { confirm: isConfirmed(req) });
    } catch (guard) {
      if (guard.code === 'payslip_paid') {
        return res.status(409).json({ status: false, code: guard.code, message: guard.message });
      }
      throw guard;
    }

    let finalAmount = null;
    let finalHours = null;
    let finalRate = null;
    // City hours are pay, never a deduction — the payslip counts every city_hours row as pay
    // regardless of direction, so a row saved as 'deduct' would read as a deduction here and pay
    // the driver there. Pin it rather than let the two disagree.
    const finalDirection = type === 'city_hours' ? 'add' : direction;

    // Every amount on this row — city-hours pay, advances, fines, bonuses — is denominated in the
    // driver's locked pay currency, so the payslip converts one consistent base instead of mixing
    // USD deductions with (say) CAD trip pay.
    const profile = await DriverProfile.findOne({ tenantId, user: driverId }).lean();
    const rowCurrency = getDriverRateCurrency(profile);

    if (type === 'city_hours') {
      if (!hours || Number(hours) <= 0) {
        return res.status(400).json({ status: false, message: 'Hours required for city hours entry' });
      }
      // If rate not provided, fetch from driver profile
      let cityRate = Number(rate || 0);
      if (!cityRate) {
        cityRate = Number(profile?.cityHoursRate || 0);
      }
      if (!(cityRate > 0)) {
        return res.status(400).json({
          status: false,
          message: 'This driver has no city-hours rate set. Add it on their profile before logging city hours.',
        });
      }
      finalHours = Number(hours);
      finalRate = cityRate;
      finalAmount = Math.round(finalHours * finalRate * 100) / 100;
    } else {
      finalAmount = parseAmount(amount);
      if (finalAmount === null) {
        return res.status(400).json({ status: false, message: 'Enter an amount greater than 0' });
      }
    }

    const companyId = normalizeCompanyId(req);
    const deduction = await DriverDeduction.create({
      tenantId,
      company: companyId,
      driver: driverId,
      type,
      direction: finalDirection,
      amount: finalAmount,
      currency: rowCurrency,
      hours: finalHours,
      rate: finalRate,
      description: description || '',
      reference: String(req.body?.reference || '').trim(),
      // Insurance, escrow and a lease payment recur every month — marking the row once is
      // what stops it being retyped (and forgotten) each period.
      recurring: !!req.body?.recurring,
      date: entryDate,
      createdBy: req.user?._id,
      updatedBy: req.user?._id
    });

    logChange(req, {
      model: 'DriverDeduction',
      module: 'drivers',
      action: 'CREATE',
      after: deduction.toObject(),
      resourceId: deduction._id,
      resourceName: `${type} ${rowCurrency} ${finalAmount}`,
      // The currency belongs in the sentence — a bare "$" on a CAD row is how a payslip dispute
      // starts. Row currency is the driver's locked rateCurrency.
      description: `Added ${finalDirection === 'add' ? 'addition' : 'deduction'} (${type}) ${rowCurrency} ${finalAmount} for driver`,
      details: { driver: String(driverId) },
    });

    res.status(201).json({ status: true, message: 'Entry saved', deduction });
  } catch (err) {
    JSONerror(res, err, next);
  }
});

// PUT /driver/:driverId/deduction/:deductionId
exports.updateDeduction = catchAsync(async (req, res, next) => {
  try {
    const tenantId = req.tenantId || req.user?.tenantId;
    const { driverId, deductionId } = req.params;

    const { type, direction, amount, hours, rate, description, date } = req.body;

    const beforeDeduction = await DriverDeduction.findOne(
      { _id: deductionId, driver: driverId, tenantId, deletedAt: null }
    ).lean();
    if (!beforeDeduction) return res.status(404).json({ status: false, message: 'Entry not found' });

    // The row's own type decides how the rest of the payload is read. Taking it from the request
    // alone meant editing a city-hours row without re-sending `type` fell through to the plain
    // amount branch and wrote an amount that no longer equalled hours x rate.
    const nextType = type || beforeDeduction.type;
    const update = { updatedAt: new Date(), updatedBy: req.user?._id || null };

    // A reimbursement row belongs to a truck expense and is kept in step with it. Editing it
    // here would put the payslip and the expense out of agreement with no way to tell which
    // is right — the expense is the record, so that is where it must be changed.
    if (beforeDeduction.autoSource === 'truck_expense') {
      return res.status(400).json({
        status: false,
        code: 'auto_generated_row',
        message: 'This line reimburses a truck expense. Edit the expense on the truck instead.',
      });
    }

    if (type) update.type = type;
    if (description != null) update.description = description;
    if (req.body?.reference !== undefined) update.reference = String(req.body.reference || '').trim();
    if (req.body?.recurring !== undefined) update.recurring = !!req.body.recurring;

    let entryDate = beforeDeduction.date;
    if (date) {
      entryDate = new Date(date);
      if (Number.isNaN(entryDate.getTime())) {
        return res.status(400).json({ status: false, message: 'Enter a valid date' });
      }
      update.date = entryDate;
    }

    // Moving a row between months touches two payslips — check both.
    try {
      const confirm = isConfirmed(req);
      await assertPayslipEditable(tenantId, driverId, beforeDeduction.date, { confirm });
      if (date) await assertPayslipEditable(tenantId, driverId, entryDate, { confirm });
    } catch (guard) {
      if (guard.code === 'payslip_paid') {
        return res.status(409).json({ status: false, code: guard.code, message: guard.message });
      }
      throw guard;
    }

    if (nextType === 'city_hours') {
      // City hours are always pay, and their amount is always hours x rate — never a typed total.
      update.direction = 'add';
      const nextHours = hours != null ? Number(hours) : Number(beforeDeduction.hours || 0);
      const nextRate = rate != null ? Number(rate) : Number(beforeDeduction.rate || 0);
      if (!(nextHours > 0) || !(nextRate > 0)) {
        return res.status(400).json({ status: false, message: 'City hours need hours and a rate greater than 0' });
      }
      update.hours = nextHours;
      update.rate = nextRate;
      update.amount = Math.round(nextHours * nextRate * 100) / 100;
    } else {
      if (direction) update.direction = direction;
      // Leaving hours/rate behind on a row that is no longer city hours makes it look like the
      // amount was derived from them.
      if (beforeDeduction.type === 'city_hours') {
        update.hours = null;
        update.rate = null;
      }
      if (amount != null) {
        const parsed = parseAmount(amount);
        if (parsed === null) {
          return res.status(400).json({ status: false, message: 'Enter an amount greater than 0' });
        }
        update.amount = parsed;
      }
    }

    const deduction = await DriverDeduction.findOneAndUpdate(
      { _id: deductionId, driver: driverId, tenantId, deletedAt: null },
      update,
      // findOneAndUpdate skips schema validators unless asked — without this the enum and `min: 0`
      // on this model are decoration.
      { new: true, runValidators: true }
    );

    if (!deduction) return res.status(404).json({ status: false, message: 'Entry not found' });

    // Editing a deduction changes a payslip that may already have been issued.
    logChange(req, {
      model: 'DriverDeduction',
      module: 'drivers',
      before: beforeDeduction,
      after: deduction.toObject(),
      resourceId: deduction._id,
      resourceName: `${deduction.type} ${deduction.currency} ${deduction.amount}`,
      description: `Updated driver ${deduction.direction === 'add' ? 'addition' : 'deduction'} (${deduction.type})`,
      details: { driver: String(driverId) },
    });

    res.json({ status: true, message: 'Entry updated', deduction });
  } catch (err) {
    JSONerror(res, err, next);
  }
});

// DELETE /driver/:driverId/deduction/:deductionId
exports.deleteDeduction = catchAsync(async (req, res, next) => {
  try {
    const tenantId = req.tenantId || req.user?.tenantId;
    const { driverId, deductionId } = req.params;

    const existing = await DriverDeduction.findOne(
      { _id: deductionId, driver: driverId, tenantId, deletedAt: null }
    ).select('date autoSource').lean();
    if (!existing) return res.status(404).json({ status: false, message: 'Entry not found' });
    if (existing.autoSource === 'truck_expense') {
      return res.status(400).json({
        status: false,
        code: 'auto_generated_row',
        message: 'This line reimburses a truck expense. Remove the expense on the truck instead.',
      });
    }

    try {
      await assertPayslipEditable(tenantId, driverId, existing.date, { confirm: isConfirmed(req) });
    } catch (guard) {
      if (guard.code === 'payslip_paid') {
        return res.status(409).json({ status: false, code: guard.code, message: guard.message });
      }
      throw guard;
    }

    const deduction = await DriverDeduction.findOneAndUpdate(
      { _id: deductionId, driver: driverId, tenantId, deletedAt: null },
      { deletedAt: new Date(), updatedAt: new Date(), updatedBy: req.user?._id || null },
      { new: true }
    );

    if (!deduction) return res.status(404).json({ status: false, message: 'Entry not found' });

    // A removed deduction raises the driver's pay. Keep the row's own numbers.
    logChange(req, {
      model: 'DriverDeduction',
      module: 'drivers',
      action: 'DELETE',
      before: deduction.toObject(),
      resourceId: deduction._id,
      resourceName: `${deduction.type} ${deduction.currency} ${deduction.amount}`,
      description: `Deleted driver ${deduction.direction === 'add' ? 'addition' : 'deduction'} (${deduction.type}) ${deduction.currency} ${deduction.amount}`,
      details: { driver: String(driverId) },
      critical: true,
    });

    res.json({ status: true, message: 'Entry deleted' });
  } catch (err) {
    JSONerror(res, err, next);
  }
});

// GET /driver/deduction-categories
// Served from the same lists the model validates against, so a category the form offers can
// never be one the API rejects.
exports.deductionCategories = catchAsync(async (req, res) => {
  const { ADDITION_TYPES, DEDUCT_TYPES } = require('../db/DriverDeduction');
  const LABELS = {
    city_hours: 'City Hours',
    bonus: 'Bonus',
    reimbursement: 'Reimbursement',
    detention: 'Detention / Layover',
    escrow_return: 'Escrow Return',
    advance: 'Advance',
    fuel: 'Fuel',
    insurance: 'Insurance',
    escrow: 'Escrow Hold',
    repair: 'Repair / Maintenance',
    lease: 'Lease / Truck Payment',
    permit: 'Permits & Licensing',
    ifta: 'IFTA / Fuel Tax',
    damage: 'Damage / Claim',
    fine: 'Fine / Violation',
    other: 'Other',
  };
  const toOptions = (values) => values.map((value) => ({ value, label: LABELS[value] || value }));
  return res.json({
    status: true,
    categories: {
      add: toOptions([...ADDITION_TYPES, 'other']),
      deduct: toOptions([...DEDUCT_TYPES, 'other']),
    },
  });
});
