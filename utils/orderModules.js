/**
 * The two order modules, and the one place that decides whether a tenant's PLAN restricts them.
 *
 * It no longer does. A subscription plan meters SEATS (maxUsers) and orders per month — it does not
 * decide which kind of work a company is allowed to record. Gating modules by plan meant a company
 * that runs its own trucks AND brokers loads to carriers had to buy a tier to describe reality, and
 * it blocked the mixed order this codebase is moving towards (one load with a company leg and a
 * carrier leg is BOTH modules at once, so a plan naming one of them can never be the right answer).
 *
 * PER-USER module permissions are untouched: a dispatcher who only holds `outsourcing` still sees
 * only outsourcing work. That is a permission, not a plan feature, and it is enforced exactly where
 * it always was (`requireModuleAccess` Gate 2, `req.allowedOrderTypes`).
 *
 * This function is kept as a function, and every former plan-lookup site now calls it, so the
 * decision lives in one file instead of five — and so re-introducing a plan gate (if the product
 * ever wants one) is a single edit rather than an archaeology exercise.
 */
const ORDER_MODULES = ['outsourcing', 'regular'];

const sanitizeModules = (value) => {
  if (!Array.isArray(value)) return [];
  return value
    .map((m) => String(m).toLowerCase().trim())
    .filter((m) => ORDER_MODULES.includes(m));
};

/**
 * Modules a tenant's plan permits. Always both — see above.
 * Takes the tenant (unused) so call sites read naturally and keep their shape.
 */
const planModulesFor = (/* tenant */) => [...ORDER_MODULES];

module.exports = { ORDER_MODULES, sanitizeModules, planModulesFor };
