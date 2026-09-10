const express = require('express');
const multer = require('multer');
const router = express.Router();
const { validateToken } = require('../controllers/multiTenantAuthController');
const { resolveTenant } = require('../middleware/tenant');
const fuel = require('../controllers/fuelPriceController');

// Vendor sheets arrive as PDF or XLSX; the parser decides what it actually is.
const upload = multer({ dest: require('os').tmpdir() + '/uploads', limits: { fileSize: 25 * 1024 * 1024 } });

// Access gate (admin / role=3 / isTenantAdmin / accounting / subadmin) lives in the controller.

router.route('/fuel/vendors').get(validateToken, resolveTenant, fuel.fuelVendors);

// Sheets. The literal paths are declared before '/fuel/sheets/:id' so they never bind as an id.
router.route('/fuel/sheets').get(validateToken, resolveTenant, fuel.listFuelSheets);
router.route('/fuel/sheets/upload').post(
  validateToken, resolveTenant,
  upload.fields([{ name: 'attachment' }, { name: 'file' }]),
  fuel.uploadFuelSheet,
);
router.route('/fuel/sheets/:id').get(validateToken, resolveTenant, fuel.fuelSheetDetail);
router.route('/fuel/sheets/remove/:id').get(validateToken, resolveTenant, fuel.removeFuelSheet);

// Pricing. Preview writes nothing; publish snapshots.
router.route('/fuel/sheets/:id/preview').post(validateToken, resolveTenant, fuel.previewFuelSheet);
router.route('/fuel/sheets/:id/preview/pdf').post(validateToken, resolveTenant, fuel.previewFuelSheetPdf);
router.route('/fuel/sheets/:id/publish').post(validateToken, resolveTenant, fuel.publishFuelSheet);
router.route('/fuel/sheets/:id/publish-batch').post(validateToken, resolveTenant, fuel.publishFuelSheetBatch);
router.route('/fuel/sheets/:id/date').post(validateToken, resolveTenant, fuel.setFuelSheetDate);
router.route('/fuel/sheets/:id/mapping').post(validateToken, resolveTenant, fuel.setFuelSheetMapping);

// Margin profiles
router.route('/fuel/profiles').get(validateToken, resolveTenant, fuel.listMarginProfiles);
router.route('/fuel/profiles/add').post(validateToken, resolveTenant, fuel.addMarginProfile);
router.route('/fuel/profiles/update/:id').post(validateToken, resolveTenant, fuel.updateMarginProfile);
router.route('/fuel/profiles/remove/:id').get(validateToken, resolveTenant, fuel.removeMarginProfile);

// Published sheets
router.route('/fuel/outputs').get(validateToken, resolveTenant, fuel.listFuelOutputs);
router.route('/fuel/outputs/:id').get(validateToken, resolveTenant, fuel.fuelOutputDetail);
router.route('/fuel/outputs/:id/pdf').get(validateToken, resolveTenant, fuel.fuelOutputPdf);
router.route('/fuel/outputs/:id/csv').get(validateToken, resolveTenant, fuel.fuelOutputCsv);

module.exports = router;
