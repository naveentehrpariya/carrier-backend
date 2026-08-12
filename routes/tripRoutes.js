const express = require('express');
const router = express.Router();
const { validateToken } = require('../controllers/multiTenantAuthController');
const { resolveTenant } = require('../middleware/tenant');
const tripController = require('../controllers/tripController');
const { requireTripWriteAccess } = require('../middlewares/tripAccessMiddleware');

router.route('/order/split').post(validateToken, resolveTenant, requireTripWriteAccess, tripController.splitOrder);
router.route('/order/trips/:orderId').get(validateToken, resolveTenant, tripController.getOrderTrips);
router.route('/trip/update/:tripId').put(validateToken, resolveTenant, requireTripWriteAccess, tripController.updateTrip);
router.route('/driver/:driverId/trips').get(validateToken, resolveTenant, tripController.getDriverTrips);
router.route('/driver/:driverId/trips/logs').get(validateToken, resolveTenant, tripController.getDriverTripLogs);
router.route('/driver/:driverId/trips/summary').get(validateToken, resolveTenant, tripController.getDriverTripSummary);
router.route('/truck/:truckId/trips/summary').get(validateToken, resolveTenant, tripController.getTruckTripSummary);
router.route('/truck/:truckId/trips/logs').get(validateToken, resolveTenant, tripController.getTruckTripLogs);
router.route('/empty-moves/ignore').post(validateToken, resolveTenant, requireTripWriteAccess, tripController.ignoreEmptyMove);
router.route('/empty-moves/note').post(validateToken, resolveTenant, requireTripWriteAccess, tripController.saveEmptyMoveNote);
router.route('/trip/:tripId').delete(validateToken, resolveTenant, requireTripWriteAccess, tripController.deleteTrip);

module.exports = router;
