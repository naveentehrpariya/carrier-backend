/**
 * RE-READ AN ORDER FROM ITS LEGS.
 *
 * The order's type, its parties, its cost columns and its owner columns are all *readings* of the
 * legs — not independent facts. So every path that writes a leg has to re-read them, or the order
 * goes on describing a shape it no longer has: an order whose last carrier leg moved to our own
 * truck still reads `outsourcing`, still names a carrier, and still reports the carrier's cost.
 *
 * This is the one definition. `splitOrder`, `deleteTrip` and `updateTrip` all call it, so a leg
 * written through any of them lands the order in the same state.
 *
 * WHAT IT DOES NOT DO: it never decides *whether* the change is allowed. The payroll/payment lock
 * (`legPartyChangeBlockers`) and the over-allocation guards run in the caller, before the legs are
 * written — by the time this runs, the legs are the truth and the order is being brought into line
 * with them.
 */
const mongoose = require('mongoose');
const { resolveOrderOwnerFields, syncOwnerFinancialRecords } = require('./ownerSettlement');
const { resolveOrderCostFields } = require('./orderCost');
const { rollupCarrierPaymentStatus } = require('./carrierSettlement');
const { resolveOrderState } = require('./orderParty');

/**
 * @param {object}   opts
 * @param {string}   opts.tenantId
 * @param {object}   opts.order         Mongoose order document (saved by this function)
 * @param {Array}    opts.trips         the order's live legs, after the write
 * @param {Map}      opts.truckMap      truck id -> {ownerOperated, ownerOperator}
 * @param {object}   [opts.ownerFields] precomputed resolveOrderOwnerFields output. `splitOrder`
 *                                      passes its own — it computes the allocation BEFORE writing
 *                                      the legs, because it needs `tripSettle` to freeze each
 *                                      leg's share, and recomputing here from the frozen values
 *                                      would be a second, different reading of the same money.
 * @param {Array}    [opts.assetSource] rows to take the order's truck/driver/trailer from, in leg
 *                                      order. Defaults to `trips`. `splitOrder` passes its incoming
 *                                      segments so the order keeps exactly the driver list the
 *                                      dispatcher submitted.
 * @param {object}   [opts.req]         for the owner-ledger sync's actor/company
 * @param {boolean}  [opts.syncOwnerLedger=true]
 */
async function resyncOrderFromLegs({
  tenantId, order, trips, truckMap,
  ownerFields = null, assetSource = null, req = null, syncOwnerLedger = true,
}) {
  const legs = Array.isArray(trips) ? trips : [];
  const assets = Array.isArray(assetSource) ? assetSource : legs;

  // The order carries the FIRST FLEET leg's assets so the edit form has something to show. Reading
  // `assets[0]` unconditionally put null on a mixed order, because leg 1 may be the carrier's.
  const baseFleet = assets.find((a) => a?.truck) || null;
  if (baseFleet) {
    const baseDrivers = Array.isArray(baseFleet.drivers) ? baseFleet.drivers.filter(Boolean) : [];
    order.truck = baseFleet.truck || null;
    order.trailer = baseFleet.trailer || null;
    order.drivers = baseDrivers;
    order.driver = baseFleet.driver || baseDrivers[0] || null;
  } else {
    // Every leg went to a carrier — the order no longer runs on our equipment, and leaving a truck
    // id here would keep it in that truck's reports.
    order.truck = null;
    order.trailer = null;
    order.drivers = [];
    order.driver = null;
  }

  const owner = ownerFields || resolveOrderOwnerFields({ order, trips: legs, truckMap });

  // Both settlement sides from ONE reading of the same legs, so the carrier column and the
  // settlement column can never be computed from two different views of the money. orderCost.js is
  // also what decides whether the legacy settle -> carrier_amount mirror may fire.
  const costFields = resolveOrderCostFields({ order, trips: legs, truckMap });

  if (owner && owner.isOwnerOperatedTruck) {
    order.isOwnerOperatedTruck = owner.isOwnerOperatedTruck;
    order.ownerOperator = owner.ownerOperator;
    order.ownerOperators = owner.ownerOperators;
    order.isMixedOwner = owner.isMixedOwner;
    order.settle_amount = owner.settle_amount;
    order.input_settle_amount = owner.input_settle_amount;
    order.owner_profit = owner.owner_profit;
  } else {
    order.isOwnerOperatedTruck = false;
    order.ownerOperator = null;
    order.ownerOperators = [];
    order.isMixedOwner = false;
    order.settle_amount = 0;
    order.input_settle_amount = 0;
    order.owner_profit = 0;
  }

  Object.entries(costFields.set).forEach(([k, v]) => { order[k] = v; });

  /* THE ORDER MUST NEVER CONTRADICT ITS LEGS ABOUT PAYMENT.
   * Only the payment endpoint used to roll this up, so a re-split left the order saying `paid`
   * while every one of its (new) legs said `pending` — and the carrier payment reports read the
   * order. `null` means there are no carrier legs to roll up, and then whatever is stored stands. */
  const rolled = rollupCarrierPaymentStatus(legs);
  if (rolled) order.carrier_payment_status = rolled;

  // The type is a reading of the parties, so it is re-stamped here — this is where an order becomes
  // (or stops being) mixed. `resolved: false` means the legs could not answer at all, and then the
  // stored type stands: absence of a readable leg is not evidence of a change.
  const partyState = resolveOrderState({ order: order.toObject(), trips: legs, truckMap });
  if (partyState.resolved) {
    order.order_type = partyState.order_type;
    order.order_parties = partyState.order_parties;
    order.isMixedType = partyState.isMixedType;
  }

  await order.save();

  if (syncOwnerLedger) {
    await syncOwnerFinancialRecords({
      tenantId,
      companyId: req?.user?.company?._id || req?.user?.company || null,
      userId: req?.user?._id,
      order,
      trips: legs,
      truckMap,
    });
  }

  return { owner, costFields, partyState };
}

/**
 * An order's live legs plus the trucks they run, in the shape every reader here expects.
 *
 * The projection is the union of what ownerSettlement, carrierSettlement and orderParty read —
 * `carrier` included, which is the field a leg-loader is most likely to forget: without it every
 * carrier leg reads as an unassigned leg and the order looks like it has no carrier at all.
 */
async function loadOrderLegsAndTrucks(tenantId, orderId) {
  const Trip = mongoose.model('trips');
  const Truck = mongoose.model('trucks');

  const trips = await Trip.find({ tenantId, order: orderId, deletedAt: null })
    .select('truck carrier miles totalDistance total_km settle_amount carrier_amount carrier_payment_status trip_no')
    .lean();

  const truckIds = [...new Set(trips.map((t) => String(t.truck || '')).filter(Boolean))];
  const truckRows = truckIds.length
    ? await Truck.find({ tenantId, _id: { $in: truckIds } }).select('ownerOperated ownerOperator').lean()
    : [];

  return { trips, truckMap: new Map(truckRows.map((t) => [String(t._id), t])) };
}

module.exports = { resyncOrderFromLegs, loadOrderLegsAndTrucks };
