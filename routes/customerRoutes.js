const express = require('express');
const router = express.Router();
const { validateToken } = require('../controllers/multiTenantAuthController');
const { resolveTenant } = require('../middleware/tenant');
const customerController = require('../controllers/customerController');

router.route('/customer/listings').get(validateToken, customerController.customers_listing);
router.route('/customer/add').post(validateToken, resolveTenant, customerController.addCustomer);
router.route('/customer/update/:id').post(validateToken, customerController.updateCustomer);
router.route('/customer/detail/:id').get(validateToken, customerController.customerDetails);
router.route('/customer/remove/:id').get(validateToken, customerController.deleteCustomer);

module.exports = router;