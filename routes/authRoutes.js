const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const { validateToken: legacyValidateToken } = require('../controllers/authController');
const { validateToken } = require('../controllers/multiTenantAuthController');
const { resolveTenant } = require('../middleware/tenant');
const multer = require('multer');
const os = require('os');
const path = require('path');

const uploadDir = path.join(os.tmpdir(), 'uploads');
const multerParse = multer({ dest: uploadDir });

router.route('/create_user').post(validateToken, authController.signup);
router.route('/edit_user/:id').post(validateToken, authController.editUser);
router.route('/suspanduser/:id').get(validateToken, authController.suspandUser);
router.route('/login').post(authController.login);
router.route('/multitenant-login').post(authController.multiTenantLogin);
router.route('/debug-test').get(authController.debugTest);
router.route('/test-super-admin-login').post(authController.testSuperAdminLogin);
router.route('/forgotpassword').post(authController.forgotPassword); 
router.route('/resetpassword/:token').patch(authController.resetpassword); 
router.route('/profile').get(validateToken, resolveTenant, authController.profile);
router.route('/employeesLisiting').get(validateToken, resolveTenant, authController.employeesLisiting);
router.route('/employee/detail/:id').get(validateToken, authController.employeeDetail);
router.route('/employee/docs/:id').get(validateToken, authController.employeesDocs);
router.route('/add-company-information').post(validateToken, resolveTenant, authController.addCompanyInfo);
router.post('/company/logo', validateToken, resolveTenant, multerParse.fields([{ name: 'attachment' }]), authController.uploadCompanyLogo);
router.route('/change-password').post(validateToken, authController.changePassword);
router.route('/logout').get(validateToken, authController.logout);

module.exports = router;
