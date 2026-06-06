const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/AppError');
const Tenant = require('../db/Tenant');
const SuperAdmin = require('../db/SuperAdmin');
const SubscriptionPlan = require('../db/SubscriptionPlan');
const User = require('../db/Users');
const Company = require('../db/Company');
const Order = require('../db/Order');
const Customer = require('../db/Customer');
const Carrier = require('../db/Carrier');
const Files = require('../db/Files');
const bcrypt = require('bcrypt');
const mongoose = require('mongoose');
const { logActivity } = require('../utils/activityLogger');

const VALID_MODULES = ['outsourcing', 'regular'];
const sanitizeAllowedModules = (value) => {
  if (!Array.isArray(value)) return undefined;
  const cleaned = value
    .map((m) => String(m).toLowerCase().trim())
    .filter((m) => VALID_MODULES.includes(m));
  return cleaned;
};

/**
 * Get system overview
 */
const getSystemOverview = catchAsync(async (req, res, next) => {
  const [
    totalTenants,
    activeTenants,
    totalUsers,
    totalOrders,
    totalRevenue,
    recentTenants
  ] = await Promise.all([
    Tenant.countDocuments(),
    Tenant.countDocuments({ status: 'active' }),
    User.countDocuments(),
    Order.countDocuments(),
    Order.aggregate([
      { $group: { _id: null, total: { $sum: '$total_amount' } } }
    ]),
    Tenant.find()
      .sort({ createdAt: -1 })
      .limit(5)
      .select('tenantId name subdomain status subscription createdAt')
      .lean()
  ]);

  const revenue = totalRevenue.length > 0 ? totalRevenue[0].total : 0;

  // Get subscription plan distribution
  const planDistribution = await Tenant.aggregate([
    {
      $group: {
        _id: '$subscription.plan',
        count: { $sum: 1 }
      }
    }
  ]);

  res.json({
    status: true,
    data: {
      overview: {
        totalTenants,
        activeTenants,
        inactiveTenants: totalTenants - activeTenants,
        totalUsers,
        totalOrders,
        totalRevenue: revenue
      },
      planDistribution,
      recentTenants
    }
  });
});

/**
 * Get all tenants with filtering and pagination
 */
const getAllTenants = catchAsync(async (req, res, next) => {
  const { page = 1, limit = 10, search, status, plan } = req.query;
  
  const filter = {};
  const and = [];
  if (search) {
    and.push({
      $or: [
        { name: { $regex: search, $options: 'i' } },
        { subdomain: { $regex: search, $options: 'i' } },
        { tenantId: { $regex: search, $options: 'i' } }
      ]
    });
  }
  if (status && status !== 'all') {
    filter.status = status;
  }
  if (plan && plan !== 'all') {
    and.push({
      $or: [
        { 'subscription.planSlug': plan },
        { 'subscription.legacyPlan': plan },
        { 'subscription.plan': plan }
      ]
    });
  }
  if (and.length) filter.$and = and;

  const tenants = await Tenant.find(filter)
    .sort({ createdAt: -1 })
    .limit(limit * 1)
    .skip((page - 1) * limit);

  const total = await Tenant.countDocuments(filter);

  // Get usage stats and subscription plan details for each tenant
  const tenantsWithUsage = await Promise.all(
    tenants.map(async (tenant) => {
      const [usage, subscriptionPlan, financialAgg] = await Promise.all([
        Promise.all([
          User.countDocuments(User.activeFilter(tenant.tenantId)),
          Order.countDocuments({ tenantId: tenant.tenantId }),
          Customer.countDocuments({ tenantId: tenant.tenantId }),
          Carrier.countDocuments({ tenantId: tenant.tenantId })
        ]),
        (async () => {
          const planSlug = tenant.subscription?.planSlug;
          const planRef = tenant.subscription?.plan;
          if (planSlug) return SubscriptionPlan.findOne({ slug: planSlug });
          if (planRef && mongoose.Types.ObjectId.isValid(planRef)) return SubscriptionPlan.findById(planRef);
          if (typeof planRef === 'string') return SubscriptionPlan.findOne({ slug: planRef });
          return null;
        })(),
        Order.aggregate([
          { $match: { tenantId: tenant.tenantId } },
          {
            $group: {
              _id: null,
              totalRevenue: { $sum: '$total_amount' },
              lastOrderDate: { $max: '$createdAt' }
            }
          }
        ])
      ]);
      
      const [users, orders, customers, carriers] = usage;
      const revenue = (financialAgg[0]?.totalRevenue) || 0;
      const lastActive = financialAgg[0]?.lastOrderDate || null;
      
      return {
        ...tenant.toObject(),
        usage: { users, orders, customers, carriers },
        revenue,
        lastActive,
        subscriptionPlan: subscriptionPlan || null
      };
    })
  );

  res.json({
    status: true,
    data: {
      tenants: tenantsWithUsage,
      pagination: {
        currentPage: parseInt(page),
        totalPages: Math.ceil(total / limit),
        totalItems: total,
        itemsPerPage: parseInt(limit)
      }
    }
  });
});

