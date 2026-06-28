const express = require('express');
const router = express.Router();
const { 
  tenantLogin,
  getProfile,
  logout
} = require('../controllers/multiTenantAuthController');
const { 
  requireTenant,
  ensureTenantContext
} = require('../middleware/tenantResolver');
const { validateToken } = require('../controllers/multiTenantAuthController');

// Tenant data filtering middleware - automatically filters all queries by tenantId
const tenantDataFilter = (req, res, next) => {
  if (req.tenantId && !req.isSuperAdminUser) {
    // Add tenant filter to all database operations
    req.dbFilter = req.dbFilter || {};
    req.dbFilter.tenantId = req.tenantId;
  }
  next();
};

// Apply tenant filtering to all routes
router.use(tenantDataFilter);

// Ensure tenant context is available (for superadmin emulation)
router.use(ensureTenantContext);

// Authentication routes
router.post('/login', requireTenant, tenantLogin);
router.get('/profile', validateToken, getProfile);
router.post('/logout', logout);

// Import existing controllers and add tenant filtering
const authController = require('../controllers/authController');
const userController = require('../controllers/userController');
const orderController = require('../controllers/orderController');
const customerController = require('../controllers/customerController');
const carrierController = require('../controllers/carrierController');
const { checkOrderLimit } = require('../middlewares/planLimitsMiddleware');
const { checkOrderModuleAccess, resolveAllowedModulesMiddleware, requireActiveSubscription } = require('../middlewares/planModulesMiddleware');
const { isSubscriptionActive, effectiveStatus, currentOrderPeriod } = require('../utils/subscription');
const OrderModel = require('../db/Order');
const SubscriptionPlanModel = require('../db/SubscriptionPlan');
const TenantModel = require('../db/Tenant');
const catchAsyncStatus = require('../utils/catchAsync');

// Import new tenant admin controller
const tenantAdminController = require('../controllers/tenantAdminController');

// Enhanced user routes with tenant filtering
router.post('/user/create_user', validateToken, authController.signup);
router.post('/user/edit_user/:id', validateToken, authController.editUser);
router.get('/user/suspanduser/:id', validateToken, authController.suspandUser);
router.post('/user/forgotpassword', authController.forgotPassword);
router.patch('/user/resetpassword/:token', authController.resetpassword);
router.get('/user/employeesLisiting', validateToken, authController.employeesLisiting);
router.get('/user/employee/detail/:id', validateToken, authController.employeeDetail);
router.get('/user/employee/docs/:id', validateToken, authController.employeesDocs);
router.post('/user/add-company-information', validateToken, authController.addCompanyInfo);
router.post('/user/change-password', validateToken, authController.changePassword);

// Admin endpoint for updating user email during emulation
router.patch('/admin/users/:id/email', validateToken, async (req, res) => {
  try {
    const { email } = req.body;
    const userId = req.params.id;
    
    // Verify superadmin access
    if (!req.isSuperAdminUser && !req.superAdmin) {
      return res.status(403).json({
        status: false,
        message: 'Super admin access required'
      });
    }
    
    // Validate email
    if (!email) {
      return res.status(400).json({
        status: false,
        message: 'Email is required'
      });
    }
    
    // Find user within tenant context
    const User = require('../db/Users');
    const filter = { _id: userId };
    if (req.tenantId) {
      filter.tenantId = req.tenantId;
    }
    
    const user = await User.findOne(filter);
    if (!user) {
      return res.status(404).json({
        status: false,
        message: 'User not found'
      });
    }
    
    // Update email
    user.email = email;
    await user.save();
    
    res.json({
      status: true,
      message: 'Email updated successfully'
    });
    
  } catch (error) {
    console.error('Admin email update error:', error);
    res.status(500).json({
      status: false,
      message: 'Failed to update email'
    });
  }
});

// Admin endpoint for setting user password during emulation
router.patch('/admin/users/:id/password', validateToken, async (req, res) => {
  try {
    const { password, confirmPassword } = req.body;
    const userId = req.params.id;
    
    // Verify superadmin access
    if (!req.isSuperAdminUser && !req.superAdmin) {
      return res.status(403).json({
        status: false,
        message: 'Super admin access required'
      });
    }
    
    // Validate passwords
    if (!password || !confirmPassword) {
      return res.status(400).json({
        status: false,
        message: 'Password and confirm password are required'
      });
    }
    
    if (password !== confirmPassword) {
      return res.status(400).json({
        status: false,
        message: 'Passwords do not match'
      });
    }
    
    // Find user within tenant context
    const User = require('../db/Users');
    const filter = { _id: userId };
    if (req.tenantId) {
      filter.tenantId = req.tenantId;
    }
    
    const user = await User.findOne(filter);
    if (!user) {
      return res.status(404).json({
        status: false,
        message: 'User not found'
      });
    }
    
    // Update password
    user.password = password;
    await user.save();
    
    res.json({
      status: true,
      message: 'Password updated successfully'
    });
    
  } catch (error) {
    console.error('Admin password reset error:', error);
    res.status(500).json({
      status: false,
      message: 'Failed to update password'
    });
  }
});
router.patch('/user/update', validateToken, userController.updateCurrentUserData);
router.delete('/user/delete', validateToken, userController.deleteCurrentUser);
router.get('/user/staff-listing', validateToken, userController.staffListing);

