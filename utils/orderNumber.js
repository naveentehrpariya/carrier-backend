/**
 * The order's human-facing number, server-side.
 *
 * `#CMC1013` was hardcoded in every server-rendered document — the customer invoice and the truck
 * earnings report both printed one particular tenant's prefix to every other tenant. The prefix is
 * configurable (`Company.order_prefix`) precisely so a company's paperwork carries its own mark.
 *
 * Mirrors frontend/src/utils/orderPrefix.js. Keep the two in step: a document that disagrees with
 * the screen about an order's number is worse than either being wrong on its own, because the two
 * numbers then have to be reconciled by hand.
 */

const initialsOf = (text) => {
  const words = String(text || '').split(/[-_\s]+/).filter(Boolean);
  const initials = words.map((w) => w.charAt(0).toUpperCase()).join('');
  if (initials.length >= 2) return initials;
  return String(text || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
};

/**
 * @param {object} opts
 * @param {object} opts.company  Company doc (order_prefix / code / name)
 * @param {object} opts.order    order doc (its own company may carry a code)
 * @param {string} opts.tenantId tenant slug, the last resort before the legacy default
 */
function getOrderPrefix({ company, order, tenantId } = {}) {
  if (company?.order_prefix) return String(company.order_prefix).toUpperCase();
  if (order?.company?.code) return String(order.company.code).toUpperCase();
  if (company?.code) return String(company.code).toUpperCase();
  if (company?.name) return initialsOf(company.name);
  if (tenantId && tenantId !== 'admin') return initialsOf(tenantId);
  // Legacy default. Kept only so an order with no company and no tenant still prints something
  // stable; every configured tenant reaches one of the branches above.
  return 'CMC';
}

/** e.g. `CMC-1013`. */
function getOrderNumber({ order, company, tenantId } = {}) {
  const prefix = getOrderPrefix({ company, order, tenantId });
  const serial = order?.serial_no ?? String(order?._id || '').slice(-6) ?? '000000';
  return `${prefix}-${serial}`;
}

module.exports = { getOrderPrefix, getOrderNumber };
