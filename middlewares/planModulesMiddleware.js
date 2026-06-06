const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/AppError');
const SubscriptionPlan = require('../db/SubscriptionPlan');

const valid = ['outsourcing', 'regular'];

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
 */
const requireModuleAccess = (moduleKey) => {
  return catchAsync(async (req, res, next) => {
    const requested = String(moduleKey || '').toLowerCase();
    if (!valid.includes(requested)) return next(new AppError('Invalid module access configuration.', 500));

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
  requireModuleAccess
};