/**
 * Get specific tenant details
 */
const getTenantDetails = catchAsync(async (req, res, next) => {
  const { tenantId } = req.params;
  
  const tenant = await Tenant.findOne({ tenantId });
  if (!tenant) {
    return next(new AppError('Tenant not found', 404));
  }

  const [company, usage, subscriptionPlan, financialAgg, docsCount] = await Promise.all([
    Company.findOne({ tenantId }),
    Promise.all([
      User.countDocuments(User.activeFilter(tenantId)),
      Order.countDocuments({ tenantId }),
      Customer.countDocuments({ tenantId }),
      Carrier.countDocuments({ tenantId })
    ]),
    (async () => {
      const planSlug = tenant.subscription?.planSlug;
      const planRef = tenant.subscription?.plan;
      if (planSlug) return SubscriptionPlan.findOne({ slug: planSlug });
      if (planRef && mongoose.Types.ObjectId.isValid(planRef)) return SubscriptionPlan.findById(planRef);
      if (typeof planRef === 'string') return SubscriptionPlan.findOne({ slug: planRef });
      return null;
    })(),
    Order.aggregate([
      { $match: { tenantId } },
      {
        $group: {
          _id: null,
          totalRevenue: { $sum: '$total_amount' },
          lastOrderDate: { $max: '$createdAt' }
        }
      }
    ]),
    Files.countDocuments({ tenantId })
  ]);

  const [users, orders, customers, carriers] = usage;
  const revenue = (financialAgg[0]?.totalRevenue) || 0;
  const lastActive = financialAgg[0]?.lastOrderDate || null;

  res.json({
    status: true,
    data: {
      tenant,
      company,
      subscriptionPlan,
      usage: { users, orders, customers, carriers, documents: docsCount },
      revenue,
      lastActive
    }
  });
});

/**
 * Update tenant status
 */
const updateTenantStatus = catchAsync(async (req, res, next) => {
  const { tenantId } = req.params;
  const { status, reason } = req.body;
  
  // Validate status
  const validStatuses = ['active', 'suspended', 'pending', 'cancelled'];
  if (!validStatuses.includes(status)) {
    return next(new AppError('Invalid status. Must be one of: ' + validStatuses.join(', '), 400));
  }
  
  const tenant = await Tenant.findOneAndUpdate(
    { tenantId },
    { 
      status,
      'billing.statusChangeReason': reason,
      'billing.statusChangedAt': new Date(),
      'billing.statusChangedBy': req.user._id,
      updatedAt: new Date()
    },
    { new: true }
  );

  if (!tenant) {
    return next(new AppError('Tenant not found', 404));
  }

  logActivity(req, {
    action: 'STATUS_CHANGE',
    module: 'settings',
    description: `Changed tenant "${tenant.name}" status to "${status}"`,
    resourceId: tenant._id,
    resourceName: tenant.name,
    details: { newStatus: status, reason },
  });

  res.json({
    status: true,
    data: { tenant },
    message: `Tenant status updated to ${status}`
  });
});

/**
 * Force upgrade/downgrade tenant plan
 */
