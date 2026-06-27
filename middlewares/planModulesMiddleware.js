const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/AppError');
const SubscriptionPlan = require('../db/SubscriptionPlan');
const { isSubscriptionActive } = require('../utils/subscription');

const valid = ['outsourcing', 'regular'];

/**
 * Blocks the action unless the tenant has a live subscription (bought + not expired).
 * Used on order creation. Super admin bypasses. Returns a stable error code the
 * frontend uses to show the "billing expired / no plan" banner.
 */
const requireActiveSubscription = catchAsync(async (req, res, next) => {
  if (req.isSuperAdminUser || req.user?.permissions?.includes('super_admin')) return next();
  if (isSubscriptionActive(req.tenant)) return next();
  return res.status(403).json({
    status: false,
    error: 'subscription_inactive',
    message: 'Your company has no active subscription. Please contact your administrator to activate billing.'
  });
});

const resolvePlanModules = async (req) => {
  const fromTenant = req.tenant?.subscription?.allowedModules;
  if (Array.isArray(fromTenant) && fromTenant.length > 0) {
    return fromTenant.map((m) => String(m).toLowerCase()).filter((m) => valid.includes(m));
  }

  const planRef = req.tenant?.subscription?.plan || req.tenant?.subscription?.planSlug || null;
  if (!planRef) return [];

  let planRecord = null;
  if (typeof planRef === 'string') {
    planRecord = await SubscriptionPlan.findOne({ slug: planRef }).lean();
  } else {
    planRecord = await SubscriptionPlan.findById(planRef).lean();
  }

  const mods = planRecord?.allowedModules;
  if (Array.isArray(mods) && mods.length > 0) {
    return mods.map((m) => String(m).toLowerCase()).filter((m) => valid.includes(m));
  }

  return [];
};

/**
 * Shared helper: compute effective modules for the current user.
 * Returns an array of allowed order types (subset of valid).
 */
const computeEffectiveModules = async (req) => {
  if (req.isSuperAdminUser || req.user?.permissions?.includes('super_admin')) {
    return [...valid];
  }

  const planModulesRaw = await resolvePlanModules(req);
  // Backward compat: if plan is not configured, allow all modules.
  const planModules = planModulesRaw.length ? planModulesRaw : [...valid];

  const isTenantAdmin = req.user?.is_admin === 1;

  const userModulesRaw = Array.isArray(req.user?.allowedModules) ? req.user.allowedModules : null;
  const userModules = userModulesRaw
    ? userModulesRaw.map((m) => String(m).toLowerCase()).filter((m) => valid.includes(m))
    : null;

  const useUserModules = req.user?.modulesCustomized === true && userModules && userModules.length > 0;

  return isTenantAdmin
    ? planModules
    : (useUserModules ? userModules.filter((m) => planModules.includes(m)) : planModules);
};

/**
 * Middleware: resolves allowed modules and attaches req.allowedOrderTypes.
 * Used on listing, detail, update, and delete routes so controllers can
 * scope queries to only the types the user is allowed to see/modify.
 */
const resolveAllowedModulesMiddleware = catchAsync(async (req, res, next) => {
  req.allowedOrderTypes = await computeEffectiveModules(req);
  next();
});

/**
 * Middleware factory: blocks order creation if the requested order_type
 * is not in the user's effective allowed modules.
 */
const checkOrderModuleAccess = () => {
  return catchAsync(async (req, res, next) => {
    const orderTypeRaw = String(req.body?.order_type || 'outsourcing').toLowerCase();
    const requested = valid.includes(orderTypeRaw) ? orderTypeRaw : 'outsourcing';

    const effective = await computeEffectiveModules(req);

    if (!effective.includes(requested)) {
      return next(new AppError(`Order type "${requested}" is not enabled for this company.`, 403));
    }

    next();
  });
};

/**
 * Middleware factory: blocks access to a specific module key (e.g. 'outsourcing').
 * Used on carrier/driver/fleet routes.
 *
 * @param {string} moduleKey  the order module required (regular/outsourcing)
 * @param {string[]} extraPerms  feature permissions that ALSO grant access
 *                               (e.g. ['carriers','accounting'] so an accountant
 *                                can read the carrier list without the module)
 */
const requireModuleAccess = (moduleKey, extraPerms = []) => {
  return catchAsync(async (req, res, next) => {
    const requested = String(moduleKey || '').toLowerCase();
    if (!valid.includes(requested)) return next(new AppError('Invalid module access configuration.', 500));

    // Platform super admin always bypasses.
    if (req.isSuperAdminUser || req.user?.permissions?.includes('super_admin')) return next();

    // Gate 1 (plan-level): the module must be part of the tenant's PLAN.
    // Applies to everyone in the tenant — admin included — so a plan without a
    // module fully disables it, not just order creation.
    const planModulesRaw = await resolvePlanModules(req);
    const planModules = planModulesRaw.length ? planModulesRaw : [...valid]; // backward-compat
    if (!planModules.includes(requested)) {
      return next(new AppError(`Module "${requested}" is not included in this company's plan.`, 403));
    }

    const perms = Array.isArray(req.user?.permissions) ? req.user.permissions : [];

    // Gate 2 (per-user): within an enabled module, admin / sub-admin has full access.
    if (req.user?.is_admin === 1 || Number(req.user?.role) === 3 || perms.includes('subadmin')) return next();

    // User has the module itself, or an explicitly-allowed feature permission
    if (perms.includes(requested)) return next();
    if (extraPerms.some(p => perms.includes(p))) return next();

    const effective = await computeEffectiveModules(req);

    if (!effective.includes(requested)) {
      return next(new AppError(`Module "${requested}" is not enabled for this account.`, 403));
    }

    next();
  });
};

module.exports = {
  resolveAllowedModulesMiddleware,
  checkOrderModuleAccess,
  requireModuleAccess,
  requireActiveSubscription
};
