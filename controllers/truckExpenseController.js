const TruckExpense = require('../db/TruckExpense');
const Truck = require('../db/Truck');
const mongoose = require('mongoose');
const catchAsync = require('../utils/catchAsync');
const JSONerror = require('../utils/jsonErrorHandler');
const { logActivity, logChange } = require('../utils/activityLogger');
const { normalizeCurrency } = require('../utils/fx');
const { createOrderFxConverter, resolveDisplayCurrency } = require('../utils/orderMoney');

function normalizeCompanyId(req) {
  const raw = req.user?.company?._id || req.user?.company;
  if (!raw) return null;
  const s = String(raw);
  if (!mongoose.Types.ObjectId.isValid(s)) return null;
  return new mongoose.Types.ObjectId(s);
}

function isAdmin(req) {
  return req.user?.is_admin === 1 || (req.user?.permissions || []).includes('accounting');
}

/**
 * Auto-create fixed monthly expenses (insurance, parking) for a truck+month
 * if they don't already exist and the truck has configured amounts.
 */
async function ensureFixedExpenses(truck, tenantId, month, year) {
  const fixedTypes = [
    { type: 'insurance', field: 'insuranceMonthly' },
    { type: 'parking', field: 'parkingMonthly' }
  ];

  for (const { type, field } of fixedTypes) {
    const amount = Number(truck[field] || 0);
    if (amount <= 0) continue;

    const exists = await TruckExpense.findOne({
      tenantId,
      truck: truck._id,
      isFixed: true,
      type,
      fixedMonth: month,
      fixedYear: year,
      deletedAt: null
    });

    if (!exists) {
      // Date = first day of that month
      const date = new Date(year, month, 1);
      await TruckExpense.create({
        tenantId,
        company: truck.company,
        truck: truck._id,
        type,
        amount,
        paid_by: 'owner',
        description: `Auto: ${type.charAt(0).toUpperCase() + type.slice(1)} for ${date.toLocaleString('default', { month: 'long' })} ${year}`,
        date,
        isFixed: true,
        fixedMonth: month,
        fixedYear: year
      });
    }
  }
}

// GET /truck/:truckId/expenses?from=&to=
exports.getExpenses = catchAsync(async (req, res, next) => {
  try {
    const tenantId = req.tenantId || req.user?.tenantId;
    if (!tenantId) return res.status(400).json({ status: false, message: 'Tenant required' });

    const { truckId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(truckId)) {
      return res.status(400).json({ status: false, message: 'Invalid truck id' });
    }

    const companyId = normalizeCompanyId(req);
    const truckFilter = { _id: truckId, tenantId, $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }] };
    if (companyId) truckFilter.company = companyId;
    const truck = await Truck.findOne(truckFilter).lean();
    if (!truck) return res.status(404).json({ status: false, message: 'Truck not found' });

    // Determine date range
    const now = new Date();
    let start, end, month, year;
    if (req.query.from && req.query.to) {
      start = new Date(req.query.from);
      end = new Date(req.query.to);
      end.setHours(23, 59, 59, 999);
      // For fixed-expense auto-add, use start month
      month = start.getMonth();
      year = start.getFullYear();
    } else {
      month = req.query.month != null ? parseInt(req.query.month) : now.getMonth();
      year = req.query.year != null ? parseInt(req.query.year) : now.getFullYear();
      start = new Date(year, month, 1);
      end = new Date(year, month + 1, 0, 23, 59, 59, 999);
    }

    // Auto-create fixed expenses if missing
    await ensureFixedExpenses(truck, tenantId, month, year);

    const expenses = await TruckExpense.find({
      tenantId,
      truck: truckId,
      deletedAt: null,
      date: { $gte: start, $lte: end }
    }).sort({ date: -1 }).lean();

    // Convert each expense once from the currency it was entered in.
    const displayCurrency = resolveDisplayCurrency(req);
    const fx = createOrderFxConverter(tenantId, displayCurrency);
    await fx.prime(expenses.map((e) => e.date));
    let totalExpenses = 0;
    for (const e of expenses) {
      e.amountConverted = fx.convert(Number(e.amount || 0), e.currency || 'USD', e.date);
      totalExpenses += e.amountConverted;
    }

    res.json({
      status: true,
      truck: { _id: truck._id, plateNumber: truck.plateNumber, unitNumber: truck.unitNumber },
      expenses,
      totalExpenses,
      currency: displayCurrency.toLowerCase(),
      insuranceMonthly: truck.insuranceMonthly || 0,
      parkingMonthly: truck.parkingMonthly || 0
    });
  } catch (err) {
    JSONerror(res, err, next);
  }
});

