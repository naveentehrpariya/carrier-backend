// Single source of truth for turning order money into a display currency.
//
// Why this exists: an order stores BOTH the exact amount the user typed
// (`input_total_amount` in `input_currency`) and a base-USD copy (`total_amount`,
// converted with the FX snapshot taken at creation time). Any screen that read the
// USD copy and then converted it back to the user's display currency did a
// round-trip (CAD -> USD at create rate -> CAD at today's rate) and drifted by a few
// dollars against the order card, which shows the exact typed value.
//
// Rule enforced here: convert ONCE, and always from the exact typed amount in its own
// input currency. When the input currency already equals the display currency the
// value passes through untouched (rate 1), so aggregate screens match the order card
// to the cent.
const { normalizeCurrency, convertAmount, getFxRatesMap } = require('./fx');

const SUPPORTED = ['USD', 'CAD', 'INR'];

// The currency the order's exact `input_*` values are denominated in.
function orderInputCurrency(order) {
  return normalizeCurrency(order?.input_currency || order?.revenue_currency || 'USD', 'USD');
}

// The currency the order's base (converted) columns are denominated in.
function orderBaseCurrency(order) {
  return normalizeCurrency(order?.revenue_currency || 'USD', 'USD');
}

// Prefer the exact typed amount; fall back to the base column for legacy orders that
// never captured an `input_*` value. Returns the amount WITH the currency it is in.
function pickOrderAmount(order, inputField, baseField) {
  const input = Number(order?.[inputField]);
  if (Number.isFinite(input) && input > 0) {
    return { amount: input, currency: orderInputCurrency(order), exact: true };
  }
  return { amount: Number(order?.[baseField] || 0), currency: orderBaseCurrency(order), exact: false };
}

// FX rates are stored per month, and a report can span months, so cache one rate map
// per (month, year). `prime()` must run before the synchronous `convert()` helpers.
function createOrderFxConverter(tenantId, targetCurrency) {
  const target = normalizeCurrency(targetCurrency, 'USD');
  const maps = new Map();

  const keyOf = (date) => {
    const d = date ? new Date(date) : new Date();
    const valid = !Number.isNaN(d.getTime()) ? d : new Date();
    return `${valid.getFullYear()}-${valid.getMonth() + 1}`;
  };

  async function prime(dates = []) {
    const keys = new Set([keyOf(new Date()), ...(dates || []).map(keyOf)]);
    for (const key of keys) {
      if (maps.has(key)) continue;
      const [year, month] = key.split('-').map(Number);
      let map;
      try {
        // Auto-seed from the historical FX API when a month has no stored rate —
        // convertAmount() silently falls back to 1:1 otherwise, which is wrong money.
        const { ensureMonthlyFxRates } = require('../controllers/ownerOperatorController');
        map = await ensureMonthlyFxRates(tenantId, month, year, target, SUPPORTED);
      } catch (err) {
        map = await getFxRatesMap(tenantId, month, year, target);
      }
      maps.set(key, map);
    }
  }

  function mapFor(date) {
    return maps.get(keyOf(date)) || maps.get(keyOf(new Date())) || new Map([[target, 1]]);
  }

  // Convert a single amount from `source` into the target currency, using the FX of
  // the month `date` belongs to (keeps historical reports stable).
  function convert(amount, source, date) {
    const src = normalizeCurrency(source, target);
    if (src === target) return Number(amount || 0);
    return convertAmount(amount, src, target, mapFor(date)).value;
  }

  // Convert one of an order's money fields, exact-typed value first.
  function convertOrder(order, inputField, baseField, date) {
    const picked = pickOrderAmount(order, inputField, baseField);
    return convert(picked.amount, picked.currency, date || order?.createdAt);
  }

  return { target, prime, convert, convertOrder, mapFor };
}

// Every money figure of one order, in the display currency. Mirrors the `commission` /
// `profit` virtuals on the Order model, but derives them from the converted exact amounts so
// a report total always equals the sum of the order cards it lists.
// `order.created_by` must be populated with `staff_commision` for commission to be correct.
function orderMoneyIn(order, fx) {
  const date = order?.createdAt;
  const revenue = fx.convertOrder(order, 'input_total_amount', 'total_amount', date);
  const carrierAmount = fx.convertOrder(order, 'input_carrier_amount', 'carrier_amount', date);
  const settle = fx.convertOrder(order, 'input_settle_amount', 'settle_amount', date);

  const isOutsourcing = order?.order_type === 'outsourcing';
  const isOwnerOperated = order?.order_type === 'regular' && !!order?.isOwnerOperatedTruck;
  const carrierCost = isOutsourcing ? carrierAmount : 0;
  const rate = Number(order?.created_by?.staff_commision) || 0;
  const commission = isOutsourcing ? (revenue - carrierCost) * (rate / 100) : 0;
  const profit = isOwnerOperated ? (revenue - settle) : (revenue - carrierCost - commission);

  return { currency: fx.target, revenue, carrierAmount, carrierCost, settle, commission, profit };
}

// $addFields stage for aggregations: exposes the exact typed revenue (`_exactAmount`) and the
// currency it is in (`_exactCurrency`), falling back to the base column for legacy orders.
// Group by `_exactCurrency` and convert each bucket once — never $sum the base column alone.
const EXACT_AMOUNT_FIELDS = {
  _exactAmount: {
    $cond: [{ $gt: ['$input_total_amount', 0] }, '$input_total_amount', { $ifNull: ['$total_amount', 0] }],
  },
  _exactCurrency: {
    $toUpper: {
      $cond: [
        { $gt: ['$input_total_amount', 0] },
        { $ifNull: ['$input_currency', { $ifNull: ['$revenue_currency', 'USD'] }] },
        { $ifNull: ['$revenue_currency', 'USD'] },
      ],
    },
  },
};

// Display currency for money aggregates: explicit `?currency=` wins, then the
// company/tenant billing currency, then USD.
function resolveDisplayCurrency(req, fallback) {
  const requested = req?.query?.currency;
  if (requested) return normalizeCurrency(requested, 'USD');
  const companyCurrency = req?.user?.company?.currency || req?.tenant?.currency;
  return normalizeCurrency(companyCurrency || fallback || 'USD', 'USD');
}

module.exports = {
  SUPPORTED,
  orderInputCurrency,
  orderBaseCurrency,
  pickOrderAmount,
  orderMoneyIn,
  EXACT_AMOUNT_FIELDS,
  createOrderFxConverter,
  resolveDisplayCurrency,
};
