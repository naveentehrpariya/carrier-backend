/**
 * Empty moves as PAY — the single definition shared by the driver payslip, the owner deduction
 * and the review panels in front of both.
 *
 * An empty move is the truck driving from where one load ended to where the next one starts,
 * with nothing on it. The trip logs have always shown them (tripController#withEmptyMoves); the
 * client asked (2026-10-06) that the driver be PAID for them, at a per-driver empty rate, and that
 * when our driver does it in an owner-operator's truck the pay comes off that owner's settlement,
 * exactly like loaded miles.
 *
 * Rules:
 * - **The gaps are the logs' gaps.** Built by the same `withEmptyMoves`, so a move the dispatcher
 *   sees in the driver's log is the move on the payslip, and nothing else is.
 * - **A gap belongs to the month of the order it drove TO.** Driver pay is bucketed by the order's
 *   month (computeDriverTripPay), and the empty run is the cost of getting to that load.
 * - **Measured once, then stored** (EmptyMoveMiles). Re-measured only when its endpoints change.
 * - **Removing a move is ONE switch** (IgnoredEmptyMove, driver-scoped or truck-scoped): removed
 *   from the logs, the driver's payslip and the owner's deduction together.
 * - **A gap Google cannot measure pays nothing and says so** (`unmeasured`), never a guessed number.
 * - **Rate** = `DriverProfile.ratePerEmptyMile` when set (> 0), else the driver's solo rate. In the
 *   driver's own pay currency. A team leg's move is shared by its drivers, like loaded miles.
 */
const Trip = require('../db/Trip');
const Truck = require('../db/Truck');
const Users = require('../db/Users');
const DriverProfile = require('../db/DriverProfile');
const IgnoredEmptyMove = require('../db/IgnoredEmptyMove');
const EmptyMoveNote = require('../db/EmptyMoveNote');
const EmptyMoveMiles = require('../db/EmptyMoveMiles');
const { pickDriverRate, getDriverRateCurrency } = require('./distance');
const { round2 } = require('./payslipMath');

// The previous load can sit in last month — look back far enough to find it.
const LOOKBACK_MS = 62 * 24 * 60 * 60 * 1000;
// Google calls per request. A driver runs a few dozen loads a month; stored distances are free.
const MAX_MEASURE_CALLS = 80;

const helpers = () => require('../controllers/tripController')._emptyMoveHelpers;
const idStr = (v) => String(v?._id || v || '');
const moveKey = (after, before) => `${idStr(after)}_${idStr(before)}`;
const notDeleted = { $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }] };

function emptyRateFor(profile) {
  const own = Number(profile?.ratePerEmptyMile);
  if (Number.isFinite(own) && own > 0) return { rate: own, source: 'empty' };
  return { rate: Number(pickDriverRate(profile || {}, false, 0) || 0), source: 'solo' };
}

function crewSize(trip) {
  const ids = new Set();
  (trip?.drivers || []).forEach((d) => d && ids.add(idStr(d)));
  if (trip?.driver) ids.add(idStr(trip.driver));
  return Math.max(ids.size, 1);
}

// Measured distance for each move: stored value when its endpoints are unchanged, else Google
// (then stored). Mutates `moves` with `miles` (null = could not measure).
async function measureMoves(tenantId, moves) {
  if (!moves.length) return;
  const stored = await EmptyMoveMiles.find({
    tenantId,
    $or: moves.map((m) => ({ after_trip: m.after_trip_id, before_trip: m.before_trip_id })),
  }).lean();
  const byKey = new Map(stored.map((s) => [moveKey(s.after_trip, s.before_trip), s]));
  let calls = 0;
  for (const m of moves) {
    const hit = byKey.get(m.key);
    if (hit && hit.from_location === m.from_location && hit.to_location === m.to_location
        && typeof hit.miles === 'number') {
      m.miles = hit.miles;
      continue;
    }
    if (calls >= MAX_MEASURE_CALLS) { m.miles = null; continue; }
    calls += 1;
    let miles = null;
    try {
      miles = await helpers().getMilesBetweenLocations(m.from_location, m.to_location, tenantId);
    } catch { miles = null; }
    m.miles = typeof miles === 'number' ? miles : null;
    if (m.miles !== null) {
      await EmptyMoveMiles.updateOne(
        { tenantId, after_trip: m.after_trip_id, before_trip: m.before_trip_id },
        { $set: { from_location: m.from_location, to_location: m.to_location, miles: m.miles, measuredAt: new Date() } },
        { upsert: true }
      ).catch(() => {});
    }
  }
}

