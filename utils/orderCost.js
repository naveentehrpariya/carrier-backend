/**
 * THE ORDER'S COST — one number built from both settlement sides.
 *
 * An order's cost used to be whichever single column its type pointed at: `carrier_amount` on an
 * outsourcing order, `settle_amount` on a regular one. An order can now be split across our own
 * truck AND an outside carrier, so neither column alone is the cost any more — the cost is the sum
 * of what every leg's party is owed.
 *
 * `cost_amount` / `input_cost_amount` on the order are that sum. On an order with only one kind of
 * leg they equal the column the reports already read, so switching a reader to them changes nothing
 * for existing data and fixes it for a mixed order.
 *
 * The two side files stay separate and keep their own contracts:
 *   utils/ownerSettlement.js   — what the owner-operators are owed
 *   utils/carrierSettlement.js — what the outside carriers are owed
 * This file only adds them up, and decides which columns may be written.
 */
const { resolveOrderOwnerFields } = require('./ownerSettlement');
const { resolveOrderCarrierFields, resolveOrderCarrierState } = require('./carrierSettlement');

const money = (n) => Math.round((Number(n) || 0) * 100) / 100;
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/**
 * Every cost column an order should carry after a split or an edit.
 *
 * @returns {{
 *   owner: object,            resolveOrderOwnerFields output (or null when no fleet leg)
 *   carrier: object,          resolveOrderCarrierFields output
 *   set: object,              the columns to write on the order
 *   mirrorCarrierAmount: boolean   whether the legacy settle -> carrier_amount mirror applies
 * }}
 */
function resolveOrderCostFields({ order: orderDoc, trips, truckMap }) {
  const order = orderDoc?.toObject ? orderDoc.toObject() : orderDoc;
  const carrierState = resolveOrderCarrierState(trips);

  // AN ORDER WITH NO LEGS CANNOT PROVE IT HAS NO CARRIER.
  //
  // `resolveOrderCarrierState([])` says "no carrier leg", which reads identically to "every leg is
  // ours" — but the two mean opposite things. On the live database 374 of 776 orders carry no leg at
  // all, so clearing the carrier columns here would fire on half the book: `carrier: null` on an
  // order still stamped `outsourcing` fails the schema's conditional `required`, and because the
  // caller treats this stamp as non-fatal the save was swallowed and the user still saw
  // "Order updated successfully" — with `cost_amount: 0` sitting beside `carrier_amount: 900`.
  //
  // Absence of legs is not evidence of absence of a carrier. Same principle as
  // orderParty.resolveOrderState returning `resolved: false` rather than guessing. So: keep the
  // order's own columns, and derive the cost total from them.
  if (!Array.isArray(trips) || trips.length === 0) {
    const isOutsourcing = String(order?.order_type || '') === 'outsourcing';
    const base = isOutsourcing ? num(order?.carrier_amount) : num(order?.settle_amount);
    const input = isOutsourcing ? num(order?.input_carrier_amount) : num(order?.input_settle_amount);
    return {
      owner: null,
      carrier: null,
      carrierState,
      mirrorCarrierAmount: false,
      set: { cost_amount: money(base), input_cost_amount: money(input) },
    };
  }

  const carrier = resolveOrderCarrierFields({ order, trips });
  const owner = resolveOrderOwnerFields({ order, trips, truckMap });

  // THE MIRROR. `resolveOrderOwnerFields` returns `carrier_amount: <the settlement>` — a legacy
  // convention that let reports read one column as "the cost" on a regular order. It is only
  // correct while the order has no carrier leg. Applying it to an order that DOES have one would
  // overwrite the carrier's cost with the owner's settlement, and — because `resolveCarrierPot`
  // falls back to `carrier_amount` — the next read would then split that settlement across the
  // carrier legs as if it were their money.
  const mirrorCarrierAmount = !carrierState.hasCarrierLeg;

  const carrierBase = carrierState.hasCarrierLeg ? num(carrier.carrier_amount) : 0;
  const carrierInput = carrierState.hasCarrierLeg ? num(carrier.input_carrier_amount) : 0;
  const settleBase = num(owner.settle_amount);
  const settleInput = num(owner.input_settle_amount);

  const set = {
    carriers: carrier.carriers,
    cost_amount: money(carrierBase + settleBase),
    input_cost_amount: money(carrierInput + settleInput),
    // What share of the route the brokered legs are — the basis for staff commission on a mixed
    // order. Stored because the Order virtuals have no access to the legs.
    carrier_ratio: carrierState.hasCarrierLeg ? Number(carrier.carrier_ratio || 0) : 0,
  };

  if (carrierState.hasCarrierLeg) {
    set.carrier = carrier.carrier;
    set.carrier_amount = money(carrierBase);
    set.input_carrier_amount = money(carrierInput);
  } else {
    set.carrier = null;
    set.input_carrier_amount = 0;
    if (mirrorCarrierAmount && owner.isOwnerOperatedTruck) {
      // Unchanged legacy behaviour for a fleet-only order.
      set.carrier_amount = money(num(owner.carrier_amount));
    } else {
      set.carrier_amount = 0;
    }
  }

  return { owner, carrier, carrierState, set, mirrorCarrierAmount };
}

/**
 * Read an order's cost, whatever shape it is in.
 *
 * `cost_amount` is only present on orders written since it existed, so a legacy order falls back to
 * the column its type points at — the same answer it has always given. Never add `carrier_amount`
 * and `settle_amount` together as a fallback: on a legacy REGULAR order the settlement is mirrored
 * into `carrier_amount`, so adding them would double the cost.
 *
 * @returns {{base: number, input: number}}
 */
function orderCostAmounts(order) {
  const stored = num(order?.cost_amount);
  const storedInput = num(order?.input_cost_amount);
  if (stored > 0 || storedInput > 0) return { base: stored, input: storedInput };

  const isOutsourcing = String(order?.order_type || '') === 'outsourcing';
  if (isOutsourcing) {
    return { base: num(order?.carrier_amount), input: num(order?.input_carrier_amount) };
  }
  return { base: num(order?.settle_amount), input: num(order?.input_settle_amount) };
}

/* There is deliberately NO commission helper here.
 *
 * Commission is defined once, on the Order model's `commission` virtual, and converted once in
 * utils/orderMoney.js#orderMoneyIn. A third copy in this file was exported and never called — and
 * an unused second definition of a money formula is exactly how two screens end up quoting
 * different commission for the same order. If commission ever needs to move out of the virtual,
 * move it; do not copy it.                                                                      */

module.exports = { resolveOrderCostFields, orderCostAmounts };
