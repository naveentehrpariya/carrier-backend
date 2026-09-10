const express = require('express');
const router = express.Router();
const { validateToken } = require('../controllers/multiTenantAuthController');
const { resolveTenant } = require('../middleware/tenant');
const vendorController = require('../controllers/vendorController');
const chequeController = require('../controllers/chequeController');
const bankAccountController = require('../controllers/bankAccountController');

// Access gate (admin / role=3 / accounting / subadmin) lives in the controllers.

// Vendors
router.route('/vendors/listings').get(validateToken, resolveTenant, vendorController.vendors_listing);
router.route('/vendors/add').post(validateToken, resolveTenant, vendorController.addVendor);
router.route('/vendors/update/:id').post(validateToken, resolveTenant, vendorController.updateVendor);
router.route('/vendors/remove/:id').get(validateToken, resolveTenant, vendorController.deleteVendor);

// Cheques
router.route('/cheques/payees').get(validateToken, resolveTenant, chequeController.chequePayees);
router.route('/cheques/listings').get(validateToken, resolveTenant, chequeController.listCheques);
router.route('/cheques/counts').get(validateToken, resolveTenant, chequeController.chequeCounts);
router.route('/cheques/add').post(validateToken, resolveTenant, chequeController.createCheque);
router.route('/cheques/update/:id').post(validateToken, resolveTenant, chequeController.updateCheque);
router.route('/cheques/void/:id').post(validateToken, resolveTenant, chequeController.voidCheque);
// Declared before '/cheques/:id/pdf' would ever be reached — a literal path, no conflict.
router.route('/cheques/print-batch').post(validateToken, resolveTenant, chequeController.printChequeBatch);
router.route('/cheques/clear/:id').post(validateToken, resolveTenant, chequeController.markChequeCleared);
router.route('/cheques/bounce/:id').post(validateToken, resolveTenant, chequeController.markChequeBounced);

// Applications — what a cheque paid for. The literal 'applications' path is
// declared before '/cheques/:id/...' so it never binds as an id.
router.route('/cheques/applications/remove/:id').post(validateToken, resolveTenant, chequeController.removeChequeApplication);
router.route('/cheques/:id/applications').get(validateToken, resolveTenant, chequeController.listChequeApplications);
router.route('/cheques/:id/apply-targets').get(validateToken, resolveTenant, chequeController.chequeApplyTargets);
router.route('/cheques/:id/apply').post(validateToken, resolveTenant, chequeController.applyCheque);

// Bank accounts — the cheque books cheques are drawn on.
router.route('/bank-accounts').get(validateToken, resolveTenant, bankAccountController.listBankAccounts);
router.route('/bank-accounts/add').post(validateToken, resolveTenant, bankAccountController.addBankAccount);
router.route('/bank-accounts/update/:id').post(validateToken, resolveTenant, bankAccountController.updateBankAccount);
router.route('/bank-accounts/remove/:id').get(validateToken, resolveTenant, bankAccountController.deleteBankAccount);
// Calibration page, printed on plain paper before any cheque stock is loaded.
router.route('/bank-accounts/:id/alignment-sheet').get(validateToken, resolveTenant, bankAccountController.alignmentSheet);
router.route('/cheques/:id/pdf').get(validateToken, resolveTenant, chequeController.chequePdf);

module.exports = router;