// Lightweight subscription status for ANY tenant user (drives the in-app billing + order-limit banners).
// Resolve the tenant by the authoritative token tenantId (NOT req.tenant, which can be a stale
// X-Tenant-ID context and disagree with the user's actual tenant).
router.get('/subscription/status', validateToken, catchAsyncStatus(async (req, res) => {
  const tenant = await TenantModel.findOne({ tenantId: req.tenantId }).lean();

  // Resolve the monthly order limit from the plan (or the snapshot on the subscription).
  let maxOrders = tenant?.subscription?.planLimits?.maxOrders;
  const planRef = tenant?.subscription?.plan;
  if (planRef) {
    try {
      const plan = typeof planRef === 'string'
        ? await SubscriptionPlanModel.findOne({ slug: planRef }).lean()
        : await SubscriptionPlanModel.findById(planRef).lean();
      if (plan?.limits?.maxOrders != null) maxOrders = plan.limits.maxOrders;
    } catch (_) { /* fall back to snapshot */ }
  }
  maxOrders = Number(maxOrders) || 0;

  const { start, end } = currentOrderPeriod(tenant);
  const used = await OrderModel.countDocuments({
    tenantId: req.tenantId,
    $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
    createdAt: { $gte: start, $lt: end }
  });
  const unlimited = maxOrders === 0;
  const remaining = unlimited ? null : Math.max(0, maxOrders - used);

  res.json({
    status: true,
    data: {
      active: isSubscriptionActive(tenant),
      subStatus: effectiveStatus(tenant),
      endDate: tenant?.subscription?.endDate || null,
      orders: {
        used,
        limit: maxOrders,        // 0 == unlimited
        remaining,
        unlimited,
        exceeded: !unlimited && used >= maxOrders,
        periodStart: start,
        resetDate: end
      }
    }
  });
}));

// Order routes with tenant filtering
router.post('/order/add', validateToken, requireActiveSubscription, checkOrderLimit(), checkOrderModuleAccess(), orderController.create_order);
router.put('/order/update/:id', validateToken, resolveAllowedModulesMiddleware, orderController.update_order);
router.get('/order/listings', validateToken, resolveAllowedModulesMiddleware, orderController.order_listing);
router.get('/order/detail/:id', validateToken, resolveAllowedModulesMiddleware, orderController.order_detail);
router.get('/order_docs/:id', validateToken, resolveAllowedModulesMiddleware, orderController.order_docs);
router.get('/lock-order/:id', validateToken, resolveAllowedModulesMiddleware, orderController.lockOrder);
router.get('/delete-order/:id', validateToken, resolveAllowedModulesMiddleware, orderController.deleteOrder);
router.get('/account/order/listings', validateToken, resolveAllowedModulesMiddleware, orderController.order_listing_account);
router.post('/account/order/update/payment/:id/:type', validateToken, resolveAllowedModulesMiddleware, orderController.updateOrderPaymentStatus);
router.post('/account/order-status/:id', validateToken, resolveAllowedModulesMiddleware, orderController.updateOrderStatus);
router.post('/account/order/addnote/:id', validateToken, resolveAllowedModulesMiddleware, orderController.addnote);
router.get('/overview', validateToken, resolveAllowedModulesMiddleware, orderController.overview);
router.get('/cummodityLists', validateToken, orderController.cummodityLists);
router.post('/removeCummodity', validateToken, orderController.removeCummodity);
router.post('/addCummodity', validateToken, orderController.addCummodity);
router.get('/equipmentLists', validateToken, orderController.equipmentLists);
router.post('/removeEquipment', validateToken, orderController.removeEquipment);
router.post('/addEquipment', validateToken, orderController.addEquipment);
router.get('/chargesLists', validateToken, orderController.chargesLists);
router.post('/removeCharge', validateToken, orderController.removeCharge);
router.post('/addCharge', validateToken, orderController.addCharges);
router.get('/payments/listings', validateToken, resolveAllowedModulesMiddleware, orderController.orderPayments);
router.get('/all_payments_status', validateToken, resolveAllowedModulesMiddleware, orderController.all_payments_status);

// Customer routes with tenant filtering
router.get('/customer/listings', validateToken, customerController.customers_listing);
router.post('/customer/add', validateToken, customerController.addCustomer);
router.post('/customer/update/:id', validateToken, customerController.updateCustomer);
router.get('/customer/detail/:id', validateToken, customerController.customerDetails);
router.get('/customer/remove/:id', validateToken, customerController.deleteCustomer);

