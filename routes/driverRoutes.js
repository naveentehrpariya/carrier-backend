const express = require('express');
const router = express.Router();
const { validateToken } = require('../controllers/multiTenantAuthController');
const { resolveTenant } = require('../middleware/tenant');
const driverController = require('../controllers/driverController');
const driverDeductionController = require('../controllers/driverDeductionController');

router.route('/driver/add').post(validateToken, resolveTenant, driverController.addDriver);
router.route('/driver/edit/:id').post(validateToken, resolveTenant, driverController.editDriver);
router.route('/driver/listings').get(validateToken, resolveTenant, driverController.driversLists);
router.route('/driver/remove/:id').get(validateToken, resolveTenant, driverController.removeDriver);

// Driver deductions / city hours / bonuses (saved to DB)
router.route('/driver/:driverId/deductions').get(validateToken, resolveTenant, driverDeductionController.getDeductions);
router.route('/driver/:driverId/deduction').post(validateToken, resolveTenant, driverDeductionController.addDeduction);
router.route('/driver/:driverId/deduction/:deductionId').put(validateToken, resolveTenant, driverDeductionController.updateDeduction);
router.route('/driver/:driverId/deduction/:deductionId').delete(validateToken, resolveTenant, driverDeductionController.deleteDeduction);

module.exports = router;