/**
 * Every empty move one driver made that belongs to `range` (the month of the order driven to).
 * Ignored moves are RETURNED, flagged `ignored`, so a review screen can put one back.
 */
async function computeDriverEmptyMoves(tenantId, driverId, range) {
  const from = new Date(new Date(range.from).getTime() - LOOKBACK_MS);
  const trips = await Trip.find({
    tenantId, deletedAt: null,
    $or: [{ drivers: driverId }, { driver: driverId }],
    createdAt: { $gte: from, $lte: new Date(range.to) },
  })
    .populate('order', 'serial_no shipping_details company totalDistance total_amount createdAt deletedAt')
    .populate('truck', 'unitNumber plateNumber truckNumber ownerOperated ownerOperator')
    .sort({ createdAt: 1 })
    .lean();
  // A deleted order's legs are already soft-deleted; skip any straggler rather than pay a move to it.
  const live = trips.filter((t) => t.order && !t.order.deletedAt);
  const tripById = new Map(live.map((t) => [idStr(t._id), t]));

  const { withEmptyMoves, buildOrderRawTotals } = helpers();
  const rawTotals = await buildOrderRawTotals(tenantId, live);
  const fromT = new Date(range.from).getTime();
  const toT = new Date(range.to).getTime();

  const moves = withEmptyMoves(live, rawTotals)
    .filter((i) => i.type === 'empty')
    .map((i) => {
      const before = tripById.get(idStr(i.before_trip_id));
      const after = tripById.get(idStr(i.after_trip_id));
      const orderAt = before?.order?.createdAt ? new Date(before.order.createdAt).getTime() : NaN;
      return {
        key: moveKey(i.after_trip_id, i.before_trip_id),
        after_trip_id: i.after_trip_id,
        before_trip_id: i.before_trip_id,
        from_location: String(i.from_location || ''),
        to_location: String(i.to_location || ''),
        after_order_serial: i.after_order_serial,
        before_order_serial: i.before_order_serial,
        before_order_id: before?.order?._id || null,
        date: before?.order?.createdAt || before?.createdAt || null,
        truck: before?.truck ? {
          _id: before.truck._id,
          number: before.truck.truckNumber || before.truck.unitNumber || before.truck.plateNumber || '',
          ownerOperated: !!before.truck.ownerOperated,
          ownerOperator: before.truck.ownerOperator || null,
        } : null,
        after_truck: after?.truck?._id || null,
        crew: crewSize(before),
        _orderAt: orderAt,
      };
    })
    .filter((m) => Number.isFinite(m._orderAt) && m._orderAt >= fromT && m._orderAt <= toT);

  if (!moves.length) return [];

  const truckIds = [...new Set(moves.map((m) => idStr(m.truck?._id)).filter(Boolean))];
  const [ignored, notes] = await Promise.all([
    IgnoredEmptyMove.find({
      tenantId,
      $or: [{ driver: driverId }, ...(truckIds.length ? [{ truck: { $in: truckIds } }] : [])],
    }).lean(),
    EmptyMoveNote.find({ tenantId, driver: driverId }).lean(),
  ]);
  const ignoredDriver = new Set(ignored.filter((g) => g.driver && idStr(g.driver) === idStr(driverId)).map((g) => moveKey(g.after_trip, g.before_trip)));
  const ignoredTruck = new Set(ignored.filter((g) => g.truck).map((g) => moveKey(g.after_trip, g.before_trip)));
  const noteByKey = new Map(notes.map((n) => [moveKey(n.after_trip, n.before_trip), n.note]));

  await measureMoves(tenantId, moves);

  return moves.map((m) => {
    const { _orderAt, ...rest } = m;
    const ignoredBy = ignoredDriver.has(m.key) ? 'driver' : (ignoredTruck.has(m.key) ? 'truck' : null);
    return {
      ...rest,
      ignored: !!ignoredBy,
      ignoredBy,
      unmeasured: m.miles === null,
      driverMiles: m.miles === null ? 0 : round2(m.miles / m.crew),
      note: noteByKey.get(m.key) || '',
    };
  });
}

