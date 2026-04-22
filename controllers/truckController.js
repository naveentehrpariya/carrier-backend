const Truck = require('../db/Truck');
const FleetDoc = require('../db/FleetDoc');
const Trip = require('../db/Trip');
const mongoose = require('mongoose');
const catchAsync = require('../utils/catchAsync');
const JSONerror = require('../utils/jsonErrorHandler');
const logger = require('../utils/logger');

function normalizeCompanyId(req) {
  const raw = req.user?.company?._id || req.user?.company;
  if (!raw) return null;
  const s = String(raw);
  if (!mongoose.Types.ObjectId.isValid(s)) return null;
  return new mongoose.Types.ObjectId(s);
}

exports.addTruck = catchAsync(async (req, res, next) => {
  try {
    const tenantId = req.tenantId || req.user?.tenantId;
    if (!tenantId) return res.status(400).json({ status: false, message: 'Tenant context is required' });
    const { plateNumber, unitNumber, make, model, year, vin, capacity, notes } = req.body;
    if (!plateNumber) return res.status(400).json({ status: false, message: 'Plate number is required' });
    const exists = await Truck.findOne({ tenantId, plateNumber });
    if (exists) return res.status(400).json({ status: false, message: 'Truck with this plate already exists' });
    const truck = await Truck.create({
      tenantId,
      company: req.user?.company ? req.user.company._id : null,
      plateNumber, unitNumber, make, model, year, vin, capacity, notes,
      createdBy: req.user?._id
    });
    res.status(201).json({ status: true, message: 'Truck added', truck });
  } catch (err) {
    JSONerror(res, err, next);
    logger(err);
  }
});

exports.trucks_listing = catchAsync(async (req, res, next) => {
  try {
    const tenantId = req.tenantId || req.user?.tenantId;
    const companyId = normalizeCompanyId(req);
    const filter = { tenantId };
    if (companyId) {
      filter.company = companyId;
    }
    filter.$or = [{ deletedAt: null }, { deletedAt: { $exists: false } }];
    const trucks = await Truck.find(filter).sort({ createdAt: -1 }).lean();
    const truckIds = (trucks || []).map((t) => t._id).filter(Boolean);

    const tripAgg = truckIds.length
      ? await Trip.aggregate([
          { $match: { tenantId, deletedAt: null, truck: { $in: truckIds } } },
          { $sort: { createdAt: -1 } },
          {
            $group: {
              _id: '$truck',
              totalMiles: { $sum: { $ifNull: ['$miles', 0] } },
              lastTripAt: { $first: '$createdAt' },
              lastLocation: { $first: '$end_location' },
              lastOrder: { $first: '$order' },
              lastDriver: { $first: '$driver' }
            }
          },
          {
            $lookup: {
              from: 'orders',
              localField: 'lastOrder',
              foreignField: '_id',
              as: 'orderDoc'
            }
          },
          { $unwind: { path: '$orderDoc', preserveNullAndEmptyArrays: true } },
          { $addFields: { lastOrderSerial: '$orderDoc.serial_no' } },
          { $project: { orderDoc: 0 } }
        ])
      : [];

    const map = new Map((tripAgg || []).map((r) => [String(r._id), r]));
    const merged = (trucks || []).map((t) => {
      const r = map.get(String(t._id));
      return {
        ...t,
        lastLocation: r?.lastLocation || '',
        lastTripAt: r?.lastTripAt || null,
        lastOrderSerial: r?.lastOrderSerial || null,
        totalMiles: Number(r?.totalMiles || 0)
      };
    });

    res.json({ status: true, lists: merged, totalDocuments: merged.length });
  } catch (err) {
    JSONerror(res, err, next);
    logger(err);
  }
});

exports.removeTruck = catchAsync(async (req, res, next) => {
  try {
    const tenantId = req.tenantId || req.user?.tenantId;
    const companyId = req.user?.company ? req.user.company._id : null;
    const id = req.params.id;
    const filter = { _id: id, tenantId };
    if (companyId) {
      filter.company = companyId;
    }
    const updated = await Truck.findOneAndUpdate(filter, { deletedAt: new Date() }, { new: true });
    if (!updated) {
      return res.status(404).json({ status: false, message: 'Truck not found' });
    }
    res.json({ status: true, message: 'Truck removed (soft delete)', truck: updated });
  } catch (err) {
    JSONerror(res, err, next);
    logger(err);
  }
});

exports.updateTruck = catchAsync(async (req, res, next) => {
  try {
    const tenantId = req.tenantId || req.user?.tenantId;
    const id = req.params.id;
    const truck = await Truck.findOneAndUpdate({ _id: id, tenantId }, req.body, { new: true });
    res.json({ status: true, message: 'Truck updated', truck });
  } catch (err) {
    JSONerror(res, err, next);
    logger(err);
  }
});

exports.truck_detail = catchAsync(async (req, res, next) => {
  try {
    const tenantId = req.tenantId || req.user?.tenantId;
    if (!tenantId) return res.status(400).json({ status: false, message: 'Tenant context is required' });
    const companyId = normalizeCompanyId(req);
    const id = req.params.id;

    const filter = { _id: id, tenantId, $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }] };
    if (companyId) filter.company = companyId;

    const truck = await Truck.findOne(filter).lean();
    if (!truck) return res.status(404).json({ status: false, message: 'Truck not found' });
    res.json({ status: true, truck });
  } catch (err) {
    JSONerror(res, err, next);
    logger(err);
  }
});
