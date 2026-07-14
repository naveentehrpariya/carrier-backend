const OwnerOperatorFinancialRecord = require('../db/OwnerOperatorFinancialRecord');
const { deriveTripMiles } = require('./distance');
const { normalizeCurrency } = require('./fx');

// Owner-operator settlement is allocated per TRIP, not per order.
//
// One order may now be split across several trucks: an owner's truck, a second owner's truck and a
// company truck. Each trip therefore belongs to exactly one settlement party — the truck's owner
// operator, or the company (null) — and the money the company pays out for the load (the order's
// settle amount) is split across those trips.
//
// Allocation key: real miles (deriveTripMiles — never trip.miles, which is unreliable), with an
// optional admin-typed per-trip override (Trip.settle_amount) taken off the top first. Company legs
// consume their miles share as well; the company just never pays itself, so that share is not paid out.

const legKey = (orderId, ownerId) => `${String(orderId)}|${String(ownerId)}`;

// Money is written back to the order/trip — keep it at cents, not float noise (8000.000000000001).
const money = (n) => Math.round((Number(n) || 0) * 100) / 100;

// The settlement party of a trip: the owner-operator that owns its truck, or null for a company truck.
function tripOwnerId(trip, truckMap) {
  const truck = truckMap.get(String(trip?.truck || ''));
  if (!truck || !truck.ownerOperated || !truck.ownerOperator) return null;
  return String(truck.ownerOperator?._id || truck.ownerOperator);
}

// Mixed = more than one settlement party on the order (two owners, or one owner + a company truck).
// A single owner running every trip stays "not mixed" and keeps the legacy order-level math.
function resolveOrderOwnerState(trips, truckMap) {
  const owners = [];
  let hasCompanyLeg = false;
  (trips || []).forEach((trip) => {
    const owner = tripOwnerId(trip, truckMap);
    if (!owner) {
      hasCompanyLeg = true;
      return;
    }
    if (!owners.includes(owner)) owners.push(owner);
  });
  const isMixedOwner = owners.length > 1 || (owners.length === 1 && hasCompanyLeg);
  return { owners, hasCompanyLeg, isMixedOwner };
}

function hasSettleOverride(trip) {
  const v = trip?.settle_amount;
  return v !== null && v !== undefined && Number.isFinite(Number(v));
}

// Pot the owner legs are paid out of, in the currency it was typed in.
function resolveSettlePot(order, trips) {
  const inputSettle = Number(order?.input_settle_amount || 0);
  const overrideTotal = (trips || []).reduce(
    (acc, t) => acc + (hasSettleOverride(t) ? Math.max(Number(t.settle_amount || 0), 0) : 0),
    0
  );
  const hasInputSettle = inputSettle > 0;
  const amount = hasInputSettle ? inputSettle : Number(order?.settle_amount || 0);
  // An override is always typed in the order's input currency. The legacy `settle_amount` column is
  // in base currency (revenue_currency), so only fall back to it when nothing was typed at trip level.
  const currency = normalizeCurrency(
    hasInputSettle || overrideTotal > 0 ? (order?.input_currency || order?.revenue_currency) : (order?.revenue_currency || order?.input_currency),
    'USD'
  );
  const fxToBase = (hasInputSettle || overrideTotal > 0) ? Number(order?.fx_to_usd || 1) : 1;
  return { amount, currency, fxToBase, overrideTotal };
}

// Per-trip settle + miles for one order. Returns [{ trip, ownerId, miles, settle }] in the pot currency.
function allocateTripSettle({ order, trips, truckMap }) {
  const orderDistanceKm = Number(order?.totalDistance || 0);
  const orderRawTotal = (trips || []).reduce(
    (acc, t) => acc + Math.max(Number(t?.totalDistance || t?.miles || t?.total_km || 0), 0),
    0
  );
  const pot = resolveSettlePot(order, trips);
  const rows = (trips || []).map((trip) => ({
    trip,
    ownerId: tripOwnerId(trip, truckMap),
    miles: deriveTripMiles(trip, orderDistanceKm, orderRawTotal),
    override: hasSettleOverride(trip) ? Math.max(Number(trip.settle_amount || 0), 0) : null,
  }));

  const remaining = Math.max(Number(pot.amount || 0) - Number(pot.overrideTotal || 0), 0);
  const autoRows = rows.filter((r) => r.override === null);
  const autoMiles = autoRows.reduce((acc, r) => acc + Math.max(Number(r.miles || 0), 0), 0);

  rows.forEach((r) => {
    if (r.override !== null) {
      r.settle = r.override;
      return;
    }
    if (autoMiles > 0) {
      r.settle = remaining * (Math.max(Number(r.miles || 0), 0) / autoMiles);
    } else {
      r.settle = autoRows.length > 0 ? remaining / autoRows.length : 0;
    }
  });

  return { rows, pot };
}

