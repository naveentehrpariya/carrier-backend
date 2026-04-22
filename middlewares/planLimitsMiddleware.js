const Tenant = require('../db/Tenant');
const SubscriptionPlan = require('../db/SubscriptionPlan');
const User = require('../db/Users');
const Order = require('../db/Order');
const Customer = require('../db/Customer');
const Carrier = require('../db/Carrier');
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/AppError');

/**
 * Check if tenant can create more resources based on their plan limits
 * @param {string} resourceType - 'users', 'orders', 'customers', 'carriers'
 * @param {number} additionalCount - number of resources to be created (default: 1)
 */
const checkPlanLimits = (resourceType, additionalCount = 1) => {
  return catchAsync(async (req, res, next) => {
    if (!req.tenantId) {
      return next(new AppError('Tenant context required', 400));
    }

    // Super admins bypass all limits
    if (req.isSuperAdminUser || req.user?.permissions?.includes('super_admin')) {
      return next();
    }

    try {
      // Get tenant with subscription plan
      const tenant = await Tenant.findOne({ tenantId: req.tenantId });
      if (!tenant) {
        return next(new AppError('Tenant not found', 404));
      }

      // Get subscription plan limits - try multiple ways to find the plan
      let plan = null;
      if (tenant.subscription.plan) {
        if (typeof tenant.subscription.plan === 'string') {
          plan = await SubscriptionPlan.findOne({
            $or: [
              { slug: tenant.subscription.plan },
              { name: { $regex: tenant.subscription.plan, $options: 'i' } }
            ]
          });
        } else {
          plan = await SubscriptionPlan.findById(tenant.subscription.plan);
        }
      }
      
      // Use plan limits if found, otherwise use subscription.planLimits, then tenant settings as final fallback
      const limits = plan?.limits || tenant.subscription.planLimits || {
        maxUsers: tenant.settings?.maxUsers || 10,
        maxOrders: tenant.settings?.maxOrders || 1000,
        maxCustomers: tenant.settings?.maxCustomers || 1000,
        maxCarriers: tenant.settings?.maxCarriers || 500
      };
      
      return checkLimit(req, resourceType, limits, additionalCount, next);
      
    } catch (error) {
      console.error('Plan limits check error:', error);
      return next(new AppError('Error checking plan limits', 500));
    }
  });
};

/**
 * Helper function to check specific resource limit
 */
async function checkLimit(req, resourceType, limits, additionalCount, next) {
  let currentCount = 0;
  let maxCount = 0;
  let resourceName = resourceType;

  try {
    switch (resourceType) {
      case 'users':
        currentCount = await User.countDocuments({ tenantId: req.tenantId });
        maxCount = limits.maxUsers;
        resourceName = 'users';
        break;
      case 'orders':
        currentCount = await Order.countDocuments({ tenantId: req.tenantId });
        maxCount = limits.maxOrders;
        resourceName = 'orders';
        break;
      case 'customers':
        currentCount = await Customer.countDocuments({ tenantId: req.tenantId });
        maxCount = limits.maxCustomers;
        resourceName = 'customers';
        break;
      case 'carriers':
        currentCount = await Carrier.countDocuments({ tenantId: req.tenantId });
        maxCount = limits.maxCarriers;
        resourceName = 'carriers';
        break;
      default:
        return next(new AppError('Unknown resource type', 400));
    }

    // Check if adding new resources would exceed limit
    if (maxCount > 0 && (currentCount + additionalCount) > maxCount) {
      return next(new AppError(
        `${resourceName.charAt(0).toUpperCase() + resourceName.slice(1)} limit reached (${currentCount}/${maxCount}). Please upgrade your subscription plan to add more ${resourceName}.`, 
        403
      ));
    }

    // Store current usage in request for potential use in controllers
    req.currentUsage = req.currentUsage || {};
    req.currentUsage[resourceType] = currentCount;
    req.limits = req.limits || {};
    req.limits[resourceType] = maxCount;

    next();
    
  } catch (error) {
    console.error(`Error counting ${resourceType}:`, error);
    return next(new AppError(`Error checking ${resourceType} limit`, 500));
  }
}

/**
 * Middleware variants for different resources
 */
const checkUserLimit = (additionalCount = 1) => checkPlanLimits('users', additionalCount);
const checkOrderLimit = (additionalCount = 1) => checkPlanLimits('orders', additionalCount);
const checkCustomerLimit = (additionalCount = 1) => checkPlanLimits('customers', additionalCount);
const checkCarrierLimit = (additionalCount = 1) => checkPlanLimits('carriers', additionalCount);

/**
 * Get tenant usage summary (utility function)
 */
const getTenantUsageSummary = catchAsync(async (tenantId) => {
  if (!tenantId) {
    throw new Error('Tenant ID required');
  }

  const [tenant, userCount, orderCount, customerCount, carrierCount] = await Promise.all([
    Tenant.findOne({ tenantId }),
    User.countDocuments({ tenantId }),
    Order.countDocuments({ tenantId }),
    Customer.countDocuments({ tenantId }),
    Carrier.countDocuments({ tenantId })
  ]);

  if (!tenant) {
    throw new Error('Tenant not found');
  }

  // Get subscription plan limits - try multiple ways to find the plan (consistent with checkPlanLimits)
  let plan = null;
  if (tenant.subscription.plan) {
    if (typeof tenant.subscription.plan === 'string') {
      plan = await SubscriptionPlan.findOne({
        $or: [
          { slug: tenant.subscription.plan },
          { name: { $regex: tenant.subscription.plan, $options: 'i' } }
        ]
      });
    } else {
      plan = await SubscriptionPlan.findById(tenant.subscription.plan);
    }
  }
  
  // Use plan limits if found, otherwise use subscription.planLimits, then tenant settings as final fallback
  const limits = plan?.limits || tenant.subscription.planLimits || {
    maxUsers: tenant.settings?.maxUsers || 10,
    maxOrders: tenant.settings?.maxOrders || 1000,
    maxCustomers: tenant.settings?.maxCustomers || 1000,
    maxCarriers: tenant.settings?.maxCarriers || 500
  };

  return {
    usage: {
      users: userCount,
      orders: orderCount,
      customers: customerCount,
      carriers: carrierCount
    },
    limits,
    utilization: {
      users: limits.maxUsers > 0 ? Math.round((userCount / limits.maxUsers) * 100) : 0,
      orders: limits.maxOrders > 0 ? Math.round((orderCount / limits.maxOrders) * 100) : 0,
      customers: limits.maxCustomers > 0 ? Math.round((customerCount / limits.maxCustomers) * 100) : 0,
      carriers: limits.maxCarriers > 0 ? Math.round((carrierCount / limits.maxCarriers) * 100) : 0
    },
    warnings: {
      nearUserLimit: limits.maxUsers > 0 && userCount / limits.maxUsers > 0.8,
      nearOrderLimit: limits.maxOrders > 0 && orderCount / limits.maxOrders > 0.8,
      nearCustomerLimit: limits.maxCustomers > 0 && customerCount / limits.maxCustomers > 0.8,
      nearCarrierLimit: limits.maxCarriers > 0 && carrierCount / limits.maxCarriers > 0.8
    }
  };
});

module.exports = {
  checkPlanLimits,
  checkUserLimit,
  checkOrderLimit,
  checkCustomerLimit,
  checkCarrierLimit,
  getTenantUsageSummary
};