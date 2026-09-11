/**
 * WHO GETS PAID FOR A LEG — the single definition of an order's type.
 *
 * An order's type used to be a question asked before any work was described: the dispatcher picked
 * "regular" or "outsourcing" and the form then demanded that type's fields. That is backwards. The
 * truck (or the carrier) on a leg already says who runs it, so the type is not an input — it is a
 * reading of what the legs say. And because it is per leg, one order can legitimately be both:
 * leg 1 on our own truck, leg 2 handed to an outside carrier. The old order-level flag could not
 * express that at all.
 *
 * Every leg belongs to exactly ONE settlement party:
 *   carrier  — an outside carrier runs it; we owe them a carrier cost
 *   owner    — an owner-operator's truck runs it; we owe them a settlement
 *   company  — our own truck and our own driver; the cost is payroll, not a payable
 *
 * This mirrors utils/ownerSettlement.js#tripOwnerId, which already splits owner from company. It is
 * deliberately a SEPARATE reader rather than a replacement, for one reason: tripOwnerId treats a
 * truck it cannot find (deleted truck — prod carries a handful) as a company leg, because changing
 * that would move money on existing settlements. This reader reports it as UNRESOLVED instead, so
 * the migration audit can list those orders for a human rather than quietly relabelling them.
 */

// Stable order, so `order_parties` is written the same way every time and a diff means a real change.
const PARTY_TYPES = ['company', 'owner', 'carrier'];

const idOf = (v) => {
  if (!v) return null;
  const raw = v._id || v;
  const s = String(raw);
  return s && s !== 'null' && s !== 'undefined' ? s : null;
};

/**
 * The settlement party of one leg.
 * @returns {{type: 'carrier'|'owner'|'company'|null, id: string|null, reason?: string}}
 *          type null = cannot be read from this leg (no truck, or a truck that no longer exists).
 */
function tripParty(trip, truckMap) {
  // A carrier on the leg wins outright. If the load was handed to an outside carrier, whatever
  // truck id may still be sitting on the row is not who runs it.
  const carrierId = idOf(trip?.carrier);
  if (carrierId) return { type: 'carrier', id: carrierId };

  const truckId = idOf(trip?.truck);
  if (!truckId) return { type: null, id: null, reason: 'no_truck_or_carrier' };

  const truck = truckMap?.get(String(truckId));
  if (!truck) return { type: null, id: null, reason: 'truck_missing' };

  const ownerId = idOf(truck.ownerOperator);
  if (truck.ownerOperated && ownerId) return { type: 'owner', id: ownerId };

  return { type: 'company', id: null };
}

/**
 * Read an order's type from its legs.
 *
 * @returns {{
 *   resolved: boolean,          false when NO leg could be read — caller must keep the stored type
 *   order_type: 'regular'|'outsourcing'|null,
 *   order_parties: string[],    subset of PARTY_TYPES, in PARTY_TYPES order
 *   isMixedType: boolean,       a carrier leg AND a fleet (company/owner) leg on the same order
 *   carrierIds: string[],
 *   ownerIds: string[],
 *   legCount: number,
 *   unresolvedLegs: number,
 *   reasons: string[]           why legs could not be read (deduped)
 * }}
 *
 * Mixed orders are stamped `regular`. That is not a judgement about the load — it is the safer of
 * the two for legacy readers: `regular` is the branch that does NOT assume a single carrier and a
 * single carrier_amount, so a report that has not learned about mixed orders yet degrades to
 * showing fleet figures rather than inventing a carrier that owns the whole order. `isMixedType`
 * is the flag that actually carries the truth.
 */
function resolveOrderTypeState(trips, truckMap) {
  const parties = [];
  const carrierIds = [];
  const ownerIds = [];
  const reasons = [];
  let unresolvedLegs = 0;

  const legs = Array.isArray(trips) ? trips : [];
  legs.forEach((trip) => {
    const p = tripParty(trip, truckMap);
    if (!p.type) {
      unresolvedLegs++;
      if (p.reason && !reasons.includes(p.reason)) reasons.push(p.reason);
      return;
    }
    if (!parties.includes(p.type)) parties.push(p.type);
    if (p.type === 'carrier' && p.id && !carrierIds.includes(p.id)) carrierIds.push(p.id);
    if (p.type === 'owner' && p.id && !ownerIds.includes(p.id)) ownerIds.push(p.id);
  });

  const order_parties = PARTY_TYPES.filter((t) => parties.includes(t));

  if (!order_parties.length) {
    return {
      resolved: false,
      order_type: null,
      order_parties: [],
      isMixedType: false,
      carrierIds: [],
      ownerIds: [],
      legCount: legs.length,
      unresolvedLegs,
      reasons: legs.length ? reasons : ['no_legs'],
    };
  }

  const hasCarrier = order_parties.includes('carrier');
  const hasFleet = order_parties.includes('company') || order_parties.includes('owner');

  return {
    resolved: true,
    order_type: hasCarrier && !hasFleet ? 'outsourcing' : 'regular',
    order_parties,
    isMixedType: hasCarrier && hasFleet,
    carrierIds,
    ownerIds,
    legCount: legs.length,
    unresolvedLegs,
    reasons,
  };
}

