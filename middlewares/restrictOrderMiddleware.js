const Order = require('../db/Order');
const catchAsync = require('../utils/catchAsync');

const restrictOrderMiddleware = catchAsync(async (req, res, next) => {
   // `Order.tenantId` is the String slug, not the Tenant document's ObjectId — falling back to
   // `req.tenant._id` matched nothing and every update came back as a bogus "Order not found".
   const tenantId = req.tenantId || (req.tenant && req.tenant.tenantId) || req.user?.tenantId;
   if (!tenantId) {
      return res.status(400).json({ status: false, message: 'Tenant context is required.' });
   }

   const order = await Order.findOne({ _id: req.params.id, tenantId });

   if (!order) {
      return res.status(404).json({ status: false, message: 'Order not found.' });
   }

   if (order.lock) {
      return res.json({
         status: false,
         message: 'This order is locked and can not be modified.',
      });
   }

   next();
});
module.exports = restrictOrderMiddleware;