// POST /truck/:truckId/expense
exports.addExpense = catchAsync(async (req, res, next) => {
  try {
    const tenantId = req.tenantId || req.user?.tenantId;
    if (!tenantId) return res.status(400).json({ status: false, message: 'Tenant required' });

    const { truckId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(truckId)) {
      return res.status(400).json({ status: false, message: 'Invalid truck id' });
    }

    const companyId = normalizeCompanyId(req);
    const truckFilter = { _id: truckId, tenantId };
    if (companyId) truckFilter.company = companyId;
    const truck = await Truck.findOne(truckFilter).lean();
    if (!truck) return res.status(404).json({ status: false, message: 'Truck not found' });

    const { type, amount, paid_by, description, date, currency } = req.body;
    if (!type || amount == null || !date) {
      return res.status(400).json({ status: false, message: 'type, amount and date are required' });
    }
    if (Number(amount) < 0) {
      return res.status(400).json({ status: false, message: 'Amount cannot be negative' });
    }

    const expenseDate = new Date(date);
    const expense = await TruckExpense.create({
      tenantId,
      company: truck.company,
      truck: truckId,
      type,
      amount: Number(amount),
      // Snapshot the currency the amount was typed in — reports convert from it, never guess.
      currency: normalizeCurrency(currency, 'USD'),
      paid_by: paid_by || 'owner',
      description: description || '',
      date: expenseDate,
      isFixed: false,
      createdBy: req.user?._id
    });

    logChange(req, {
      model: 'TruckExpense',
      module: 'fleet',
      action: 'CREATE',
      after: expense.toObject(),
      // Currency belongs in the sentence: TruckExpense.currency is a per-row snapshot and a bare
      // "$" on a CAD row reads as USD in the trail.
      description: `Added ${type} expense ${expense.currency} ${amount} for truck ${truck.unitNumber || truck.plateNumber}`,
      resourceId: expense._id,
      resourceName: truck.unitNumber || truck.plateNumber,
      details: { truck: String(truckId) },
    });

    res.status(201).json({ status: true, message: 'Expense added', expense });
  } catch (err) {
    JSONerror(res, err, next);
  }
});

// PUT /truck/:truckId/expense/:expenseId
exports.updateExpense = catchAsync(async (req, res, next) => {
  try {
    const tenantId = req.tenantId || req.user?.tenantId;
    const { truckId, expenseId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(truckId) || !mongoose.Types.ObjectId.isValid(expenseId)) {
      return res.status(400).json({ status: false, message: 'Invalid id' });
    }

    const { type, amount, paid_by, description, date, currency } = req.body;
    const update = {};
    if (type) update.type = type;
    if (amount != null) update.amount = Number(amount);
    if (currency) update.currency = normalizeCurrency(currency, 'USD');
    if (paid_by) update.paid_by = paid_by;
    if (description != null) update.description = description;
    if (date) update.date = new Date(date);

    const beforeExpense = await TruckExpense.findOne(
      { _id: expenseId, truck: truckId, tenantId, deletedAt: null }
    ).lean();

    const expense = await TruckExpense.findOneAndUpdate(
      { _id: expenseId, truck: truckId, tenantId, deletedAt: null },
      update,
      { new: true }
    );

    if (!expense) return res.status(404).json({ status: false, message: 'Expense not found' });

    // Expenses subtract from truck profit; editing one moves a reported figure.
    logChange(req, {
      model: 'TruckExpense',
      module: 'fleet',
      before: beforeExpense,
      after: expense.toObject(),
      resourceId: expense._id,
      description: `Updated ${expense.type} expense on truck`,
      details: { truck: String(truckId) },
    });

    res.json({ status: true, message: 'Expense updated', expense });
  } catch (err) {
    JSONerror(res, err, next);
  }
});

// DELETE /truck/:truckId/expense/:expenseId
exports.deleteExpense = catchAsync(async (req, res, next) => {
  try {
    const tenantId = req.tenantId || req.user?.tenantId;
    const { truckId, expenseId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(truckId) || !mongoose.Types.ObjectId.isValid(expenseId)) {
      return res.status(400).json({ status: false, message: 'Invalid id' });
    }

    const expense = await TruckExpense.findOneAndUpdate(
      { _id: expenseId, truck: truckId, tenantId, deletedAt: null },
      { deletedAt: new Date() },
      { new: true }
    );

    if (!expense) return res.status(404).json({ status: false, message: 'Expense not found' });

    // Removing an expense raises reported truck profit — keep the row's own numbers.
    logChange(req, {
      model: 'TruckExpense',
      module: 'fleet',
      action: 'DELETE',
      before: expense.toObject(),
      resourceId: expense._id,
      description: `Deleted ${expense.type} expense ${expense.currency} ${expense.amount} on truck`,
      details: { truck: String(truckId) },
      critical: true,
    });

    res.json({ status: true, message: 'Expense deleted' });
  } catch (err) {
    JSONerror(res, err, next);
  }
});

// GET /truck/:truckId/profit-summary?from=&to=  (gross - expenses = profit)
exports.getTruckProfitSummary = catchAsync(async (req, res, next) => {
  try {
    const tenantId = req.tenantId || req.user?.tenantId;
    const { truckId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(truckId)) {
      return res.status(400).json({ status: false, message: 'Invalid truck id' });
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

    const agg = await TruckExpense.aggregate([
      {
        $match: {
          tenantId,
          truck: new mongoose.Types.ObjectId(truckId),
          deletedAt: null,
          date: { $gte: start, $lte: end }
        }
      },
      {
        $group: {
          _id: { type: '$type', currency: '$currency' },
          total: { $sum: '$amount' },
          lastDate: { $max: '$date' }
        }
      }
    ]);

    const displayCurrency = resolveDisplayCurrency(req);
    const fx = createOrderFxConverter(tenantId, displayCurrency);
    await fx.prime(agg.map((row) => row.lastDate));
    const byType = {};
    let totalExpenses = 0;
    for (const row of agg) {
      const converted = fx.convert(Number(row.total || 0), row._id?.currency || 'USD', row.lastDate);
      const type = row._id?.type;
      byType[type] = Number(byType[type] || 0) + converted;
      totalExpenses += converted;
    }

    res.json({ status: true, totalExpenses, byType, currency: displayCurrency.toLowerCase() });
  } catch (err) {
    JSONerror(res, err, next);
  }
});
