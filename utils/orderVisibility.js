/**
 * Who may READ an order — the one definition.
 *
 * Client rule: everyone's work is private, and a customer belongs to whoever is CURRENTLY
 * assigned to it. A non-privileged employee sees an order only when
 *   - its customer is currently assigned to them, or
 *   - its customer is assigned to nobody (public) / missing, and they created the order.
 * Creating a load does NOT keep it visible once its customer is assigned to someone else —
 * the order carries the customer's name, terms and money, and the customer detail page is
 * already current-assignee only. A driver sees only the orders they drive.
 * Admin / role=3 / tenant admin / sub-admin / accounting (and a super admin emulating)
 * see every order in the tenant.
 *
 * This used to be written out by hand in seven places with three different answers
 * (accounting was scoped to its own orders on its own accounting page; overview forgot
 * sub-admin), and a dozen side endpoints — trips, rate confirmations, invoices, search,
 * reports — checked the tenant only, so any employee could read any load's customer,
 * carrier and rate by id. Every reader goes through here now.
 *
 * Writes are the INTERSECTION: creator-or-admin (`applyOrderOwnershipScope`) AND this read
 * scope. Being assigned to a customer lets you read its loads, not rewrite another
 * dispatcher's; having created a load does not let you edit it once its customer is
 * someone else's.
 */
const Customer = require('../db/Customer');

const permsOf = (user) => (Array.isArray(user?.permissions) ? user.permissions : []);

function orderSeesAll(req) {
  const user = req?.user;
  if (!user) return false;
  if (req.isEmulating || req.isSuperAdminUser) return true;
  if (user.is_admin === 1 || Number(user.role) === 3 || user.isTenantAdmin) return true;
  const perms = permsOf(user);
  return perms.includes('subadmin') || perms.includes('accounting');
}

function isDriverUser(user) {
  return Number(user?.role) === 0 || permsOf(user).includes('driver');
}

/**
 * Customer ids that decide this user's orders: `mine` (assigned to them) and `others`
 * (assigned to somebody, not them). Soft-deleted customers count too — deleting a customer
 * does not make its loads public.
 */
async function customerSplit(req) {
  const tenantId = req.tenantId || req.user?.tenantId;
  if (!tenantId || !req.user?._id) return { mine: [], others: [] };
  const uid = req.user._id;
  const [mine, others] = await Promise.all([
    Customer.find({ tenantId, assigned_to: uid }).distinct('_id'),
    Customer.find({ tenantId, 'assigned_to.0': { $exists: true }, assigned_to: { $ne: uid } }).distinct('_id'),
  ]);
  return { mine, others };
}

/**
 * The clause that limits an order query to what this user may read, or **null** when they
 * may read everything. No user ⇒ a clause that matches nothing (never "everything").
 */
async function orderReadClause(req) {
  if (!req?.user) return { _id: null };
  if (orderSeesAll(req)) return null;
  const uid = req.user._id;
  if (isDriverUser(req.user)) return { $or: [{ driver: uid }, { drivers: uid }] };
  const { mine, others } = await customerSplit(req);
  const or = [{ created_by: uid, customer: { $nin: others } }];
  if (mine.length) or.push({ customer: { $in: mine } });
  return { $or: or };
}

/** Push the read scope onto `$and` (never onto `$or` — that would overwrite the soft-delete `$or`). */
async function applyOrderReadScope(req, criteria) {
  const clause = await orderReadClause(req);
  if (!clause) return criteria;
  criteria.$and = (criteria.$and || []).concat([clause]);
  return criteria;
}

const idOf = (v) => (v && v._id ? String(v._id) : v ? String(v) : null);

/**
 * In-memory check for an order already loaded (populated or not). Needs `created_by`,
 * `customer`, `driver`, `drivers` on the document.
 */
async function canReadOrder(req, order) {
  if (!req?.user || !order) return false;
  if (orderSeesAll(req)) return true;
  const uid = String(req.user._id);
  if (isDriverUser(req.user)) {
    return [order.driver, ...(Array.isArray(order.drivers) ? order.drivers : [])]
      .map(idOf).includes(uid);
  }
  const isCreator = idOf(order.created_by) === uid;
  const customerId = idOf(order.customer);
  if (!customerId) return isCreator;
  const tenantId = req.tenantId || req.user?.tenantId;
  const customer = await Customer.findOne({ _id: customerId, tenantId }).select('assigned_to').lean();
  const assigned = (customer?.assigned_to || []).map(String);
  if (assigned.length) return assigned.includes(uid);
  return isCreator;
}

/** Reports/analytics that list the whole tenant's orders: privileged only. */
const hasTenantReportAccess = orderSeesAll;

module.exports = {
  orderSeesAll,
  orderReadClause,
  applyOrderReadScope,
  canReadOrder,
  hasTenantReportAccess,
};
