const express = require('express');
const multer = require('multer');
const os = require('os');
const { validateToken } = require('../controllers/multiTenantAuthController');
const { resolveTenant } = require('../middleware/tenant');
const { requireModuleAccess } = require('../middlewares/planModulesMiddleware');
const ownerOperatorController = require('../controllers/ownerOperatorController');
const fileupload = require('../utils/fileupload');
const FleetDoc = require('../db/FleetDoc');

const router = express.Router();
const upload = multer({ dest: os.tmpdir() + '/uploads' });

router
  .route('/owner-operators/listings')
  .get(validateToken, resolveTenant, requireModuleAccess('regular'), ownerOperatorController.ownerOperatorListings);
router
  .route('/owner-operators/active')
  .get(validateToken, resolveTenant, requireModuleAccess('regular'), ownerOperatorController.activeOwnerOperators);
router
  .route('/owner-operators/detail/:id')
  .get(validateToken, resolveTenant, requireModuleAccess('regular'), ownerOperatorController.ownerOperatorDetail);
router
  .route('/owner-operators/add')
  .post(validateToken, resolveTenant, requireModuleAccess('regular'), ownerOperatorController.addOwnerOperator);
router
  .route('/owner-operators/update/:id')
  .post(validateToken, resolveTenant, requireModuleAccess('regular'), ownerOperatorController.updateOwnerOperator);
router
  .route('/owner-operators/remove/:id')
  .get(validateToken, resolveTenant, requireModuleAccess('regular'), ownerOperatorController.removeOwnerOperator);

router
  .route('/owner-operators/salary/generate')
  .post(validateToken, resolveTenant, requireModuleAccess('regular'), ownerOperatorController.generateMonthlySalary);
router
  .route('/owner-operators/salary/listings')
  .get(validateToken, resolveTenant, requireModuleAccess('regular'), ownerOperatorController.salaryListings);
router
  .route('/owner-operators/salary/detail/:id')
  .get(validateToken, resolveTenant, requireModuleAccess('regular'), ownerOperatorController.salaryDetail);
router
  .route('/owner-operators/salary/pdf/:id')
  .get(validateToken, resolveTenant, requireModuleAccess('regular'), ownerOperatorController.salaryStatementPdf);
router
  .route('/owner-operators/salary/remove/:id')
  .get(validateToken, resolveTenant, requireModuleAccess('regular'), ownerOperatorController.removeSalarySlip);
router
  .route('/owner-operators/salary/pay/:id')
  .post(validateToken, resolveTenant, requireModuleAccess('regular'), ownerOperatorController.updateSalaryPayment);
router
  .route('/owner-operators/salary/adjust/:id')
  .post(validateToken, resolveTenant, requireModuleAccess('regular'), ownerOperatorController.updateSalaryAdjustments);
router
  .route('/owner-operators/salary/expense/:id')
  .post(validateToken, resolveTenant, requireModuleAccess('regular'), ownerOperatorController.addSalaryExpense);
router
  .route('/owner-operators/salary/expense/update/:id')
  .post(validateToken, resolveTenant, requireModuleAccess('regular'), ownerOperatorController.updateSalaryExpense);
router
  .route('/owner-operators/salary/expense/remove/:id')
  .post(validateToken, resolveTenant, requireModuleAccess('regular'), ownerOperatorController.removeSalaryExpense);

router
  .route('/owner-operators/financial/:ownerOperatorId')
  .get(validateToken, resolveTenant, requireModuleAccess('regular'), ownerOperatorController.ownerFinancialSummary);
router
  .route('/owner-operators/reports/overview')
  .get(validateToken, resolveTenant, requireModuleAccess('regular'), ownerOperatorController.reportingOverview);
router
  .route('/owner-operators/reports/breakdown')
  .get(validateToken, resolveTenant, requireModuleAccess('regular'), ownerOperatorController.reportingOwnerBreakdown);
router
  .route('/owner-operators/fx-rates')
  .get(validateToken, resolveTenant, requireModuleAccess('regular'), ownerOperatorController.getMonthlyFxRates)
  .post(validateToken, resolveTenant, requireModuleAccess('regular'), ownerOperatorController.saveMonthlyFxRates);
router
  .route('/owner-operators/fx-rates/auto')
  .post(validateToken, resolveTenant, requireModuleAccess('regular'), ownerOperatorController.autoSyncMonthlyFxRates);

router.post(
  '/upload/owner-operator/doc/:id',
  validateToken,
  resolveTenant,
  requireModuleAccess('regular'),
  upload.fields([{ name: 'attachment' }]),
  async (req, res) => {
    try {
      const entityId = req.params.id;
      const attachment = req.files?.attachment?.[0];
      if (!attachment) return res.status(400).json({ status: false, message: 'No file uploaded' });
      const uploadResponse = await fileupload(attachment);
      const file = await FleetDoc.create({
        tenantId: req.tenantId,
        type: 'owner_operator',
        entityId,
        name: uploadResponse.file.originalname,
        mime: uploadResponse.mime,
        filename: uploadResponse.filename,
        url: uploadResponse.url,
        size: uploadResponse.size,
        added_by: req.user._id,
      });
      return res.status(201).json({ status: true, message: 'Document uploaded successfully', file_data: file });
    } catch (error) {
      return res.status(500).json({ status: false, message: 'An error occurred during file upload', error });
    }
  }
);

module.exports = router;
