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
  getPlansCatalog,
  checkoutSubscription,
  getSubscriptionHistory,
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
  getResourceHistory,
  verifyActivityChain,
  exportActivityLogs,
} = require('../controllers/activityLogController');

const { validateToken, emulateEmployee, stopEmployeeEmulation } = require('../controllers/multiTenantAuthController');
const { resolveTenant } = require('../middleware/tenant');

// Apply middleware to all tenant admin routes (emulation-aware)
router.use(validateToken);
router.use(resolveTenant);

// Employee emulation routes
router.post('/emulate-employee', emulateEmployee);
router.post('/stop-employee-emulation', stopEmployeeEmulation);

// Tenant Information Routes
router.get('/info', getTenantInfo);
router.get('/subscription', getSubscriptionDetails);
router.put('/settings', updateTenantSettings);
router.get('/usage', getTenantUsage);
router.get('/analytics', getTenantAnalytics);

// Billing & Subscription Routes
router.get('/billing', getBillingInfo);
router.post('/billing/upgrade', upgradePlan);
router.get('/subscription/plans', getPlansCatalog);     // buyable catalog with per-cycle prices
router.post('/subscription/checkout', checkoutSubscription); // mock buy/renew
router.get('/subscription/history', getSubscriptionHistory);

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

// Activity Logs / Audit Trail Routes
// Static segments are declared before '/activity-logs' itself only for readability —
// Express matches on the full path, so order is not load-bearing here.
router.get('/activity-logs', getActivityLogs);
router.get('/activity-logs/summary', getActivitySummary);
router.get('/activity-logs/users', getLogUsers);
router.get('/activity-logs/verify', verifyActivityChain);
router.get('/activity-logs/export', exportActivityLogs);
router.get('/activity-logs/resource/:module/:id', getResourceHistory);

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
