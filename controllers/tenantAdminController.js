const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/AppError');
const Tenant = require('../db/Tenant');
const User = require('../db/Users');

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const Company = require('../db/Company');
const Order = require('../db/Order');
const Customer = require('../db/Customer');
const Carrier = require('../db/Carrier');
const SubscriptionPlan = require('../db/SubscriptionPlan');
const SubscriptionHistory = require('../db/SubscriptionHistory');
const bcrypt = require('bcrypt');
const { getTenantUsageSummary } = require('../middlewares/planLimitsMiddleware');
const { logActivity } = require('../utils/activityLogger');
const { computeCyclePrice, priceMatrix, computeEndDate, effectiveStatus, isSubscriptionActive, currentOrderPeriod } = require('../utils/subscription');

/**
 * Get tenant information
 */
/**
 * Get tenant subscription details only
 */
const getSubscriptionDetails = catchAsync(async (req, res, next) => {
  console.log('🔍 getSubscriptionDetails called for tenantId:', req.tenantId);
  const tenant = await Tenant.findOne({ tenantId: req.tenantId });
  
  if (!tenant) {
    console.log('❌ Tenant not found for tenantId:', req.tenantId);
    return next(new AppError('Tenant not found', 404));
  }
  
  console.log('✅ Found tenant:', tenant.name, 'subscription:', tenant.subscription);

  // Get subscription plan details - handle both old and new formats
  let subscriptionPlan = null;
  
  if (tenant.subscription.plan) {
    if (typeof tenant.subscription.plan === 'string') {
      subscriptionPlan = await SubscriptionPlan.findOne({
        $or: [
          { slug: tenant.subscription.plan },
          { name: { $regex: tenant.subscription.plan, $options: 'i' } }
        ]
      });
    } else {
      subscriptionPlan = await SubscriptionPlan.findById(tenant.subscription.plan);
    }
  } else if (tenant.subscription.planSlug) {
    subscriptionPlan = await SubscriptionPlan.findOne({ slug: tenant.subscription.planSlug });
  } else if (tenant.subscription.legacyPlan) {
    subscriptionPlan = await SubscriptionPlan.findOne({
      $or: [
        { slug: tenant.subscription.legacyPlan },
        { name: { $regex: tenant.subscription.legacyPlan, $options: 'i' } }
      ]
    });
  }

  // Only ORDERS are metered per month. `users` is a total active-seat count.
  const orderPeriod = currentOrderPeriod(tenant);
  const notDeleted = { $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }] };

  const usage = {
    users: await User.countDocuments(User.activeFilter(req.tenantId)),
    orders: await Order.countDocuments({ tenantId: req.tenantId, ...notDeleted, createdAt: { $gte: orderPeriod.start, $lt: orderPeriod.end } })
  };

  // Determine plan limits and features from subscription plan or defaults
  const planLimits = subscriptionPlan?.limits || tenant.subscription.planLimits || {
    maxUsers: tenant.settings?.maxUsers || 10,
    maxOrders: tenant.settings?.maxOrders || 1000,
    maxCustomers: tenant.settings?.maxCustomers || 1000,
    maxCarriers: tenant.settings?.maxCarriers || 500
  };
  
  const planFeatures = subscriptionPlan?.features || tenant.subscription.planFeatures || 
    tenant.settings?.features || ['orders', 'customers', 'carriers', 'basic_reporting'];

  // limit 0 == unlimited (per planLimitsMiddleware). pct null when unlimited or no plan.
  const pct = (cur, lim) => (lim && lim > 0 ? Math.round((cur / lim) * 100) : null);
  const status = effectiveStatus(tenant);       // lazy expiry
  const active = isSubscriptionActive(tenant);
  const hasPlan = !!(subscriptionPlan || tenant.subscription.planSlug || tenant.subscription.plan);

  const subscriptionInfo = {
    status,
    hasPlan,
    startDate: tenant.subscription.startDate,
    endDate: tenant.subscription.endDate,
    billingCycle: tenant.subscription.billingCycle || 'monthly',
    planName: subscriptionPlan?.name || tenant.subscription.legacyPlan ||
               (typeof tenant.subscription.plan === 'string' ? tenant.subscription.plan : (hasPlan ? 'Plan' : 'No plan')),
    planSlug: subscriptionPlan?.slug || tenant.subscription.planSlug,
    planDescription: subscriptionPlan?.description || (hasPlan ? '' : 'No subscription yet — choose a plan to get started.'),
    monthlyPrice: subscriptionPlan?.monthlyPrice ?? null,
    currency: subscriptionPlan?.currency || 'USD',
    allowedModules: tenant.subscription.allowedModules || [],
    planLimits,
    planFeatures,
    isActive: active,
    daysUntilRenewal: tenant.subscription.endDate ?
      Math.ceil((new Date(tenant.subscription.endDate) - new Date()) / (1000 * 60 * 60 * 24)) : null,
    usage: {
      users: { current: usage.users, limit: planLimits.maxUsers, percentage: pct(usage.users, planLimits.maxUsers) },
      orders: { current: usage.orders, limit: planLimits.maxOrders, percentage: pct(usage.orders, planLimits.maxOrders), monthly: true, resetDate: orderPeriod.end }
    },
    orderResetDate: orderPeriod.end
  };

  res.json({
    status: true,
    data: {
      subscription: subscriptionInfo
    }
  });
});

/**
 * Get tenant information
 */
const getTenantInfo = catchAsync(async (req, res, next) => {
  const tenant = await Tenant.findOne({ tenantId: req.tenantId });
  const company = await Company.findOne({ tenantId: req.tenantId });
  
  if (!tenant || !company) {
    return next(new AppError('Tenant information not found', 404));
  }

  // Get usage statistics
  const usage = {
    users: await User.countDocuments(User.activeFilter(req.tenantId)),
    orders: await Order.countDocuments({ tenantId: req.tenantId }),
    customers: await Customer.countDocuments({ tenantId: req.tenantId }),
    carriers: await Carrier.countDocuments({ tenantId: req.tenantId })
  };

  // Get subscription plan details - handle both old and new formats
  let subscriptionPlan = null;
  
  if (tenant.subscription.plan) {
    if (typeof tenant.subscription.plan === 'string') {
      // Old format - try to find by slug or legacy plan name
      subscriptionPlan = await SubscriptionPlan.findOne({
        $or: [
          { slug: tenant.subscription.plan },
          { name: { $regex: tenant.subscription.plan, $options: 'i' } }
        ]
      });
    } else {
      // New format - ObjectId reference
      subscriptionPlan = await SubscriptionPlan.findById(tenant.subscription.plan);
    }
  } else if (tenant.subscription.planSlug) {
    // Try to find by planSlug
    subscriptionPlan = await SubscriptionPlan.findOne({ slug: tenant.subscription.planSlug });
  } else if (tenant.subscription.legacyPlan) {
    // Try to find by legacy plan name
    subscriptionPlan = await SubscriptionPlan.findOne({
      $or: [
        { slug: tenant.subscription.legacyPlan },
        { name: { $regex: tenant.subscription.legacyPlan, $options: 'i' } }
      ]
    });
  }

  res.json({
    status: true,
    data: {
      tenant: {
        id: tenant._id,
        name: tenant.name,
        subdomain: tenant.subdomain,
        status: tenant.status,
        subscription: {
          status: tenant.subscription.status || 'active',
          startDate: tenant.subscription.startDate,
          endDate: tenant.subscription.endDate,
          billingCycle: tenant.subscription.billingCycle || 'monthly',
          planName: subscriptionPlan?.name || tenant.subscription.legacyPlan || tenant.subscription.plan || 'Basic',
          planSlug: subscriptionPlan?.slug || tenant.subscription.planSlug,
          planDescription: subscriptionPlan?.description || 'Standard logistics management features',
          planLimits: subscriptionPlan?.limits || tenant.subscription.planLimits || {
            maxUsers: tenant.settings.maxUsers || 10,
            maxOrders: tenant.settings.maxOrders || 1000,
            maxCustomers: 1000,
            maxCarriers: 500
          },
          
          planFeatures: subscriptionPlan?.features || tenant.subscription.planFeatures || [
            'orders', 'customers', 'carriers', 'basic_reporting'
          ],
          isActive: tenant.subscription.status === 'active',
          daysUntilRenewal: tenant.subscription.endDate ? 
            Math.ceil((new Date(tenant.subscription.endDate) - new Date()) / (1000 * 60 * 60 * 24)) : null
        },
        settings: tenant.settings,
        usage,
        limits: {
          users: {
            used: usage.users,
            limit: subscriptionPlan?.limits?.maxUsers || tenant.subscription.planLimits?.maxUsers || tenant.settings.maxUsers || 10,
            percentage: Math.round((usage.users / (subscriptionPlan?.limits?.maxUsers || tenant.settings.maxUsers || 10)) * 100)
          },
          orders: {
            used: usage.orders,
            limit: subscriptionPlan?.limits?.maxOrders || tenant.subscription.planLimits?.maxOrders || tenant.settings.maxOrders || 1000,
            percentage: Math.round((usage.orders / (subscriptionPlan?.limits?.maxOrders || tenant.settings.maxOrders || 1000)) * 100)
          },
          customers: {
            used: usage.customers,
            limit: subscriptionPlan?.limits?.maxCustomers || tenant.subscription.planLimits?.maxCustomers || 1000,
            percentage: Math.round((usage.customers / (subscriptionPlan?.limits?.maxCustomers || 1000)) * 100)
          },
          carriers: {
            used: usage.carriers,
            limit: subscriptionPlan?.limits?.maxCarriers || tenant.subscription.planLimits?.maxCarriers || 500,
            percentage: Math.round((usage.carriers / (subscriptionPlan?.limits?.maxCarriers || 500)) * 100)
          }
        }
      },
      company
    }
  });
});



