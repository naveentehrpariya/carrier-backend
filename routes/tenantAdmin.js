const express = require('express');
const router = express.Router();
const {
  getTenantInfo,
  getSubscriptionDetails,
  updateTenantSettings,
  getTenantUsage,
  getTenantAnalytics,
  getBillingInfo,
  upgradePlan,
  getTenantUsers,
  inviteUser,
  updateUserModules,
  updateUserRole,
  removeUser,
  getIntegrations,
  configureIntegration,
  removeIntegration,
  getOrdersReport,
  getCustomersReport,
  getCarriersReport,
  getFinancialReport,
  exportData,
  getFinanceReport,
  getFinanceReportPdf
} = require('../controllers/tenantAdminController');

const {
  getActivityLogs,
  getActivitySummary,
  getLogUsers,
} = require('../controllers/activityLogController');

const { validateToken } = require('../controllers/multiTenantAuthController');
const { resolveTenant } = require('../middleware/tenant');

// Apply middleware to all tenant admin routes (emulation-aware)
router.use(validateToken);
router.use(resolveTenant);

// Tenant Information Routes
router.get('/info', getTenantInfo);
router.get('/subscription', getSubscriptionDetails);
router.put('/settings', updateTenantSettings);
router.get('/usage', getTenantUsage);
router.get('/analytics', getTenantAnalytics);

// Billing & Subscription Routes
router.get('/billing', getBillingInfo);
router.post('/billing/upgrade', upgradePlan);

// User Management Routes
router.get('/users', getTenantUsers);
router.post('/users/invite', inviteUser);
router.patch('/users/:id/modules', updateUserModules);
router.put('/users/:id/role', updateUserRole);
router.delete('/users/:id', removeUser);

// Integration Management Routes
router.get('/integrations', getIntegrations);
router.post('/integrations', configureIntegration);
router.delete('/integrations/:id', removeIntegration);

// Activity Logs Routes
router.get('/activity-logs', getActivityLogs);
router.get('/activity-logs/summary', getActivitySummary);
router.get('/activity-logs/users', getLogUsers);

// Reports Routes
router.get('/reports/orders', getOrdersReport);
router.get('/reports/customers', getCustomersReport);
router.get('/reports/carriers', getCarriersReport);
router.get('/reports/financial', getFinancialReport);
router.post('/export', exportData);

// Finance Report Routes
router.get('/finance/report', getFinanceReport);
router.get('/finance/report/pdf', getFinanceReportPdf);

module.exports = router;
