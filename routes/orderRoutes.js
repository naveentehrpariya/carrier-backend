const express = require('express');
const router = express.Router();
const { validateToken } = require('../controllers/multiTenantAuthController');
const { resolveTenant, optionalTenant } = require('../middleware/tenant');
const orderController = require('../controllers/orderController');
const tripController = require('../controllers/tripController');
const restrictOrderMiddleware = require('../middlewares/restrictOrderMiddleware');
const { checkOrderLimit } = require('../middlewares/planLimitsMiddleware');
const { checkOrderModuleAccess } = require('../middlewares/planModulesMiddleware');

router.route('/order/add').post(validateToken, resolveTenant, checkOrderLimit(), checkOrderModuleAccess(), orderController.create_order);
router.route('/order/update/:id').put(validateToken, restrictOrderMiddleware, orderController.update_order);
router.route('/order/listings').get(validateToken, orderController.order_listing);
router.route('/order/detail/:id').get(validateToken, orderController.order_detail);
router.route('/order_docs/:id').get(validateToken, orderController.order_docs);
router.route('/lock-order/:id').get(validateToken, orderController.lockOrder);
router.route('/delete-order/:id').get(validateToken, orderController.deleteOrder);
router.route('/account/order/listings').get(validateToken, orderController.order_listing_account);
router.route('/account/order/update/payment/:id/:type').post(validateToken, restrictOrderMiddleware, orderController.updateOrderPaymentStatus);

router.route('/account/order-status/:id').post(validateToken, restrictOrderMiddleware, orderController.updateOrderStatus);
router.route('/account/order/addnote/:id').post(validateToken, restrictOrderMiddleware, orderController.addnote);

router.route('/account/trucks/gross').get(validateToken, resolveTenant, tripController.getTrucksGrossEarnings);
router
  .route('/account/trucks/gross/:truckId')
  .get(validateToken, resolveTenant, tripController.getTruckGrossEarningsDetail);

router.route('/overview').get(validateToken, optionalTenant, orderController.overview);
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
router.route('/payments/listings').get(validateToken, orderController.orderPayments);
router.route('/all_payments_status').get(validateToken, orderController.all_payments_status);

module.exports = router;