/**
 * Update tenant settings
 */
const updateTenantSettings = catchAsync(async (req, res, next) => {
  if (!req.user.isTenantAdmin && req.user.role !== 3) {
    return next(new AppError('Only tenant administrators can update settings', 403));
  }
  const allowedUpdates = [
    'settings.customizations',
    'contactInfo.phone',
    'contactInfo.address'
  ];

  const updates = {};
  Object.keys(req.body).forEach(key => {
    if (allowedUpdates.some(allowed => key.startsWith(allowed.split('.')[0]))) {
      updates[key] = req.body[key];
    }
  });

  const tenant = await Tenant.findOneAndUpdate(
    { tenantId: req.tenantId },
    updates,
    { new: true, runValidators: true }
  );

  if (!tenant) {
    return next(new AppError('Tenant not found', 404));
  }

  logActivity(req, {
    action: 'UPDATE',
    module: 'settings',
    description: `Updated tenant settings`,
    resourceId: tenant._id,
    resourceName: tenant.name,
  });

  res.json({
    status: true,
    data: { tenant },
    message: 'Tenant settings updated successfully'
  });
});

/**
 * Get tenant usage analytics
 */
const getTenantUsage = catchAsync(async (req, res, next) => {
  const tenant = await Tenant.findOne({ tenantId: req.tenantId });
  
  if (!tenant) {
    return next(new AppError('Tenant not found', 404));
  }

  // Get subscription plan limits - same logic as other functions for consistency
  let subscriptionPlan = null;
  if (tenant.subscription.plan) {
    if (typeof tenant.subscription.plan === 'string') {
      subscriptionPlan = await SubscriptionPlan.findOne({
        $or: [
          { slug: tenant.subscription.plan },
          { name: { $regex: tenant.subscription.plan, $options: 'i' } }
        ]
      });
    } else {
      subscriptionPlan = await SubscriptionPlan.findById(tenant.subscription.plan);
    }
  }

  const currentUsage = {
    users: await User.countDocuments(User.activeFilter(req.tenantId)),
    orders: await Order.countDocuments({ tenantId: req.tenantId }),
    customers: await Customer.countDocuments({ tenantId: req.tenantId }),
    carriers: await Carrier.countDocuments({ tenantId: req.tenantId })
  };

  // Use subscription plan limits first, then fallback to tenant settings
  const limits = {
    maxUsers: subscriptionPlan?.limits?.maxUsers || tenant.subscription?.planLimits?.maxUsers || tenant.settings?.maxUsers || 10,
    maxOrders: subscriptionPlan?.limits?.maxOrders || tenant.subscription?.planLimits?.maxOrders || tenant.settings?.maxOrders || 1000,
    maxCustomers: subscriptionPlan?.limits?.maxCustomers || tenant.subscription?.planLimits?.maxCustomers || tenant.settings?.maxCustomers || 999999,
    maxCarriers: subscriptionPlan?.limits?.maxCarriers || tenant.subscription?.planLimits?.maxCarriers || tenant.settings?.maxCarriers || 999999
  };
  const utilizationPercentage = {
    users: limits.maxUsers > 0 ? (currentUsage.users / limits.maxUsers) * 100 : 0,
    orders: limits.maxOrders > 0 ? (currentUsage.orders / limits.maxOrders) * 100 : 0,
    customers: limits.maxCustomers > 0 ? (currentUsage.customers / limits.maxCustomers) * 100 : 0,
    carriers: limits.maxCarriers > 0 ? (currentUsage.carriers / limits.maxCarriers) * 100 : 0
  };

  res.json({
    status: true,
    data: {
      usage: currentUsage,
      limits,
      utilization: utilizationPercentage,
      warnings: {
        nearUserLimit: utilizationPercentage.users > 80,
        nearOrderLimit: utilizationPercentage.orders > 80
      }
    }
  });
});

/**
 * Get tenant analytics
 */
const getTenantAnalytics = catchAsync(async (req, res, next) => {
  const { period = '30d' } = req.query;
  
  // Calculate date range based on period
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

  const baseFilter = { 
    tenantId: req.tenantId,
    createdAt: { $gte: startDate }
  };

  // Allow filtering by module/type (e.g. outsourcing vs regular)
  if (req.query.type && ['outsourcing', 'regular'].includes(req.query.type)) {
    baseFilter.order_type = req.query.type;
  }

  // Get analytics data
  const [
    totalOrders,
    totalRevenue,
    newCustomers,
    newCarriers,
    recentOrders,
    ordersByStatus,
    revenueByMonth
  ] = await Promise.all([
    Order.countDocuments({ tenantId: req.tenantId, ...baseFilter }),
    Order.aggregate([
      { $match: { tenantId: req.tenantId, ...baseFilter } },
      { $group: { _id: null, total: { $sum: '$total_amount' } } }
    ]),

    Customer.countDocuments(baseFilter),

    Carrier.countDocuments(baseFilter),

    // Recent orders within the period
    Order.find({ tenantId: req.tenantId, ...baseFilter })
      .sort({ createdAt: -1 })
      .limit(10)
      .populate('customer', 'name')
      .populate('carrier', 'name')
      .lean(),

    // Orders grouped by status within the period
    Order.aggregate([
      { $match: { tenantId: req.tenantId, ...baseFilter } },
      { $group: { _id: '$order_status', count: { $sum: 1 } } }
    ]),

    Order.aggregate([
      { $match: { tenantId: req.tenantId, ...baseFilter } },
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
    ])
  ]);

  const revenue = totalRevenue.length > 0 ? totalRevenue[0].total : 0;

  res.json({
    status: true,
    data: {
      period,
      summary: {
        totalOrders,
        totalRevenue: revenue,
        newCustomers,
        newCarriers
      },
      charts: {
        ordersByStatus: ordersByStatus.map(item => ({
          status: item._id,
          count: item.count
        })),
        revenueByMonth: revenueByMonth.map(item => ({
          period: `${item._id.year}-${String(item._id.month).padStart(2, '0')}`,
          revenue: item.revenue,
          orders: item.orders
        }))
      },
      recentOrders
    }
  });
});