/** Price a driver's moves at their empty rate, in their own pay currency. */
function priceDriverEmptyMoves(moves, profile) {
  const { rate, source } = emptyRateFor(profile);
  let emptyMiles = 0;
  let emptyPay = 0;
  const priced = moves.map((m) => {
    const counts = !m.ignored && !m.unmeasured;
    const pay = counts ? round2(m.driverMiles * rate) : 0;
    if (counts) { emptyMiles += m.driverMiles; emptyPay += pay; }
    return { ...m, rate, pay };
  });
  return {
    rateCurrency: getDriverRateCurrency(profile),
    emptyRate: rate,
    emptyRateSource: source,
    emptyMiles: round2(emptyMiles),
    emptyPay: round2(emptyPay),
    moves: priced,
  };
}

async function driverEmptyMovePay(tenantId, driverId, range) {
  const profile = await DriverProfile.findOne({ tenantId, user: driverId }).lean();
  const moves = await computeDriverEmptyMoves(tenantId, driverId, range);
  return priceDriverEmptyMoves(moves, profile);
}

/**
 * The empty-move pay an owner operator is charged for `range`: every move OUR driver made into a
 * load run on one of this owner's trucks. Same moves, same miles, same rate as that driver's own
 * payslip — the deduction is the driver's pay, so they cannot drift apart.
 */
async function ownerEmptyMoveCharges(tenantId, ownerId, range) {
  const trucks = await Truck.find({ tenantId, ownerOperator: ownerId, ...notDeleted }).select('_id').lean();
  if (!trucks.length) return [];
  const truckIds = trucks.map((t) => idStr(t._id));
  const from = new Date(new Date(range.from).getTime() - LOOKBACK_MS);
  const legs = await Trip.find({
    tenantId, deletedAt: null, truck: { $in: truckIds },
    createdAt: { $gte: from, $lte: new Date(range.to) },
  }).select('driver drivers').lean();
  const driverIds = [...new Set(legs.flatMap((t) => [t.driver, ...(t.drivers || [])]).filter(Boolean).map(idStr))];
  if (!driverIds.length) return [];

  const [profiles, users] = await Promise.all([
    DriverProfile.find({ tenantId, user: { $in: driverIds } }).lean(),
    Users.find({ tenantId, _id: { $in: driverIds } }).setOptions({ includeInactive: true }).select('name').lean(),
  ]);
  const profileBy = new Map(profiles.map((p) => [idStr(p.user), p]));
  const nameBy = new Map(users.map((u) => [idStr(u._id), u.name]));
  const truckSet = new Set(truckIds);

  const out = [];
  for (const driverId of driverIds) {
    const profile = profileBy.get(driverId);
    // No driver profile ⇒ not on our payroll (an owner's own driver) ⇒ nothing to charge.
    if (!profile) continue;
    const moves = await computeDriverEmptyMoves(tenantId, driverId, range);
    const priced = priceDriverEmptyMoves(moves.filter((m) => truckSet.has(idStr(m.truck?._id))), profile);
    priced.moves.forEach((m) => out.push({
      ...m,
      driver: { _id: driverId, name: nameBy.get(driverId) || 'Driver' },
      currency: priced.rateCurrency,
    }));
  }
  return out.sort((a, b) => new Date(a.date || 0) - new Date(b.date || 0));
}

module.exports = {
  computeDriverEmptyMoves,
  priceDriverEmptyMoves,
  driverEmptyMovePay,
  ownerEmptyMoveCharges,
  emptyRateFor,
  moveKey,
};
