/**
 * WHAT THE OUTSIDE CARRIERS ARE OWED — allocated per LEG, the exact mirror of utils/ownerSettlement.js.
 *
 * An order used to have one carrier and one carrier_amount. It can now be split: leg 1 on our own
 * truck, leg 2 handed to an outside carrier — and leg 3 to a different carrier. So the cost of a
 * load is not one number on the order any more; it is the sum of what each leg's party is owed.
 *
 * Every leg belongs to exactly one settlement party (utils/orderParty.js). This file only concerns
 * itself with the CARRIER legs. Owner and company legs consume their miles share — they are part of
 * the route and the carrier's share must not swallow their distance — but they are never paid from
 * the carrier pot. That is the same rule ownerSettlement.js applies to company legs.
 *
 * Allocation key: real miles (deriveTripMiles — never trip.miles, which is unreliable), with an
 * optional admin-typed per-leg override (Trip.carrier_amount) taken off the top first.
 *
 * CURRENCY. A typed leg override is ALWAYS in the ORDER's input currency, so the pot is expressed in
 * that same currency before anything is compared or subtracted. A legacy order predates
 * `input_carrier_amount` and carries its cost in the base column only; that number is divided back
 * by the order's own `fx_to_usd` snapshot rather than being read as if it were already the input
 * currency. Reading it the other way inflated the owner's settlement by the whole FX rate once
 * already — see the settle-pot note in CLAUDE.md. Do not repeat it here.
 */
const { deriveTripMiles } = require('./distance');
const { normalizeCurrency } = require('./fx');

// Money is written back to the order/trip — keep it at cents, not float noise (8000.000000000001).
const money = (n) => Math.round((Number(n) || 0) * 100) / 100;

const idOf = (v) => {
  if (!v) return null;
  const raw = v._id || v;
  const s = String(raw);
  return s && s !== 'null' && s !== 'undefined' ? s : null;
};

/** The carrier that runs a leg, or null when we run it ourselves. */
function tripCarrierId(trip) {
  return idOf(trip?.carrier);
}

/**
 * Which carriers have a leg on this order, and whether any leg is ours.
 * Mirrors resolveOrderOwnerState. `isMixedCarrier` = more than one carrier on one order.
 */
function resolveOrderCarrierState(trips) {
  const carriers = [];
  let hasFleetLeg = false;
  (trips || []).forEach((trip) => {
    const carrierId = tripCarrierId(trip);
    if (!carrierId) {
      hasFleetLeg = true;
      return;
    }
    if (!carriers.includes(carrierId)) carriers.push(carrierId);
  });
  return {
    carriers,
    hasFleetLeg,
    hasCarrierLeg: carriers.length > 0,
    isMixedCarrier: carriers.length > 1,
  };
}

function hasCostOverride(trip) {
  const v = trip?.carrier_amount;
  return v !== null && v !== undefined && Number.isFinite(Number(v));
}

/**
 * The pot the carrier legs are paid out of, expressed in the currency the leg overrides are typed
 * in. See the CURRENCY note at the top of this file.
 */
function resolveCarrierPot(order, trips) {
  const inputCost = Number(order?.input_carrier_amount || 0);
  const overrideTotal = (trips || []).reduce(
    (acc, t) => acc + (hasCostOverride(t) ? Math.max(Number(t.carrier_amount || 0), 0) : 0),
    0
  );
  const hasInputCost = inputCost > 0;

  /* `carrier_amount` IS NOT ALWAYS THE CARRIER'S MONEY.
   *
   * On a fleet-only order the owner's settlement is MIRRORED into it (utils/orderCost.js explains
   * why that mirror exists). So an order that has just gained its first carrier leg — a fleet order
   * being partly handed over — would fall back to that column and pay the carrier the OWNER's
   * settlement. Found in the browser: a 1,200 settlement + a 1,000 carrier quote came out as a
   * 1,200 carrier leg and a 2,400 order cost.
   *
   * Guarding the write side was not enough: orderCost.js refuses to APPLY the mirror once a carrier
   * leg exists, but the mirrored value written before that leg existed is still sitting there to be
   * read. So the fallback is refused whenever the column could be a mirror — the order has a fleet
   * leg and a settlement — and the pot is then 0, which makes `carrier_leg_unpaid` ask the
   * dispatcher what the carrier is owed instead of inventing it. */
  const hasFleetLeg = (trips || []).some((t) => !idOf(t?.carrier) && idOf(t?.truck));
  const mirrorRisk = hasFleetLeg && Number(order?.settle_amount || 0) > 0;
  const baseAmount = mirrorRisk ? 0 : Number(order?.carrier_amount || 0);
  const fx = Number(order?.fx_to_usd || 0) > 0 ? Number(order.fx_to_usd) : 1;

  const usesInputCurrency = hasInputCost || overrideTotal > 0;
  const amount = hasInputCost ? inputCost : (usesInputCurrency ? baseAmount / fx : baseAmount);
  const currency = normalizeCurrency(
    usesInputCurrency ? (order?.input_currency || order?.revenue_currency) : (order?.revenue_currency || order?.input_currency),
    'USD'
  );
  const fxToBase = usesInputCurrency ? fx : 1;
  return { amount, currency, fxToBase, overrideTotal };
}

