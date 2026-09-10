/**
 * Who may see a commercial record — customers, carriers, vendors.
 *
 * These rules already existed, written out by hand in each controller (the customer
 * one twice, in `customers_listing` and `customerDetails`). Documents attached to
 * those records have to obey exactly the same rule, and a fourth hand-written copy
 * is how the four drift apart. One definition, three callers.
 */
const { hasChequeAccess } = require('../controllers/vendorController');

const permsOf = (user) => (Array.isArray(user?.permissions) ? user.permissions : []);
const isFullAdmin = (user) =>
  user?.is_admin === 1 || Number(user?.role) === 3 || Boolean(user?.isTenantAdmin);

/** Admin / sub-admin / accounting see every customer; everyone else is scoped. */
function customerSeesAll(user) {
  const perms = permsOf(user);
  return isFullAdmin(user) || perms.includes('subadmin') || perms.includes('accounting');
}

/**
 * The `$or` that scopes a customer query to what this user may see, or **null**
 * when they may see everything. Mirrors the table in CLAUDE.md: assigned customers,
 * plus unassigned ones in their own company when they hold `regular`.
 */
function customerVisibilityOr(user) {
  if (customerSeesAll(user)) return null;
  const perms = permsOf(user);
  const or = [{ assigned_to: user?._id }];
  if (perms.includes('regular')) {
    const company = user?.company?._id || user?.company || null;
    if (company) {
      or.push({
        company,
        $or: [{ assigned_to: { $size: 0 } }, { assigned_to: { $exists: false } }],
      });
    }
  }
  return or;
}

/** Apply the customer scope to a query object, pushing onto `$and` so an existing `$or` survives. */
function applyCustomerVisibility(queryObj, user) {
  const or = customerVisibilityOr(user);
  if (!or) return queryObj;
  queryObj.$and = queryObj.$and || [];
  queryObj.$and.push({ $or: or });
  return queryObj;
}

/** Carriers are not per-user assigned — holding any carrier-ish permission is the gate. */
const CARRIER_PERMS = ['carriers', 'carriers_write', 'outsourcing', 'accounting', 'subadmin'];
function hasCarrierAccess(user) {
  if (!user) return false;
  if (isFullAdmin(user)) return true;
  return CARRIER_PERMS.some((p) => permsOf(user).includes(p));
}

module.exports = {
  isFullAdmin,
  customerSeesAll,
  customerVisibilityOr,
  applyCustomerVisibility,
  hasCarrierAccess,
  hasVendorAccess: hasChequeAccess,
  CARRIER_PERMS,
};
