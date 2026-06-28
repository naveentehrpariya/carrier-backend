const express = require('express');
const router = express.Router();
const { validateToken } = require('../controllers/multiTenantAuthController');
const { resolveTenant, optionalTenant } = require('../middleware/tenant');
const orderController = require('../controllers/orderController');
const tripController = require('../controllers/tripController');
const restrictOrderMiddleware = require('../middlewares/restrictOrderMiddleware');
const { checkOrderLimit } = require('../middlewares/planLimitsMiddleware');
const { checkOrderModuleAccess, resolveAllowedModulesMiddleware, requireActiveSubscription } = require('../middlewares/planModulesMiddleware');
const catchAsync = require('../utils/catchAsync');
const Tenant = require('../db/Tenant');
const Order = require('../db/Order');
const SubscriptionPlan = require('../db/SubscriptionPlan');
const { isSubscriptionActive, effectiveStatus, currentOrderPeriod } = require('../utils/subscription');

// Subscription status for ANY tenant user — drives the in-app billing + order-limit banners.
// Resolved by the authoritative token tenantId (root-mounted so the frontend hits /subscription/status).
router.get('/subscription/status', validateToken, catchAsync(async (req, res) => {
  const tenant = await Tenant.findOne({ tenantId: req.tenantId }).lean();

  let maxOrders = tenant?.subscription?.planLimits?.maxOrders;
  const planRef = tenant?.subscription?.plan;
  if (planRef) {
    try {
      const plan = typeof planRef === 'string'
        ? await SubscriptionPlan.findOne({ slug: planRef }).lean()
        : await SubscriptionPlan.findById(planRef).lean();
      if (plan?.limits?.maxOrders != null) maxOrders = plan.limits.maxOrders;
    } catch (_) { /* fall back to snapshot */ }
  }
  maxOrders = Number(maxOrders) || 0;

  const { start, end } = currentOrderPeriod(tenant);
  const used = await Order.countDocuments({
    tenantId: req.tenantId,
    $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
    createdAt: { $gte: start, $lt: end }
  });
  const unlimited = maxOrders === 0;

  res.json({
    status: true,
    data: {
      active: isSubscriptionActive(tenant),
      subStatus: effectiveStatus(tenant),
      endDate: tenant?.subscription?.endDate || null,
      orders: {
        used,
        limit: maxOrders,
        remaining: unlimited ? null : Math.max(0, maxOrders - used),
        unlimited,
        exceeded: !unlimited && used >= maxOrders,
        periodStart: start,
        resetDate: end
      }
    }
  });
}));

router.route('/order/add').post(validateToken, resolveTenant, requireActiveSubscription, checkOrderLimit(), checkOrderModuleAccess(), orderController.create_order);
router.route('/order/update/:id').put(validateToken, optionalTenant, resolveAllowedModulesMiddleware, restrictOrderMiddleware, orderController.update_order);
router.route('/order/listings').get(validateToken, optionalTenant, resolveAllowedModulesMiddleware, orderController.order_listing);
router.route('/order/detail/:id').get(validateToken, optionalTenant, resolveAllowedModulesMiddleware, orderController.order_detail);
router.route('/order/generate-pdf').post(validateToken, optionalTenant, orderController.generatePdfFromHtml);
router.route('/order_docs/:id').get(validateToken, optionalTenant, resolveAllowedModulesMiddleware, orderController.order_docs);
router.route('/lock-order/:id').get(validateToken, optionalTenant, resolveAllowedModulesMiddleware, orderController.lockOrder);
router.route('/delete-order/:id').get(validateToken, optionalTenant, resolveAllowedModulesMiddleware, orderController.deleteOrder);
router.route('/account/order/listings').get(validateToken, optionalTenant, resolveAllowedModulesMiddleware, orderController.order_listing_account);
router.route('/account/order/update/payment/:id/:type').post(validateToken, optionalTenant, resolveAllowedModulesMiddleware, restrictOrderMiddleware, orderController.updateOrderPaymentStatus);

router.route('/account/order-status/:id').post(validateToken, optionalTenant, resolveAllowedModulesMiddleware, restrictOrderMiddleware, orderController.updateOrderStatus);
router.route('/account/order/addnote/:id').post(validateToken, optionalTenant, resolveAllowedModulesMiddleware, restrictOrderMiddleware, orderController.addnote);

router.route('/account/trucks/gross').get(validateToken, resolveTenant, tripController.getTrucksGrossEarnings);
router
  .route('/account/trucks/gross/:truckId')
  .get(validateToken, resolveTenant, tripController.getTruckGrossEarningsDetail);

router.route('/overview').get(validateToken, optionalTenant, resolveAllowedModulesMiddleware, orderController.overview);
router.route('/fx/rate').get(validateToken, optionalTenant, orderController.getFxRate);
router.route('/cummodityLists').get(validateToken, optionalTenant, orderController.cummodityLists);
router.route('/removeCummodity').post(validateToken, optionalTenant, orderController.removeCummodity);
router.route('/addCummodity').post(validateToken, optionalTenant, orderController.addCummodity);

router.route('/equipmentLists').get(validateToken, optionalTenant, orderController.equipmentLists);
router.route('/removeEquipment').post(validateToken, optionalTenant, orderController.removeEquipment);
router.route('/addEquipment').post(validateToken, optionalTenant, orderController.addEquipment);

router.route('/chargesLists').get(validateToken, orderController.chargesLists);
router.route('/removeCharge').post(validateToken, orderController.removeCharge);
router.route('/addCharge').post(validateToken, orderController.addCharges);

// Payments
router.route('/payments/listings').get(validateToken, optionalTenant, resolveAllowedModulesMiddleware, orderController.orderPayments);
router.route('/all_payments_status').get(validateToken, optionalTenant, resolveAllowedModulesMiddleware, orderController.all_payments_status);

module.exports = router;