const updateTenantPlan = catchAsync(async (req, res, next) => {
  const { tenantId } = req.params;
  const { planSlug, reason } = req.body;
  
  const newPlan = await SubscriptionPlan.findOne({ slug: planSlug, isActive: true });
  if (!newPlan) {
    return next(new AppError('Subscription plan not found', 404));
  }

  const tenant = await Tenant.findOneAndUpdate(
    { tenantId },
    {
      'subscription.plan': newPlan._id,
      'subscription.planSlug': planSlug,
      'subscription.allowedModules': Array.isArray(newPlan.allowedModules) ? newPlan.allowedModules : ['outsourcing', 'regular'],
      'subscription.planLimits': newPlan.limits,
      'subscription.planFeatures': newPlan.features,
      'subscription.legacyPlan': (newPlan.slug && typeof newPlan.slug === 'string' && newPlan.slug.split('-')[0]) || 'basic',
      'settings.maxUsers': newPlan.limits.maxUsers,
      'settings.maxOrders': newPlan.limits.maxOrders,
      'settings.features': newPlan.features,
      'billing.planChangeReason': reason,
      'billing.planChangedAt': new Date(),
      'billing.planChangedBy': req.user._id,
      updatedAt: new Date()
    },
    { new: true }
  );

  if (!tenant) {
    return next(new AppError('Tenant not found', 404));
  }

  logActivity(req, {
    action: 'UPDATE',
    module: 'settings',
    description: `Updated plan for tenant "${tenant.name}" to "${newPlan.name}"`,
    resourceId: tenant._id,
    resourceName: tenant.name,
    details: { planSlug, reason },
  });

  res.json({
    status: true,
    data: { tenant },
    message: `Tenant plan updated to ${newPlan.name}`
  });
});

/**
 * Get all subscription plans
 */
const getSubscriptionPlans = catchAsync(async (req, res, next) => {
  // For superadmin, include both active and inactive plans
  const plans = await SubscriptionPlan.find({}).sort({ name: 1 });
  const sanitizedPlans = plans.map((p) => {
    const obj = p.toObject();
    obj.allowedModules = sanitizeAllowedModules(obj.allowedModules) || [];
    return obj;
  });

  res.json({
    status: true,
    data: { plans: sanitizedPlans }
  });
});

/**
 * Create new subscription plan
 */
const createSubscriptionPlan = catchAsync(async (req, res, next) => {
  const allowedModules = sanitizeAllowedModules(req.body.allowedModules);
  if (!allowedModules || allowedModules.length === 0) {
    return next(new AppError('Please select at least one valid module (outsourcing, regular).', 400));
  }

  const plan = await SubscriptionPlan.create({
    ...req.body,
    allowedModules,
    createdBy: req.user._id
  });

  logActivity(req, {
    action: 'CREATE',
    module: 'settings',
    description: `Created subscription plan "${plan.name}"`,
    resourceId: plan._id,
    resourceName: plan.name,
  });

  res.status(201).json({
    status: true,
    data: { plan },
    message: 'Subscription plan created successfully'
  });
});

/**
 * Update subscription plan
 */
const updateSubscriptionPlan = catchAsync(async (req, res, next) => {
  const { id } = req.params;

  const update = { ...req.body, updatedAt: new Date() };
  if (Object.prototype.hasOwnProperty.call(req.body, 'allowedModules')) {
    const allowedModules = sanitizeAllowedModules(req.body.allowedModules);
    if (!allowedModules || allowedModules.length === 0) {
      return next(new AppError('Please select at least one valid module (outsourcing, regular).', 400));
    }
    update.allowedModules = allowedModules;
  }
  
  // Use findOneAndUpdate with _id to bypass the pre-find middleware
  const plan = await SubscriptionPlan.findOneAndUpdate(
    { _id: id },
    update,
    { new: true, runValidators: true }
  );

  if (!plan) {
    return next(new AppError('Subscription plan not found', 404));
  }

  try {
    const updateObj = {};
    if (Array.isArray(plan.allowedModules)) updateObj['subscription.allowedModules'] = plan.allowedModules;
    if (plan.limits) updateObj['subscription.planLimits'] = plan.limits;
    if (Array.isArray(plan.features)) updateObj['subscription.planFeatures'] = plan.features;
    if (plan.slug) updateObj['subscription.planSlug'] = plan.slug;

    const planIdStr = String(plan._id);
    await Tenant.updateMany(
      {
        $or: [
          { 'subscription.plan': plan._id },
          { 'subscription.plan': planIdStr },
          { 'subscription.plan': plan.slug },
          { 'subscription.planSlug': plan.slug }
        ]
      },
      { $set: updateObj }
    );
  } catch (err) {
    console.error('Failed to sync tenants after plan update:', err);
  }

  logActivity(req, {
    action: 'UPDATE',
    module: 'settings',
    description: `Updated subscription plan "${plan.name}"`,
    resourceId: plan._id,
    resourceName: plan.name,
  });

  res.json({
    status: true,
    data: { plan },
    message: 'Subscription plan updated successfully'
  });
});

/**
 * Delete subscription plan
 */