/**
 * Get billing information
 */
const getBillingInfo = catchAsync(async (req, res, next) => {
  const tenant = await Tenant.findOne({ tenantId: req.tenantId });
  
  if (!tenant) {
    return next(new AppError('Tenant not found', 404));
  }

  const subscriptionPlan = await SubscriptionPlan.findOne({ 
    slug: tenant.subscription.plan 
  });

  // Calculate usage-based billing (if applicable)
  const currentUsage = {
    users: await User.countDocuments(User.activeFilter(req.tenantId)),
    orders: await Order.countDocuments({ tenantId: req.tenantId })
  };

  res.json({
    status: true,
    data: {
      subscription: {
        plan: subscriptionPlan,
        status: tenant.subscription.status,
        startDate: tenant.subscription.startDate,
        endDate: tenant.subscription.endDate,
        billingCycle: tenant.subscription.billingCycle
      },
      usage: currentUsage,
      billing: tenant.billing,
      nextBillingDate: tenant.billing.nextBillingDate,
      balance: tenant.billing.balance
    }
  });
});

/**
 * Upgrade subscription plan
 */
const upgradePlan = catchAsync(async (req, res, next) => {
  const { planSlug } = req.body;
  
  const newPlan = await SubscriptionPlan.findOne({ slug: planSlug, isActive: true });
  if (!newPlan) {
    return next(new AppError('Subscription plan not found', 404));
  }

  const tenant = await Tenant.findOneAndUpdate(
    { tenantId: req.tenantId },
    {
      'subscription.plan': planSlug,
      'settings.maxUsers': newPlan.limits.maxUsers,
      'settings.maxOrders': newPlan.limits.maxOrders,
      'settings.features': newPlan.features,
      updatedAt: new Date()
    },
    { new: true }
  );

  logActivity(req, {
    action: 'UPDATE',
    module: 'settings',
    description: `Upgraded subscription plan to "${newPlan.name}"`,
    resourceId: tenant?._id,
    resourceName: newPlan.name,
    details: { planSlug },
  });

  res.json({
    status: true,
    data: { tenant },
    message: `Successfully upgraded to ${newPlan.name} plan`
  });
});

const MODULE_VALID = ['outsourcing', 'regular'];
const OUTSOURCING_PERMS = ['outsourcing', 'carriers', 'carriers_write'];

// Re-sync an admin's module permissions + allowedModules to the plan's modules.
// Feature perms (accounting/customers/employees/subadmin/invoices…) are preserved.
function adminPermsForPlan(currentPerms, planModules) {
  let next = (Array.isArray(currentPerms) ? currentPerms : []).slice();
  if (planModules.includes('regular')) { if (!next.includes('regular')) next.push('regular'); }
  else next = next.filter((p) => p !== 'regular');
  if (planModules.includes('outsourcing')) OUTSOURCING_PERMS.forEach((p) => { if (!next.includes(p)) next.push(p); });
  else next = next.filter((p) => !OUTSOURCING_PERMS.includes(p));
  return next;
}

/**
 * Public catalog of buyable plans, with the price for each billing cycle.
 * GET /api/tenant-admin/subscription/plans
 */
const getPlansCatalog = catchAsync(async (req, res) => {
  const plans = await SubscriptionPlan.find({ isActive: true }).sort({ monthlyPrice: 1 }).lean();
  const data = plans.map((p) => ({
    _id: p._id,
    name: p.name,
    slug: p.slug,
    description: p.description,
    monthlyPrice: p.monthlyPrice || 0,
    currency: p.currency || 'USD',
    discounts: p.discounts || { monthly: 0, quarterly: 0, yearly: 0 },
    limits: p.limits,
    allowedModules: p.allowedModules || [],
    features: p.features || [],
    pricing: priceMatrix(p) // [{cycle, months, base, discountPct, price, currency}]
  }));
  res.json({ status: true, data: { plans: data } });
});

/**
 * Mock checkout: buy or renew a plan for the current tenant. No real payment.
 * POST /api/tenant-admin/subscription/checkout  { planSlug, billingCycle }
 */
