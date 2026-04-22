const Order = require('../db/Order');
const catchAsync = require('../utils/catchAsync');

const restrictOrderMiddleware = catchAsync(async (req, res, next) => {
   const tenantId = req.tenantId || (req.tenant && req.tenant._id);
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