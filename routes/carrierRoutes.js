const express = require('express');
const router = express.Router();
const { validateToken } = require('../controllers/multiTenantAuthController');
const { resolveTenant } = require('../middleware/tenant');
const carrierController = require('../controllers/carrierController');
const { checkCarrierLimit } = require('../middlewares/planLimitsMiddleware');
const { requireModuleAccess } = require('../middlewares/planModulesMiddleware');

router.route('/carriers/listings').get(validateToken, resolveTenant, requireModuleAccess('outsourcing'), carrierController.carriers_listing);
router.route('/carriers/add').post(validateToken, resolveTenant, requireModuleAccess('outsourcing'), checkCarrierLimit(), carrierController.addCarrier);
router.route('/carriers/remove/:id').get(validateToken, resolveTenant, requireModuleAccess('outsourcing'), carrierController.deleteCarrier);
router.route('/carriers/update/:id').post(validateToken, resolveTenant, requireModuleAccess('outsourcing'), carrierController.updateCarrier);
router.route('/carrier/detail/:id').get(validateToken, resolveTenant, requireModuleAccess('outsourcing'), carrierController.carrierDetail);
router.route('/getdistance').post(carrierController.getDistance);


module.exports = router;
