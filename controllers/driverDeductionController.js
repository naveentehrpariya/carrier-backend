const DriverDeduction = require('../db/DriverDeduction');
const DriverProfile = require('../db/DriverProfile');
const mongoose = require('mongoose');
const catchAsync = require('../utils/catchAsync');
const JSONerror = require('../utils/jsonErrorHandler');
const { logActivity } = require('../utils/activityLogger');

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

    res.json({
      status: true,
      deductions,
      cityHours,
      additions,
      deductionItems,
      totalCityPay,
      totalAdditions,
      totalDeductions,
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

    let finalAmount = Number(amount || 0);
    let finalHours = null;
    let finalRate = null;

    if (type === 'city_hours') {
      if (!hours || Number(hours) <= 0) {
        return res.status(400).json({ status: false, message: 'Hours required for city hours entry' });
      }
      // If rate not provided, fetch from driver profile
      let cityRate = Number(rate || 0);
      if (!cityRate) {
        const companyId = normalizeCompanyId(req);
        const profile = await DriverProfile.findOne({ tenantId, user: driverId }).lean();
        cityRate = Number(profile?.cityHoursRate || 0);
      }
      finalHours = Number(hours);
      finalRate = cityRate;
      finalAmount = finalHours * finalRate;
    } else {
      if (finalAmount <= 0) {
        return res.status(400).json({ status: false, message: 'Amount must be greater than 0' });
      }
    }

    const companyId = normalizeCompanyId(req);
    const deduction = await DriverDeduction.create({
      tenantId,
      company: companyId,
      driver: driverId,
      type,
      direction,
      amount: finalAmount,
      hours: finalHours,
      rate: finalRate,
      description: description || '',
      date: new Date(date),
      createdBy: req.user?._id
    });

    logActivity(req, {
      action: 'CREATE',
      module: 'drivers',
      description: `Added ${direction === 'add' ? 'addition' : 'deduction'} (${type}) $${finalAmount} for driver`,
      resourceId: deduction._id
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
    const update = {};

    if (type) update.type = type;
    if (direction) update.direction = direction;
    if (description != null) update.description = description;
    if (date) update.date = new Date(date);

    if (type === 'city_hours' && hours != null) {
      update.hours = Number(hours);
      update.rate = Number(rate || 0);
      update.amount = update.hours * update.rate;
    } else if (amount != null) {
      update.amount = Number(amount);
    }

    const deduction = await DriverDeduction.findOneAndUpdate(
      { _id: deductionId, driver: driverId, tenantId, deletedAt: null },
      update,
      { new: true }
    );

    if (!deduction) return res.status(404).json({ status: false, message: 'Entry not found' });
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

    const deduction = await DriverDeduction.findOneAndUpdate(
      { _id: deductionId, driver: driverId, tenantId, deletedAt: null },
      { deletedAt: new Date() },
      { new: true }
    );

    if (!deduction) return res.status(404).json({ status: false, message: 'Entry not found' });
    res.json({ status: true, message: 'Entry deleted' });
  } catch (err) {
    JSONerror(res, err, next);
  }
});
