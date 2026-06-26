const Truck = require('../db/Truck');
const FleetDoc = require('../db/FleetDoc');
const Trip = require('../db/Trip');
const OwnerOperator = require('../db/OwnerOperator');
const mongoose = require('mongoose');
const catchAsync = require('../utils/catchAsync');
const JSONerror = require('../utils/jsonErrorHandler');
const logger = require('../utils/logger');
const { logActivity } = require('../utils/activityLogger');

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
    const {
      plateNumber,
      truckNumber,
      unitNumber,
      make,
      model,
      year,
      vin,
      capacity,
      notes,
      insuranceMonthly,
      parkingMonthly,
      ownerOperated,
      ownerOperator
    } = req.body;
    if (!plateNumber) return res.status(400).json({ status: false, message: 'Plate number is required' });
    const exists = await Truck.findOne({ tenantId, plateNumber });
    if (exists) return res.status(400).json({ status: false, message: 'Truck with this plate already exists' });
    const isOwnerOperated = ownerOperated === true || ownerOperated === 'true' || ownerOperated === 1 || ownerOperated === '1';
    let ownerOperatorDoc = null;
    if (isOwnerOperated) {
      if (!ownerOperator) {
        return res.status(400).json({ status: false, message: 'Owner operator is required for owner operated truck' });
      }
      ownerOperatorDoc = await OwnerOperator.findOne({
        _id: ownerOperator,
        tenantId,
        status: 'active',
        $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }]
      }).lean();
      if (!ownerOperatorDoc) {
        return res.status(400).json({ status: false, message: 'Selected owner operator is inactive or not found' });
      }
    }
    const truck = await Truck.create({
      tenantId,
      company: req.user?.company ? req.user.company._id : null,
      plateNumber, truckNumber, unitNumber, make, model, year, vin, capacity, notes,
      insuranceMonthly: Number(insuranceMonthly || 0),
      parkingMonthly: Number(parkingMonthly || 0),
      ownerOperated: isOwnerOperated,
      ownerOperator: isOwnerOperated ? ownerOperatorDoc?._id : null,
      ownerOperatorAssignedAt: isOwnerOperated ? new Date() : null,
      createdBy: req.user?._id
    });
    logActivity(req, {
      action: 'CREATE',
      module: 'fleet',
      description: `Added truck "${truck.unitNumber || truck.plateNumber}"`,
      resourceId: truck._id,
      resourceName: truck.unitNumber || truck.plateNumber,
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
    const trucks = await Truck.find(filter)
      .populate('ownerOperator', 'fullName ownerOperatorId status')
      .sort({ createdAt: -1 })
      .lean();
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
    logActivity(req, {
      action: 'DELETE',
      module: 'fleet',
      description: `Removed truck "${updated.unitNumber || updated.plateNumber}"`,
      resourceId: updated._id,
      resourceName: updated.unitNumber || updated.plateNumber,
    });
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
    const updateData = { ...req.body };
    const isOwnerOperated = updateData.ownerOperated === true || updateData.ownerOperated === 'true' || updateData.ownerOperated === 1 || updateData.ownerOperated === '1';
    if ('ownerOperated' in updateData) {
      updateData.ownerOperated = isOwnerOperated;
      if (!isOwnerOperated) {
        updateData.ownerOperator = null;
        updateData.ownerOperatorAssignedAt = null;
      } else {
        if (!updateData.ownerOperator) {
          return res.status(400).json({ status: false, message: 'Owner operator is required for owner operated truck' });
        }
        const ownerOperatorDoc = await OwnerOperator.findOne({
          _id: updateData.ownerOperator,
          tenantId,
          status: 'active',
          $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }]
        }).lean();
        if (!ownerOperatorDoc) {
          return res.status(400).json({ status: false, message: 'Selected owner operator is inactive or not found' });
        }
        updateData.ownerOperatorAssignedAt = new Date();
      }
    }
    const truck = await Truck.findOneAndUpdate({ _id: id, tenantId }, updateData, { new: true }).populate(
      'ownerOperator',
      'fullName ownerOperatorId status'
    );
    logActivity(req, {
      action: 'UPDATE',
      module: 'fleet',
      description: `Updated truck "${truck?.unitNumber || truck?.plateNumber}"`,
      resourceId: truck?._id,
      resourceName: truck?.unitNumber || truck?.plateNumber,
    });
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

    const truck = await Truck.findOne(filter).populate('ownerOperator', 'fullName ownerOperatorId status').lean();
    if (!truck) return res.status(404).json({ status: false, message: 'Truck not found' });
    res.json({ status: true, truck });
  } catch (err) {
    JSONerror(res, err, next);
    logger(err);
  }
});
