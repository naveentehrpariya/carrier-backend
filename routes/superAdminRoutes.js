const express = require('express');
const router = express.Router();
const { 
  superAdminLogin,
  emulateTenant,
  stopEmulation,
  getProfile,
  logout
} = require('../controllers/multiTenantAuthController');
const {
  authenticateJWT,
  requireSuperAdmin
} = require('../middleware/auth');

// Import controllers
const superAdminTenantController = require('../controllers/superAdminTenantController');
const superAdminAnalyticsController = require('../controllers/superAdminAnalyticsController');
const superAdminBillingController = require('../controllers/superAdminBillingController');

// Authentication routes — login is public, everything else requires auth + super-admin role
router.post('/login', superAdminLogin);
router.get('/profile', authenticateJWT, requireSuperAdmin, getProfile);
router.post('/logout', logout);

// Tenant emulation routes
router.post('/emulate-tenant', authenticateJWT, requireSuperAdmin, emulateTenant);
router.post('/stop-emulation', authenticateJWT, requireSuperAdmin, stopEmulation);

// Tenant management routes
router.get('/tenants', authenticateJWT, requireSuperAdmin, superAdminTenantController.getTenants);
router.post('/tenants', authenticateJWT, requireSuperAdmin, superAdminTenantController.createTenant);
router.get('/tenants/:id', authenticateJWT, requireSuperAdmin, superAdminTenantController.getTenantDetails);
router.patch('/tenants/:id', authenticateJWT, requireSuperAdmin, superAdminTenantController.updateTenant);
router.delete('/tenants/:id', authenticateJWT, requireSuperAdmin, superAdminTenantController.deleteTenant);
router.patch('/tenants/:id/status', authenticateJWT, requireSuperAdmin, superAdminTenantController.updateTenantStatus);
router.post('/tenants/:id/invite-admin', authenticateJWT, requireSuperAdmin, superAdminTenantController.inviteTenantAdmin);
router.post('/tenants/:tenantId/ensure-company', authenticateJWT, requireSuperAdmin, superAdminTenantController.ensureCompanyRecord);
// Permanent tenant deletion
router.delete('/tenants/:tenantId/hard-delete', authenticateJWT, requireSuperAdmin, superAdminTenantController.hardDeleteTenant);
// Tenant subscription management
router.get('/tenants/:tenantId/subscription', authenticateJWT, requireSuperAdmin, superAdminTenantController.getTenantSubscriptionDetails);
router.put('/tenants/:tenantId/subscription', authenticateJWT, requireSuperAdmin, superAdminTenantController.updateTenantSubscriptionPlan);
// Subscription plan management
router.get('/subscription-plans', authenticateJWT, requireSuperAdmin, superAdminTenantController.getSubscriptionPlans);
router.get('/public/subscription-plans', superAdminTenantController.getSubscriptionPlans); // Public route for frontend
router.post('/subscription-plans', authenticateJWT, requireSuperAdmin, superAdminTenantController.createSubscriptionPlan);
router.patch('/subscription-plans/:id', authenticateJWT, requireSuperAdmin, superAdminTenantController.updateSubscriptionPlan);
router.delete('/subscription-plans/:id', authenticateJWT, requireSuperAdmin, superAdminTenantController.deleteSubscriptionPlan);

// Platform analytics routes
router.get('/analytics/overview', authenticateJWT, requireSuperAdmin, superAdminAnalyticsController.getPlatformOverview);
router.get('/analytics/tenants', authenticateJWT, requireSuperAdmin, superAdminAnalyticsController.getTenantsAnalytics);
router.get('/analytics/revenue', authenticateJWT, requireSuperAdmin, superAdminAnalyticsController.getRevenueAnalytics);
router.get('/analytics/usage', authenticateJWT, requireSuperAdmin, superAdminAnalyticsController.getUsageAnalytics);
router.get('/analytics/growth', authenticateJWT, requireSuperAdmin, superAdminAnalyticsController.getGrowthAnalytics);

// Billing management routes
router.get('/billing/overview', authenticateJWT, requireSuperAdmin, superAdminBillingController.getBillingOverview);
router.get('/billing/invoices', authenticateJWT, requireSuperAdmin, superAdminBillingController.getInvoices);
router.get('/billing/subscriptions', authenticateJWT, requireSuperAdmin, superAdminBillingController.getSubscriptions);
router.patch('/billing/subscriptions/:id', authenticateJWT, requireSuperAdmin, superAdminBillingController.updateSubscription);
router.post('/billing/invoices/:id/send', authenticateJWT, requireSuperAdmin, superAdminBillingController.sendInvoice);

// System management routes
router.get('/system/health', authenticateJWT, requireSuperAdmin, superAdminTenantController.getSystemHealth);
router.get('/system/logs', authenticateJWT, requireSuperAdmin, superAdminTenantController.getSystemLogs);
router.post('/system/maintenance', authenticateJWT, requireSuperAdmin, superAdminTenantController.toggleMaintenance);

// User management routes (super admin users)
router.get('/super-admins', authenticateJWT, requireSuperAdmin, superAdminTenantController.getSuperAdmins);
router.post('/super-admins', authenticateJWT, requireSuperAdmin, superAdminTenantController.createSuperAdmin);
router.patch('/super-admins/:id', authenticateJWT, requireSuperAdmin, superAdminTenantController.updateSuperAdmin);
router.delete('/super-admins/:id', authenticateJWT, requireSuperAdmin, superAdminTenantController.deleteSuperAdmin);

module.exports = router;
