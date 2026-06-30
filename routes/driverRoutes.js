const express = require('express');
const router = express.Router();
const { validateToken } = require('../controllers/multiTenantAuthController');
const { resolveTenant } = require('../middleware/tenant');
const driverController = require('../controllers/driverController');
const driverDeductionController = require('../controllers/driverDeductionController');
const driverSalaryController = require('../controllers/driverSalaryController');

router.route('/driver/add').post(validateToken, resolveTenant, driverController.addDriver);
router.route('/driver/edit/:id').post(validateToken, resolveTenant, driverController.editDriver);
router.route('/driver/listings').get(validateToken, resolveTenant, driverController.driversLists);
router.route('/driver/remove/:id').get(validateToken, resolveTenant, driverController.removeDriver);

// Driver deductions / city hours / bonuses (saved to DB)
router.route('/driver/:driverId/deductions').get(validateToken, resolveTenant, driverDeductionController.getDeductions);
router.route('/driver/:driverId/deduction').post(validateToken, resolveTenant, driverDeductionController.addDeduction);
router.route('/driver/:driverId/deduction/:deductionId').put(validateToken, resolveTenant, driverDeductionController.updateDeduction);
router.route('/driver/:driverId/deduction/:deductionId').delete(validateToken, resolveTenant, driverDeductionController.deleteDeduction);

// Driver monthly salary (parity with owner-operator salary): generate / view / history / adjust / pdf
router.route('/driver/:driverId/salary/generate').post(validateToken, resolveTenant, driverSalaryController.generateDriverSalary);
router.route('/driver/:driverId/salary/history').get(validateToken, resolveTenant, driverSalaryController.getDriverSalaryHistory);
router.route('/driver/:driverId/salary/pdf').get(validateToken, resolveTenant, driverSalaryController.getDriverSalaryPdf);
router.route('/driver/:driverId/salary/:salaryId').put(validateToken, resolveTenant, driverSalaryController.updateDriverSalary);
router.route('/driver/:driverId/salary').get(validateToken, resolveTenant, driverSalaryController.getDriverSalary);

module.exports = router;
