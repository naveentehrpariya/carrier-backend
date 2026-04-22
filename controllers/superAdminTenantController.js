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
const { generateTenantUrl } = require('../middleware/tenantResolver');
const bcrypt = require('bcrypt');
const mongoose = require('mongoose');

/**
 * Get all tenants with pagination and filtering
 */
const getTenants = catchAsync(async (req, res, next) => {
  const { page = 1, limit = 10, search, status, plan } = req.query;
  
  // Build filter query
  const filter = {};
  if (search) {
    filter.$or = [
      { name: { $regex: search, $options: 'i' } },
      { subdomain: { $regex: search, $options: 'i' } },
      { 'contactInfo.adminEmail': { $regex: search, $options: 'i' } }
    ];
  }
  if (status && status !== 'all') {
    filter.status = status;
  }
  if (plan && plan !== 'all') {
    filter['subscription.plan'] = plan;
  }

  const tenants = await Tenant.find(filter)
    .sort({ createdAt: -1 })
    .limit(limit * 1)
    .skip((page - 1) * limit)
    .lean();

  const total = await Tenant.countDocuments(filter);

  // Enhance tenants with additional data
  const enhancedTenants = await Promise.all(
    tenants.map(async (tenant) => {
      const userCount = await User.countDocuments({ tenantId: tenant.tenantId });
      const orderCount = await Order.countDocuments({ tenantId: tenant.tenantId });
      const customerCount = await Customer.countDocuments({ tenantId: tenant.tenantId });
      const carrierCount = await Carrier.countDocuments({ tenantId: tenant.tenantId });

      return {
        ...tenant,
        stats: {
          users: userCount,
          orders: orderCount,
          customers: customerCount,
          carriers: carrierCount
        },
        url: generateTenantUrl(tenant.subdomain)
      };
    })
  );

  res.json({
    status: true,
    data: {
      tenants: enhancedTenants,
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
 * Get tenant details
 */
const getTenantDetails = catchAsync(async (req, res, next) => {
  const tenant = await Tenant.findById(req.params.id);
  
  if (!tenant) {
    return next(new AppError('Tenant not found', 404));
  }

  // Get detailed stats
  const stats = {
    users: await User.countDocuments({ tenantId: tenant.tenantId }),
    orders: await Order.countDocuments({ tenantId: tenant.tenantId }),
    customers: await Customer.countDocuments({ tenantId: tenant.tenantId }),
    carriers: await Carrier.countDocuments({ tenantId: tenant.tenantId })
  };

  // Get recent activity
  const recentOrders = await Order.find({ tenantId: tenant.tenantId })
    .sort({ createdAt: -1 })
    .limit(5)
    .populate('customer', 'name')
    .populate('carrier', 'name')
    .lean();

  const recentUsers = await User.find({ tenantId: tenant.tenantId })
    .sort({ createdAt: -1 })
    .limit(5)
    .select('name email role createdAt')
    .lean();

  res.json({
    status: true,
    data: {
      tenant: {
        ...tenant.toObject(),
        stats,
        url: generateTenantUrl(tenant.subdomain)
      },
      recentActivity: {
        orders: recentOrders,
        users: recentUsers
      }
    }
  });
});

/**
 * Create new tenant
 * 
 * @route POST /api/super-admin/tenants
 * @access SuperAdmin
 * @returns {
 *   status: boolean,
 *   data: {
 *     tenant: Object,
 *     company: Object,
 *     adminUser: Object (sanitized),
 *     credentials: { email: string, password: string, url: string },
 *     tempPassword: string (backward compatibility)
 *   },
 *   message: string
 * }
 * @description Creates a new tenant with auto-generated admin credentials.
 * The credentials object contains email, password, and URL for immediate sharing.
 * The password is only returned once and should be stored securely.
 */
const createTenant = catchAsync(async (req, res, next) => {
  const {
    name,
    subdomain,
    contactInfo,
    subscriptionPlanId, // New format
    subscription, // Old format (for backward compatibility)
    billingCycle = 'monthly',
    settings
  } = req.body;

  // Validation
  if (!name || !subdomain || !contactInfo?.adminEmail) {
    return next(new AppError('Name, subdomain, and admin email are required', 400));
  }

  // Check if subdomain is available
  const existingTenant = await Tenant.findOne({ subdomain });
  if (existingTenant) {
    return next(new AppError('Subdomain already exists', 400));
  }

  // Debug: Log the incoming request data
  console.log('🔍 DEBUG - Incoming request body:', JSON.stringify(req.body, null, 2));
  
  // Handle subscription plan - support both old and new formats
  let subscriptionPlan = null;
  let subscriptionData = {};
  
  if (subscriptionPlanId) {
    // New format - using subscription plan ID
    subscriptionPlan = await SubscriptionPlan.findById(subscriptionPlanId);
    if (!subscriptionPlan || !subscriptionPlan.isActive) {
      return next(new AppError('Invalid or inactive subscription plan', 400));
    }
    
    subscriptionData = {
      plan: subscriptionPlan._id, // ObjectId
      planSlug: subscriptionPlan.slug,
      status: 'active',
      startDate: new Date(),
      billingCycle: billingCycle,
      planLimits: {
        maxUsers: subscriptionPlan.limits.maxUsers,
        maxOrders: subscriptionPlan.limits.maxOrders,
        maxCustomers: subscriptionPlan.limits.maxCustomers,
        maxCarriers: subscriptionPlan.limits.maxCarriers
      },
      planFeatures: subscriptionPlan.features,
      allowedModules: subscriptionPlan.allowedModules || ['outsourcing', 'regular']
    };
  } else if (subscription?.plan) {
    // Old format - using string plan name (now supported by Mixed type)
    subscriptionData = {
      plan: subscription.plan, // String (now allowed by Mixed type)
      legacyPlan: subscription.plan, // Also store in legacy field
      status: subscription.status || 'active',
      startDate: new Date(),
      billingCycle: subscription.billingCycle || billingCycle,
      planLimits: {
        maxUsers: settings?.maxUsers || 10,
        maxOrders: settings?.maxOrders || 1000,
        maxCustomers: settings?.maxCustomers || 1000,
        maxCarriers: settings?.maxCarriers || 500
      },
      planFeatures: settings?.features || ['orders', 'customers', 'carriers', 'basic_reporting']
    };
  } else {
    // Default fallback
    subscriptionData = {
      plan: 'basic', // String default
      legacyPlan: 'basic',
      status: 'active',
      startDate: new Date(),
      billingCycle: billingCycle,
      planLimits: {
        maxUsers: 10,
        maxOrders: 1000,
        maxCustomers: 1000,
        maxCarriers: 500
      },
      planFeatures: ['orders', 'customers', 'carriers', 'basic_reporting']
    };
  }

  // Generate tenant ID based on subdomain (domain-based naming)
  const tenantId = subdomain;

  // Debug: Log the subscription data being used
  console.log('🔍 DEBUG - Subscription data being used:', JSON.stringify(subscriptionData, null, 2));
  
  // Create tenant with subscription data (supports both old and new formats)
  const tenantCreateData = {
    tenantId,
    name,
    domain: process.env.DOMAIN || 'yourapp.com',
    subdomain,
    status: 'active',
    contactInfo,
    subscription: subscriptionData,
    settings: {
      maxUsers: subscriptionData.planLimits.maxUsers,
      maxOrders: subscriptionData.planLimits.maxOrders,
      maxStorage: settings?.maxStorage || '1GB',
      features: subscriptionData.planFeatures,
      customizations: settings?.customizations || {}
    },
    createdBy: req.user._id
  };
  
  console.log('🔍 DEBUG - Final tenant data:', JSON.stringify(tenantCreateData, null, 2));
  
  // Check for existing email before creating tenant
  const existingUser = await User.findOne({ email: contactInfo.adminEmail });
  if (existingUser) {
    return next(new AppError(`Email address '${contactInfo.adminEmail}' is already in use. Please use a different email address.`, 409));
  }

  let tenant, company, adminUser;
  
  // Generate admin password outside try block so it's accessible later
  const isProd = (process.env.NODE_ENV === 'production');
  const providedPassword = req.body?.adminPassword || req.body?.contactInfo?.adminPassword;
  const defaultDevPassword = process.env.DEFAULT_ADMIN_PASSWORD || '12345678';
  const adminPassword = providedPassword && typeof providedPassword === 'string' && providedPassword.length >= 6
    ? providedPassword
    : (isProd ? Math.random().toString(36).substring(2, 15) : defaultDevPassword);
  
  try {
    // Create tenant first
    tenant = await Tenant.create(tenantCreateData);

    // Create company record for the tenant with comprehensive default values
    company = await Company.create({
      tenantId,
      company_slug: tenantId,
      logo: '', // Empty, to be filled later by tenant admin
      name: name, // Use tenant name as initial company name
      email: contactInfo.adminEmail,
      phone: contactInfo.phone || '[To be updated]',
      address: contactInfo.address || '[To be updated]',
      bank_name: '[To be updated]',
      account_name: '[To be updated]', 
      account_number: '[To be updated]',
      routing_number: '[To be updated]',
      remittance_primary_email: contactInfo.adminEmail,
      remittance_secondary_email: null,
      rate_confirmation_terms: `Carrier is responsible to confirm the actual weight and count received from the shipper before transit.

Additional fees such as loading/unloading, pallet exchange, etc., are included in the agreed rate.

POD must be submitted within 5 days of delivery.

Freight charges include $100 for MacroPoint tracking. Non-compliance may lead to deduction.

Cross-border shipments require custom stamps or deductions may apply.`
    });

    // Create admin user (plain password; User model will hash)
    adminUser = await User.create({
      tenantId,
      company: company._id,
      name: contactInfo.adminName || 'Administrator',
      email: contactInfo.adminEmail,
      password: adminPassword,
      phone: contactInfo.phone || '',
      country: 'USA',
      address: contactInfo.address || 'N/A',
      is_admin: 1,
      permissions: ['admin', 'regular', 'outsourcing', 'accounting', 'customers', 'employees', 'payments', 'orders'],
      position: 'Administrator',
      corporateID: `ADMIN_${Date.now()}`
    });
  } catch (error) {
    console.error('Error during tenant creation:', error);
    
    // Clean up any partially created records
    if (tenant) {
      try {
        await Tenant.findByIdAndDelete(tenant._id);
      } catch (deleteError) {
        console.error('Error cleaning up tenant:', deleteError);
      }
    }
    
    if (company) {
      try {
        await Company.findByIdAndDelete(company._id);
      } catch (deleteError) {
        console.error('Error cleaning up company:', deleteError);
      }
    }
    
    // Let the global error handler transform MongoDB errors
    // Just re-throw the original error
    throw error;
  }

  // Create credentials object for frontend display
  const credentials = {
    email: contactInfo.adminEmail,
    password: adminPassword,
    url: generateTenantUrl(tenant.subdomain)
  };

  res.status(201).json({
    status: true,
    data: {
      tenant: {
        ...tenant.toObject(),
        url: generateTenantUrl(tenant.subdomain)
      },
      company,
      adminUser: {
        _id: adminUser._id,
        name: adminUser.name,
        email: adminUser.email,
        role: adminUser.role,
        tenantId: adminUser.tenantId
      },
      credentials,
      tempPassword: adminPassword // Keep for backward compatibility
    },
    message: 'Tenant created successfully.'
  });
});

/**
 * Update tenant
 */
const updateTenant = catchAsync(async (req, res, next) => {
  const updates = req.body;
  
  // Remove fields that shouldn't be updated directly
  delete updates.tenantId;
  delete updates.createdAt;
  delete updates.createdBy;

  const tenant = await Tenant.findByIdAndUpdate(
    req.params.id,
    updates,
    { new: true, runValidators: true }
  );

  if (!tenant) {
    return next(new AppError('Tenant not found', 404));
  }

  res.json({
    status: true,
    data: { tenant },
    message: 'Tenant updated successfully'
  });
});

/**
 * Update tenant status
 */
const updateTenantStatus = catchAsync(async (req, res, next) => {
  const { status } = req.body;
  
  if (!['active', 'suspended', 'pending', 'cancelled'].includes(status)) {
    return next(new AppError('Invalid status', 400));
  }

  const tenant = await Tenant.findByIdAndUpdate(
    req.params.id,
    { status, updatedAt: new Date() },
    { new: true }
  );

  if (!tenant) {
    return next(new AppError('Tenant not found', 404));
  }

  res.json({
    status: true,
    data: { tenant },
    message: `Tenant ${status} successfully`
  });
});

/**
 * Delete tenant (soft delete)
 */
const deleteTenant = catchAsync(async (req, res, next) => {
  const tenant = await Tenant.findById(req.params.id);
  
  if (!tenant) {
    return next(new AppError('Tenant not found', 404));
  }

  // Soft delete by setting status to cancelled
  tenant.status = 'cancelled';
  tenant.subscription.status = 'cancelled';
  tenant.updatedAt = new Date();
  await tenant.save();

  res.json({
    status: true,
    message: 'Tenant deleted successfully'
  });
});

/**
 * Permanently delete tenant and all related data
 */
const hardDeleteTenant = catchAsync(async (req, res, next) => {
  const { tenantId } = req.params;

  if (!req.isSuperAdminUser && !req.superAdmin) {
    return next(new AppError('Super admin access required', 403));
  }

  if (!tenantId) {
    return next(new AppError('Tenant ID is required', 400));
  }

  let tenant;
  if (mongoose.Types.ObjectId.isValid(tenantId)) {
    tenant = await Tenant.findOne({ $or: [{ tenantId }, { _id: tenantId }] });
  } else {
    tenant = await Tenant.findOne({ tenantId });
  }
  if (!tenant) {
    return next(new AppError('Tenant not found', 404));
  }

  const slug = tenant.tenantId;

  try {
    await Promise.all([
      User.deleteMany({ tenantId: slug }),
      Order.deleteMany({ tenantId: slug }),
      Customer.deleteMany({ tenantId: slug }),
      Carrier.deleteMany({ tenantId: slug }),
      Company.deleteMany({ tenantId: slug }),
      require('../db/Equipment').deleteMany({ tenantId: slug }),
      require('../db/Commudity').deleteMany({ tenantId: slug }),
      require('../db/Charges').deleteMany({ tenantId: slug }),
      require('../db/Files').deleteMany({ tenantId: slug }),
      require('../db/Notification').deleteMany({ tenantId: slug }),
      require('../db/PaymentLogs').deleteMany({ tenantId: slug })
    ]);

    await Tenant.deleteOne({ _id: tenant._id });

    return res.json({
      status: true,
      message: 'Tenant and all related data permanently deleted',
      data: { tenantId: slug }
    });
  } catch (err) {
    console.error('Hard delete error:', err);
    return next(new AppError('Failed to permanently delete tenant', 500));
  }
});

/**
 * Invite tenant admin
 */
const inviteTenantAdmin = catchAsync(async (req, res, next) => {
  const { email, name, password } = req.body;
  const tenant = await Tenant.findById(req.params.id);
  
  if (!tenant) {
    return next(new AppError('Tenant not found', 404));
  }

  // Generate temporary password
  const tempPassword = password && typeof password === 'string' && password.length >= 6
    ? password
    : Math.random().toString(36).substring(2, 15);

  // Create tenant admin user
  const adminUser = await User.create({
    tenantId: tenant.tenantId,
    company: await Company.findOne({ tenantId: tenant.tenantId }).then(c => c._id),
    name,
    email,
    password: tempPassword,
    phone: 'N/A',
    country: 'N/A',
    address: 'N/A',
    role: 3,
    is_admin: 1,
    isTenantAdmin: true,
    corporateID: `ADMIN_${Date.now()}`,
    position: 'Tenant Administrator',
    tenantPermissions: [
      'users.manage',
      'company.configure',
      'reports.generate',
      'integrations.manage'
    ],
    created_by: req.user._id
  });

  // Update tenant status to active if it was pending
  if (tenant.status === 'pending') {
    tenant.status = 'active';
    await tenant.save();
  }

  // Send invitation email (implement email service)
  // await sendAdminInvitationEmail(adminUser, tenant, tempPassword);

  const responsePayload = {
    status: true,
    data: { 
      user: {
        id: adminUser._id,
        name: adminUser.name,
        email: adminUser.email,
        role: adminUser.role
      }
    },
    message: 'Admin user created and invitation sent'
  };

  // In non-production environments, include the temporary password for convenience
  if (process.env.NODE_ENV !== 'production') {
    responsePayload.data.tempPassword = tempPassword;
  }

  res.json(responsePayload);
});

/**
 * Get subscription plans
 */
const getSubscriptionPlans = catchAsync(async (req, res, next) => {
  const { publicOnly = false } = req.query;
  
  const filter = { isActive: true };
  if (publicOnly === 'true') {
    filter.isPublic = true;
  }
  
  const plans = await SubscriptionPlan.find(filter)
    .select('name slug description limits features isPublic allowedModules')
    .sort({ name: 1 });

  res.json({
    status: true,
    data: { plans }
  });
});

/**
 * Create subscription plan
 */
const createSubscriptionPlan = catchAsync(async (req, res, next) => {
  const plan = await SubscriptionPlan.create({
    ...req.body,
    createdBy: req.user._id
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
  const plan = await SubscriptionPlan.findByIdAndUpdate(
    req.params.id,
    req.body,
    { new: true, runValidators: true }
  );

  if (!plan) {
    return next(new AppError('Subscription plan not found', 404));
  }

  // Sync plan changes to all active tenants using this plan
  if (req.body.allowedModules || req.body.limits || req.body.features) {
    try {
      const Tenant = require('../db/Tenant');
      const updateObj = {};
      if (req.body.allowedModules) updateObj['subscription.allowedModules'] = req.body.allowedModules;
      if (req.body.features) updateObj['subscription.planFeatures'] = req.body.features;
      if (req.body.limits) {
        if (req.body.limits.maxUsers) updateObj['subscription.planLimits.maxUsers'] = req.body.limits.maxUsers;
        if (req.body.limits.maxOrders) updateObj['subscription.planLimits.maxOrders'] = req.body.limits.maxOrders;
        if (req.body.limits.maxCustomers) updateObj['subscription.planLimits.maxCustomers'] = req.body.limits.maxCustomers;
        if (req.body.limits.maxCarriers) updateObj['subscription.planLimits.maxCarriers'] = req.body.limits.maxCarriers;
      }

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
      console.log(`✅ Synced plan ${plan.name} updates to tenants`);
    } catch (syncErr) {
      console.error('Failed to sync plan updates to tenants:', syncErr);
    }
  }

  res.json({
    status: true,
    data: { plan },
    message: 'Subscription plan updated successfully and synced to tenants'
  });
});

/**
 * Delete subscription plan
 */
const deleteSubscriptionPlan = catchAsync(async (req, res, next) => {
  const plan = await SubscriptionPlan.findByIdAndUpdate(
    req.params.id,
    { isActive: false },
    { new: true }
  );

  if (!plan) {
    return next(new AppError('Subscription plan not found', 404));
  }

  res.json({
    status: true,
    message: 'Subscription plan deleted successfully'
  });
});

/**
 * Get system health
 */
const getSystemHealth = catchAsync(async (req, res, next) => {
  const stats = {
    tenants: {
      total: await Tenant.countDocuments(),
      active: await Tenant.countDocuments({ status: 'active' }),
      suspended: await Tenant.countDocuments({ status: 'suspended' }),
      trial: await Tenant.countDocuments({ 'subscription.status': 'trial' })
    },
    users: await User.countDocuments(),
    orders: await Order.countDocuments(),
    customers: await Customer.countDocuments(),
    carriers: await Carrier.countDocuments(),
    database: {
      connected: true,
      uptime: process.uptime()
    }
  };

  res.json({
    status: true,
    data: { health: stats }
  });
});

/**
 * Get system logs (placeholder)
 */
const getSystemLogs = catchAsync(async (req, res, next) => {
  // Implement actual log retrieval logic
  res.json({
    status: true,
    data: { 
      logs: [],
      message: 'Log retrieval functionality to be implemented'
    }
  });
});

/**
 * Toggle maintenance mode (placeholder)
 */
const toggleMaintenance = catchAsync(async (req, res, next) => {
  // Implement maintenance mode toggle
  res.json({
    status: true,
    message: 'Maintenance mode functionality to be implemented'
  });
});

/**
 * Get super admins
 */
const getSuperAdmins = catchAsync(async (req, res, next) => {
  const superAdmins = await SuperAdmin.find({ status: 'active' })
    .select('-password')
    .sort({ createdAt: -1 });

  res.json({
    status: true,
    data: { superAdmins }
  });
});

/**
 * Create super admin
 */
const createSuperAdmin = catchAsync(async (req, res, next) => {
  const { name, email, password, role, permissions } = req.body;

  const superAdmin = await SuperAdmin.create({
    name,
    email,
    password,
    role: role || 'platform_admin',
    permissions,
    createdBy: req.user._id
  });

  // Remove password from response
  superAdmin.password = undefined;

  res.status(201).json({
    status: true,
    data: { superAdmin },
    message: 'Super admin created successfully'
  });
});

const updateSuperAdmin = catchAsync(async (req, res, next) => {
  const updates = req.body;
  delete updates.password; // Don't allow password updates through this endpoint

  const superAdmin = await SuperAdmin.findByIdAndUpdate(
    req.params.id,
    updates,
    { new: true, runValidators: true }
  ).select('-password');

  if (!superAdmin) {
    return next(new AppError('Super admin not found', 404));
  }

  res.json({
    status: true,
    data: { superAdmin },
    message: 'Super admin updated successfully'
  });
});

const deleteSuperAdmin = catchAsync(async (req, res, next) => {
  const superAdmin = await SuperAdmin.findByIdAndUpdate(
    req.params.id,
    { status: 'inactive' },
    { new: true }
  );
  if (!superAdmin) {
    return next(new AppError('Super admin not found', 404));
  }
  res.json({
    status: true,
    message: 'Super admin deleted successfully'
  });
});

/**
 * Ensure company record exists for tenant
 * This is a utility function to create missing company records for existing tenants
 */
const ensureCompanyRecord = catchAsync(async (req, res, next) => {
  const { tenantId } = req.params;
  
  // Check if company already exists
  const existingCompany = await Company.findOne({ tenantId });
  if (existingCompany) {
    return res.json({
      status: true,
      message: 'Company record already exists',
      data: { company: existingCompany }
    });
  }
  
  // Get tenant details
  const tenant = await Tenant.findOne({ tenantId });
  if (!tenant) {
    return next(new AppError('Tenant not found', 404));
  }
  
  // Create company record with default values
  const company = await Company.create({
    tenantId,
    company_slug: tenantId,
    logo: '',
    name: tenant.name,
    email: tenant.contactInfo.adminEmail,
    phone: tenant.contactInfo.phone || '[To be updated]',
    address: tenant.contactInfo.address || '[To be updated]',
    bank_name: '[To be updated]',
    account_name: '[To be updated]',
    account_number: '[To be updated]',
    routing_number: '[To be updated]',
    remittance_primary_email: tenant.contactInfo.adminEmail,
    remittance_secondary_email: null,
    rate_confirmation_terms: `Carrier is responsible to confirm the actual weight and count received from the shipper before transit.\n\nAdditional fees such as loading/unloading, pallet exchange, etc., are included in the agreed rate.\n\nPOD must be submitted within 5 days of delivery.\n\nFreight charges include $100 for MacroPoint tracking. Non-compliance may lead to deduction.\n\nCross-border shipments require custom stamps or deductions may apply.`
  });
  
  res.status(201).json({
    status: true,
    message: 'Company record created successfully',
    data: { company }
  });
});

/**
 * Update tenant subscription plan (Super Admin only)
 */
const updateTenantSubscriptionPlan = catchAsync(async (req, res, next) => {
  const { tenantId } = req.params;
  const { subscriptionPlanId, billingCycle = 'monthly' } = req.body;
  
  if (!subscriptionPlanId) {
    return next(new AppError('Subscription plan ID is required', 400));
  }
  
  // Get the tenant
  const tenant = await Tenant.findOne({ tenantId });
  if (!tenant) {
    return next(new AppError('Tenant not found', 404));
  }
  
  // Get and validate the subscription plan
  const subscriptionPlan = await SubscriptionPlan.findById(subscriptionPlanId);
  if (!subscriptionPlan || !subscriptionPlan.isActive) {
    return next(new AppError('Invalid or inactive subscription plan', 400));
  }
  
  // Update the tenant's subscription
  const updatedTenant = await Tenant.findOneAndUpdate(
    { tenantId },
    {
      $set: {
        'subscription.plan': subscriptionPlan._id,
        'subscription.planSlug': subscriptionPlan.slug,
        'subscription.billingCycle': billingCycle,
        'subscription.planLimits': {
          maxUsers: subscriptionPlan.limits.maxUsers,
          maxOrders: subscriptionPlan.limits.maxOrders,
          maxCustomers: subscriptionPlan.limits.maxCustomers,
          maxCarriers: subscriptionPlan.limits.maxCarriers
        },
        'subscription.planFeatures': subscriptionPlan.features,
        'subscription.allowedModules': subscriptionPlan.allowedModules || ['outsourcing', 'regular'],
        'subscription.status': 'active',
        'settings.maxUsers': subscriptionPlan.limits.maxUsers,
        'settings.maxOrders': subscriptionPlan.limits.maxOrders,
        'settings.features': subscriptionPlan.features,
        'updatedAt': new Date()
      }
    },
    { new: true, runValidators: true }
  ).populate('subscription.plan');
  
  res.json({
    status: true,
    data: {
      tenant: updatedTenant,
      message: `Tenant subscription updated to ${subscriptionPlan.name} plan successfully`
    }
  });
});

/**
 * Get tenant subscription details (Super Admin view)
 */
const getTenantSubscriptionDetails = catchAsync(async (req, res, next) => {
  const { tenantId } = req.params;
  
  const tenant = await Tenant.findOne({ tenantId }).populate('subscription.plan');
  if (!tenant) {
    return next(new AppError('Tenant not found', 404));
  }
  
  // Get all available subscription plans
  const availablePlans = await SubscriptionPlan.find({ isActive: true })
    .select('_id name slug description limits features')
    .sort({ name: 1 });
  
  // Get current usage
  const usage = {
    users: await User.countDocuments({ tenantId }),
    orders: await Order.countDocuments({ tenantId }),
    customers: await Customer.countDocuments({ tenantId }),
    carriers: await Carrier.countDocuments({ tenantId })
  };
  
  // Get subscription plan details
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
      subscriptionPlan = tenant.subscription.plan;
    }
  }
  
  res.json({
    status: true,
    data: {
      tenant: {
        tenantId: tenant.tenantId,
        name: tenant.name,
        status: tenant.status
      },
      currentSubscription: {
        planName: subscriptionPlan?.name || tenant.subscription.legacyPlan || 'Unknown',
        planSlug: subscriptionPlan?.slug || tenant.subscription.planSlug,
        status: tenant.subscription.status,
        billingCycle: tenant.subscription.billingCycle,
        limits: subscriptionPlan?.limits || tenant.subscription.planLimits,
        features: subscriptionPlan?.features || tenant.subscription.planFeatures || [],
        allowedModules: subscriptionPlan?.allowedModules || tenant.subscription.allowedModules || ['outsourcing', 'regular']
      },
      usage,
      availablePlans
    }
  });
});

module.exports = {
  getTenants,
  getTenantDetails,
  createTenant,
  updateTenant,
  updateTenantStatus,
  deleteTenant,
  hardDeleteTenant,
  inviteTenantAdmin,
  getSubscriptionPlans,
  createSubscriptionPlan,
  updateSubscriptionPlan,
  deleteSubscriptionPlan,
  getSystemHealth,
  getSystemLogs,
  toggleMaintenance,
  getSuperAdmins,
  createSuperAdmin,
  updateSuperAdmin,
  deleteSuperAdmin,
  ensureCompanyRecord,
  updateTenantSubscriptionPlan,
  getTenantSubscriptionDetails
};