const checkoutSubscription = catchAsync(async (req, res, next) => {
  const { planSlug, billingCycle = 'monthly' } = req.body;
  const cycle = String(billingCycle).toLowerCase();
  if (!['monthly', 'quarterly', 'yearly'].includes(cycle)) {
    return next(new AppError('Invalid billing cycle', 400));
  }

  const plan = await SubscriptionPlan.findOne({ slug: planSlug, isActive: true });
  if (!plan) return next(new AppError('Subscription plan not found', 404));

  const tenant = await Tenant.findOne({ tenantId: req.tenantId });
  if (!tenant) return next(new AppError('Tenant not found', 404));

  const { price, discountPct, currency } = computeCyclePrice(plan, cycle);
  const startDate = new Date();
  const endDate = computeEndDate(startDate, cycle);
  const planModules = (plan.allowedModules || MODULE_VALID)
    .map((m) => String(m).toLowerCase()).filter((m) => MODULE_VALID.includes(m));

  // Decide the action label for history.
  const wasActive = isSubscriptionActive(tenant);
  const prevSlug = tenant.subscription?.planSlug;
  const action = !wasActive ? 'buy' : (prevSlug === plan.slug ? 'renew' : 'upgrade');

  // Apply the subscription via a targeted update. We intentionally do NOT use
  // tenant.save() — that would run full-document validation and fail on unrelated
  // legacy fields (e.g. a missing/invalid contactInfo on older tenants).
  await Tenant.updateOne(
    { tenantId: req.tenantId },
    {
      $set: {
        'subscription.plan': plan._id,
        'subscription.planSlug': plan.slug,
        'subscription.status': 'active',
        'subscription.startDate': startDate,
        'subscription.endDate': endDate,
        'subscription.billingCycle': cycle,
        'subscription.planLimits': {
          maxUsers: plan.limits.maxUsers,
          maxOrders: plan.limits.maxOrders,
          maxCustomers: plan.limits.maxCustomers,
          maxCarriers: plan.limits.maxCarriers
        },
        'subscription.planFeatures': plan.features,
        'subscription.allowedModules': planModules,
        'settings.maxUsers': plan.limits.maxUsers,
        'settings.maxOrders': plan.limits.maxOrders,
        'settings.features': plan.features
      },
      $unset: { 'subscription.legacyPlan': '' }
    }
  );

  // Re-sync tenant admins so module access matches the new plan.
  const admins = await User.find({ tenantId: req.tenantId, $or: [{ is_admin: 1 }, { role: 3 }] });
  for (const admin of admins) {
    admin.permissions = adminPermsForPlan(admin.permissions, planModules);
    admin.allowedModules = planModules;
    await admin.save();
  }

  // Record history (mock payment).
  const paymentRef = `MOCK-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  await SubscriptionHistory.create({
    tenantId: req.tenantId,
    action,
    plan: plan._id,
    planSlug: plan.slug,
    planName: plan.name,
    billingCycle: cycle,
    amount: price,
    currency,
    discountPct,
    startDate,
    endDate,
    paymentStatus: price > 0 ? 'paid' : 'free',
    paymentRef,
    performedBy: req.user?._id,
    performedByName: req.user?.name,
    note: `${action} ${plan.name} (${cycle})`
  });

  logActivity(req, {
    action: 'UPDATE',
    module: 'settings',
    description: `${action === 'buy' ? 'Purchased' : action === 'renew' ? 'Renewed' : 'Changed to'} "${plan.name}" plan (${cycle})`,
    resourceId: tenant._id,
    resourceName: plan.name,
    details: { planSlug: plan.slug, billingCycle: cycle, amount: price },
  });

  res.json({
    status: true,
    message: `Subscription ${action === 'buy' ? 'activated' : action === 'renew' ? 'renewed' : 'updated'} — ${plan.name} (${cycle}).`,
    data: {
      planName: plan.name,
      planSlug: plan.slug,
      billingCycle: cycle,
      amount: price,
      currency,
      startDate,
      endDate,
      paymentRef
    }
  });
});

/**
 * Subscription purchase history for the current tenant.
 * GET /api/tenant-admin/subscription/history
 */
const getSubscriptionHistory = catchAsync(async (req, res) => {
  const history = await SubscriptionHistory.find({ tenantId: req.tenantId })
    .sort({ createdAt: -1 })
    .limit(100)
    .lean();
  res.json({ status: true, data: { history } });
});

/**
 * Get tenant users
 */
const getTenantUsers = catchAsync(async (req, res, next) => {
  const { page = 1, limit = 10, search, q, role } = req.query;
  const searchText = (search || q || '').toString().trim();
  
  // Start with active users filter
  const filter = User.activeFilter(req.tenantId);
  if (searchText) {
    const safeSearchText = escapeRegex(searchText);
    filter.$or = [
      { name: { $regex: safeSearchText, $options: 'i' } },
      { email: { $regex: safeSearchText, $options: 'i' } },
      { corporateID: { $regex: safeSearchText, $options: 'i' } }
    ];
  }
  if (role && role !== 'all') {
    filter.role = parseInt(role);
  }

  const users = await User.find(filter)
    .select('-password')
    .sort({ createdAt: -1 })
    .limit(limit * 1)
    .skip((page - 1) * limit);

  const total = await User.countDocuments(filter);

  res.json({
    status: true,
    data: {
      users,
      pagination: {
        currentPage: parseInt(page),
        totalPages: Math.ceil(total / limit),
        totalItems: total,
        itemsPerPage: parseInt(limit)
      }
    }
  });
});

const updateUserModules = catchAsync(async (req, res, next) => {
  if (!req.user.isTenantAdmin && req.user.role !== 3 && req.user.is_admin !== 1) {
    return next(new AppError('Only tenant administrators can update user permissions', 403));
  }

  const tenantId = req.tenantId;
  if (!tenantId) return next(new AppError('Tenant context required', 400));

  const raw = req.body?.permissions ?? req.body?.allowedModules;
  if (!Array.isArray(raw) || raw.length === 0) {
    return next(new AppError('Please select at least one permission', 400));
  }

  // All assignable permissions — order modules + feature areas
  const VALID_PERMISSIONS = ['outsourcing', 'regular', 'accounting', 'customers', 'customers_write', 'carriers', 'carriers_write', 'employees', 'subadmin', 'invoices'];
  const requested = raw
    .map((m) => String(m).toLowerCase().trim())
    .filter((m) => VALID_PERMISSIONS.includes(m));

  if (requested.length === 0) {
    return next(new AppError('Invalid permissions provided', 400));
  }

  // Only admins can assign 'employees' permission
  const callerIsAdmin = req.user.is_admin === 1 || req.user.role === 3;
  const filtered = requested.filter(p => p !== 'employees' || callerIsAdmin);

  const criteria = { _id: req.params.id, tenantId };

  // Determine which order modules are active (for allowedModules field sync)
  const orderModules = ['outsourcing', 'regular'].filter(m => filtered.includes(m));
  const isCustomized = orderModules.length > 0;

  const user = await User.findOneAndUpdate(
    criteria,
    {
      permissions: filtered,
      allowedModules: orderModules,
      modulesCustomized: isCustomized
    },
    { new: true, runValidators: true }
  ).select('-password');

  if (!user) {
    return next(new AppError('User not found', 404));
  }

  logActivity(req, {
    action: 'UPDATE',
    module: 'employee',
    description: `Updated permissions for user "${user.name}"`,
    resourceId: user._id,
    resourceName: user.name,
    details: { permissions: filtered },
  });

  res.json({
    status: true,
    data: { user },
    message: 'User permissions updated successfully'
  });
});

/**
 * Invite user to tenant
 */
const inviteUser = catchAsync(async (req, res, next) => {
  if (!req.user.isTenantAdmin && req.user.role !== 3) {
    return next(new AppError('Only tenant administrators can invite users', 403));
  }

  const { name, email, role, position, allowedModules: requestedModulesRaw } = req.body;
  
  // Check if user already exists (scoped to admin's company — same email may
  // exist in a different company of the same tenant)
  const inviteCompanyId = req.user?.company?._id || req.user?.company || null;
  const existingUser = await User.findOne({
    email,
    tenantId: req.tenantId,
    ...(inviteCompanyId ? { company: inviteCompanyId } : {}),
  });
  if (existingUser) {
    return next(new AppError('User with this email already exists in your organization', 400));
  }

  // Enforce max users limit
  const tenant = await Tenant.findOne({ tenantId: req.tenantId }).select('settings.maxUsers');
  const currentUsers = await User.countDocuments(User.activeFilter(req.tenantId));
  const maxUsersLimit = tenant?.settings?.maxUsers ?? 10;
  if (currentUsers >= maxUsersLimit) {
    return next(new AppError(`User limit reached (${maxUsersLimit}). Upgrade plan to add more users.`, 403));
  }

  // Generate temporary password
  const tempPassword = Math.random().toString(36).substring(2, 15);
  const hashedPassword = await bcrypt.hash(tempPassword, 12);

  const companyId = req.user?.company?._id || req.user?.company || null;
  const company = companyId ? await Company.findOne({ _id: companyId, tenantId: req.tenantId }) : await Company.findOne({ tenantId: req.tenantId });
  if (!company) {
    return next(new AppError('Company details are not set up yet. Please add company details first.', 400));
  }

  const valid = ['outsourcing', 'regular'];
  const sanitize = (arr) => (Array.isArray(arr) ? arr.map((m) => String(m).toLowerCase().trim()).filter((m) => valid.includes(m)) : []);

  const tenantForModules = await Tenant.findOne({ tenantId: req.tenantId })
    .select('subscription.plan subscription.planSlug subscription.legacyPlan subscription.allowedModules')
    .lean();

  let planModules = sanitize(tenantForModules?.subscription?.allowedModules);
  if (!planModules.length) {
    const planSlug = tenantForModules?.subscription?.planSlug || tenantForModules?.subscription?.legacyPlan || null;
    const planRef = tenantForModules?.subscription?.plan;
    let planRecord = null;
    if (planSlug) planRecord = await SubscriptionPlan.findOne({ slug: planSlug }).select('allowedModules').lean();
    else if (typeof planRef === 'string') planRecord = await SubscriptionPlan.findOne({ slug: planRef }).select('allowedModules').lean();
    else if (planRef) planRecord = await SubscriptionPlan.findById(planRef).select('allowedModules').lean();
    planModules = sanitize(planRecord?.allowedModules);
  }
  if (!planModules.length) planModules = ['outsourcing'];

  const requestedModules = sanitize(requestedModulesRaw);
  const effectiveModules = requestedModules.length
    ? requestedModules.filter((m) => planModules.includes(m))
    : planModules;

  if (!effectiveModules.length) {
    return next(new AppError('Selected modules are not enabled for this company', 400));
  }

  // Default permissions by role — read-only by default, admin manually grants write
  const DEFAULT_PERMISSIONS_BY_ROLE = {
    0: ['driver'],
    1: ['regular', 'outsourcing', 'customers', 'carriers', 'invoices'],
    2: ['accounting', 'customers', 'carriers', 'invoices'],
    3: ['regular', 'outsourcing', 'accounting', 'customers', 'customers_write', 'carriers', 'carriers_write', 'employees', 'subadmin', 'invoices'],
  };
  const defaultPermissions = DEFAULT_PERMISSIONS_BY_ROLE[parseInt(role)] || [];

  const user = await User.create({
    tenantId: req.tenantId,
    company: company._id,
    name,
    email,
    password: hashedPassword,
    phone: 'N/A',
    country: 'N/A',
    address: 'N/A',
    role: parseInt(role),
    position,
    corporateID: `USER_${Date.now()}`,
    created_by: req.user._id,
    permissions: defaultPermissions,
    allowedModules: effectiveModules,
    modulesCustomized: requestedModules.length > 0 && effectiveModules.length !== planModules.length
  });

  // Remove password from response
  user.password = undefined;

  // Send invitation email (implement email service)
  // await sendUserInvitationEmail(user, tempPassword);

  logActivity(req, {
    action: 'CREATE',
    module: 'employee',
    description: `Invited user "${user.name}" (${user.email})`,
    resourceId: user._id,
    resourceName: user.name,
  });

  res.status(201).json({
    status: true,
    data: { user, tempPassword },
    message: 'User invited successfully. Invitation email sent.'
  });
});

/**
 * Update user role
 */
const updateUserRole = catchAsync(async (req, res, next) => {
  if (!req.user.isTenantAdmin && req.user.role !== 3) {
    return next(new AppError('Only tenant administrators can update user roles', 403));
  }

  const { role, position } = req.body;
  
  const user = await User.findOneAndUpdate(
    { _id: req.params.id, tenantId: req.tenantId },
    { role: parseInt(role), position },
    { new: true }
  ).select('-password');

  if (!user) {
    return next(new AppError('User not found', 404));
  }

  logActivity(req, {
    action: 'UPDATE',
    module: 'employee',
    description: `Updated role for user "${user.name}" to role ${role}`,
    resourceId: user._id,
    resourceName: user.name,
    details: { role, position },
  });

  res.json({
    status: true,
    data: { user },
    message: 'User role updated successfully'
  });
});

/**
 * Remove user from tenant
 */
const removeUser = catchAsync(async (req, res, next) => {
  if (!req.user.isTenantAdmin && req.user.role !== 3) {
    return next(new AppError('Only tenant administrators can remove users', 403));
  }

  const user = await User.findOne(
    { _id: req.params.id, tenantId: req.tenantId },
    null,
    { includeInactive: true }
  );

  if (!user) {
    return next(new AppError('User not found', 404));
  }

  const deletedAt = new Date();
  // Free the email so it can be re-used for a new user in this company
  if (user.email && !user.email.startsWith('deleted_')) {
    user.email = `deleted_${deletedAt.getTime()}_${user.email}`;
  }
  user.status = 'inactive';
  user.deletedAt = deletedAt;
  await user.save({ validateBeforeSave: false });

  logActivity(req, {
    action: 'DELETE',
    module: 'employee',
    description: `Removed user "${user.name}" (${user.email})`,
    resourceId: user._id,
    resourceName: user.name,
  });

  res.json({
    status: true,
    message: 'User removed successfully'
  });
});

/**
 * Get integrations (placeholder)
 */
const getIntegrations = catchAsync(async (req, res, next) => {
  res.json({
    status: true,
    data: {
      integrations: [],
      message: 'Integration management to be implemented'
    }
  });
});

/**
 * Configure integration (placeholder)
 */
const configureIntegration = catchAsync(async (req, res, next) => {
  res.json({
    status: true,
    message: 'Integration configuration to be implemented'
  });
});

/**
 * Remove integration (placeholder)
 */
const removeIntegration = catchAsync(async (req, res, next) => {
  res.json({
    status: true,
    message: 'Integration removal to be implemented'
  });
});

/**
 * Get orders report
 */
const getOrdersReport = catchAsync(async (req, res, next) => {
  const { startDate, endDate, format = 'json' } = req.query;
  
  const filter = { tenantId: req.tenantId };
  if (startDate || endDate) {
    filter.createdAt = {};
    if (startDate) filter.createdAt.$gte = new Date(startDate);
    if (endDate) filter.createdAt.$lte = new Date(endDate);
  }

  const orders = await Order.find(filter)
    .populate('customer', 'name email')
    .populate('carrier', 'name mc_code')
    .sort({ createdAt: -1 })
    .lean();

  res.json({
    status: true,
    data: { orders, count: orders.length }
  });
});

/**
 * Get customers report
 */
const getCustomersReport = catchAsync(async (req, res, next) => {
  const customers = await Customer.find({ tenantId: req.tenantId })
    .sort({ createdAt: -1 })
    .lean();

  res.json({
    status: true,
    data: { customers, count: customers.length }
  });
});

/**
 * Get carriers report
 */
const getCarriersReport = catchAsync(async (req, res, next) => {
  const carriers = await Carrier.find({ tenantId: req.tenantId })
    .sort({ createdAt: -1 })
    .lean();

  res.json({
    status: true,
    data: { carriers, count: carriers.length }
  });
});

/**
 * Get financial report
 */
const getFinancialReport = catchAsync(async (req, res, next) => {
  const { startDate, endDate } = req.query;
  
  const filter = { tenantId: req.tenantId };
  if (startDate || endDate) {
    filter.createdAt = {};
    if (startDate) filter.createdAt.$gte = new Date(startDate);
    if (endDate) filter.createdAt.$lte = new Date(endDate);
  }

  const financialData = await Order.aggregate([
    { $match: filter },
    {
      $group: {
        _id: null,
        totalRevenue: { $sum: '$total_amount' },
        totalCarrierCost: { $sum: '$carrier_amount' },
        totalOrders: { $sum: 1 },
        averageOrderValue: { $avg: '$total_amount' }
      }
    }
  ]);

  const result = financialData[0] || {
    totalRevenue: 0,
    totalCarrierCost: 0,
    totalOrders: 0,
    averageOrderValue: 0
  };

  result.grossProfit = result.totalRevenue - result.totalCarrierCost;
  result.profitMargin = result.totalRevenue > 0 ? 
    (result.grossProfit / result.totalRevenue) * 100 : 0;

  res.json({
    status: true,
    data: { financial: result }
  });
});

/**
 * Export data (placeholder)
 */
const exportData = catchAsync(async (req, res, next) => {
  res.json({
    status: true,
    message: 'Data export functionality to be implemented'
  });
});

// ---------------------------------------------------------------------------
// Finance Report helpers
// ---------------------------------------------------------------------------

const normalizeDeletedFilter = () => ({ deletedAt: { $exists: false } });

const resolveDateRange = (period, startDateParam, endDateParam) => {
  if (startDateParam || endDateParam) {
    return {
      from: startDateParam ? new Date(startDateParam) : new Date(0),
      to: endDateParam ? new Date(endDateParam) : new Date()
    };
  }
  const to = new Date();
  const from = new Date();
  switch (period) {
    case '60d': from.setDate(from.getDate() - 60); break;
    case '90d': from.setDate(from.getDate() - 90); break;
    case '6m':  from.setMonth(from.getMonth() - 6); break;
    case '1y':  from.setFullYear(from.getFullYear() - 1); break;
    default:    from.setDate(from.getDate() - 30); // 30d default
  }
  return { from, to };
};

const routeFromShipping = (shipping) => {
  const blocks = Array.isArray(shipping) ? shipping : [];
  const locs = blocks.flatMap(b => Array.isArray(b?.locations) ? b.locations : []);
  const pickup = locs.find(l => String(l?.type || '').toLowerCase() === 'pickup') || locs[0];
  const delivery = [...locs].reverse().find(l => String(l?.type || '').toLowerCase() === 'delivery') || locs[locs.length - 1];
  const from = (pickup?.city || pickup?.location || pickup?.address || '').trim();
  const to = (delivery?.city || delivery?.location || delivery?.address || '').trim();
  return from && to ? `${from} → ${to}` : from || to || '—';
};

/**
 * GET /api/tenant-admin/finance/report
 * Query: type (outsourcing|regular), period (30d|60d|90d|6m|1y), startDate, endDate
 */
const getFinanceReport = catchAsync(async (req, res, next) => {
  const { type = 'outsourcing', period = '30d', startDate, endDate } = req.query;

  if (!['outsourcing', 'regular'].includes(type)) {
    return next(new AppError('type must be "outsourcing" or "regular"', 400));
  }

  const dateRange = resolveDateRange(period, startDate, endDate);

  const baseFilter = {
    tenantId: req.tenantId,
    order_type: type,
    ...normalizeDeletedFilter(),
    createdAt: { $gte: dateRange.from, $lte: dateRange.to }
  };

  if (type === 'outsourcing') {
    const orders = await Order.find(baseFilter)
      .populate('customer', 'name')
      .populate('carrier', 'name mc_code')
      .populate('truck', 'unitNumber plateNumber')
      .populate('created_by', 'name staff_commision')
      .select('serial_no customer_order_no total_amount carrier_amount owner_profit order_status customer_payment_status carrier_payment_status createdAt shipping_details customer carrier truck created_by')
      .sort({ createdAt: -1 })
      .lean();

    let totalRevenue = 0, totalCarrierCost = 0, totalCommission = 0;
    let pendingCustomerAmt = 0, pendingCustomerCount = 0;
    let pendingCarrierAmt = 0, pendingCarrierCount = 0;
    let paidCustomerAmt = 0, paidCarrierAmt = 0;

    for (const o of orders) {
      const rev = Number(o.total_amount) || 0;
      const cost = Number(o.carrier_amount) || 0;
      // Net profit = revenue - carrier cost. Commission comes out of that net profit.
      const netProfit = rev - cost;
      const rate = Number(o.created_by?.staff_commision) || 0;
      const commission = netProfit * (rate / 100);
      o.commission = commission;
      o.profit = netProfit - commission;
      totalRevenue += rev;
      totalCarrierCost += cost;
      totalCommission += commission;
      if (o.customer_payment_status !== 'paid') {
        pendingCustomerAmt += rev;
        pendingCustomerCount++;
      } else {
        paidCustomerAmt += rev;
      }
      if (o.carrier_payment_status !== 'paid') {
        pendingCarrierAmt += cost;
        pendingCarrierCount++;
      } else {
        paidCarrierAmt += cost;
      }
    }

    const grossProfit = totalRevenue - totalCarrierCost;
    const netProfit = grossProfit - totalCommission;
    const profitMargin = totalRevenue > 0 ? ((netProfit / totalRevenue) * 100).toFixed(2) : '0.00';

    return res.json({
      status: true,
      data: {
        type,
        period,
        dateRange: { from: dateRange.from, to: dateRange.to },
        summary: {
          totalOrders: orders.length,
          totalRevenue,
          totalCarrierCost,
          totalCommission,
          grossProfit,
          netProfit,
          profitMargin: parseFloat(profitMargin),
          pendingCustomerAmt,
          pendingCustomerCount,
          pendingCarrierAmt,
          pendingCarrierCount,
          paidCustomerAmt,
          paidCarrierAmt
        },
        orders
      }
    });
  }

  // regular
  const orders = await Order.find(baseFilter)
    .populate('customer', 'name')
    .populate('truck', 'unitNumber plateNumber')
    .populate('ownerOperator', 'fullName ownerOperatorId')
    .select('serial_no customer_order_no total_amount settle_amount owner_profit isOwnerOperatedTruck order_status customer_payment_status createdAt shipping_details customer truck ownerOperator')
    .sort({ createdAt: -1 })
    .lean();

  let totalRevenue = 0;
  let ownerOperatorOrders = 0, ownerOperatorSettlement = 0, ownerOperatorProfit = 0;
  let companyDriverOrders = 0, companyDriverRevenue = 0, totalProfit = 0;

  for (const o of orders) {
    const rev = Number(o.total_amount) || 0;
    totalRevenue += rev;
    totalProfit += Number(o.owner_profit) || 0;
    if (o.isOwnerOperatedTruck) {
      ownerOperatorOrders++;
      ownerOperatorSettlement += Number(o.settle_amount) || 0;
      ownerOperatorProfit += Number(o.owner_profit) || 0;
    } else {
      companyDriverOrders++;
      companyDriverRevenue += rev;
    }
  }

  return res.json({
    status: true,
    data: {
      type,
      period,
      dateRange: { from: dateRange.from, to: dateRange.to },
      summary: {
        totalOrders: orders.length,
        totalRevenue,
        ownerOperatorOrders,
        ownerOperatorSettlement,
        ownerOperatorProfit,
        companyDriverOrders,
        companyDriverRevenue,
        totalProfit
      },
      orders
    }
  });
});

/**
 * GET /api/tenant-admin/finance/report/pdf
 * Same query params as getFinanceReport — returns a PDF file
 */
const getFinanceReportPdf = catchAsync(async (req, res, next) => {
  const puppeteer = require('puppeteer');

  const { type = 'outsourcing', period = '30d', startDate, endDate } = req.query;

  if (!['outsourcing', 'regular'].includes(type)) {
    return next(new AppError('type must be "outsourcing" or "regular"', 400));
  }

  const dateRange = resolveDateRange(period, startDate, endDate);

  const baseFilter = {
    tenantId: req.tenantId,
    order_type: type,
    ...normalizeDeletedFilter(),
    createdAt: { $gte: dateRange.from, $lte: dateRange.to }
  };

  // Fetch orders
  let orders = [];
  let summary = {};

  if (type === 'outsourcing') {
    orders = await Order.find(baseFilter)
      .populate('customer', 'name')
      .populate('carrier', 'name mc_code')
      .populate('truck', 'unitNumber plateNumber')
      .populate('created_by', 'name staff_commision')
      .select('serial_no customer_order_no total_amount carrier_amount owner_profit order_status customer_payment_status carrier_payment_status createdAt shipping_details customer carrier truck created_by')
      .sort({ createdAt: -1 })
      .lean();

    let totalRevenue = 0, totalCarrierCost = 0, totalCommission = 0;
    let pendingCustomerAmt = 0, pendingCustomerCount = 0;
    let pendingCarrierAmt = 0, pendingCarrierCount = 0;
    let paidCustomerAmt = 0, paidCarrierAmt = 0;

    for (const o of orders) {
      const rev = Number(o.total_amount) || 0;
      const cost = Number(o.carrier_amount) || 0;
      // Net profit = revenue - carrier cost. Commission comes out of that net profit.
      const netProfit = rev - cost;
      const rate = Number(o.created_by?.staff_commision) || 0;
      const commission = netProfit * (rate / 100);
      o.commission = commission;
      o.profit = netProfit - commission;
      totalRevenue += rev;
      totalCarrierCost += cost;
      totalCommission += commission;
      if (o.customer_payment_status !== 'paid') { pendingCustomerAmt += rev; pendingCustomerCount++; }
      else { paidCustomerAmt += rev; }
      if (o.carrier_payment_status !== 'paid') { pendingCarrierAmt += cost; pendingCarrierCount++; }
      else { paidCarrierAmt += cost; }
    }

    const grossProfit = totalRevenue - totalCarrierCost;
    const netProfit = grossProfit - totalCommission;
    const profitMargin = totalRevenue > 0 ? ((netProfit / totalRevenue) * 100).toFixed(2) : '0.00';

    summary = {
      totalOrders: orders.length, totalRevenue, totalCarrierCost, totalCommission,
      grossProfit, netProfit, profitMargin: parseFloat(profitMargin),
      pendingCustomerAmt, pendingCustomerCount, pendingCarrierAmt, pendingCarrierCount,
      paidCustomerAmt, paidCarrierAmt
    };
  } else {
    orders = await Order.find(baseFilter)
      .populate('customer', 'name')
      .populate('truck', 'unitNumber plateNumber')
      .populate('ownerOperator', 'fullName ownerOperatorId')
      .select('serial_no customer_order_no total_amount settle_amount owner_profit isOwnerOperatedTruck order_status customer_payment_status createdAt shipping_details customer truck ownerOperator')
      .sort({ createdAt: -1 })
      .lean();

    let totalRevenue = 0, ownerOperatorOrders = 0, ownerOperatorSettlement = 0;
    let ownerOperatorProfit = 0, companyDriverOrders = 0, companyDriverRevenue = 0, totalProfit = 0;

    for (const o of orders) {
      const rev = Number(o.total_amount) || 0;
      totalRevenue += rev;
      totalProfit += Number(o.owner_profit) || 0;
      if (o.isOwnerOperatedTruck) {
        ownerOperatorOrders++;
        ownerOperatorSettlement += Number(o.settle_amount) || 0;
        ownerOperatorProfit += Number(o.owner_profit) || 0;
      } else {
        companyDriverOrders++;
        companyDriverRevenue += rev;
      }
    }

    summary = {
      totalOrders: orders.length, totalRevenue, ownerOperatorOrders,
      ownerOperatorSettlement, ownerOperatorProfit, companyDriverOrders,
      companyDriverRevenue, totalProfit
    };
  }

  // HTML helpers
  const safe = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const fmt = (n) => `$${(Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const fmtDate = (d) => d ? new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—';

  const companyName = req.tenant?.settings?.customizations?.branding?.companyName || req.tenant?.name || 'Company';
  const logo = req.tenant?.settings?.customizations?.theme?.logo || '';
  const address = req.tenant?.contactInfo?.address || '';
  const email = req.tenant?.contactInfo?.adminEmail || '';
  const phone = req.tenant?.contactInfo?.phone || '';
  const generatedDate = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const periodLabel = period === '30d' ? 'Last 30 Days' : period === '60d' ? 'Last 60 Days' : period === '90d' ? 'Last 90 Days' : period === '6m' ? 'Last 6 Months' : period === '1y' ? 'Last 1 Year' : period;
  const typeLabel = type === 'outsourcing' ? 'Outsourcing' : 'Regular (Fleet)';

  // Summary stat boxes HTML
  let summaryBoxesHtml = '';
  if (type === 'outsourcing') {
    const boxes = [
      { label: 'Total Revenue', value: fmt(summary.totalRevenue), bg: '#dbeafe', border: '#3b82f6', text: '#1e40af' },
      { label: 'Carrier Cost', value: fmt(summary.totalCarrierCost), bg: '#fee2e2', border: '#ef4444', text: '#991b1b' },
      { label: 'Commission', value: fmt(summary.totalCommission), bg: '#fef3c7', border: '#f59e0b', text: '#92400e' },
      { label: 'Net Profit', value: fmt(summary.netProfit), bg: '#dcfce7', border: '#22c55e', text: '#15803d' },
      { label: 'Profit Margin', value: `${summary.profitMargin}%`, bg: '#f3e8ff', border: '#a855f7', text: '#7e22ce' },
      { label: 'Pending (Customer)', value: fmt(summary.pendingCustomerAmt), bg: '#ffedd5', border: '#f97316', text: '#9a3412' },
      { label: 'Pending (Carrier)', value: fmt(summary.pendingCarrierAmt), bg: '#fef3c7', border: '#f59e0b', text: '#92400e' }
    ];
    summaryBoxesHtml = boxes.map(b => `
      <div style="background:${b.bg};border:1.5px solid ${b.border};border-radius:8px;padding:14px 16px;min-width:130px;flex:1;">
        <div style="font-size:10px;color:${b.text};font-weight:600;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:6px;">${b.label}</div>
        <div style="font-size:18px;font-weight:700;color:${b.text};">${b.value}</div>
      </div>`).join('');
  } else {
    const boxes = [
      { label: 'Total Revenue', value: fmt(summary.totalRevenue), bg: '#dbeafe', border: '#3b82f6', text: '#1e40af' },
      { label: 'Total Profit', value: fmt(summary.totalProfit), bg: '#dcfce7', border: '#22c55e', text: '#15803d' },
      { label: 'OO Orders', value: String(summary.ownerOperatorOrders), bg: '#f3e8ff', border: '#a855f7', text: '#7e22ce' },
      { label: 'OO Settlement', value: fmt(summary.ownerOperatorSettlement), bg: '#ffedd5', border: '#f97316', text: '#9a3412' },
      { label: 'Driver Orders', value: String(summary.companyDriverOrders), bg: '#fef3c7', border: '#f59e0b', text: '#92400e' },
      { label: 'Driver Revenue', value: fmt(summary.companyDriverRevenue), bg: '#e0f2fe', border: '#0ea5e9', text: '#075985' }
    ];
    summaryBoxesHtml = boxes.map(b => `
      <div style="background:${b.bg};border:1.5px solid ${b.border};border-radius:8px;padding:14px 16px;min-width:130px;flex:1;">
        <div style="font-size:10px;color:${b.text};font-weight:600;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:6px;">${b.label}</div>
        <div style="font-size:18px;font-weight:700;color:${b.text};">${b.value}</div>
      </div>`).join('');
  }

  // Table rows HTML
  let tableHeaderHtml = '';
  let tableRowsHtml = '';
  let tableFooterHtml = '';

  if (type === 'outsourcing') {
    tableHeaderHtml = `
      <tr>
        <th>Order #</th>
        <th>Date</th>
        <th>Customer</th>
        <th>Carrier</th>
        <th>Route</th>
        <th>Revenue</th>
        <th>Carrier Cost</th>
        <th>Commission</th>
        <th>Profit</th>
        <th>Cust. Payment</th>
        <th>Carrier Payment</th>
      </tr>`;

    tableRowsHtml = orders.map((o, i) => {
      const bg = i % 2 === 0 ? '#ffffff' : '#f0f4ff';
      const custPayBadge = o.customer_payment_status === 'paid'
        ? `<span style="background:#dcfce7;color:#15803d;padding:2px 8px;border-radius:12px;font-size:10px;font-weight:600;">Paid</span>`
        : `<span style="background:#fee2e2;color:#991b1b;padding:2px 8px;border-radius:12px;font-size:10px;font-weight:600;">${safe(o.customer_payment_status || 'Pending')}</span>`;
      const carrPayBadge = o.carrier_payment_status === 'paid'
        ? `<span style="background:#dcfce7;color:#15803d;padding:2px 8px;border-radius:12px;font-size:10px;font-weight:600;">Paid</span>`
        : `<span style="background:#fee2e2;color:#991b1b;padding:2px 8px;border-radius:12px;font-size:10px;font-weight:600;">${safe(o.carrier_payment_status || 'Pending')}</span>`;
      return `<tr style="background:${bg};">
        <td>${safe(o.serial_no || o.customer_order_no || '—')}</td>
        <td>${fmtDate(o.createdAt)}</td>
        <td>${safe(o.customer?.name || '—')}</td>
        <td>${safe(o.carrier?.name || '—')}</td>
        <td style="max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${safe(routeFromShipping(o.shipping_details))}</td>
        <td>${fmt(o.total_amount)}</td>
        <td>${fmt(o.carrier_amount)}</td>
        <td>${fmt(o.commission)}</td>
        <td>${fmt(o.profit)}</td>
        <td>${custPayBadge}</td>
        <td>${carrPayBadge}</td>
      </tr>`;
    }).join('');

    tableFooterHtml = `
      <tr style="background:#1e3a5f;color:#fff;font-weight:700;">
        <td colspan="5" style="color:#fff;">TOTALS (${orders.length} orders)</td>
        <td style="color:#fff;">${fmt(summary.totalRevenue)}</td>
        <td style="color:#fff;">${fmt(summary.totalCarrierCost)}</td>
        <td style="color:#fff;">${fmt(summary.totalCommission)}</td>
        <td style="color:#fff;">${fmt(summary.netProfit)}</td>
        <td colspan="2" style="color:#fff;"></td>
      </tr>`;
  } else {
    tableHeaderHtml = `
      <tr>
        <th>Order #</th>
        <th>Date</th>
        <th>Customer</th>
        <th>Type</th>
        <th>Truck</th>
        <th>Route</th>
        <th>Revenue</th>
        <th>Settlement</th>
        <th>Profit</th>
        <th>Payment</th>
      </tr>`;

    tableRowsHtml = orders.map((o, i) => {
      const bg = i % 2 === 0 ? '#ffffff' : '#f0f4ff';
      const orderType = o.isOwnerOperatedTruck
        ? `<span style="background:#f3e8ff;color:#7e22ce;padding:2px 8px;border-radius:12px;font-size:10px;font-weight:600;">OO</span>`
        : `<span style="background:#e0f2fe;color:#075985;padding:2px 8px;border-radius:12px;font-size:10px;font-weight:600;">Driver</span>`;
      const payBadge = o.customer_payment_status === 'paid'
        ? `<span style="background:#dcfce7;color:#15803d;padding:2px 8px;border-radius:12px;font-size:10px;font-weight:600;">Paid</span>`
        : `<span style="background:#fee2e2;color:#991b1b;padding:2px 8px;border-radius:12px;font-size:10px;font-weight:600;">${safe(o.customer_payment_status || 'Pending')}</span>`;
      const truckInfo = o.truck ? safe(`${o.truck.unitNumber || ''} ${o.truck.plateNumber ? '(' + o.truck.plateNumber + ')' : ''}`.trim()) : '—';
      return `<tr style="background:${bg};">
        <td>${safe(o.serial_no || o.customer_order_no || '—')}</td>
        <td>${fmtDate(o.createdAt)}</td>
        <td>${safe(o.customer?.name || '—')}</td>
        <td>${orderType}</td>
        <td>${truckInfo}</td>
        <td style="max-width:100px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${safe(routeFromShipping(o.shipping_details))}</td>
        <td>${fmt(o.total_amount)}</td>
        <td>${fmt(o.settle_amount)}</td>
        <td>${fmt(o.owner_profit)}</td>
        <td>${payBadge}</td>
      </tr>`;
    }).join('');

    tableFooterHtml = `
      <tr style="background:#1e3a5f;color:#fff;font-weight:700;">
        <td colspan="6" style="color:#fff;">TOTALS (${orders.length} orders)</td>
        <td style="color:#fff;">${fmt(summary.totalRevenue)}</td>
        <td style="color:#fff;">${fmt(summary.ownerOperatorSettlement)}</td>
        <td style="color:#fff;">${fmt(summary.totalProfit)}</td>
        <td style="color:#fff;"></td>
      </tr>`;
  }

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Finance Report</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Segoe UI', Arial, sans-serif; font-size: 12px; color: #1f2937; background: #f9fafb; }
    .page { padding: 32px 36px; max-width: 1100px; margin: 0 auto; background: #fff; }

    /* Header */
    .header {
      background: linear-gradient(135deg, #1e3a5f 0%, #1e40af 100%);
      border-radius: 10px;
      padding: 28px 32px;
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      margin-bottom: 28px;
      color: #fff;
    }
    .header-left { display: flex; align-items: center; gap: 16px; }
    .header-logo { width: 56px; height: 56px; object-fit: contain; border-radius: 6px; background: rgba(255,255,255,0.15); padding: 6px; }
    .header-company-name { font-size: 22px; font-weight: 700; letter-spacing: -0.02em; }
    .header-company-sub { font-size: 11px; opacity: 0.75; margin-top: 3px; }
    .header-right { text-align: right; }
    .report-title-box {
      background: rgba(255,255,255,0.12);
      border: 1px solid rgba(255,255,255,0.25);
      border-radius: 8px;
      padding: 14px 20px;
      text-align: right;
    }
    .report-title { font-size: 18px; font-weight: 800; letter-spacing: 0.08em; text-transform: uppercase; }
    .report-meta { font-size: 10.5px; opacity: 0.85; margin-top: 6px; line-height: 1.7; }

    /* Section title */
    .section-title { font-size: 12px; font-weight: 700; color: #1e3a5f; text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 12px; margin-top: 24px; border-left: 3px solid #1e40af; padding-left: 10px; }

    /* Summary boxes */
    .summary-grid { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 28px; }

    /* Table */
    .table-wrap { overflow-x: auto; border-radius: 8px; border: 1px solid #e5e7eb; margin-bottom: 28px; }
    table { width: 100%; border-collapse: collapse; font-size: 11px; }
    thead tr { background: #1e3a5f; }
    thead th {
      color: #fff;
      font-weight: 600;
      padding: 11px 12px;
      text-align: left;
      font-size: 10.5px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      white-space: nowrap;
    }
    tbody td { padding: 9px 12px; border-bottom: 1px solid #e5e7eb; vertical-align: middle; }
    tfoot td { padding: 10px 12px; font-size: 11px; }

    /* Footer */
    .footer {
      border-top: 1px solid #e5e7eb;
      padding-top: 16px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      color: #6b7280;
      font-size: 10px;
    }
    .footer-left { line-height: 1.6; }
    .footer-right { text-align: right; line-height: 1.6; }
  </style>
</head>
<body>
<div class="page">
  <!-- Header -->
  <div class="header">
    <div class="header-left">
      ${logo ? `<img src="${safe(logo)}" class="header-logo" alt="logo">` : ''}
      <div>
        <div class="header-company-name">${safe(companyName)}</div>
        ${address ? `<div class="header-company-sub">${safe(address)}</div>` : ''}
        ${phone || email ? `<div class="header-company-sub">${[phone, email].filter(Boolean).map(v => safe(v)).join(' &nbsp;|&nbsp; ')}</div>` : ''}
      </div>
    </div>
    <div class="header-right">
      <div class="report-title-box">
        <div class="report-title">Finance Report</div>
        <div class="report-meta">
          Type: ${safe(typeLabel)}<br>
          Period: ${safe(periodLabel)}<br>
          ${safe(fmtDate(dateRange.from))} &ndash; ${safe(fmtDate(dateRange.to))}<br>
          Generated: ${safe(generatedDate)}
        </div>
      </div>
    </div>
  </div>

  <!-- Summary -->
  <div class="section-title">Summary</div>
  <div class="summary-grid">
    ${summaryBoxesHtml}
  </div>

  <!-- Orders Table -->
  <div class="section-title">Order Details</div>
  <div class="table-wrap">
    <table>
      <thead>${tableHeaderHtml}</thead>
      <tbody>${tableRowsHtml || '<tr><td colspan="10" style="text-align:center;padding:20px;color:#6b7280;">No orders found for this period.</td></tr>'}</tbody>
      <tfoot>${tableFooterHtml}</tfoot>
    </table>
  </div>

  <!-- Footer -->
  <div class="footer">
    <div class="footer-left">
      <strong>${safe(companyName)}</strong><br>
      Finance Report &bull; ${safe(typeLabel)} &bull; ${safe(periodLabel)}
    </div>
    <div class="footer-right">
      Generated on ${safe(generatedDate)}<br>
      Total Orders: ${summary.totalOrders}
    </div>
  </div>
</div>
</body>
</html>`;

  let browser = null;
  try {
    browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'load', timeout: 20000 }).catch(() => {});
    const pdfBuffer = await page.pdf({ format: 'A3', landscape: true, printBackground: true, margin: { top: '16px', bottom: '16px', left: '16px', right: '16px' } });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="Finance_Report_${type}_${period}.pdf"`);
    return res.status(200).send(Buffer.from(pdfBuffer));
  } finally {
    if (browser) await browser.close();
  }
});

module.exports = {
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
};