/**
 * Per-leg carrier cost + miles for one order, in the pot's currency.
 * @returns {{rows: Array<{trip, carrierId, miles, override, cost}>, pot}}
 */
function allocateTripCarrierCost({ order, trips }) {
  const orderDistanceKm = Number(order?.totalDistance || 0);
  const orderRawTotal = (trips || []).reduce(
    (acc, t) => acc + Math.max(Number(t?.totalDistance || t?.miles || t?.total_km || 0), 0),
    0
  );
  const pot = resolveCarrierPot(order, trips);

  const rows = (trips || []).map((trip) => ({
    trip,
    carrierId: tripCarrierId(trip),
    miles: deriveTripMiles(trip, orderDistanceKm, orderRawTotal),
    override: hasCostOverride(trip) ? Math.max(Number(trip.carrier_amount || 0), 0) : null,
  }));

  const remaining = Math.max(Number(pot.amount || 0) - Number(pot.overrideTotal || 0), 0);

  // Only CARRIER legs share the remainder. A fleet leg with no override takes nothing: the pot is
  // what outside carriers are owed, and paying a share of it to our own truck would invent a cost.
  // (ownerSettlement lets company legs consume miles because the settle pot is split by route
  // share; here the pot belongs to the carriers alone.)
  const autoRows = rows.filter((r) => r.override === null && r.carrierId);
  const autoMiles = autoRows.reduce((acc, r) => acc + Math.max(Number(r.miles || 0), 0), 0);

  rows.forEach((r) => {
    if (r.override !== null) {
      r.cost = r.override;
      return;
    }
    if (!r.carrierId) {
      r.cost = 0;
      return;
    }
    if (autoMiles > 0) {
      r.cost = remaining * (Math.max(Number(r.miles || 0), 0) / autoMiles);
    } else {
      r.cost = autoRows.length > 0 ? remaining / autoRows.length : 0;
    }
  });

  return { rows, pot };
}

/**
 * Carrier legs of one order: Map<carrierId, {miles, costOriginal, costCurrency, costBase, priceRatio, tripIds}>.
 *
 * An order with exactly ONE carrier and no fleet leg returns a single legacy leg with
 * `costOriginal: null` — the signal to read the order's own carrier columns, so nothing that was
 * already invoiced or paid moves. Same contract as buildOrderLegs on the owner side.
 */
function buildOrderCarrierLegs({ order: orderDoc, trips }) {
  const order = orderDoc?.toObject ? orderDoc.toObject() : orderDoc;
  const state = resolveOrderCarrierState(trips);
  const { rows, pot } = allocateTripCarrierCost({ order, trips });
  const totalMiles = rows.reduce((acc, r) => acc + Math.max(Number(r.miles || 0), 0), 0);
  const legs = new Map();

  const isSplitCost = state.isMixedCarrier || (state.hasCarrierLeg && state.hasFleetLeg);

  if (!isSplitCost) {
    const carrierId = state.carriers[0] || idOf(order?.carrier);
    if (!carrierId) return { legs, totalMiles, ...state, rows, pot };
    legs.set(carrierId, {
      miles: totalMiles,
      costOriginal: null, // legacy: use the order's own carrier columns
      costCurrency: pot.currency,
      costBase: Number(order?.carrier_amount || 0),
      priceRatio: 1,
      tripIds: new Set((trips || []).map((t) => String(t._id))),
    });
    return { legs, totalMiles, ...state, rows, pot };
  }

  rows.forEach((r) => {
    if (!r.carrierId) return; // our own leg — never paid from the carrier pot
    const cur = legs.get(r.carrierId) || {
      miles: 0,
      costOriginal: 0,
      costCurrency: pot.currency,
      costBase: 0,
      priceRatio: 0,
      tripIds: new Set(),
    };
    cur.miles += Math.max(Number(r.miles || 0), 0);
    cur.costOriginal += Number(r.cost || 0);
    cur.costBase += Number(r.cost || 0) * Number(pot.fxToBase || 1);
    cur.tripIds.add(String(r.trip?._id));
    legs.set(r.carrierId, cur);
  });
  legs.forEach((leg) => {
    leg.priceRatio = totalMiles > 0 ? leg.miles / totalMiles : 0;
  });

  return { legs, totalMiles, ...state, rows, pot };
}

/**
 * Carrier columns to write back on the order after a split.
 *
 * `carrier` stays a single id ONLY while there is exactly one carrier; with several it is null and
 * `carriers` is the list — the same shape `ownerOperator` / `ownerOperators` already uses, so a
 * reader that knows one convention knows both.
 *
 * `tripCost` freezes each carrier leg's share onto the trip. Without it the next read would
 * re-split the (now carrier-only) amount across the fleet legs again and shrink the carrier's cost
 * on every pass — the exact bug the owner side hit and documents.
 */
