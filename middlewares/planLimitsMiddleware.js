const Tenant = require('../db/Tenant');
const SubscriptionPlan = require('../db/SubscriptionPlan');
const User = require('../db/Users');
const Order = require('../db/Order');
const Customer = require('../db/Customer');
const Carrier = require('../db/Carrier');
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/AppError');
const { currentOrderPeriod } = require('../utils/subscription');

// Only ORDERS are metered per month. Everything else that has a plan number
// (users = team seats) is a TOTAL limit. Customers/carriers/fleet are NOT capped
// (master data — capping them has no product value).
const MONTHLY_RESOURCES = new Set(['orders']);
const RESOURCE_LABEL = { orders: 'order', users: 'user', customers: 'customer', carriers: 'carrier' };

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Resolve the plan a tenant is on. The name match is ANCHORED: a loose `{ name: { $regex: plan } }`
// let the slug 'pro' match the plan named 'Professional', so a tenant could be metered against a
// plan they never bought — and which of the two `findOne` returned was not deterministic.
async function resolvePlanRecord(planRef) {
  if (!planRef) return null;
  if (typeof planRef === 'string') {
    return SubscriptionPlan.findOne({
      $or: [{ slug: planRef }, { name: new RegExp(`^${escapeRegex(planRef)}$`, 'i') }],
    });
  }
  return SubscriptionPlan.findById(planRef);
}

// Build the count query + model + plan-limit key for a resource type.
function resolveResource(resourceType, req, period) {
  const base = { tenantId: req.tenantId, $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }] };
  if (MONTHLY_RESOURCES.has(resourceType) && period) {
    base.createdAt = { $gte: period.start, $lt: period.end };
  }
  switch (resourceType) {
    case 'users': return { model: User, query: { ...base, status: { $ne: 'inactive' } }, limitKey: 'maxUsers' };
    case 'orders': return { model: Order, query: base, limitKey: 'maxOrders' };
    case 'customers': return { model: Customer, query: base, limitKey: 'maxCustomers' };
    case 'carriers': return { model: Carrier, query: base, limitKey: 'maxCarriers' };
    default: return null;
  }
}

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
      const plan = await resolvePlanRecord(tenant.subscription.plan);

      // Use plan limits if found, otherwise use subscription.planLimits, then tenant settings as final fallback
      const limits = plan?.limits || tenant.subscription.planLimits || {
        maxUsers: tenant.settings?.maxUsers || 10,
        maxOrders: tenant.settings?.maxOrders || 1000,
        maxCustomers: tenant.settings?.maxCustomers || 1000,
        maxCarriers: tenant.settings?.maxCarriers || 500
      };
      
      return checkLimit(req, resourceType, limits, additionalCount, next, tenant);

    } catch (error) {
      console.error('Plan limits check error:', error);
      return next(new AppError('Error checking plan limits', 500));
    }
  });
};

/**
 * Helper function to check specific resource limit
 */
async function checkLimit(req, resourceType, limits, additionalCount, next, tenant) {
  try {
    const monthly = MONTHLY_RESOURCES.has(resourceType);
    const period = monthly ? currentOrderPeriod(tenant) : null;
    const resetDate = period ? period.end : null;

    const cfg = resolveResource(resourceType, req, period);
    if (!cfg) return next(new AppError('Unknown resource type', 400));

    const currentCount = await cfg.model.countDocuments(cfg.query);
    const maxCount = Number(limits[cfg.limitKey]) || 0;
    const label = RESOURCE_LABEL[resourceType] || resourceType;

    // maxCount === 0 means "no limit configured" (unlimited), not "zero allowed"
    if (maxCount > 0 && (currentCount + additionalCount) > maxCount) {
      if (monthly) {
        const resetStr = resetDate ? new Date(resetDate).toLocaleDateString() : 'next month';
        const err = new AppError(
          `Monthly ${label} limit reached (${currentCount}/${maxCount}). Resets on ${resetStr}. Upgrade your plan to add more this month.`,
          403
        );
        err.code = 'limit_reached';
        return next(err);
      }
      return next(new AppError(
        `${label.charAt(0).toUpperCase() + label.slice(1)} limit reached (${currentCount}/${maxCount}). Please upgrade your subscription plan to add more.`,
        403
      ));
    }

    // Store current usage in request for potential use in controllers
    req.currentUsage = req.currentUsage || {};
    req.currentUsage[resourceType] = currentCount;
    req.limits = req.limits || {};
    req.limits[resourceType] = maxCount;
    if (monthly) req.orderResetDate = resetDate;

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
// Kept for backward-compat but no longer wired on routes (customers/carriers are not capped).
const checkCustomerLimit = (additionalCount = 1) => checkPlanLimits('customers', additionalCount);
const checkCarrierLimit = (additionalCount = 1) => checkPlanLimits('carriers', additionalCount);

/**
 * Get tenant usage summary (utility function)
 */
const getTenantUsageSummary = catchAsync(async (tenantId) => {
  if (!tenantId) {
    throw new Error('Tenant ID required');
  }

  const tenant = await Tenant.findOne({ tenantId });
  if (!tenant) {
    throw new Error('Tenant not found');
  }

  // Count exactly what checkPlanLimits enforces, or this summary reports a different number than
  // the gate: soft-deleted records excluded, and orders counted in the CURRENT MONTHLY window
  // (maxOrders is per month, not lifetime).
  const notDeleted = { $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }] };
  const period = currentOrderPeriod(tenant);
  const [userCount, orderCount, customerCount, carrierCount] = await Promise.all([
    User.countDocuments({ tenantId, ...notDeleted, status: { $ne: 'inactive' } }),
    Order.countDocuments({ tenantId, ...notDeleted, createdAt: { $gte: period.start, $lt: period.end } }),
    Customer.countDocuments({ tenantId, ...notDeleted }),
    Carrier.countDocuments({ tenantId, ...notDeleted })
  ]);

  // Get subscription plan limits (same resolution as checkPlanLimits)
  const plan = await resolvePlanRecord(tenant.subscription.plan);

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