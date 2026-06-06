const express = require('express');
const router = express.Router();
const multer = require('multer');
const { validateToken } = require('../controllers/multiTenantAuthController');
const { resolveTenant } = require('../middleware/tenant');
const fileupload = require('../utils/fileupload');
const FleetDoc = require('../db/FleetDoc');
const truckController = require('../controllers/truckController');
const trailerController = require('../controllers/trailerController');
const truckExpenseController = require('../controllers/truckExpenseController');
const { requireModuleAccess } = require('../middlewares/planModulesMiddleware');

const upload = multer({ dest: require('os').tmpdir() + '/uploads' });

// Trucks
router.route('/fleet/trucks/listings').get(validateToken, resolveTenant, requireModuleAccess('regular'), truckController.trucks_listing);
router.route('/fleet/trucks/detail/:id').get(validateToken, resolveTenant, requireModuleAccess('regular'), truckController.truck_detail);
router.route('/fleet/trucks/add').post(validateToken, resolveTenant, requireModuleAccess('regular'), truckController.addTruck);
router.route('/fleet/trucks/update/:id').post(validateToken, resolveTenant, requireModuleAccess('regular'), truckController.updateTruck);
router.route('/fleet/trucks/remove/:id').get(validateToken, resolveTenant, requireModuleAccess('regular'), truckController.removeTruck);

// Truck Expenses
router.route('/truck/:truckId/expenses').get(validateToken, resolveTenant, truckExpenseController.getExpenses);
router.route('/truck/:truckId/expense').post(validateToken, resolveTenant, truckExpenseController.addExpense);
router.route('/truck/:truckId/expense/:expenseId').put(validateToken, resolveTenant, truckExpenseController.updateExpense);
router.route('/truck/:truckId/expense/:expenseId').delete(validateToken, resolveTenant, truckExpenseController.deleteExpense);
router.route('/truck/:truckId/profit-summary').get(validateToken, resolveTenant, truckExpenseController.getTruckProfitSummary);

// Trailers
router.route('/fleet/trailers/listings').get(validateToken, resolveTenant, requireModuleAccess('regular'), trailerController.trailers_listing);
router.route('/fleet/trailers/detail/:id').get(validateToken, resolveTenant, requireModuleAccess('regular'), trailerController.trailer_detail);
router.route('/fleet/trailers/add').post(validateToken, resolveTenant, requireModuleAccess('regular'), trailerController.addTrailer);
router.route('/fleet/trailers/update/:id').post(validateToken, resolveTenant, requireModuleAccess('regular'), trailerController.updateTrailer);
router.route('/fleet/trailers/remove/:id').get(validateToken, resolveTenant, requireModuleAccess('regular'), trailerController.removeTrailer);

// Upload docs for trucks
router.post('/upload/truck/doc/:id', validateToken, resolveTenant, upload.fields([{ name: 'attachment' }]), async (req, res) => {
  try {
    const entityId = req.params.id;
    const attachment = req.files?.attachment?.[0];
    if (!attachment) return res.status(400).json({ status: false, message: 'No file uploaded' });
    const uploadResponse = await fileupload(attachment);
    const file = await FleetDoc.create({
      tenantId: req.tenantId,
      type: 'truck',
      entityId,
      name: uploadResponse.file.originalname,
      mime: uploadResponse.mime,
      filename: uploadResponse.filename,
      url: uploadResponse.url,
      size: uploadResponse.size,
      added_by: req.user._id
    });
    return res.status(201).json({ status: true, message: 'Document uploaded successfully', file_data: file });
  } catch (error) {
    console.error(error);
    res.status(500).json({ status: false, message: 'An error occurred during file upload', error });
  }
});

// Upload docs for trailers
router.post('/upload/trailer/doc/:id', validateToken, resolveTenant, upload.fields([{ name: 'attachment' }]), async (req, res) => {
  try {
    const entityId = req.params.id;
    const attachment = req.files?.attachment?.[0];
    if (!attachment) return res.status(400).json({ status: false, message: 'No file uploaded' });
    const uploadResponse = await fileupload(attachment);
    const file = await FleetDoc.create({
      tenantId: req.tenantId,
      type: 'trailer',
      entityId,
      name: uploadResponse.file.originalname,
      mime: uploadResponse.mime,
      filename: uploadResponse.filename,
      url: uploadResponse.url,
      size: uploadResponse.size,
      added_by: req.user._id
    });
    return res.status(201).json({ status: true, message: 'Document uploaded successfully', file_data: file });
  } catch (error) {
    console.error(error);
    res.status(500).json({ status: false, message: 'An error occurred during file upload', error });
  }
});

// List docs
router.get('/fleet/docs/:type/:id', validateToken, resolveTenant, async (req, res) => {
  const { type, id } = req.params;
  const docs = await FleetDoc.find({ tenantId: req.tenantId, type, entityId: id }).sort({ createdAt: -1 });
  res.json({ status: true, documents: docs });
});

module.exports = router;