// Carrier routes with tenant filtering
router.get('/carriers/listings', validateToken, carrierController.carriers_listing);
router.post('/carriers/add', validateToken, carrierController.addCarrier);
router.get('/carriers/remove/:id', validateToken, carrierController.deleteCarrier);
router.post('/carriers/update/:id', validateToken, carrierController.updateCarrier);
router.get('/carrier/detail/:id', validateToken, carrierController.carrierDetail);
router.post('/getdistance', carrierController.getDistance);

// New tenant admin routes
router.get('/tenant/info', validateToken, tenantAdminController.getTenantInfo);
router.patch('/tenant/settings', validateToken, tenantAdminController.updateTenantSettings);
router.get('/tenant/usage', validateToken, tenantAdminController.getTenantUsage);
router.get('/tenant/analytics', validateToken, tenantAdminController.getTenantAnalytics);
router.get('/tenant/billing', validateToken, tenantAdminController.getBillingInfo);
router.post('/tenant/upgrade-plan', validateToken, tenantAdminController.upgradePlan);

// Tenant user management (for tenant admins)
router.get('/tenant/users', validateToken, tenantAdminController.getTenantUsers);
router.post('/tenant/users/invite', validateToken, tenantAdminController.inviteUser);
router.patch('/tenant/users/:id/role', validateToken, tenantAdminController.updateUserRole);
router.delete('/tenant/users/:id', validateToken, tenantAdminController.removeUser);

// Tenant integrations management
router.get('/tenant/integrations', validateToken, tenantAdminController.getIntegrations);
router.post('/tenant/integrations/:type/configure', validateToken, tenantAdminController.configureIntegration);
router.delete('/tenant/integrations/:type', validateToken, tenantAdminController.removeIntegration);

// Tenant reports and exports
router.get('/tenant/reports/orders', validateToken, tenantAdminController.getOrdersReport);
router.get('/tenant/reports/customers', validateToken, tenantAdminController.getCustomersReport);
router.get('/tenant/reports/carriers', validateToken, tenantAdminController.getCarriersReport);
router.get('/tenant/reports/financial', validateToken, tenantAdminController.getFinancialReport);
router.post('/tenant/reports/export', validateToken, tenantAdminController.exportData);

router.patch('/admin/users/:id/modules', validateToken, async (req, res) => {
  try {
    if (!req.isSuperAdminUser && !req.superAdmin) {
      return res.status(403).json({
        status: false,
        message: 'Super admin access required'
      });
    }
    const userId = req.params.id;
    const { allowedModules } = req.body || {};
    if (!Array.isArray(allowedModules)) {
      return res.status(400).json({
        status: false,
        message: 'allowedModules must be an array'
      });
    }
    const valid = ['outsourcing', 'regular'];
    const cleaned = [...new Set(allowedModules.filter(m => valid.includes(String(m).toLowerCase())))]
      .map(m => m.toLowerCase());
    const User = require('../db/Users');
    const filter = { _id: userId };
    if (req.tenantId) {
      filter.tenantId = req.tenantId;
    }
    const user = await User.findOne(filter);
    if (!user) {
      return res.status(404).json({
        status: false,
        message: 'User not found'
      });
    }
    user.allowedModules = cleaned;
    await user.save({ validateBeforeSave: false });
    res.json({
      status: true,
      message: 'User modules updated',
      allowedModules: user.allowedModules
    });
  } catch (error) {
    console.error('Admin modules update error:', error);
    res.status(500).json({
      status: false,
      message: 'Failed to update modules'
    });
  }
});

router.get('/admin/users', validateToken, async (req, res) => {
  try {
    if (!req.isSuperAdminUser && !req.superAdmin) {
      return res.status(403).json({
        status: false,
        message: 'Super admin access required'
      });
    }
    const User = require('../db/Users');
    const tenantId = req.tenantId;
    if (!tenantId) {
      return res.status(400).json({
        status: false,
        message: 'Tenant context is required (?tenant=<tenantId> or X-Tenant-ID)'
      });
    }
    const { q } = req.query;
    const filter = { tenantId };
    if (q && q.trim()) {
      const keyword = q.trim();
      filter.$or = [
        { name: { $regex: keyword, $options: 'i' } },
        { email: { $regex: keyword, $options: 'i' } },
        { corporateID: { $regex: keyword, $options: 'i' } }
      ];
    }
    const users = await User.find(filter, 'name email role is_admin allowedModules status createdAt').sort({ createdAt: -1 }).lean();
    res.json({
      status: true,
      users
    });
  } catch (error) {
    console.error('Admin users list error:', error);
    res.status(500).json({
      status: false,
      message: 'Failed to fetch users'
    });
  }
});

module.exports = router;