/**
 * Read the type from an order payload that has no legs yet (order creation — the default leg is
 * built AFTER the order row). Same rule, one step earlier: a carrier means an outside carrier runs
 * it, a truck or a driver means we do.
 *
 * @returns {'regular'|'outsourcing'|null}  null = the payload says nothing either way.
 */
function deriveOrderTypeFromPayload(body) {
  const hasCarrier = !!idOf(body?.carrier);
  const hasFleet = !!idOf(body?.truck)
    || !!idOf(body?.driver)
    || (Array.isArray(body?.drivers) && body.drivers.some((d) => idOf(d)))
    || !!idOf(body?.ownerOperator);

  if (hasCarrier && !hasFleet) return 'outsourcing';
  if (hasFleet && !hasCarrier) return 'regular';
  if (hasCarrier && hasFleet) return 'regular'; // both named: mixed, stamped regular (see above)
  return null;
}

/** Parties implied by an order payload with no legs yet — same shape as resolveOrderTypeState's. */
function partiesFromPayload(body, truck) {
  const out = [];
  if (idOf(body?.carrier)) out.push('carrier');
  if (idOf(body?.truck) || idOf(body?.driver) || idOf(body?.ownerOperator)) {
    const ownerId = idOf(body?.ownerOperator) || (truck?.ownerOperated ? idOf(truck?.ownerOperator) : null);
    out.push(ownerId ? 'owner' : 'company');
  }
  return PARTY_TYPES.filter((t) => out.includes(t));
}

/**
 * THE production rule: read an order's type, falling back the way the data actually is.
 *
 * Legs are authoritative when they can be read, but they cannot always be read. On the live
 * database 374 of 776 orders carry no leg at all — every one of them an outsourcing order from
 * before a default leg was created on save. A derivation that only looked at legs would call half
 * the book "unreadable", so it falls back to the order's own columns, which is the same question
 * asked one level up: a carrier on the order means an outside carrier ran it.
 *
 * Order of trust:
 *   1. legs      — the only source that can express a MIXED order, so it always wins
 *   2. the order's own carrier / truck / driver / ownerOperator columns
 *   3. nothing   — resolved:false, and the caller MUST keep whatever type is stored
 *
 * @param {object} order      lean order doc (needs carrier, truck, driver, drivers, ownerOperator)
 * @param {Array}  trips      the order's live legs
 * @param {Map}    truckMap   truck id -> {ownerOperated, ownerOperator}
 */
function resolveOrderState({ order, trips, truckMap }) {
  const fromLegs = resolveOrderTypeState(trips, truckMap);
  if (fromLegs.resolved) return { ...fromLegs, source: 'legs' };

  const type = deriveOrderTypeFromPayload(order);
  if (type) {
    const truck = truckMap?.get(String(idOf(order?.truck) || ''));
    const order_parties = partiesFromPayload(order, truck);
    const carrierId = idOf(order?.carrier);
    const ownerId = idOf(order?.ownerOperator) || (truck?.ownerOperated ? idOf(truck?.ownerOperator) : null);
    return {
      resolved: true,
      source: 'order',
      order_type: type,
      order_parties,
      // An order-level read can never prove a mixed order: the columns hold one carrier and one
      // truck, which is exactly the shape that could not express a mix in the first place.
      isMixedType: false,
      carrierIds: carrierId ? [carrierId] : [],
      ownerIds: ownerId ? [ownerId] : [],
      legCount: fromLegs.legCount,
      unresolvedLegs: fromLegs.unresolvedLegs,
      reasons: fromLegs.reasons,
    };
  }

  return { ...fromLegs, source: 'none' };
}


