const mongoose = require('mongoose');
const Order = require('../db/Order');
const Trip = require('../db/Trip');
const catchAsync = require('../utils/catchAsync');

// Trip planning is a money write, not a scheduling detail: the truck on a leg decides which owner
// operator gets settled for it, and the drivers on a leg decide what payroll owes. These routes
// used to run on `validateToken + resolveTenant` alone, so any authenticated tenant user — a
// driver, an accountant, plain staff — could re-split a load, rewrite its settlement amounts and
// delete legs. They also skipped the order lock that every other order mutation honours.
const TRIP_WRITE_PERMISSIONS = ['regular', 'outsourcing', 'subadmin'];

const canPlanTrips = (user) => {
  if (!user) return false;
  if (Number(user.is_admin) === 1 || Number(user.role) === 3 || user.isTenantAdmin === true) return true;
  const perms = Array.isArray(user.permissions) ? user.permissions : [];
  return TRIP_WRITE_PERMISSIONS.some((p) => perms.includes(p));
};

const requireTripWriteAccess = catchAsync(async (req, res, next) => {
  const tenantId = req.tenantId || req.user?.tenantId;
  if (!tenantId) {
    return res.status(400).json({ status: false, message: 'Tenant context is required.' });
  }
  if (!canPlanTrips(req.user)) {
    return res.status(403).json({ status: false, message: 'You are not allowed to plan or edit trips.' });
  }

  // The order this write lands on. When a trip is named in the URL, that trip's own order is the
  // authority — reading it from the body instead would let a caller point the lock check at some
  // other, unlocked order while editing a leg of a locked one.
  let orderId = null;
  if (req.params?.tripId) {
    if (!mongoose.isValidObjectId(req.params.tripId)) {
      return res.status(400).json({ status: false, message: 'Invalid trip id.' });
    }
    const trip = await Trip.findOne({ _id: req.params.tripId, tenantId }).select('order').lean();
    if (!trip) {
      return res.status(404).json({ status: false, message: 'Trip not found.' });
    }
    orderId = trip.order;
  } else {
    orderId = req.body?.orderId || req.body?.order || null;
  }
  // Empty-move notes carry no order — permission alone is the gate there.
  if (!orderId) return next();

  if (!mongoose.isValidObjectId(orderId)) {
    return res.status(400).json({ status: false, message: 'Invalid order id.' });
  }
  const order = await Order.findOne({ _id: orderId, tenantId }).select('lock').lean();
  if (!order) {
    return res.status(404).json({ status: false, message: 'Order not found.' });
  }
  if (order.lock) {
    return res.status(403).json({ status: false, message: 'This order is locked and can not be modified.' });
  }
  req.tripOrderId = String(orderId);
  next();
});

module.exports = { requireTripWriteAccess, canPlanTrips };