const deleteSubscriptionPlan = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  
  console.log('Delete request for plan ID:', id);
  
  // First find the plan to get its slug for tenant check
  const plan = await SubscriptionPlan.findOne({ _id: id });
  if (!plan) {
    return next(new AppError('Subscription plan not found', 404));
  }
  
  // Check if any tenant is using this plan (check by slug, not id)
  const planIdStr = String(plan._id);
  const tenantsUsingPlan = await Tenant.countDocuments({
    $or: [
      { 'subscription.plan': plan._id },
      { 'subscription.plan': planIdStr },
      { 'subscription.plan': plan.slug },
      { 'subscription.planSlug': plan.slug }
    ]
  });
  if (tenantsUsingPlan > 0) {
    return next(new AppError('Cannot delete plan that is in use by tenants', 400));
  }

  const deletedPlan = await SubscriptionPlan.findOneAndDelete({ _id: id });
  if (!deletedPlan) {
    return next(new AppError('Subscription plan not found', 404));
  }

  console.log('Plan deleted successfully:', deletedPlan.name);

  logActivity(req, {
    action: 'DELETE',
    module: 'settings',
    description: `Deleted subscription plan "${deletedPlan.name}"`,
    resourceId: deletedPlan._id,
    resourceName: deletedPlan.name,
  });

  res.json({
    status: true,
    message: 'Subscription plan deleted successfully'
  });
});

/**
 * Create new tenant
 */
const createTenant = catchAsync(async (req, res, next) => {
  const {
    name,
    subdomain,
    adminName,
    adminEmail,
    adminPhone,
    subscriptionPlan,
    companyInfo
  } = req.body;

  // Check if admin email already exists
  const existingUser = await User.findOne({ email: adminEmail });
  if (existingUser) {
    return next(new AppError('Admin email already exists', 400));
  }

  // Get subscription plan details
  const plan = await SubscriptionPlan.findOne({ slug: subscriptionPlan });
  if (!plan) {
    return next(new AppError('Subscription plan not found', 404));
  }

  // Map plan slug to tenant schema enum (basic|standard|premium|enterprise)
  const allowedPlans = ['basic', 'standard', 'premium', 'enterprise'];
  const planSlug = plan?.slug || subscriptionPlan;
  const tenantPlanKey = allowedPlans.find(p => planSlug.startsWith(p)) || 'basic';

  // Helper function to create URL-friendly tenant ID from name
  const createTenantId = (name) => {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '') // Remove special characters except spaces and hyphens
      .replace(/\s+/g, '-') // Replace spaces with hyphens
      .replace(/-+/g, '-') // Replace multiple hyphens with single
      .replace(/^-|-$/g, '') // Remove leading/trailing hyphens
      .substring(0, 50); // Limit length
  };

  // Generate unique tenant ID from name
  let tenantId = createTenantId(name);
  
  // Check if this tenant ID already exists and make it unique if needed
  let existingTenant = await Tenant.findOne({ tenantId });
  if (existingTenant) {
    let counter = 1;
    let testId = `${tenantId}-${counter}`;
    
    while (await Tenant.findOne({ tenantId: testId })) {
      counter++;
      testId = `${tenantId}-${counter}`;
    }
    
    tenantId = testId;
  }

  // Create tenant (use tenantId only, no subdomain)
  const tenant = await Tenant.create({
    tenantId,
    name,
    domain: process.env.DOMAIN || 'localhost',
    status: 'active',
    contactInfo: {
      adminName,
      adminEmail,
      phone: adminPhone || ''
    },
    subscription: {
      plan: plan._id,
      legacyPlan: tenantPlanKey,
      planSlug: plan.slug,
      status: 'active',
      startDate: new Date(),
      endDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days
      billingCycle: 'monthly',
      planLimits: plan?.limits || undefined,
      planFeatures: Array.isArray(plan?.features) ? plan.features : undefined,
      allowedModules: Array.isArray(plan?.allowedModules) ? plan.allowedModules : undefined
    },
    settings: {
      maxUsers: plan?.limits?.maxUsers ?? 10,
      maxOrders: plan?.limits?.maxOrders ?? 500,
      features: Array.isArray(plan?.features) ? plan.features : [],
    },
    billing: {
      balance: 0,
      nextBillingDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
    },
    createdBy: req.user._id
  });

  // Create company
  const company = await Company.create({
    tenantId,
    name: (companyInfo && companyInfo.name) ? companyInfo.name : name,
    mc_code: (companyInfo && companyInfo.mc_code) ? companyInfo.mc_code : `MC${Date.now()}`,
    dot_number: (companyInfo && companyInfo.dot_number) ? companyInfo.dot_number : `DOT${Date.now()}`,
    address: (companyInfo && companyInfo.address) ? companyInfo.address : 'N/A',
    city: (companyInfo && companyInfo.city) ? companyInfo.city : 'N/A',
    state: (companyInfo && companyInfo.state) ? companyInfo.state : 'N/A',
    zip: (companyInfo && companyInfo.zip) ? companyInfo.zip : 'N/A',
    email: adminEmail || 'N/A',
    phone: adminPhone || 'N/A'
  });

  // Create admin user
  const providedPassword = req.body?.adminPassword;
  const defaultDevPassword = process.env.DEFAULT_ADMIN_PASSWORD || '12345678';
  const isProd = (process.env.NODE_ENV === 'production');
  const tempPassword = providedPassword && typeof providedPassword === 'string' && providedPassword.length >= 6
    ? providedPassword
    : (isProd ? Math.random().toString(36).substring(2, 15) : defaultDevPassword);
  
  // Note: Don't manually hash password - User model pre-save hook will handle this
  const adminUser = await User.create({
    tenantId,
    company: company._id,
    name: adminName,
    email: adminEmail,
    password: tempPassword, // Plain password - will be hashed by User model pre-save hook
    phone: adminPhone,
    country: 'USA',
    address: (companyInfo && companyInfo.address) ? companyInfo.address : 'N/A',
    role: 3, // Admin role
    position: 'Administrator',
    corporateID: `ADMIN_${Date.now()}`,
    isTenantAdmin: true
  });

  // Remove password from response
  adminUser.password = undefined;

  logActivity(req, {
    action: 'CREATE',
    module: 'settings',
    description: `Created new tenant "${tenant.name}" (${tenantId})`,
    resourceId: tenant._id,
    resourceName: tenant.name,
    details: { tenantId, plan: planSlug },
  });

  res.status(201).json({
    status: true,
    data: {
      tenant,
      company,
      adminUser,
      tempPassword: isProd ? undefined : tempPassword
    },
    message: 'Tenant created successfully'
  });
});

