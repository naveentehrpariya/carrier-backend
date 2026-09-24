/**
 * The lock on changing WHO runs a leg — one definition, shared by every path that can change it.
 *
 * It lived privately in tripController, which was fine while the only ways to change a leg's party
 * were Trip Planning (`splitOrder`) and the leg edit (`updateTrip`). The Edit Order form is a third:
 * its carrier field is, underneath, a change to the order's single carrier leg. A copy of this rule
 * in orderController would be the next thing to drift, so it moved here.
 */
const Trip = require('../db/Trip');
const Truck = require('../db/Truck');

/**
 * Changing WHO runs a leg after somebody has been paid for it rewrites history.
 *
 * A driver payslip is built from the legs; an owner settlement is allocated across them; a carrier
 * is paid against theirs. Once any of that has happened, moving a leg from our truck to a carrier
 * (or the reverse) silently changes what those documents were built from, and nothing on screen
 * says the numbers no longer match the paperwork in someone's hand.
 *
 * This is the same rule `distanceEditBlockers` applies to the order's distance, for the same
 * reason. It is deliberately checked on the SET of settlement parties rather than per leg: a split
 * deletes and recreates every trip, so leg identity does not survive the operation — but "this
 * order used to be settled to an owner and a carrier, and now it is settled to two carriers" is
 * exactly the change that must not pass unnoticed.
 *
 * @returns {Promise<{blocked: boolean, code?: string, blockers?: string[]}>}
 */
async function legPartyChangeBlockers({ tenantId, order, segments, truckMap }) {
    const none = { blocked: false };

    const existingLegs = await Trip.find({ tenantId, order: order._id, deletedAt: null })
        .select('_id truck carrier carrier_payment_status').lean();
    if (!existingLegs.length) return none; // nothing has been settled against yet

    // The caller's truckMap only holds the INCOMING segments' trucks. An existing leg on a truck
    // that is not in the new segments would then fall through to a `truck:<id>` key while the same
    // party expressed through a different truck resolves to `company` — so moving a load from one
    // company truck to another read as a party change and 409'd a perfectly ordinary edit. Resolve
    // every truck on both sides before comparing.
    const parties = new Map(truckMap);
    const unknown = existingLegs
        .map((l) => String(l.truck || ''))
        .filter((id) => id && !parties.has(id));
    if (unknown.length) {
        const rows = await Truck.find({ _id: { $in: [...new Set(unknown)] }, tenantId })
            .select('ownerOperated ownerOperator').lean();
        rows.forEach((t) => parties.set(String(t._id), t));
    }

    const partyKey = (leg) => {
        if (leg?.carrier) return `carrier:${String(leg.carrier)}`;
        const truck = parties.get(String(leg?.truck || ''));
        // A truck that no longer exists cannot be resolved to a party. Treat it as its own key
        // rather than as `company`: guessing here would either hide a real change or invent one.
        if (!truck) return leg?.truck ? `truck:${String(leg.truck)}` : 'none';
        return (truck.ownerOperated && truck.ownerOperator)
            ? `owner:${String(truck.ownerOperator)}`
            : 'company';
    };

    const before = [...new Set(existingLegs.map(partyKey))].sort();
    const after = [...new Set((segments || []).map(partyKey))].sort();
    const sameParties = before.length === after.length && before.every((v, i) => v === after[i]);
    if (sameParties) return none;

    // Only now is it worth asking whether money has moved.
    const DriverSalary = require('../db/DriverSalary');
    const OwnerOperatorFinancialRecord = require('../db/OwnerOperatorFinancialRecord');
    const [salaryCount, settledCount] = await Promise.all([
        DriverSalary.countDocuments({ tenantId, 'orderBreakdown.order': order._id }),
        OwnerOperatorFinancialRecord.countDocuments({ tenantId, order: order._id, paymentStatus: { $ne: 'pending' } }),
    ]);
    const paidCarrierLegs = existingLegs.filter(
        (l) => l.carrier && String(l.carrier_payment_status || 'pending').toLowerCase() !== 'pending');

    const blockers = [];
    if (salaryCount > 0) blockers.push('This order is already on a generated driver payslip.');
    if (settledCount > 0) blockers.push('An owner operator has already been paid for this order.');
    if (paidCarrierLegs.length > 0) {
        blockers.push(`${paidCarrierLegs.length} carrier leg(s) on this order have already been paid.`);
    }
    if (!blockers.length) return none;

    return { blocked: true, code: 'leg_party_locked', blockers };
}

module.exports = { legPartyChangeBlockers };