// Owner legs of one order: Map<ownerId, { miles, settleOriginal, settleCurrency, settleBase, priceRatio, tripIds }>.
//
// A non-mixed order returns a single legacy leg: settleOriginal null tells resolveOwnerOrderAmounts to
// read the order's own settle/price columns, so existing (already paid) payslips keep their numbers.
function buildOrderLegs({ order: orderDoc, trips, truckMap }) {
  const order = orderDoc?.toObject ? orderDoc.toObject() : orderDoc;
  const { owners, hasCompanyLeg, isMixedOwner } = resolveOrderOwnerState(trips, truckMap);
  const { rows, pot } = allocateTripSettle({ order, trips, truckMap });
  const totalMiles = rows.reduce((acc, r) => acc + Math.max(Number(r.miles || 0), 0), 0);
  const legs = new Map();

  if (!order?.isMixedOwner) {
    const ownerId = order?.ownerOperator ? String(order.ownerOperator) : (owners[0] || null);
    if (!ownerId) return { legs, totalMiles, owners, hasCompanyLeg, isMixedOwner, rows, pot };
    legs.set(ownerId, {
      miles: totalMiles,
      settleOriginal: null, // legacy: use the order's own settle columns
      settleCurrency: pot.currency,
      settleBase: Number(order?.settle_amount || 0),
      priceRatio: 1,
      tripIds: new Set((trips || []).map((t) => String(t._id))),
    });
    return { legs, totalMiles, owners, hasCompanyLeg, isMixedOwner, rows, pot };
  }

  rows.forEach((r) => {
    if (!r.ownerId) return; // company leg — consumes its miles share, but is never paid out
    const cur = legs.get(r.ownerId) || {
      miles: 0,
      settleOriginal: 0,
      settleCurrency: pot.currency,
      settleBase: 0,
      priceRatio: 0,
      tripIds: new Set(),
    };
    cur.miles += Math.max(Number(r.miles || 0), 0);
    cur.settleOriginal += Number(r.settle || 0);
    cur.settleBase += Number(r.settle || 0) * Number(pot.fxToBase || 1);
    cur.tripIds.add(String(r.trip?._id));
    legs.set(r.ownerId, cur);
  });
  legs.forEach((leg) => {
    leg.priceRatio = totalMiles > 0 ? leg.miles / totalMiles : 0;
  });

  return { legs, totalMiles, owners, hasCompanyLeg, isMixedOwner, rows, pot };
}

// Owner-related columns to write back on the order after a split. Order-level owner fields are
// derived from the trips whenever trips exist — the truck a trip runs decides who gets settled.
function resolveOrderOwnerFields({ order: orderDoc, trips, truckMap }) {
  // Spreading a Mongoose document drops its schema fields (they live on _doc), which would zero the
  // settle pot and 400 every mixed split. Work on a plain object.
  const order = orderDoc?.toObject ? orderDoc.toObject() : orderDoc;
  const { owners, hasCompanyLeg, isMixedOwner } = resolveOrderOwnerState(trips, truckMap);
  const fxToBase = Number(order?.fx_to_usd || 1);
  const totalInput = Number(order?.input_total_amount || 0) > 0
    ? Number(order.input_total_amount)
    : Number(order?.total_amount || 0);

  if (owners.length === 0) {
    return {
      isOwnerOperatedTruck: false,
      ownerOperator: null,
      ownerOperators: [],
      isMixedOwner: false,
      settle_amount: 0,
      input_settle_amount: 0,
      owner_profit: 0,
      carrier_amount: 0,
    };
  }

  if (!isMixedOwner) {
    // Single owner running the whole order — keep the settle amount already on the order. Legacy
    // orders predate `input_settle_amount` and carry the amount in `settle_amount` (base currency)
    // only, so never derive the pot from the input column alone. If the order carries no settle at
    // all (it was created on a company truck and only later split onto an owner's truck), fall back
    // to what the admin typed on the trips.
    const pot = resolveSettlePot(order, trips);
    const typed = Number(order?.input_settle_amount || 0);
    const existingBase = Number(order?.settle_amount || 0);
    const hasOrderSettle = typed > 0 || existingBase > 0;
    const inputSettle = hasOrderSettle ? typed : Number(pot.overrideTotal || 0);
    const baseSettle = hasOrderSettle ? existingBase : Number(pot.overrideTotal || 0) * fxToBase;
    return {
      isOwnerOperatedTruck: true,
      ownerOperator: owners[0],
      ownerOperators: [owners[0]],
      isMixedOwner: false,
      settle_amount: baseSettle,
      input_settle_amount: inputSettle,
      owner_profit: Number(order?.total_amount || 0) - baseSettle,
      carrier_amount: baseSettle,
      settlePot: baseSettle,
    };
  }

  // Mixed: the order's settle amount becomes the sum of what the owner legs actually earn — the
  // company's own legs are not paid out.
  const { legs, rows, pot } = buildOrderLegs({ order: { ...order, isMixedOwner: true }, trips, truckMap });
  let legTotal = 0;
  let baseSettle = 0;
  legs.forEach((leg) => {
    legTotal += Number(leg.settleOriginal || 0);
    baseSettle += Number(leg.settleBase || 0);
  });
  // A legacy order has no `input_settle_amount` — its pot lives in `settle_amount` (base currency).
  // Don't invent an input amount for it; the leg shares are already base.
  const hasInputPot = Number(order?.input_settle_amount || 0) > 0 || Number(pot?.overrideTotal || 0) > 0;
  const inputSettle = hasInputPot ? legTotal : 0;

  // Freeze each owner leg's share onto the trip. Without this the next read would re-split the NEW
  // (owner-only) settle amount across every trip — including the company legs — and shrink the
  // owner's pay on each pass. Company legs stay null: they are never paid out.
  const tripSettle = new Map();
  rows.forEach((r) => {
    if (!r.ownerId) return;
    tripSettle.set(String(r.trip?._id), money(r.settle));
  });
  // The legs are what actually gets paid — keep the order's settle equal to their (rounded) sum.
  const roundedInputSettle = money([...tripSettle.values()].reduce((a, b) => a + b, 0)) || money(inputSettle);
  const roundedBaseSettle = money(baseSettle);

  return {
    isOwnerOperatedTruck: true,
    ownerOperator: null, // no single settlement party — read ownerOperators instead
    ownerOperators: owners,
    isMixedOwner: true,
    settle_amount: roundedBaseSettle,
    input_settle_amount: roundedInputSettle,
    owner_profit: money(Number(order?.total_amount || 0) - roundedBaseSettle),
    carrier_amount: roundedBaseSettle,
    tripSettle,
    settlePot: roundedBaseSettle,
    totalInput,
  };
}