/**
 * Get system analytics
 */
const getSystemAnalytics = catchAsync(async (req, res, next) => {
  const { period = '30d' } = req.query;
  
  // Calculate date range
  const now = new Date();
  const startDate = new Date();
  
  switch (period) {
    case '7d':
      startDate.setDate(now.getDate() - 7);
      break;
    case '30d':
      startDate.setDate(now.getDate() - 30);
      break;
    case '90d':
      startDate.setDate(now.getDate() - 90);
      break;
    case '1y':
      startDate.setFullYear(now.getFullYear() - 1);
      break;
    default:
      startDate.setDate(now.getDate() - 30);
  }

  const baseFilter = { createdAt: { $gte: startDate } };

  const [
    newTenants,
    newUsers,
    totalOrders,
    totalRevenue,
    tenantGrowth,
    revenueByMonth,
    planDistribution
  ] = await Promise.all([
    Tenant.countDocuments(baseFilter),
    User.countDocuments(baseFilter),
    Order.countDocuments(baseFilter),
    Order.aggregate([
      { $match: baseFilter },
      { $group: { _id: null, total: { $sum: '$total_amount' } } }
    ]),
    Tenant.aggregate([
      { $match: baseFilter },
      {
        $group: {
          _id: {
            year: { $year: '$createdAt' },
            month: { $month: '$createdAt' },
            day: { $dayOfMonth: '$createdAt' }
          },
          count: { $sum: 1 }
        }
      },
      { $sort: { '_id.year': 1, '_id.month': 1, '_id.day': 1 } }
    ]),
    Order.aggregate([
      { $match: baseFilter },
      {
        $group: {
          _id: {
            year: { $year: '$createdAt' },
            month: { $month: '$createdAt' }
          },
          revenue: { $sum: '$total_amount' },
          orders: { $sum: 1 }
        }
      },
      { $sort: { '_id.year': 1, '_id.month': 1 } }
    ]),
    Tenant.aggregate([
      {
        $group: {
          _id: '$subscription.plan',
          count: { $sum: 1 }
        }
      }
    ])
  ]);

  const revenue = totalRevenue.length > 0 ? totalRevenue[0].total : 0;

  res.json({
    status: true,
    data: {
      period,
      summary: {
        newTenants,
        newUsers,
        totalOrders,
        totalRevenue: revenue
      },
      charts: {
        tenantGrowth: tenantGrowth.map(item => ({
          date: `${item._id.year}-${String(item._id.month).padStart(2, '0')}-${String(item._id.day).padStart(2, '0')}`,
          count: item.count
        })),
        revenueByMonth: revenueByMonth.map(item => ({
          period: `${item._id.year}-${String(item._id.month).padStart(2, '0')}`,
          revenue: item.revenue,
          orders: item.orders
        })),
        planDistribution: planDistribution.map(item => ({
          plan: item._id,
          count: item.count
        }))
      }
    }
  });
});

