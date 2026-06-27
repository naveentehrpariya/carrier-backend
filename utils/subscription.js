/**
 * Subscription pricing + status helpers.
 *
 * Pricing model: a plan stores a `monthlyPrice` and a per-cycle `discounts` map.
 * The price for a cycle = monthlyPrice * months(cycle) * (1 - discount%/100).
 *
 * Status model: a subscription is "active" only when its status is active/trial AND
 * its endDate (if set) is in the future. Once endDate passes it is effectively expired.
 */

const CYCLE_MONTHS = { monthly: 1, quarterly: 3, yearly: 12 };

const cycleMonths = (cycle) => CYCLE_MONTHS[String(cycle || '').toLowerCase()] || 1;

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * Effective price for buying `plan` on `cycle`. Returns { months, base, discountPct, price, currency }.
 */
function computeCyclePrice(plan, cycle) {
  const c = String(cycle || 'monthly').toLowerCase();
  const months = cycleMonths(c);
  const monthly = Number(plan?.monthlyPrice) || 0;
  const base = round2(monthly * months);
  const discountPct = Math.min(100, Math.max(0, Number(plan?.discounts?.[c]) || 0));
  const price = round2(base * (1 - discountPct / 100));
  return { cycle: c, months, base, discountPct, price, currency: plan?.currency || 'USD' };
}

/** Price breakdown for all three cycles — handy for the buy UI. */
function priceMatrix(plan) {
  return ['monthly', 'quarterly', 'yearly'].map((c) => ({ ...computeCyclePrice(plan, c) }));
}

/** endDate = start + months(cycle). */
function computeEndDate(startDate, cycle) {
  const start = startDate ? new Date(startDate) : new Date();
  const end = new Date(start);
  end.setMonth(end.getMonth() + cycleMonths(cycle));
  return end;
}

/**
 * Is the tenant's subscription currently usable?
 * Active when status is active/trial AND endDate (if present) hasn't passed.
 */
function isSubscriptionActive(tenant, now = new Date()) {
  const sub = tenant?.subscription;
  if (!sub) return false;
  const status = String(sub.status || '').toLowerCase();
  if (!['active', 'trial'].includes(status)) return false;
  if (sub.endDate && new Date(sub.endDate).getTime() <= now.getTime()) return false;
  return true;
}

/**
 * The status the subscription SHOULD have right now (lazy expiry): if it was
 * active/trial but the endDate has passed, it is 'expired'. Otherwise unchanged.
 */
function effectiveStatus(tenant, now = new Date()) {
  const sub = tenant?.subscription;
  if (!sub) return 'none';
  const status = String(sub.status || 'none').toLowerCase();
  if (['active', 'trial'].includes(status) && sub.endDate && new Date(sub.endDate).getTime() <= now.getTime()) {
    return 'expired';
  }
  return status || 'none';
}

// Clamp a day-of-month to the given month's length (e.g. anchor day 31 in Feb → 28/29).
const clampDay = (y, m, d) => Math.min(d, new Date(y, m + 1, 0).getDate());

/**
 * The current MONTHLY order-counting window. Order limits are per month (not lifetime)
 * and reset each month, regardless of billing cycle. The window is anchored to the
 * subscription's startDate day-of-month; with no startDate it falls back to the calendar month.
 * Returns { start, end } — count orders with start <= createdAt < end; end is the reset date.
 */
function currentOrderPeriod(tenant, now = new Date()) {
  const anchor = tenant?.subscription?.startDate ? new Date(tenant.subscription.startDate) : null;
  const day = anchor && !isNaN(anchor.getTime()) ? anchor.getDate() : 1;
  const y = now.getFullYear();
  const m = now.getMonth();

  let start = new Date(y, m, clampDay(y, m, day));
  if (start.getTime() > now.getTime()) {
    start = new Date(y, m - 1, clampDay(y, m - 1, day)); // anniversary not reached yet this month
  }
  const sy = start.getFullYear();
  const sm = start.getMonth();
  const end = new Date(sy, sm + 1, clampDay(sy, sm + 1, day));
  return { start, end };
}

module.exports = {
  CYCLE_MONTHS,
  cycleMonths,
  computeCyclePrice,
  priceMatrix,
  computeEndDate,
  isSubscriptionActive,
  effectiveStatus,
  currentOrderPeriod,
};