// Owner ledger rows (SETTLEMENT / OWNER_PROFIT) for an order — one pair per owner leg.
async function syncOwnerFinancialRecords({ tenantId, companyId, userId, order, trips = [], truckMap = new Map() }) {
  await OwnerOperatorFinancialRecord.deleteMany({
    tenantId,
    order: order._id,
    type: { $in: ['SETTLEMENT', 'OWNER_PROFIT', 'DRIVER_DEDUCTION'] },
  });
  if (!order?.isOwnerOperatedTruck) return;

  const createdAt = new Date(order.createdAt || Date.now());
  const base = {
    tenantId,
    company: companyId || null,
    order: order._id,
    month: createdAt.getMonth() + 1,
    year: createdAt.getFullYear(),
    currency: order.revenue_currency || 'usd',
    createdBy: userId || null,
  };

  const rows = [];
  if (!order.isMixedOwner) {
    if (!order.ownerOperator) return;
    rows.push(
      {
        ...base,
        ownerOperator: order.ownerOperator,
        type: 'SETTLEMENT',
        amount: Number(order.settle_amount || 0),
        paymentStatus: 'pending',
        notes: `Settlement for order #${order.serial_no || ''}`.trim(),
      },
      {
        ...base,
        ownerOperator: order.ownerOperator,
        type: 'OWNER_PROFIT',
        amount: Number(order.owner_profit || 0),
        paymentStatus: 'pending',
        notes: `Owner profit for order #${order.serial_no || ''}`.trim(),
      }
    );
  } else {
    const { legs } = buildOrderLegs({ order, trips, truckMap });
    const orderTotalBase = Number(order.total_amount || 0);
    legs.forEach((leg, ownerId) => {
      const settleBase = Number(leg.settleBase || 0);
      const legRevenueBase = orderTotalBase * Number(leg.priceRatio || 0);
      rows.push(
        {
          ...base,
          ownerOperator: ownerId,
          type: 'SETTLEMENT',
          amount: settleBase,
          paymentStatus: 'pending',
          notes: `Settlement for order #${order.serial_no || ''} (split leg)`.trim(),
        },
        {
          ...base,
          ownerOperator: ownerId,
          type: 'OWNER_PROFIT',
          amount: legRevenueBase - settleBase,
          paymentStatus: 'pending',
          notes: `Owner profit for order #${order.serial_no || ''} (split leg)`.trim(),
        }
      );
    });
  }

  if (rows.length > 0) await OwnerOperatorFinancialRecord.insertMany(rows);
}

// Orders an owner can appear on: settled entirely to them, or one leg of a mixed split.
function ownerOrderMatch(ownerIds) {
  const ids = Array.isArray(ownerIds) ? ownerIds : [ownerIds];
  return { $or: [{ ownerOperator: { $in: ids } }, { ownerOperators: { $in: ids } }] };
}

module.exports = {
  legKey,
  tripOwnerId,
  resolveOrderOwnerState,
  allocateTripSettle,
  buildOrderLegs,
  resolveOrderOwnerFields,
  syncOwnerFinancialRecords,
  ownerOrderMatch,
  resolveSettlePot,
};