function resolveOrderCarrierFields({ order: orderDoc, trips }) {
  const order = orderDoc?.toObject ? orderDoc.toObject() : orderDoc;
  const state = resolveOrderCarrierState(trips);
  const fxToBase = Number(order?.fx_to_usd || 1);

  if (!state.hasCarrierLeg) {
    return {
      carrier: null,
      carriers: [],
      isMixedCarrier: false,
      carrier_amount: 0,
      input_carrier_amount: 0,
      carrier_ratio: 0,
      tripCost: new Map(),
    };
  }

  const isSplitCost = state.isMixedCarrier || state.hasFleetLeg;

  if (!isSplitCost) {
    // One carrier running the whole order — keep the amount already on the order. A legacy order
    // predates `input_carrier_amount` and carries the cost in `carrier_amount` (base) only, so
    // never derive the pot from the input column alone. If the order carries no cost at all (it was
    // created on our own truck and only later handed to a carrier), fall back to what was typed on
    // the legs.
    const pot = resolveCarrierPot(order, trips);
    const typed = Number(order?.input_carrier_amount || 0);
    const existingBase = Number(order?.carrier_amount || 0);
    const hasOrderCost = typed > 0 || existingBase > 0;
    return {
      carrier: state.carriers[0],
      carriers: [state.carriers[0]],
      isMixedCarrier: false,
      carrier_amount: hasOrderCost ? existingBase : money(Number(pot.overrideTotal || 0) * fxToBase),
      input_carrier_amount: hasOrderCost ? typed : money(Number(pot.overrideTotal || 0)),
      carrier_ratio: 1, // one carrier runs every leg
      tripCost: new Map(),
    };
  }

  const { legs, rows, pot } = buildOrderCarrierLegs({ order, trips });
  let legTotal = 0;
  let baseCost = 0;
  legs.forEach((leg) => {
    legTotal += Number(leg.costOriginal || 0);
    baseCost += Number(leg.costBase || 0);
  });

  const tripCost = new Map();
  rows.forEach((r) => {
    if (!r.carrierId) return;
    tripCost.set(String(r.trip?._id), money(r.cost));
  });

  // A legacy order has no `input_carrier_amount` — its pot lives in `carrier_amount` (base).
  // Don't invent an input amount for it; the leg shares are already base.
  const hasInputPot = Number(order?.input_carrier_amount || 0) > 0 || Number(pot?.overrideTotal || 0) > 0;
  const roundedInput = hasInputPot
    ? (money([...tripCost.values()].reduce((a, b) => a + b, 0)) || money(legTotal))
    : 0;

  // The carrier legs' share of the route. Revenue is attributed to a leg by miles, so this is what
  // decides how much of the order's revenue the brokered part represents — which is what staff
  // commission is earned on. A pure carrier order is 1; an order with no carrier leg is 0.
  const carrierMiles = rows.reduce((acc, r) => acc + (r.carrierId ? Math.max(Number(r.miles || 0), 0) : 0), 0);
  const allMiles = rows.reduce((acc, r) => acc + Math.max(Number(r.miles || 0), 0), 0);

  return {
    // More than one carrier means no single party owns the order's carrier column.
    carrier: state.carriers.length === 1 ? state.carriers[0] : null,
    carriers: state.carriers,
    isMixedCarrier: state.isMixedCarrier,
    carrier_amount: money(baseCost),
    input_carrier_amount: roundedInput,
    carrier_ratio: allMiles > 0 ? Math.round((carrierMiles / allMiles) * 10000) / 10000 : 0,
    tripCost,
  };
}

/**
 * Derived carrier payment status for the ORDER, rolled up from its carrier legs.
 * Every existing reader queries the order, so the order keeps a status column — it is simply no
 * longer written by hand once an order has more than one carrier leg.
 *
 *   no carrier legs      -> null  (caller keeps whatever is stored)
 *   every leg paid       -> 'paid'
 *   some leg paid        -> 'partial'
 *   otherwise            -> the shared status if the legs agree, else 'pending'
 */
function rollupCarrierPaymentStatus(trips) {
  const carrierLegs = (trips || []).filter((t) => tripCarrierId(t));
  if (!carrierLegs.length) return null;

  const statuses = carrierLegs.map((t) => String(t.carrier_payment_status || 'pending').toLowerCase());
  const paid = statuses.filter((s) => s === 'paid').length;
  if (paid === statuses.length) return 'paid';
  if (paid > 0) return 'partial';
  const first = statuses[0];
  return statuses.every((s) => s === first) ? first : 'pending';
}

/** `$or` matching orders that involve any of these carriers, on either the single or the list column. */
function carrierOrderMatch(carrierIds) {
  const ids = (Array.isArray(carrierIds) ? carrierIds : [carrierIds]).filter(Boolean);
  return { $or: [{ carrier: { $in: ids } }, { carriers: { $in: ids } }] };
}

module.exports = {
  tripCarrierId,
  resolveOrderCarrierState,
  resolveCarrierPot,
  allocateTripCarrierCost,
  buildOrderCarrierLegs,
  resolveOrderCarrierFields,
  rollupCarrierPaymentStatus,
  carrierOrderMatch,
  hasCostOverride,
};