/* ── THE ORDER'S SHAPE, read from the order itself ───────────────────────────────────────────────
   `isOwnerOperatedTruck`, `isMixedOwner`, `isMixedType` and `isMixedCarrier` were four stored
   booleans that said nothing the order was not already carrying. Every one of them is answerable
   from `order_parties` plus the two id arrays — same document, no legs needed — so as columns they
   were four more things that could disagree with the legs, and four more things a writer had to
   remember to set.

   These are the one definition. Read the shape through them; never re-derive it inline.

   THE FALLBACK MATTERS. `order_parties` is absent on an order written before the stamp existed AND
   on any query whose `.select()` forgot it. For a single-party order falling back to `order_type`
   gives the right answer either way. For a MIXED order it does not — it reads as fleet-only and the
   carrier's cost vanishes. That is why ORDER_SHAPE_FIELDS exists below, and why a test asserts the
   money paths project it.                                                                        */

const partiesOf = (order) => (Array.isArray(order?.order_parties) ? order.order_parties : []);
const countOf = (v) => (Array.isArray(v) ? v.filter(Boolean).length : 0);

/**
 * Booked, but nobody is running it yet — no carrier, no truck of ours.
 *
 * This is a real state, not a gap: a load is often taken before it is decided who moves it, and the
 * whole point of deriving the type is that the question can wait until there is an answer. The
 * dispatcher leaves the choice alone on the order form and assigns the leg later in Trip Planning,
 * at which point the type stamps itself.
 *
 * An EMPTY `order_parties` array means it — an ABSENT one does not. Absent is a legacy order the
 * party migration could not read (72 of them: no legs and no carrier/truck), and those must keep
 * falling back to their stored `order_type`. Verified before relying on the distinction: not one
 * order on the live database carried `order_parties: []`, so the empty array was free to take this
 * meaning without a migration or a new column.
 */
function isUnassigned(order) {
  return Array.isArray(order?.order_parties) && order.order_parties.length === 0;
}

/** Does an outside carrier move any part of this order? */
function hasCarrierWork(order) {
  const p = partiesOf(order);
  return p.length ? p.includes('carrier') : String(order?.order_type || '') === 'outsourcing';
}

/** Does any part of it run on our own equipment — our truck, or an owner-operator's? */
function hasFleetWork(order) {
  const p = partiesOf(order);
  return p.length
    ? (p.includes('company') || p.includes('owner'))
    : String(order?.order_type || '') === 'regular';
}

/** An owner-operator runs at least one leg. Replaces the stored `isOwnerOperatedTruck`. */
function isOwnerOperated(order) {
  const p = partiesOf(order);
  if (p.length) return p.includes('owner');
  // Legacy: the stored flag is all a pre-stamp order has to say it.
  return Boolean(order?.isOwnerOperatedTruck);
}

/** More than one owner-operator on the order. Replaces the stored `isMixedOwner`. */
function hasMultipleOwners(order) {
  const n = countOf(order?.ownerOperators);
  if (n) return n > 1;
  return Boolean(order?.isMixedOwner);
}

/**
 * More than one outside carrier on the order. There is no stored flag for this and there never
 * needs to be — `carriers` is on the same document. Query form: `{ 'carriers.1': { $exists: true } }`.
 */
function hasMultipleCarriers(order) {
  return countOf(order?.carriers) > 1;
}

/** Part ours, part a carrier's. Replaces the stored `isMixedType`. */
function isMixedOrder(order) {
  const p = partiesOf(order);
  if (p.length) return p.includes('carrier') && (p.includes('company') || p.includes('owner'));
  return Boolean(order?.isMixedType);
}

/**
 * Every field the shape readers above need, as a projection fragment.
 *
 * Include this in the `.select()` of ANY query whose result is handed to a money or shape reader.
 * Omitting `order_parties` does not throw and does not read as empty — it reads as *a different
 * order*, and on a mixed order that means its carrier cost silently disappears from the figures.
 * That exact omission has already shipped twice in this codebase, in report projections.
 * `scripts/test-order-shape-projection.js` fails the build if a money path drops it.
 */
const ORDER_SHAPE_FIELDS = 'order_type order_parties carriers ownerOperators carrier_ratio isMixedType isOwnerOperatedTruck isMixedOwner';

module.exports = {
  PARTY_TYPES,
  ORDER_SHAPE_FIELDS,
  isUnassigned,
  hasCarrierWork,
  hasFleetWork,
  isOwnerOperated,
  hasMultipleOwners,
  hasMultipleCarriers,
  isMixedOrder,
  resolveOrderState,
  tripParty,
  resolveOrderTypeState,
  deriveOrderTypeFromPayload,
  partiesFromPayload,
};
