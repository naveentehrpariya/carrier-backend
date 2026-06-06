const Trailer = require('../db/Trailer');
const FleetDoc = require('../db/FleetDoc');
const catchAsync = require('../utils/catchAsync');
const JSONerror = require('../utils/jsonErrorHandler');
const logger = require('../utils/logger');
const { logActivity } = require('../utils/activityLogger');

exports.addTrailer = catchAsync(async (req, res, next) => {
  try {
    const tenantId = req.tenantId || req.user?.tenantId;
    if (!tenantId) return res.status(400).json({ status: false, message: 'Tenant context is required' });
    const { plateNumber, unitNumber, vin, licenseNumber, type, length, make, model, notes, ratePerMile } = req.body;
    if (!plateNumber) return res.status(400).json({ status: false, message: 'Plate number is required' });
    const exists = await Trailer.findOne({ tenantId, plateNumber });
    if (exists) return res.status(400).json({ status: false, message: 'Trailer with this plate already exists' });
    const trailer = await Trailer.create({
      tenantId,
      company: req.user?.company ? req.user.company._id : null,
      plateNumber, unitNumber, vin, licenseNumber, type, length, make, model, notes,
      ratePerMile: Number(ratePerMile) || 0,
      createdBy: req.user?._id
    });
    logActivity(req, {
      action: 'CREATE',
      module: 'fleet',
      description: `Added trailer "${trailer.unitNumber || trailer.plateNumber}"`,
      resourceId: trailer._id,
      resourceName: trailer.unitNumber || trailer.plateNumber,
    });
    res.status(201).json({ status: true, message: 'Trailer added', trailer });
  } catch (err) {
    JSONerror(res, err, next);
    logger(err);
  }
});

exports.trailers_listing = catchAsync(async (req, res, next) => {
  try {
    const tenantId = req.tenantId || req.user?.tenantId;
    const companyId = req.user?.company ? req.user.company._id : null;
    const filter = { tenantId };
    if (companyId) {
      filter.company = companyId;
    }
    if (req.query.active === 'true') {
      filter.isActive = true;
    }
    filter.$or = [{ deletedAt: null }, { deletedAt: { $exists: false } }];
    const trailers = await Trailer.find(filter).sort({ createdAt: -1 });
    res.json({ status: true, lists: trailers, totalDocuments: trailers.length });
  } catch (err) {
    JSONerror(res, err, next);
    logger(err);
  }
});

exports.removeTrailer = catchAsync(async (req, res, next) => {
  try {
    const tenantId = req.tenantId || req.user?.tenantId;
    const companyId = req.user?.company ? req.user.company._id : null;
    const id = req.params.id;
    const filter = { _id: id, tenantId };
    if (companyId) {
      filter.company = companyId;
    }
    const updated = await Trailer.findOneAndUpdate(filter, { deletedAt: new Date() }, { new: true });
    if (!updated) {
      return res.status(404).json({ status: false, message: 'Trailer not found' });
    }
    logActivity(req, {
      action: 'DELETE',
      module: 'fleet',
      description: `Removed trailer "${updated.unitNumber || updated.plateNumber}"`,
      resourceId: updated._id,
      resourceName: updated.unitNumber || updated.plateNumber,
    });
    res.json({ status: true, message: 'Trailer removed (soft delete)', trailer: updated });
  } catch (err) {
    JSONerror(res, err, next);
    logger(err);
  }
});

exports.updateTrailer = catchAsync(async (req, res, next) => {
  try {
    const tenantId = req.tenantId || req.user?.tenantId;
    const id = req.params.id;
    const payload = { ...req.body };
    if (payload.ratePerMile !== undefined) {
      payload.ratePerMile = Number(payload.ratePerMile) || 0;
    }
    const trailer = await Trailer.findOneAndUpdate({ _id: id, tenantId }, payload, { new: true });
    logActivity(req, {
      action: 'UPDATE',
      module: 'fleet',
      description: `Updated trailer "${trailer?.unitNumber || trailer?.plateNumber}"`,
      resourceId: trailer?._id,
      resourceName: trailer?.unitNumber || trailer?.plateNumber,
    });
    res.json({ status: true, message: 'Trailer updated', trailer });
  } catch (err) {
    JSONerror(res, err, next);
    logger(err);
  }
});

exports.trailer_detail = catchAsync(async (req, res, next) => {
  try {
    const tenantId = req.tenantId || req.user?.tenantId;
    if (!tenantId) return res.status(400).json({ status: false, message: 'Tenant context is required' });
    const companyId = req.user?.company ? req.user.company._id : null;
    const id = req.params.id;

    const filter = { _id: id, tenantId, $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }] };
    if (companyId) filter.company = companyId;

    const trailer = await Trailer.findOne(filter).lean();
    if (!trailer) return res.status(404).json({ status: false, message: 'Trailer not found' });
    res.json({ status: true, trailer });
  } catch (err) {
    JSONerror(res, err, next);
    logger(err);
  }
});
