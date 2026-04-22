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

const checkOrderModuleAccess = () => {
  return catchAsync(async (req, res, next) => {
    if (req.isSuperAdminUser || req.user?.permissions?.includes('super_admin')) return next();

    const orderTypeRaw = String(req.body?.order_type || 'outsourcing').toLowerCase();
    const requested = valid.includes(orderTypeRaw) ? orderTypeRaw : 'outsourcing';

    const planModulesRaw = await resolvePlanModules(req);
    const planModules = planModulesRaw.length ? planModulesRaw : ['outsourcing'];
    const isTenantAdmin = req.user?.is_admin === 1 || req.user?.is_admin === 1;

    const userModulesRaw = Array.isArray(req.user?.allowedModules) ? req.user.allowedModules : null;
    const userModules = userModulesRaw
      ? userModulesRaw.map((m) => String(m).toLowerCase()).filter((m) => valid.includes(m))
      : null;

    const useUserModules = req.user?.modulesCustomized === true && userModules && userModules.length;
    const effective = isTenantAdmin
      ? planModules
      : (useUserModules ? userModules.filter((m) => planModules.includes(m)) : planModules);

    if (!effective.includes(requested)) {
      return next(new AppError(`Order type "${requested}" is not enabled for this company.`, 403));
    }

    next();
  });
};

const requireModuleAccess = (moduleKey) => {
  return catchAsync(async (req, res, next) => {
    if (req.isSuperAdminUser || req.user?.permissions?.includes('super_admin')) return next();

    const requested = String(moduleKey || '').toLowerCase();
    if (!valid.includes(requested)) return next(new AppError('Invalid module access configuration.', 500));

    const planModulesRaw = await resolvePlanModules(req);
    const planModules = planModulesRaw.length ? planModulesRaw : ['outsourcing'];
    const isTenantAdmin = req.user?.is_admin === 1 || req.user?.is_admin === 1;

    const userModulesRaw = Array.isArray(req.user?.allowedModules) ? req.user.allowedModules : null;
    const userModules = userModulesRaw
      ? userModulesRaw.map((m) => String(m).toLowerCase()).filter((m) => valid.includes(m))
      : null;

    const useUserModules = req.user?.modulesCustomized === true && userModules && userModules.length;
    const effective = isTenantAdmin
      ? planModules
      : (useUserModules ? userModules.filter((m) => planModules.includes(m)) : planModules);

    if (!effective.includes(requested)) {
      return next(new AppError(`Module "${requested}" is not enabled for this account.`, 403));
    }

    next();
  });
};

module.exports = {
  checkOrderModuleAccess,
  requireModuleAccess
};
