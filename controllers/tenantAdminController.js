const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/AppError');
const Tenant = require('../db/Tenant');
const User = require('../db/Users');
const Company = require('../db/Company');
const Order = require('../db/Order');
const Customer = require('../db/Customer');
const Carrier = require('../db/Carrier');
const SubscriptionPlan = require('../db/SubscriptionPlan');
const bcrypt = require('bcrypt');
const { getTenantUsageSummary } = require('../middlewares/planLimitsMiddleware');
const { logActivity } = require('../utils/activityLogger');

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

  // Get current usage for limit calculations
  const usage = {
    users: await User.countDocuments(User.activeFilter(req.tenantId)),
    orders: await Order.countDocuments({ tenantId: req.tenantId }),
    customers: await Customer.countDocuments({ tenantId: req.tenantId }),
    carriers: await Carrier.countDocuments({ tenantId: req.tenantId })
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

  const subscriptionInfo = {
    status: tenant.subscription.status || 'active',
    startDate: tenant.subscription.startDate,
    endDate: tenant.subscription.endDate,
    billingCycle: tenant.subscription.billingCycle || 'monthly',
    planName: subscriptionPlan?.name || tenant.subscription.legacyPlan || 
               (typeof tenant.subscription.plan === 'string' ? tenant.subscription.plan : 'Basic'),
    planSlug: subscriptionPlan?.slug || tenant.subscription.planSlug,
    planDescription: subscriptionPlan?.description || 'Standard logistics management features',
    planLimits,
    planFeatures,
    isActive: tenant.subscription.status === 'active',
    daysUntilRenewal: tenant.subscription.endDate ? 
      Math.ceil((new Date(tenant.subscription.endDate) - new Date()) / (1000 * 60 * 60 * 24)) : null,
    usage: {
      users: {
        current: usage.users,
        limit: planLimits.maxUsers,
        percentage: Math.round((usage.users / planLimits.maxUsers) * 100)
      },
      orders: {
        current: usage.orders,
        limit: planLimits.maxOrders,
        percentage: Math.round((usage.orders / planLimits.maxOrders) * 100)
      },
      customers: {
        current: usage.customers,
        limit: planLimits.maxCustomers,
        percentage: Math.round((usage.customers / planLimits.maxCustomers) * 100)
      },
      carriers: {
        current: usage.carriers,
        limit: planLimits.maxCarriers,
        percentage: Math.round((usage.carriers / planLimits.maxCarriers) * 100)
      }
    }
  };

  console.log('📊 Returning subscription info:', JSON.stringify(subscriptionInfo, null, 2));
  
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

/**
 * Get tenant users
 */
const getTenantUsers = catchAsync(async (req, res, next) => {
  const { page = 1, limit = 10, search, q, role } = req.query;
  const searchText = (search || q || '').toString().trim();
  
  // Start with active users filter
  const filter = User.activeFilter(req.tenantId);
  if (searchText) {
    filter.$or = [
      { name: { $regex: searchText, $options: 'i' } },
      { email: { $regex: searchText, $options: 'i' } },
      { corporateID: { $regex: searchText, $options: 'i' } }
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
  const VALID_PERMISSIONS = ['outsourcing', 'regular', 'accounting', 'customers', 'carriers', 'employees'];
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
  
  // Check if user already exists
  const existingUser = await User.findOne({ email, tenantId: req.tenantId });
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
  const company = companyId ? await Company.findById(companyId) : await Company.findOne({ tenantId: req.tenantId });
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

  const user = await User.findOneAndUpdate(
    { _id: req.params.id, tenantId: req.tenantId },
    { status: 'inactive', deletedAt: new Date() },
    { new: true }
  );

  if (!user) {
    return next(new AppError('User not found', 404));
  }

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

module.exports = {
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
  exportData
};