/**
 * Get tenant activity logs (placeholder)
 */
const getTenantActivityLogs = catchAsync(async (req, res, next) => {
  const { tenantId } = req.params;
  
  res.json({
    status: true,
    data: {
      logs: [],
      message: 'Activity logging to be implemented'
    }
  });
});

/**
 * Export system data (placeholder)
 */
const exportSystemData = catchAsync(async (req, res, next) => {
  res.json({
    status: true,
    message: 'System data export to be implemented'
  });
});

/**
 * Update tenant settings (limits)
 */
const updateTenantSettings = catchAsync(async (req, res, next) => {
  const { tenantId } = req.params;
  const { maxUsers, maxOrders, maxCustomers, maxCarriers } = req.body;

  const update = { updatedAt: new Date() };
  if (maxUsers !== undefined) update['settings.maxUsers'] = Number(maxUsers);
  if (maxOrders !== undefined) update['settings.maxOrders'] = Number(maxOrders);
  if (maxCustomers !== undefined) update['settings.maxCustomers'] = Number(maxCustomers);
  if (maxCarriers !== undefined) update['settings.maxCarriers'] = Number(maxCarriers);

  const tenant = await Tenant.findOneAndUpdate(
    { tenantId },
    update,
    { new: true, runValidators: true }
  );

  if (!tenant) {
    return next(new AppError('Tenant not found', 404));
  }

  logActivity(req, {
    action: 'UPDATE',
    module: 'settings',
    description: `Updated settings for tenant "${tenant.name}"`,
    resourceId: tenant._id,
    resourceName: tenant.name,
    details: { maxUsers, maxOrders, maxCustomers, maxCarriers },
  });

  res.json({
    status: true,
    data: { tenant },
    message: 'Tenant settings updated successfully'
  });
});

/**
 * Update tenant basic information
 */
const updateTenantInfo = catchAsync(async (req, res, next) => {
  const { tenantId } = req.params;
  const { name, contactInfo } = req.body;

  const update = { updatedAt: new Date() };
  if (name) update.name = name;
  if (contactInfo) {
    if (contactInfo.adminName) update['contactInfo.adminName'] = contactInfo.adminName;
    if (contactInfo.adminEmail) update['contactInfo.adminEmail'] = contactInfo.adminEmail;
    if (contactInfo.phone) update['contactInfo.phone'] = contactInfo.phone;
    if (contactInfo.address) update['contactInfo.address'] = contactInfo.address;
    if (contactInfo.city) update['contactInfo.city'] = contactInfo.city;
    if (contactInfo.state) update['contactInfo.state'] = contactInfo.state;
    if (contactInfo.country) update['contactInfo.country'] = contactInfo.country;
    if (contactInfo.zipcode) update['contactInfo.zipcode'] = contactInfo.zipcode;
  }

  const tenant = await Tenant.findOneAndUpdate(
    { tenantId },
    update,
    { new: true, runValidators: true }
  );

  if (!tenant) {
    return next(new AppError('Tenant not found', 404));
  }

  logActivity(req, {
    action: 'UPDATE',
    module: 'settings',
    description: `Updated information for tenant "${tenant.name}"`,
    resourceId: tenant._id,
    resourceName: tenant.name,
  });

  res.json({
    status: true,
    data: { tenant },
    message: 'Tenant information updated successfully'
  });
});

module.exports = {
  getSystemOverview,
  getAllTenants,
  getTenantDetails,
  updateTenantStatus,
  updateTenantPlan,
  updateTenantSettings,
  updateTenantInfo,
  getSubscriptionPlans,
  createSubscriptionPlan,
  updateSubscriptionPlan,
  deleteSubscriptionPlan,
  createTenant,
  getSystemAnalytics,
  getTenantActivityLogs,
  exportSystemData
};
