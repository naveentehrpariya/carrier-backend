const express = require('express');
const multer = require('multer');
const { rateLimit } = require('express-rate-limit');
const { validateToken } = require('../controllers/multiTenantAuthController');
const { resolveTenant } = require('../middleware/tenant');
const ctrl = require('../controllers/carrierOnboardingController');

const router = express.Router();

const upload = multer({
  dest: require('os').tmpdir() + '/uploads',
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
});
// multer's own errors (file too large) must answer 400, not fall into the 500 handler.
const uploadOne = (req, res, next) => upload.single('file')(req, res, (err) => {
  if (!err) return next();
  const tooBig = err.code === 'LIMIT_FILE_SIZE';
  return res.status(400).json({ status: false, code: tooBig ? 'file_too_large' : 'upload_error', message: tooBig ? 'Files must be 10 MB or smaller.' : 'The file could not be read.' });
});

// Public routes have no login, so they are throttled. The app sits behind nginx
// without `trust proxy`, so req.ip is the proxy for everyone — key on the
// forwarded client address plus the token instead.
const clientKey = (req) => `${String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim()}|${req.params.token || ''}`;
const limiter = (limit, windowMinutes) => rateLimit({
  windowMs: windowMinutes * 60 * 1000,
  limit,
  keyGenerator: clientKey,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  validate: false,
  message: { status: false, code: 'rate_limited', message: 'Too many requests — please wait a few minutes and try again.' },
});

// ---- public (the carrier) ----
router.get('/public/carrier-onboarding/:token', limiter(120, 15), ctrl.publicGet);
router.post('/public/carrier-onboarding/:token/draft', limiter(240, 15), ctrl.publicSaveDraft);
router.post('/public/carrier-onboarding/:token/files', limiter(60, 15), uploadOne, ctrl.publicUploadFile);
router.post('/public/carrier-onboarding/:token/files/remove/:fileId', limiter(60, 15), ctrl.publicRemoveFile);
router.post('/public/carrier-onboarding/:token/preview', limiter(60, 15), ctrl.publicPreview);
router.post('/public/carrier-onboarding/:token/submit', limiter(10, 15), ctrl.publicSubmit);

// ---- dashboard ----
router.get('/carrier-onboarding', validateToken, resolveTenant, ctrl.listLinks);
router.post('/carrier-onboarding/links', validateToken, resolveTenant, ctrl.createLink);
router.post('/carrier-onboarding/revoke/:id', validateToken, resolveTenant, ctrl.revokeLink);
router.post('/carrier-onboarding/:id/approve', validateToken, resolveTenant, ctrl.approvePacket);
router.post('/carrier-onboarding/:id/reject', validateToken, resolveTenant, ctrl.rejectPacket);
router.post('/carrier-onboarding/:id/resend-email', validateToken, resolveTenant, ctrl.resendEmail);
router.get('/carrier-onboarding/:id/pdf', validateToken, resolveTenant, ctrl.linkPdf);
router.get('/carrier-onboarding/:id', validateToken, resolveTenant, ctrl.linkDetail);

module.exports = router;
