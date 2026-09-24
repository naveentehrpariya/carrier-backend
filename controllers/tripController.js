const Trip = require('../db/Trip');
const { legPartyChangeBlockers } = require('../utils/legPartyLock');
const Order = require('../db/Order');
const User = require('../db/Users');
const DriverProfile = require('../db/DriverProfile');
const Truck = require('../db/Truck');
const Company = require('../db/Company');
const TruckExpense = require('../db/TruckExpense');
const IgnoredEmptyMove = require('../db/IgnoredEmptyMove');
const EmptyMoveNote = require('../db/EmptyMoveNote');
const mongoose = require('mongoose');
const { logActivity, logChange } = require('../utils/activityLogger');
const { MI_PER_KM, KM_PER_MI, deriveTripMiles, pickDriverRate, getDriverRateCurrency } = require('../utils/distance');
const { resolveOrderOwnerFields, syncOwnerFinancialRecords, resolveSettlePot } = require('../utils/ownerSettlement');
const {
    resolveOrderCarrierFields, resolveOrderCarrierState, resolveCarrierPot,
} = require('../utils/carrierSettlement');
const { resolveOrderCostFields } = require('../utils/orderCost');
const { resolveOrderState } = require('../utils/orderParty');
const { resyncOrderFromLegs, loadOrderLegsAndTrucks } = require('../utils/orderFromLegs');
const { createOrderFxConverter, resolveDisplayCurrency, pickOrderAmount } = require('../utils/orderMoney');
const { resolveRouteDistance } = require('../utils/routeDistance');
const driverSalaryController = require('./driverSalaryController');

const emptyDistanceCache = new Map();

// A trip's settle amount is optional: null means "derive it from the order's settle pot by miles".
function normalizeSegmentSettle(value) {
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) return null;
    return n;
}

// Empty moves use the same border-aware routing as order distance — otherwise a deadhead between
// two Canadian yards could be measured on a US shortcut the truck never takes.
async function getMilesBetweenLocations(from, to, tenantId) {
    const a = String(from || '').trim();
    const b = String(to || '').trim();
    if (!a || !b) return null;
    const key = `${tenantId || ''}||${a}||${b}`;
    if (emptyDistanceCache.has(key)) return emptyDistanceCache.get(key);
    const result = await resolveRouteDistance({ origin: a, destination: b, tenantId });
    const rounded = result?.ok && Number.isFinite(result.miles) ? Number(result.miles.toFixed(2)) : null;
    emptyDistanceCache.set(key, rounded);
    return rounded;
}

async function enrichEmptyMiles(logs, maxCalls = 25, tenantId = null) {
    let calls = 0;
    for (const item of logs) {
        if (item.type !== 'empty') continue;
        if (calls >= maxCalls) break;
        if (typeof item.miles === 'number') continue;
        try {
            const miles = await getMilesBetweenLocations(item.from_location, item.to_location, tenantId);
            if (typeof miles === 'number') {
                item.miles = miles;
            }
        } catch {
        }
        calls += 1;
    }
    return logs;
}

function isRelayLoc(loc) {
    if (!loc) return false;
    return (loc.location_type && String(loc.location_type).toLowerCase() === 'relay') ||
           (loc.type && String(loc.type).toLowerCase() === 'relay');
}

function buildSegmentsFromOrder(orderDoc) {
    const locs = (orderDoc?.shipping_details?.[0]?.locations) || [];
    if (!Array.isArray(locs) || locs.length < 2) return [];
    const n = locs.length;
    const relayIdxs = [];
    for (let i = 0; i < n; i++) {
        if (isRelayLoc(locs[i]) && i > 0 && i < n) relayIdxs.push(i);
    }
    const bounds = [0, ...relayIdxs, n - 1];
    const uniq = bounds.filter((b, i, arr) => i === 0 || b !== arr[i - 1]);
    const segs = [];
    for (let i = 0; i < uniq.length - 1; i++) {
        const start = uniq[i];
        const end = uniq[i + 1];
        const startLoc = locs[start];
        const endLoc = locs[end];
        segs.push({
            start_stop_index: start,
            end_stop_index: end,
            start_location: `${startLoc?.location || startLoc?.address || ''}${startLoc?.city ? `, ${startLoc.city}` : ''}`,
            end_location: `${endLoc?.location || endLoc?.address || ''}${endLoc?.city ? `, ${endLoc.city}` : ''}`,
            miles: 0,
            totalDistance: 0,
            distance_unit: 'mi'
        });
    }
    return segs;
}

function parseDateStart(value) {
    if (!value) return null;
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return null;
    d.setHours(0, 0, 0, 0);
    return d;
}

function parseDateEnd(value) {
    if (!value) return null;
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return null;
    d.setHours(23, 59, 59, 999);
    return d;
}

function resolveRange(from, to) {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    const start = parseDateStart(from) || startOfMonth;
    const end = parseDateEnd(to) || endOfMonth;
    end.setHours(23, 59, 59, 999);
    return { start, end };
}


// `legPartyChangeBlockers` lives in utils/legPartyLock.js — the Edit Order form needs it too.

exports.splitOrder = async (req, res) => {
    try {
        const { orderId, segments } = req.body;
        const tenantId = req.user.tenantId;

        const order = await Order.findOne({ _id: orderId, tenantId });
        if (!order) {
            return res.status(404).json({ status: false, message: 'Order not found' });
        }

        // An order may be split across an owner's truck, a second owner's truck and a company truck.
        // Settlement is then per trip (see utils/ownerSettlement.js): each owner is paid only for the
        // legs their trucks ran. Validate the trucks exist and that the owner legs actually carry money.
        // Gated on the SEGMENTS, not on order.order_type. The type is now a reading of the legs
        // (utils/orderParty.js), so an order that was booked as outsourcing can legitimately arrive
        // here with a fleet leg on it — that is exactly how a mixed order comes into existence.
        const truckMap = new Map();
        {
            const truckIds = [...new Set((segments || []).map(s => s.truck).filter(Boolean).map(String))];
            if (truckIds.length > 0) {
                const trucksInUse = await Truck.find({ _id: { $in: truckIds }, tenantId })
                    .select('ownerOperated ownerOperator')
                    .lean();
                trucksInUse.forEach(t => truckMap.set(String(t._id), t));
                for (const tid of truckIds) {
                    if (!truckMap.has(tid)) {
                        return res.status(400).json({ status: false, message: 'One of the selected trucks was not found for this tenant.' });
                    }
                }
            }

            const settleErrors = [];
            (segments || []).forEach((seg, i) => {
                if (seg.settle_amount === null || seg.settle_amount === undefined || seg.settle_amount === '') return;
                const v = Number(seg.settle_amount);
                if (!Number.isFinite(v) || v < 0) settleErrors.push(`Trip ${i + 1}`);
            });
            if (settleErrors.length > 0) {
                return res.status(400).json({
                    status: false,
                    message: `Settle amount must be a positive number (${settleErrors.join(', ')}).`,
                });
            }
        }

        // Guard: a trip stores ONE blended `rate_per_mile` across its drivers, and driver pay is
        // later read back in each driver's own locked pay currency. If two drivers on the same trip
        // are paid in different currencies, that single number gets interpreted as both — e.g. a
        // blended 0.80 read as 0.80 USD for one driver and 0.80 CAD for the other. Until rates are
        // stored per driver per trip, require one pay currency per trip.
        const segmentDriverIds = [...new Set(
            (segments || []).flatMap(s => (Array.isArray(s.drivers) && s.drivers.length > 0 ? s.drivers : (s.driver ? [s.driver] : [])))
                .filter(Boolean).map(String)
        )];
        // Also used below to stamp each trip with the currency its pay is denominated in.
        const currencyByDriver = new Map();
        if (segmentDriverIds.length > 0) {
            const profiles = await DriverProfile.find({
                tenantId,
                user: { $in: segmentDriverIds },
            }).select('user rateCurrency').lean();
            profiles.forEach(p => currencyByDriver.set(String(p.user), getDriverRateCurrency(p)));
        }
        if (segmentDriverIds.length > 1) {
            for (const seg of (segments || [])) {
                const list = (Array.isArray(seg.drivers) && seg.drivers.length > 0 ? seg.drivers : (seg.driver ? [seg.driver] : []))
                    .filter(Boolean).map(String);
                const currencies = [...new Set(list.map(id => currencyByDriver.get(id) || 'USD'))];
                if (currencies.length > 1) {
                    return res.status(400).json({
                        status: false,
                        message: `All drivers on a trip must be paid in the same currency — this trip mixes ${currencies.join(' and ')}. Assign drivers with a matching pay currency.`,
                    });
                }
            }
        }

        // Owner legs must actually carry money: an owner whose settle share is zero would be paid
        // nothing for the miles they ran. Same for a carrier leg. Check on the incoming segments,
        // before any trip is written.
        //
        // Both settlement sides are resolved from ONE set of segment stand-ins, so the owner pot and
        // the carrier pot are always read from the same legs. See utils/orderCost.js.
        const segTrips = (segments || []).map((seg, i) => ({
            _id: `seg-${i}`,
            truck: seg.truck,
            carrier: seg.carrier,
            miles: Number(seg.miles || seg.totalDistance || 0),
            totalDistance: Number(seg.totalDistance || seg.miles || 0),
            total_km: Number(seg.total_km || 0),
            settle_amount: normalizeSegmentSettle(seg.settle_amount),
            carrier_amount: normalizeSegmentSettle(seg.carrier_amount),
        }));
        const carrierState = resolveOrderCarrierState(segTrips);
        const hasFleetLeg = segTrips.some((t) => t.truck);

        // A leg has to say who runs it. Without a truck and without a carrier there is nobody to pay
        // and nobody to bill, and the leg would silently drop out of every settlement.
        {
            const orphanLegs = segTrips
                .map((t, i) => (!t.truck && !t.carrier ? i + 1 : null))
                .filter(Boolean);
            if (orphanLegs.length > 0 && segTrips.length > 1) {
                return res.status(400).json({
                    status: false,
                    code: 'leg_has_no_party',
                    message: `Leg ${orphanLegs.join(', ')} has neither a truck nor a carrier. Every leg must say who runs it.`,
                    legs: orphanLegs,
                });
            }
        }

        // Carrier legs must carry money, and must not claim more than the order's carrier amount.
        // Mirrors the two owner guards below — a carrier paid nothing for the miles they ran, and a
        // company paying out more than anyone approved, are the same two failures on the other side.
        let carrierFields = null;
        if (carrierState.hasCarrierLeg) {
            const costErrors = [];
            (segments || []).forEach((seg, i) => {
                if (seg.carrier_amount === null || seg.carrier_amount === undefined || seg.carrier_amount === '') return;
                const v = Number(seg.carrier_amount);
                if (!Number.isFinite(v) || v < 0) costErrors.push(`Leg ${i + 1}`);
            });
            if (costErrors.length > 0) {
                return res.status(400).json({
                    status: false,
                    message: `Carrier amount must be a positive number (${costErrors.join(', ')}).`,
                });
            }

            const cpot = resolveCarrierPot(order, segTrips);
            const callocated = Number(cpot.overrideTotal || 0);
            if (Number(cpot.amount || 0) > 0 && callocated - Number(cpot.amount) > 0.01) {
                return res.status(400).json({
                    status: false,
                    code: 'carrier_over_allocated',
                    message: `Leg carrier amounts add up to ${callocated.toFixed(2)} ${cpot.currency}, which is more than this order's carrier amount of ${Number(cpot.amount).toFixed(2)} ${cpot.currency}. Lower a leg amount, or raise the order's carrier amount first.`,
                    allocated: Math.round(callocated * 100) / 100,
                    pot: Math.round(Number(cpot.amount) * 100) / 100,
                    currency: cpot.currency,
                });
            }

            carrierFields = resolveOrderCarrierFields({ order, trips: segTrips });
            if (Number(cpot.amount || 0) <= 0 && callocated <= 0) {
                return res.status(400).json({
                    status: false,
                    code: 'carrier_leg_unpaid',
                    message: 'This split hands a leg to an outside carrier but has no carrier amount. Enter the amount for each carrier leg (or set it on the order) so the carrier gets paid.',
                });
            }
        }

        let ownerFields = null;
        if (hasFleetLeg) {
            // Typed leg amounts and the order's settle amount are two claims about the same money.
            // When the legs claim MORE than the pot, allocateTripSettle clamps the remainder to 0,
            // pays every override in full and the order's settle amount is then rewritten upward —
            // the company pays out more than anyone approved. TripPlanning blocks this client-side;
            // the API has to as well, or the guard is one curl away from being skipped.
            const pot = resolveSettlePot(order, segTrips);
            const allocated = Number(pot.overrideTotal || 0);
            if (Number(pot.amount || 0) > 0 && allocated - Number(pot.amount) > 0.01) {
                return res.status(400).json({
                    status: false,
                    code: 'settle_over_allocated',
                    message: `Leg amounts add up to ${allocated.toFixed(2)} ${pot.currency}, which is more than this order's settle amount of ${Number(pot.amount).toFixed(2)} ${pot.currency}. Lower a leg amount, or raise the order's settle amount first.`,
                    allocated: Math.round(allocated * 100) / 100,
                    pot: Math.round(Number(pot.amount) * 100) / 100,
                    currency: pot.currency,
                });
            }

            ownerFields = resolveOrderOwnerFields({ order, trips: segTrips, truckMap });
            // settlePot is the base-currency payout: it covers legacy orders too, which carry the
            // amount in settle_amount and leave input_settle_amount at 0.
            if (ownerFields.isOwnerOperatedTruck && Number(ownerFields.settlePot || 0) <= 0) {
                return res.status(400).json({
                    status: false,
                    message: 'This split uses an owner operator\'s truck but has no settle amount. Enter the settle amount for each owner-operated trip (or set it on the order) so the owner gets paid.',
                });
            }
        }

        // Nothing below this point is reversible — the legs are deleted and rebuilt — so the
        // "somebody has already been paid for this" check happens here, last, and refuses outright.
        const partyLock = await legPartyChangeBlockers({ tenantId, order, segments: segTrips, truckMap });
        if (partyLock.blocked) {
            return res.status(409).json({
                status: false,
                code: partyLock.code,
                message: 'Who runs a leg on this order cannot be changed any more — it has already been paid against.',
                blockers: partyLock.blockers,
            });
        }

        /* A carrier already paid must not come back as unpaid. The legs are deleted and rebuilt, so
           their payment state has to be carried across by CARRIER — the same rule deleteTrip
           follows when a relay is removed. Keyed by carrier id, because that is who was paid; a
           leg that changes carrier is a different contract and starts pending (and the party lock
           above has already refused that case on a paid order). */
        const paidByCarrier = new Map();
        (await Trip.find({ order: orderId, tenantId, deletedAt: null })
            .select('carrier carrier_payment_status carrier_payment_date carrier_payment_method carrier_payment_notes carrier_payment_updated_by')
            .lean())
            .forEach((t) => {
                const cid = t.carrier ? String(t.carrier) : null;
                if (!cid) return;
                if (String(t.carrier_payment_status || 'pending').toLowerCase() === 'pending') return;
                paidByCarrier.set(cid, {
                    carrier_payment_status: t.carrier_payment_status,
                    carrier_payment_date: t.carrier_payment_date || null,
                    carrier_payment_method: t.carrier_payment_method || null,
                    carrier_payment_notes: t.carrier_payment_notes || null,
                    carrier_payment_updated_by: t.carrier_payment_updated_by || null,
                });
            });

        // Remove existing trips for this order before re-splitting
        await Trip.deleteMany({ order: orderId, tenantId });

        const createdTrips = [];
        for (let i = 0; i < segments.length; i++) {
            const seg = segments[i];
            
            // Ensure drivers array always contains the primary driver (fix for trip lookup)
            const primaryDriver = seg.driver || (seg.drivers && seg.drivers.length > 0 ? seg.drivers[0] : null);
            const driversArr = Array.isArray(seg.drivers) ? [...seg.drivers] : [];
            if (primaryDriver && !driversArr.some((d) => String(d) === String(primaryDriver))) {
                driversArr.unshift(primaryDriver);
            }

            /* The leg's rate snapshot. Resolved from the RESOLVED primary driver and through
             * pickDriverRate, which is the same function the payslip uses.
             *
             * It used to read `seg.driver` alone and `profile.ratePerMile` alone, which got a TEAM
             * leg wrong twice over: Trip Planning sends a two-driver leg as `drivers: [...]` with no
             * `driver` key, so the lookup never ran and the leg was stored with `rate_per_mile: 0`;
             * and when it did run it took the flat rate, ignoring `ratePerMileTeam`. The payslip
             * recomputes from the profile and so was never wrong, but everything that reads the
             * SNAPSHOT was — `buildTripLogItem` prints `match?.rate_per_mile || 0`, so a team leg
             * showed zero driver pay in the truck and driver trip logs. */
            const isTeamLeg = driversArr.length > 1;
            let rate = Number(seg.rate_per_mile || 0);
            if (!rate && primaryDriver) {
                const profile = await DriverProfile.findOne({ user: primaryDriver, tenantId });
                rate = pickDriverRate(profile, isTeamLeg, 0);
            }

            const trip = new Trip({
                tenantId,
                order: orderId,
                trip_no: i + 1,
                start_stop_index: seg.start_stop_index,
                end_stop_index: seg.end_stop_index,
                driver: primaryDriver,
                drivers: driversArr,
                truck: seg.truck,
                trailer: seg.trailer,
                carrier: seg.carrier,
                start_location: seg.start_location,
                end_location: seg.end_location,
                miles: Number(seg.miles || seg.totalDistance || 0),
                totalDistance: Number(seg.totalDistance || seg.miles || 0),
                distance_unit: seg.distance_unit || 'mi',
                rate_per_mile: rate || 0,
                // Pay currency is the driver's locked rate currency (one per trip, guarded above).
                rate_currency: currencyByDriver.get(String(primaryDriver)) || 'USD',
                // On a mixed split the owner leg's share is frozen onto the trip (see
                // resolveOrderOwnerFields) so re-reading the order can't re-split it a second time.
                settle_amount: ownerFields?.tripSettle?.has(`seg-${i}`)
                    ? ownerFields.tripSettle.get(`seg-${i}`)
                    : normalizeSegmentSettle(seg.settle_amount),
                // Same freeze on the carrier side: without it, re-reading the order would split the
                // (now carrier-only) amount across the fleet legs again and shrink the carrier's
                // cost on every pass.
                carrier_amount: carrierFields?.tripCost?.has(`seg-${i}`)
                    ? carrierFields.tripCost.get(`seg-${i}`)
                    : normalizeSegmentSettle(seg.carrier_amount),
                carrier_revenue_items: Array.isArray(seg.carrier_revenue_items) ? seg.carrier_revenue_items : [],
                // Carried across the rebuild, so a carrier already paid stays paid (see above).
                ...(seg.carrier && paidByCarrier.get(String(seg.carrier)) ? paidByCarrier.get(String(seg.carrier)) : {}),
                notes: seg.notes,
                instructions: seg.instructions,
                created_by: req.user._id
            });

            await trip.save();
            createdTrips.push(trip);
        }

        // Keep the order as source of truth for the edit form: sync the FIRST FLEET leg's assets
        // back onto the order. It used to take segments[0] unconditionally, which on a mixed order
        // would put null on the order because leg 1 belongs to a carrier and has no truck.
        if (segments.length > 0) {
            // One definition of "re-read the order from its legs" — see utils/orderFromLegs.js.
            // `ownerFields` is passed in rather than recomputed: it was allocated BEFORE the legs
            // were written (it supplies `tripSettle`, which froze each leg's share), and reading it
            // back off the frozen values would be a second, different view of the same money.
            // `assetSource: segments` keeps exactly the driver list the dispatcher submitted.
            await resyncOrderFromLegs({
                tenantId, order, trips: createdTrips, truckMap,
                ownerFields, assetSource: segments, req,
            });
        }

        // A split rewrites every leg at once, so a per-document diff would be unreadable. Record
        // the resulting allocation instead — miles, rate and settle per leg is exactly what a
        // payslip is later built from, and what a disputed settlement is checked against.
        logChange(req, {
            model: 'Order',
            module: 'order',
            action: 'UPDATE',
            before: null,
            after: {
                _id: orderId,
                settle_amount: order.settle_amount,
                isMixedOwner: order.isMixedOwner,
                ownerOperators: order.ownerOperators,
            },
            description: `Split order #${order.serial_no} into ${createdTrips.length} leg(s)`,
            resourceId: orderId,
            resourceName: `Order #${order.serial_no}`,
            details: {
                tripCount: createdTrips.length,
                legs: createdTrips.map((t) => ({
                    trip_no: t.trip_no,
                    miles: t.miles,
                    rate_per_mile: t.rate_per_mile,
                    rate_currency: t.rate_currency,
                    total_driver_pay: t.total_driver_pay,
                    settle_amount: t.settle_amount,
                    truck: t.truck ? String(t.truck) : null,
                    drivers: (t.drivers || []).map(String),
                })),
            },
            critical: true,
        });
        res.json({
            status: true,
            message: 'Order split successfully into trips',
            trips: createdTrips
        });

    } catch (error) {
        console.error('Split Order Error:', error);
        res.status(500).json({ status: false, message: 'Server error during split' });
    }
};

exports.getOrderTrips = async (req, res) => {
    try {
        const { orderId } = req.params;
        const tenantId = req.user.tenantId;

        const trips = await Trip.find({ order: orderId, tenantId, deletedAt: null })
            .populate('driver', 'name email corporateID phone')
            .populate('drivers', 'name email corporateID phone')
            .populate('truck', 'unitNumber plateNumber')
            .populate('trailer', 'unitNumber plateNumber')
            .populate('carrier', 'name mc_code phone email')
            .sort({ trip_no: 1 })
            .lean();

        // `total_driver_pay` / `miles` on the row are snapshots taken when the split was saved. What
        // the driver is actually paid comes from the live engine: real miles derived from the order's
        // KM, times the driver's CURRENT rate in their own locked currency. Send both so Order View
        // can print the number that matches the payslip instead of a stale one.
        const order = await Order.findOne({ _id: orderId, tenantId }).select('totalDistance').lean();
        const rawTotal = trips.reduce(
            (a, t) => a + Math.max(Number(t.totalDistance || t.miles || t.total_km || 0), 0), 0);
        const driverIds = [...new Set(trips.flatMap((t) => {
            const list = Array.isArray(t.drivers) && t.drivers.length > 0 ? t.drivers : (t.driver ? [t.driver] : []);
            return list.map((d) => String(d?._id || d));
        }).filter(Boolean))];
        const profiles = driverIds.length
            ? await DriverProfile.find({ tenantId, user: { $in: driverIds } })
                .select('user rateCurrency ratePerMile ratePerMileSolo ratePerMileTeam').lean()
            : [];
        const profileByDriver = new Map(profiles.map((p) => [String(p.user), p]));

        const enriched = trips.map((t) => {
            const list = Array.isArray(t.drivers) && t.drivers.length > 0 ? t.drivers : (t.driver ? [t.driver] : []);
            const ids = list.map((d) => String(d?._id || d)).filter(Boolean);
            const realMiles = deriveTripMiles(t, Number(order?.totalDistance || 0), rawTotal);
            const count = Math.max(ids.length, 1);
            const isTeam = ids.length > 1;
            // A legacy trip carries no rate_currency; it predates the field and was USD.
            const snapshotCurrency = String(t.rate_currency || 'USD').toUpperCase();
            let pay = 0;
            const currencies = new Set();
            ids.forEach((id) => {
                const profile = profileByDriver.get(id);
                const profileCurrency = getDriverRateCurrency(profile);
                const usable = snapshotCurrency === profileCurrency;
                const rate = pickDriverRate(profile, isTeam, usable ? t.rate_per_mile : 0);
                pay += (realMiles / count) * rate;
                currencies.add(profileCurrency);
            });
            return {
                ...t,
                real_miles: realMiles,
                driver_pay_current: Number(pay.toFixed(2)),
                // Save is blocked on a trip whose drivers don't share a pay currency, so one code
                // describes the whole row.
                driver_pay_currency: [...currencies][0] || snapshotCurrency,
            };
        });

        res.json({ status: true, trips: enriched });
    } catch (error) {
        res.status(500).json({ status: false, message: 'Server error fetching trips' });
    }
};

exports.updateTrip = async (req, res) => {
    try {
        const { tripId } = req.params;
        const tenantId = req.user.tenantId;
        const updateData = req.body;

        // A leg carries miles, rate and settle amount — the three inputs to driver pay and owner
        // settlement. Read it as it stood so the trail can show what moved.
        const beforeTrip = await Trip.findOne({ _id: tripId, tenantId }).lean();

        // The payload used to be written verbatim, so a caller could set `order`, `tenantId` or a
        // carrier's payment state through a leg edit. Only the fields a leg edit is actually for.
        const EDITABLE = [
            'driver', 'drivers', 'truck', 'trailer', 'carrier',
            'start_stop_index', 'end_stop_index', 'start_location', 'end_location',
            'miles', 'totalDistance', 'total_km', 'distance_unit',
            'rate_per_mile', 'rate_currency', 'settle_amount', 'carrier_amount',
            'carrier_revenue_items', 'notes', 'instructions', 'status', 'trip_no',
        ];
        const patch = {};
        Object.keys(updateData || {}).forEach((k) => { if (EDITABLE.includes(k)) patch[k] = updateData[k]; });

        if (!beforeTrip) {
            return res.status(404).json({ status: false, message: 'Trip not found' });
        }

        /* THE PAYROLL/PAYMENT LOCK APPLIES HERE TOO.
           `splitOrder` refuses to move a leg's party once someone has been paid against it, but this
           endpoint wrote the leg with no such check — so the same change went through unguarded, and
           now that the order is re-derived below it also rewrites the owner ledger. Run the identical
           check, and run it BEFORE the write: nothing after that point is reversible. */
        const PARTY_FIELDS = ['truck', 'carrier'];
        const movesParty = PARTY_FIELDS.some((k) => k in patch);
        if (movesParty && beforeTrip.order) {
            const siblings = await Trip.find({ tenantId, order: beforeTrip.order, deletedAt: null })
                .select('_id truck carrier').lean();
            // The leg set as it WOULD be after this patch — that is what the lock has to compare.
            const resulting = siblings.map((t) => (String(t._id) === String(tripId)
                ? { ...t, ...patch }
                : t));
            const lockTruckIds = [...new Set(
                resulting.map((t) => String(t.truck || '')).filter(Boolean)
            )];
            const lockTrucks = lockTruckIds.length
                ? await Truck.find({ _id: { $in: lockTruckIds }, tenantId }).select('ownerOperated ownerOperator').lean()
                : [];
            const orderDoc = await Order.findOne({ _id: beforeTrip.order, tenantId }).select('_id').lean();
            if (orderDoc) {
                const lock = await legPartyChangeBlockers({
                    tenantId,
                    order: orderDoc,
                    segments: resulting,
                    truckMap: new Map(lockTrucks.map((t) => [String(t._id), t])),
                });
                if (lock.blocked) {
                    return res.status(409).json({
                        status: false,
                        code: lock.code,
                        message: 'Who runs a leg on this order cannot be changed any more — it has already been paid against.',
                        blockers: lock.blockers,
                    });
                }
            }
        }

        const trip = await Trip.findOneAndUpdate(
            // `deletedAt: null` — a removed leg is not editable. Without it a soft-deleted leg could
            // be patched, and the re-derive below would then rewrite the order's money from the legs
            // that are still live, driven by an edit to one that is not.
            { _id: tripId, tenantId, deletedAt: null },
            { ...patch, updatedAt: Date.now() },
            { new: true, runValidators: true }
        );

        if (!trip) {
            return res.status(404).json({ status: false, message: 'Trip not found' });
        }

        /* THE ORDER IS A READING OF ITS LEGS, so writing a leg has to re-read it.
           This endpoint wrote the trip and stopped — so moving a leg's carrier or truck here left
           the order still claiming the old type, the old carrier and the old cost. Everything that
           reads the order (reports, the carrier's own order list, commission, the payment rollup)
           then answered from a shape the legs no longer had.

           Only re-read when the edit could have changed WHO runs the leg or WHAT they are owed —
           a note or a stop time cannot, and re-deriving on those would rewrite the owner ledger for
           nothing. Never fatal: the leg write already succeeded, and a stamp is an index. */
        const PARTY_OR_MONEY = ['truck', 'carrier', 'driver', 'drivers', 'settle_amount', 'carrier_amount', 'miles', 'totalDistance', 'total_km'];
        const touchedParty = Object.keys(patch).some((k) => PARTY_OR_MONEY.includes(k));
        if (touchedParty && trip.order) {
            try {
                const order = await Order.findOne({ _id: trip.order, tenantId });
                if (order) {
                    const { trips: legs, truckMap } = await loadOrderLegsAndTrucks(tenantId, order._id);
                    await resyncOrderFromLegs({ tenantId, order, trips: legs, truckMap, req });
                }
            } catch (resyncErr) {
                console.error('order resync after leg update failed:', resyncErr?.message || resyncErr);
            }
        }

        logChange(req, {
            model: 'Trip',
            module: 'order',
            before: beforeTrip,
            after: trip.toObject(),
            description: `Updated leg #${trip.trip_no} (Trip ID: ${tripId})`,
            resourceId: tripId,
            resourceName: `Trip #${trip.trip_no}`,
            details: { order: trip.order ? String(trip.order) : null },
        });
        res.json({ status: true, message: 'Trip updated successfully', trip });
    } catch (error) {
        res.status(500).json({ status: false, message: 'Server error updating trip' });
    }
};

exports.getDriverTrips = async (req, res) => {
    try {
        const { driverId } = req.params;
        const { from, to } = req.query;
        const tenantId = req.user.tenantId;
        const filter = { tenantId, drivers: driverId, deletedAt: null };
        if (from || to) {
            filter.createdAt = {};
            if (from) filter.createdAt.$gte = new Date(from);
            if (to) filter.createdAt.$lte = new Date(to);
        }
        const trips = await Trip.find(filter)
            .populate('order', 'serial_no totalDistance revenue_currency customer')
            .populate('truck', 'unitNumber')
            .populate('trailer', 'unitNumber')
            .sort({ createdAt: -1 });
        res.json({ status: true, trips });
    } catch (error) {
        res.status(500).json({ status: false, message: 'Server error fetching driver trips' });
    }
};

function getOrderLocations(orderDoc) {
    const block = orderDoc?.shipping_details?.[0];
    const locs = block?.locations;
    return Array.isArray(locs) ? locs : [];
}

function extractLocMeta(orderDoc, idx) {
    const locs = getOrderLocations(orderDoc);
    const loc = typeof idx === 'number' ? locs[idx] : null;
    const rawType = loc?.type || loc?.location_type || '';
    return {
        type: rawType ? String(rawType).toLowerCase() : '',
        date: loc?.date || null,
        referenceNo: loc?.referenceNo || null
    };
}

function normalizeCompanyId(req) {
    const raw = req.user?.company?._id || req.user?.company;
    if (!raw) return null;
    const s = String(raw);
    if (!mongoose.Types.ObjectId.isValid(s)) return null;
    return new mongoose.Types.ObjectId(s);
}

// Raw distance per order across ALL its trips — the denominator every per-trip share is taken
// against. Raw/raw is unit-agnostic, so it holds whether the stored value is km or miles.
async function buildOrderRawTotals(tenantId, trips) {
    const orderIds = [...new Set(trips.map((t) => String(t.order?._id || t.order)).filter(Boolean))];
    if (!orderIds.length) return new Map();
    const all = await Trip.find({ tenantId, deletedAt: null, order: { $in: orderIds } })
        .select('order totalDistance miles total_km').lean();
    const totals = new Map();
    all.forEach((t) => {
        const oid = String(t.order);
        const raw = Math.max(Number(t.totalDistance || t.miles || t.total_km || 0), 0);
        totals.set(oid, Number(totals.get(oid) || 0) + raw);
    });
    return totals;
}

// `rawTotals` (from buildOrderRawTotals) turns the stored distance into REAL miles the same way
// the payslip does. Without it this read `trip.miles` straight — a legacy/KM-mislabeled value —
// and then divided it by order.totalDistance, which is KM: miles/km is not a share of anything,
// so the revenue split came out ~38% low. Both numbers now come from the one shared derivation.
function buildTripLogItem(trip, rawTotals = null) {
    const order = trip.order;
    const startMeta = extractLocMeta(order, trip.start_stop_index);
    const endMeta = extractLocMeta(order, trip.end_stop_index);
    const orderId = String(order?._id || trip.order || '');
    const raw = Math.max(Number(trip.totalDistance || trip.miles || trip.total_km || 0), 0);
    const denom = Number(rawTotals?.get(orderId) || 0) || raw;
    const miles = deriveTripMiles(trip, Number(order?.totalDistance || 0), denom);
    const orderTotalAmount = Number(order?.total_amount || 0);
    const gross = denom > 0 ? (orderTotalAmount * raw) / denom : 0;
    return {
        type: 'trip',
        tripId: trip._id,
        createdAt: trip.createdAt,
        updatedAt: trip.updatedAt,
        status: trip.status,
        orderId: order?._id || trip.order,
        orderSerial: order?.serial_no || null,
        start_location: trip.start_location || '',
        end_location: trip.end_location || '',
        start_type: startMeta.type,
        end_type: endMeta.type,
        start_date: startMeta.date,
        end_date: endMeta.date,
        miles,
        gross,
        driver: trip.driver ? { _id: trip.driver._id, name: trip.driver.name, corporateID: trip.driver.corporateID } : null,
        truck: trip.truck ? { _id: trip.truck._id, unitNumber: trip.truck.unitNumber, plateNumber: trip.truck.plateNumber } : null,
        trailer: trip.trailer ? { _id: trip.trailer._id, unitNumber: trip.trailer.unitNumber } : null
    };
}

function withEmptyMoves(trips, rawTotals = null) {
    const items = [];
    let prev = null;
    for (const t of trips) {
        const cur = buildTripLogItem(t, rawTotals);
        if (
            prev &&
            prev.type === 'trip' &&
            prev.end_location &&
            cur.start_location &&
            String(prev.end_location).trim().toLowerCase() !== String(cur.start_location).trim().toLowerCase() &&
            String(prev.orderId || '') !== String(cur.orderId || '')
        ) {
            items.push({
                type: 'empty',
                createdAt: cur.createdAt,
                from_location: prev.end_location,
                to_location: cur.start_location,
                after_order_serial: prev.orderSerial,
                before_order_serial: cur.orderSerial,
                after_trip_id: prev.tripId,
                before_trip_id: cur.tripId
            });
        }
        items.push(cur);
        prev = cur;
    }
    return items;
}

exports.getTruckTripLogs = async (req, res) => {
    try {
        const { truckId } = req.params;
        const { from, to, limit, includeEmptyMiles } = req.query;
        const tenantId = req.user.tenantId;
        const companyId = normalizeCompanyId(req);

        const filter = { tenantId, truck: truckId, deletedAt: null };
        if (from || to) {
            filter.createdAt = {};
            if (from) filter.createdAt.$gte = new Date(from);
            if (to) filter.createdAt.$lte = new Date(to);
        }

        const qLimit = Math.min(Math.max(Number(limit) || 500, 1), 2000);
        const trips = await Trip.find(filter)
            .populate('order', 'serial_no shipping_details company totalDistance total_amount')
            .populate('driver', 'name corporateID')
            .populate('truck', 'unitNumber plateNumber')
            .populate('trailer', 'unitNumber')
            .sort({ createdAt: 1 })
            .limit(qLimit);

        const scoped = companyId
            ? trips.filter((t) => t?.order?.company && String(t.order.company) === String(companyId))
            : trips;

        // Fetch ignored empty moves for this truck
        const ignoredMoves = await IgnoredEmptyMove.find({ tenantId, truck: truckId }).lean();
        const ignoredSet = new Set(ignoredMoves.map(m => `${m.after_trip}_${m.before_trip}`));

        // Fetch empty move notes
        const emptyNotes = await EmptyMoveNote.find({ tenantId, truck: truckId }).lean();
        const notesMap = new Map(emptyNotes.map(m => [`${m.after_trip}_${m.before_trip}`, m.note]));

        const wantEmptyMiles = String(includeEmptyMiles || '').toLowerCase() === '1' || String(includeEmptyMiles || '').toLowerCase() === 'true';
        const rawTotals = await buildOrderRawTotals(tenantId, scoped);
        let logs = wantEmptyMiles
            ? withEmptyMoves(scoped, rawTotals)
            : scoped.map((t) => buildTripLogItem(t, rawTotals));

        if (wantEmptyMiles) {
            await enrichEmptyMiles(logs, 25, tenantId);
        }

        // Filter out ignored empty moves and attach notes
        logs = logs.filter(l => !(l.type === 'empty' && ignoredSet.has(`${l.after_trip_id}_${l.before_trip_id}`))).map(l => {
            if (l.type === 'empty') {
                l.note = notesMap.get(`${l.after_trip_id}_${l.before_trip_id}`) || '';
            }
            return l;
        });

        const summary = logs.reduce(
            (acc, l) => {
                if (l.type === 'trip') acc.loadedMiles += Number(l.miles || 0);
                if (l.type === 'empty') acc.emptyMiles += Number(l.miles || 0);
                if (l.type === 'trip') acc.totalGross += Number(l.gross || 0);
                return acc;
            },
            { loadedMiles: 0, emptyMiles: 0, totalGross: 0 }
        );
        summary.totalMiles = summary.loadedMiles + summary.emptyMiles;
        res.json({ status: true, summary, logs });
    } catch (error) {
        res.status(500).json({ status: false, message: 'Server error fetching truck logs' });
    }
};

exports.getDriverTripLogs = async (req, res) => {
    try {
        const { driverId } = req.params;
        const { from, to, limit, includeEmptyMiles } = req.query;
        const tenantId = req.user.tenantId;
        const companyId = normalizeCompanyId(req);

        const driverObjId = new mongoose.Types.ObjectId(driverId);
        const filter = {
            tenantId,
            deletedAt: null,
            $or: [{ drivers: driverObjId }, { driver: driverObjId }]
        };
        if (from || to) {
            filter.createdAt = {};
            if (from) filter.createdAt.$gte = new Date(from);
            if (to) filter.createdAt.$lte = new Date(to);
        }

        const qLimit = Math.min(Math.max(Number(limit) || 500, 1), 2000);
        const trips = await Trip.find(filter)
            .populate('order', 'serial_no shipping_details company totalDistance total_amount')
            .populate('driver', 'name corporateID')
            .populate('truck', 'unitNumber plateNumber')
            .populate('trailer', 'unitNumber')
            .sort({ createdAt: 1 })
            .limit(qLimit);

        const scoped = companyId
            ? trips.filter((t) => t?.order?.company && String(t.order.company) === String(companyId))
            : trips;

        // Fetch ignored empty moves for this driver
        const ignoredMoves = await IgnoredEmptyMove.find({ tenantId, driver: driverId }).lean();
        const ignoredSet = new Set(ignoredMoves.map(m => `${m.after_trip}_${m.before_trip}`));

        // Fetch empty move notes
        const emptyNotes = await EmptyMoveNote.find({ tenantId, driver: driverId }).lean();
        const notesMap = new Map(emptyNotes.map(m => [`${m.after_trip}_${m.before_trip}`, m.note]));

        const wantEmptyMiles = String(includeEmptyMiles || '').toLowerCase() === '1' || String(includeEmptyMiles || '').toLowerCase() === 'true';
        const rawTotals = await buildOrderRawTotals(tenantId, scoped);
        let logs = wantEmptyMiles
            ? withEmptyMoves(scoped, rawTotals)
            : scoped.map((t) => buildTripLogItem(t, rawTotals));

        if (wantEmptyMiles) {
            await enrichEmptyMiles(logs, 25, tenantId);
        }

        // Filter out ignored empty moves and attach notes
        logs = logs.filter(l => !(l.type === 'empty' && ignoredSet.has(`${l.after_trip_id}_${l.before_trip_id}`))).map(l => {
            if (l.type === 'empty') {
                l.note = notesMap.get(`${l.after_trip_id}_${l.before_trip_id}`) || '';
            }
            return l;
        });

        const summary = logs.reduce(
            (acc, l) => {
                if (l.type === 'trip') acc.loadedMiles += Number(l.miles || 0);
                if (l.type === 'empty') acc.emptyMiles += Number(l.miles || 0);
                if (l.type === 'trip') acc.totalGross += Number(l.gross || 0);
                return acc;
            },
            { loadedMiles: 0, emptyMiles: 0, totalGross: 0 }
        );
        summary.totalMiles = summary.loadedMiles + summary.emptyMiles;
        res.json({ status: true, summary, logs });
    } catch (error) {
        res.status(500).json({ status: false, message: 'Server error fetching driver logs' });
    }
};

exports.getDriverTripSummary = async (req, res) => {
    try {
        const { driverId } = req.params;
        const { from, to } = req.query;
        const tenantId = req.user.tenantId;

        // Reuse the single driver-pay engine (real miles from order KM, order-month attribution,
        // all-trips proportioning denominator) so this matches the saved driver salary + owner payslip.
        const range = {
            from: from ? new Date(from) : new Date(2000, 0, 1),
            to: to ? new Date(to) : new Date(9999, 11, 31, 23, 59, 59, 999),
        };
        const tp = await driverSalaryController.computeDriverTripPay(tenantId, driverId, range);

        const byOrder = tp.byOrder.map((b) => ({
            _id: b.order,
            orderSerial: b.serial_no,
            miles: b.miles,
            km: b.km,
            trips: b.trips,
            pay: b.pay,            // in tp.rateCurrency; frontend converts to display currency
            rateUsed: b.rateUsed,
            rateType: b.rateType,
            // Where this driver's legs started and ended on the order — the same route the payslip
            // PDF prints. Not the order's own pickup/delivery: a driver often runs only one leg.
            pickupLocation: b.pickupLocation || '',
            deliveryLocation: b.deliveryLocation || '',
            pickupDate: b.pickupDate || null,
            deliveryDate: b.deliveryDate || null,
        }));

        res.json({
            status: true,
            summary: {
                totalTrips: tp.totalTrips,
                totalMiles: tp.totalMiles,
                totalKm: tp.totalKm,
                totalPay: tp.totalPay,
                // Every money field above is denominated in this, not USD — the driver's rates are
                // stored in the currency they were agreed in.
                rateCurrency: tp.rateCurrency,
                soloRate: tp.soloRate,
                teamRate: tp.teamRate,
            },
            byOrder,
        });
    } catch (error) {
        res.status(500).json({ status: false, message: 'Server error summarizing driver trips' });
    }
};

exports.getTruckTripSummary = async (req, res) => {
    try {
        const { truckId } = req.params;
        const { from, to } = req.query;
        const tenantId = req.user.tenantId;
        const companyId = normalizeCompanyId(req);
        
        const match = { tenantId, truck: new mongoose.Types.ObjectId(truckId), deletedAt: null };
        if (from || to) {
            match.createdAt = {};
            if (from) match.createdAt.$gte = new Date(from);
            if (to) match.createdAt.$lte = new Date(to);
        }
        
        // Fetch all raw trips within range to compute empty moves dynamically
        const rawTrips = await Trip.find(match)
            .populate('order', 'serial_no shipping_details company totalDistance total_amount')
            .sort({ createdAt: 1 })
            .lean();

        const scoped = companyId
            ? rawTrips.filter((t) => t?.order?.company && String(t.order.company) === String(companyId))
            : rawTrips;

        // Fetch ignored empty moves for this truck
        const ignoredMoves = await IgnoredEmptyMove.find({ tenantId, truck: truckId }).lean();
        const ignoredSet = new Set(ignoredMoves.map(m => `${m.after_trip}_${m.before_trip}`));

        // Fetch empty move notes
        const emptyNotes = await EmptyMoveNote.find({ tenantId, truck: truckId }).lean();
        const notesMap = new Map(emptyNotes.map(m => [`${m.after_trip}_${m.before_trip}`, m.note]));

        // Extract empty moves
        const rawTotals = await buildOrderRawTotals(tenantId, scoped);
        const logs = withEmptyMoves(scoped, rawTotals);
        await enrichEmptyMiles(logs, 25, tenantId);
        
        const emptyTrips = logs.filter(l => l.type === 'empty' && !ignoredSet.has(`${l.after_trip_id}_${l.before_trip_id}`)).map((e, idx) => ({
            _id: `empty_${idx}`,
            type: 'empty',
            miles: Number(e.miles || 0),
            km: Number(e.miles || 0) * KM_PER_MI,
            trips: 1,
            orderSerial: 'Empty Move',
            from_location: e.from_location,
            to_location: e.to_location,
            after_trip_id: e.after_trip_id,
            before_trip_id: e.before_trip_id,
            note: notesMap.get(`${e.after_trip_id}_${e.before_trip_id}`) || ''
        }));

        const emptyTripsTotalMiles = emptyTrips.reduce((acc, e) => acc + e.miles, 0);
        const emptyTripsTotalKm = emptyTrips.reduce((acc, e) => acc + e.km, 0);

        // Real miles, not the raw stored value. Summing `$miles` in Mongo skipped the one shared
        // derivation (order KM × this trip's share) — legacy rows hold KM under a "miles" name and
        // pre-fix splits hold an inflated pair-sum, so this total disagreed with the payslip and
        // with Trucks Gross Earning. `$total_km` is likewise stale; km comes from the real miles.
        const tripLogs = logs.filter((l) => l.type === 'trip');
        const byOrderMap = new Map();
        let totalTrips = 0, totalMiles = 0;
        tripLogs.forEach((l) => {
            const oid = String(l.orderId || '');
            const miles = Number(l.miles || 0);
            totalTrips += 1;
            totalMiles += miles;
            const cur = byOrderMap.get(oid) || { _id: l.orderId, orderSerial: l.orderSerial, miles: 0, km: 0, trips: 0, type: 'trip' };
            cur.miles += miles;
            cur.km += miles * KM_PER_MI;
            cur.trips += 1;
            byOrderMap.set(oid, cur);
        });
        const byOrder = Array.from(byOrderMap.values()).sort((a, b) => b.trips - a.trips);

        const finalSummary = { totalTrips, totalMiles, totalKm: totalMiles * KM_PER_MI };
        finalSummary.totalMiles += emptyTripsTotalMiles;
        finalSummary.totalKm += emptyTripsTotalKm;
        
        // Merge normal order trips and empty trips
        const combinedByOrder = [...byOrder, ...emptyTrips];

        res.json({ status: true, summary: finalSummary, byOrder: combinedByOrder });
    } catch (error) {
        res.status(500).json({ status: false, message: 'Server error summarizing truck trips' });
    }
};

// Per-trip truck revenue share: orderAmount × (tripRaw / sum of the order's trip raws).
// The raw/raw ratio is unit-agnostic (works whether trip distance is km or miles, and regardless
// of trip-vs-order distance mismatch). Also returns real miles for display.
//
// `fx` (createOrderFxConverter, already primed) converts the EXACT typed order amount from its
// input currency straight into the display currency — one conversion, so a CAD order shown in CAD
// stays exactly what the user typed instead of drifting through the USD base column.
async function buildTruckTripGross(tenantId, trips, fx = null) {
  const orderIds = [...new Set(trips.map((t) => String(t.order?._id || t.order)).filter(Boolean))];
  const allTrips = orderIds.length
    ? await Trip.find({ tenantId, deletedAt: null, order: { $in: orderIds } }).select('order totalDistance miles total_km').lean()
    : [];
  const orderRawTotal = new Map();
  allTrips.forEach((t) => {
    const oid = String(t.order);
    const raw = Math.max(Number(t.totalDistance || t.miles || t.total_km || 0), 0);
    orderRawTotal.set(oid, Number(orderRawTotal.get(oid) || 0) + raw);
  });
  return trips.map((t) => {
    const o = (t.order && t.order._id) ? t.order : null;
    const oid = String(o?._id || t.order);
    const raw = Math.max(Number(t.totalDistance || t.miles || t.total_km || 0), 0);
    const denom = Number(orderRawTotal.get(oid) || 0);
    const ratio = denom > 0 ? (raw / denom) : 0;
    const picked = pickOrderAmount(o || {}, 'input_total_amount', 'total_amount');
    const inputAmount = picked.amount;            // exact typed revenue (base column for legacy)
    const inputCurrency = picked.currency;
    const grossInput = inputAmount * ratio;       // exact, in the order's own currency
    const grossTarget = fx
      ? fx.convert(grossInput, inputCurrency, o?.createdAt || t.createdAt)
      : grossInput;                               // display currency, converted once
    const realMiles = deriveTripMiles(t, Number(o?.totalDistance || 0), denom);
    return {
      ...t, _orderId: oid,
      _grossTarget: grossTarget, _grossInput: grossInput,
      _inputAmount: inputAmount, _inputCurrency: inputCurrency,
      _realMiles: realMiles, _realKm: realMiles / MI_PER_KM,
    };
  });
}

exports.getTrucksGrossEarnings = async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const companyIdRaw = req.user?.company?._id || req.user?.company;
        const companyId =
            companyIdRaw && mongoose.Types.ObjectId.isValid(String(companyIdRaw))
                ? new mongoose.Types.ObjectId(String(companyIdRaw))
                : null;
        const permissions = req.user?.permissions || [];
        // `'orders'` is not a permission this app issues (see the valid list in CLAUDE.md), so that
        // clause never matched — the gate was admin + accounting only, and a sub-admin who can do
        // everything else was locked out of the truck earnings report.
        if (!(req.user?.is_admin === 1 || Number(req.user?.role) === 3
            || permissions.includes('accounting') || permissions.includes('subadmin'))) {
            return res.status(403).json({ status: false, message: 'Not authorized' });
        }

        const { from, to, status } = req.query;
        const { start, end } = resolveRange(from, to);
        const match = {
            tenantId,
            deletedAt: null,
            truck: { $ne: null },
            createdAt: { $gte: start, $lte: end }
        };
        if (status && String(status).toLowerCase() !== 'all') {
            match.status = status;
        } else if (!status) {
            match.status = { $ne: 'cancelled' };
        }

        const tripsRaw = await Trip.find(match)
            .populate('order', 'serial_no total_amount totalDistance revenue_currency company input_total_amount input_currency createdAt')
            .select('truck order miles totalDistance total_km end_location driver updatedAt createdAt')
            .lean();
        const scopedTrips = companyId
            ? tripsRaw.filter((t) => t?.order?.company && String(t.order.company) === String(companyId))
            : tripsRaw;
        const displayCurrency = resolveDisplayCurrency(req);
        const fx = createOrderFxConverter(tenantId, displayCurrency);
        await fx.prime(scopedTrips.map((t) => t?.order?.createdAt || t.createdAt));
        const enriched = await buildTruckTripGross(tenantId, scopedTrips, fx);
        const byTruck = new Map();
        enriched.forEach((t) => {
            const tid = String(t.truck);
            const cur = byTruck.get(tid) || { totalTrips: 0, totalMiles: 0, totalGross: 0, lastTripAt: null, lastLocation: '', lastDriver: null };
            cur.totalTrips += 1;
            cur.totalMiles += Number(t._realMiles || 0);
            cur.totalGross += Number(t._grossTarget || 0);
            if (!cur.lastTripAt || (t.updatedAt && new Date(t.updatedAt) > new Date(cur.lastTripAt))) {
                cur.lastTripAt = t.updatedAt; cur.lastLocation = t.end_location; cur.lastDriver = t.driver;
            }
            byTruck.set(tid, cur);
        });

        const truckFilter = { tenantId, deletedAt: null };
        if (companyId) truckFilter.company = companyId;
        const trucks = await Truck.find(truckFilter).select('_id plateNumber unitNumber').lean();

        const driverIds = Array.from(byTruck.values()).map((r) => r.lastDriver).filter(Boolean);
        const drivers = driverIds.length
            ? await User.find({ _id: { $in: driverIds } }).select('_id name corporateID').lean()
            : [];
        const driverMap = new Map(drivers.map((d) => [String(d._id), d]));

        // Aggregate expenses per truck for this period, grouped by the currency each expense was
        // entered in so they convert once into the display currency (same rule as order revenue).
        const truckObjectIds = trucks.map((t) => t._id).filter(Boolean);
        const expenseAgg = truckObjectIds.length
            ? await TruckExpense.aggregate([
                {
                    $match: {
                        tenantId,
                        truck: { $in: truckObjectIds },
                        deletedAt: null,
                        date: { $gte: start, $lte: end }
                    }
                },
                {
                    // Grouped by MONTH as well as currency. Summing a whole range into one bucket
                    // and converting it at the latest expense's rate priced January's fuel at
                    // March's FX — and made this list disagree with the per-truck detail below,
                    // which has always converted each row at its own date.
                    $group: {
                        _id: {
                            truck: '$truck',
                            currency: '$currency',
                            year: { $year: '$date' },
                            month: { $month: '$date' }
                        },
                        totalExpenses: { $sum: '$amount' },
                        anyDate: { $min: '$date' }
                    }
                }
            ])
            : [];
        const expenseMap = new Map();
        await fx.prime(expenseAgg.map((e) => e.anyDate));
        expenseAgg.forEach((e) => {
            const key = String(e._id?.truck);
            const converted = fx.convert(Number(e.totalExpenses || 0), e._id?.currency || 'USD', e.anyDate);
            expenseMap.set(key, Number(expenseMap.get(key) || 0) + converted);
        });

        const result = (trucks || []).map((t) => {
            const row = byTruck.get(String(t._id));
            const lastDriver = row?.lastDriver ? driverMap.get(String(row.lastDriver)) : null;
            const totalGross = Number(row?.totalGross || 0);
            const totalExpenses = Number(expenseMap.get(String(t._id)) || 0);
            return {
                truckId: t._id,
                plateNumber: t.plateNumber || '',
                unitNumber: t.unitNumber || '',
                totalTrips: row?.totalTrips || 0,
                totalMiles: Number(row?.totalMiles || 0),
                totalGross,
                totalExpenses,
                profit: totalGross - totalExpenses,
                currency: displayCurrency.toLowerCase(), // already in the display currency — no re-convert
                lastTripAt: row?.lastTripAt || null,
                lastLocation: row?.lastLocation || '',
                lastDriver: lastDriver ? { _id: lastDriver._id, name: lastDriver.name, corporateID: lastDriver.corporateID } : null
            };
        });

        result.sort((a, b) => (b.totalGross || 0) - (a.totalGross || 0));
        res.json({ status: true, from: start, to: end, currency: displayCurrency.toLowerCase(), trucks: result });
    } catch (error) {
        res.status(500).json({ status: false, message: 'Server error computing gross earnings' });
    }
};

exports.getTruckGrossEarningsDetail = async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const companyIdRaw = req.user?.company?._id || req.user?.company;
        const companyId =
            companyIdRaw && mongoose.Types.ObjectId.isValid(String(companyIdRaw))
                ? new mongoose.Types.ObjectId(String(companyIdRaw))
                : null;
        const permissions = req.user?.permissions || [];
        // `'orders'` is not a permission this app issues (see the valid list in CLAUDE.md), so that
        // clause never matched — the gate was admin + accounting only, and a sub-admin who can do
        // everything else was locked out of the truck earnings report.
        if (!(req.user?.is_admin === 1 || Number(req.user?.role) === 3
            || permissions.includes('accounting') || permissions.includes('subadmin'))) {
            return res.status(403).json({ status: false, message: 'Not authorized' });
        }

        const { truckId } = req.params;
        if (!mongoose.Types.ObjectId.isValid(truckId)) {
            return res.status(400).json({ status: false, message: 'Invalid truck id' });
        }

        const { from, to, status } = req.query;
        const { start, end } = resolveRange(from, to);
        const match = {
            tenantId,
            deletedAt: null,
            truck: new mongoose.Types.ObjectId(truckId),
            createdAt: { $gte: start, $lte: end }
        };
        if (status && String(status).toLowerCase() !== 'all') {
            match.status = status;
        } else if (!status) {
            match.status = { $ne: 'cancelled' };
        }

        const tripsRaw = await Trip.find(match)
            .populate('order', 'serial_no total_amount totalDistance revenue_currency company input_total_amount input_currency createdAt')
            .select('order miles totalDistance total_km updatedAt createdAt')
            .lean();
        const scopedTrips = companyId
            ? tripsRaw.filter((t) => t?.order?.company && String(t.order.company) === String(companyId))
            : tripsRaw;
        const displayCurrency = resolveDisplayCurrency(req);
        const fx = createOrderFxConverter(tenantId, displayCurrency);
        await fx.prime(scopedTrips.map((t) => t?.order?.createdAt || t.createdAt));
        const enriched = await buildTruckTripGross(tenantId, scopedTrips, fx);
        const byOrderMap = new Map();
        enriched.forEach((t) => {
            const o = (t.order && t.order._id) ? t.order : null;
            const oid = String(o?._id || t.order);
            const cur = byOrderMap.get(oid) || {
                _id: o?._id || t.order,
                orderSerial: o?.serial_no ?? null,
                orderTotalAmount: Number(t._inputAmount || 0),       // exact typed revenue
                orderCurrency: t._inputCurrency || 'usd',            // its input currency
                // Same conversion the summary uses (order-month FX), so row + summary agree.
                orderTotalAmountTarget: fx.convert(Number(t._inputAmount || 0), t._inputCurrency, o?.createdAt || t.createdAt),
                orderTotalMiles: Number(o?.totalDistance || 0) * MI_PER_KM, // order full distance, real miles
                trips: 0, miles: 0, km: 0, gross: 0, grossTarget: 0, lastTripAt: null,
            };
            cur.trips += 1;
            cur.miles += Number(t._realMiles || 0);
            cur.km += Number(t._realKm || 0);
            cur.gross += Number(t._grossInput || 0);       // exact, in order's input currency
            cur.grossTarget += Number(t._grossTarget || 0); // display currency, for the summary
            if (!cur.lastTripAt || (t.updatedAt && new Date(t.updatedAt) > new Date(cur.lastTripAt))) cur.lastTripAt = t.updatedAt;
            byOrderMap.set(oid, cur);
        });
        const rows = Array.from(byOrderMap.values()).sort((a, b) => new Date(b.lastTripAt || 0) - new Date(a.lastTripAt || 0));

        // Auto-create fixed monthly expenses (insurance, parking) if truck has them configured
        const truck = await Truck.findOne({ _id: truckId, tenantId }).lean();
        if (truck) {
            const month = start.getMonth();
            const year = start.getFullYear();
            const fixedTypes = [
                { type: 'insurance', field: 'insuranceMonthly' },
                { type: 'parking', field: 'parkingMonthly' }
            ];
            for (const { type, field } of fixedTypes) {
                const amount = Number(truck[field] || 0);
                if (amount <= 0) continue;
                const exists = await TruckExpense.findOne({
                    tenantId, truck: truck._id, isFixed: true, type,
                    fixedMonth: month, fixedYear: year, deletedAt: null
                });
                if (!exists) {
                    const date = new Date(year, month, 1);
                    await TruckExpense.create({
                        tenantId, company: truck.company, truck: truck._id,
                        type, amount, paid_by: 'owner',
                        description: `Auto: ${type.charAt(0).toUpperCase() + type.slice(1)} for ${date.toLocaleString('default', { month: 'long' })} ${year}`,
                        date, isFixed: true, fixedMonth: month, fixedYear: year
                    });
                }
            }
        }

        // Fetch all expenses for this truck in this period (after auto-creation)
        const expenseRows = await TruckExpense.find({
            tenantId,
            truck: new mongoose.Types.ObjectId(truckId),
            deletedAt: null,
            date: { $gte: start, $lte: end }
        })
            // A driver-paid receipt is reimbursed on that driver's payslip — the breakdown has to
            // name them, not just say "driver".
            .populate('driver', 'name')
            .sort({ isFixed: -1, date: -1 })
            .lean();

        await fx.prime(expenseRows.map((e) => e.date));
        const expenseByType = {};
        let totalExpenses = 0;
        for (const e of expenseRows) {
            // Each expense converts once from the currency it was entered in.
            const converted = fx.convert(Number(e.amount || 0), e.currency || 'USD', e.date);
            e.amountConverted = converted;
            expenseByType[e.type] = (expenseByType[e.type] || 0) + converted;
            totalExpenses += converted;
        }

        const summary = rows.reduce(
            (acc, r) => {
                acc.totalTrips += Number(r.trips || 0);
                acc.totalMiles += Number(r.miles || 0);
                acc.totalGross += Number(r.grossTarget || 0); // display currency (rows may differ in input currency)
                return acc;
            },
            { totalTrips: 0, totalMiles: 0, totalGross: 0 }
        );
        summary.totalExpenses = totalExpenses;
        summary.profit = summary.totalGross - totalExpenses;
        summary.currency = displayCurrency.toLowerCase(); // already converted — frontend must not re-convert

        res.json({ status: true, from: start, to: end, currency: displayCurrency.toLowerCase(), summary, orders: rows, expenses: expenseRows, expenseByType });
    } catch (error) {
        res.status(500).json({ status: false, message: 'Server error computing truck gross detail' });
    }
};

exports.deleteTrip = async (req, res) => {
    try {
        const { tripId } = req.params;
        const tenantId = req.user.tenantId;

        const trip = await Trip.findOne({ _id: tripId, tenantId });
        if (!trip) {
            return res.status(404).json({ status: false, message: 'Trip not found' });
        }
        const order = await Order.findOne({ _id: trip.order, tenantId });
        if (!order) {
            return res.status(404).json({ status: false, message: 'Order not found' });
        }

        // Delete the selected trip first
        await Trip.deleteOne({ _id: tripId, tenantId });

        // Remove an adjacent relay location (boundary) so segments merge naturally
        let locs = order?.shipping_details?.[0]?.locations || [];
        let removedIndex = null;
        // Prefer removing the relay at this trip's start boundary (works for all except first segment)
        if (trip.start_stop_index > 0 && isRelayLoc(locs[trip.start_stop_index])) {
            removedIndex = trip.start_stop_index;
        } else if (trip.end_stop_index + 1 < locs.length && isRelayLoc(locs[trip.end_stop_index + 1])) {
            removedIndex = trip.end_stop_index + 1;
        }
        if (removedIndex !== null) {
            locs.splice(removedIndex, 1);
            order.shipping_details[0].locations = locs;
            await order.save();
        }

        // Rebuild segments based on remaining relay points
        const segments = buildSegmentsFromOrder(order);

        // Capture existing trips (except the deleted one) for assignment carry-over. Soft-deleted
        // legs are excluded — carrying one forward would resurrect a driver/rate that was removed.
        const existing = await Trip.find({ order: order._id, tenantId, deletedAt: null }).lean();

        // Remove all remaining trips to re-number cleanly
        await Trip.deleteMany({ order: order._id, tenantId });

        // Helper: choose best matching old trip by overlap of indices
        const chooseAssignment = (seg) => {
            let best = null;
            let bestScore = -1;
            for (const t of existing) {
                // overlap score: count of common indices
                const start = Math.max(t.start_stop_index, seg.start_stop_index);
                const end = Math.min(t.end_stop_index, seg.end_stop_index);
                const score = end >= start ? (end - start + 1) : 0;
                if (score > bestScore) {
                    bestScore = score;
                    best = t;
                }
            }
            return best;
        };

        const createdTrips = [];
        for (let i = 0; i < segments.length; i++) {
            const seg = segments[i];
            const match = chooseAssignment(seg);
            const rate =  match?.rate_per_mile || 0;
            // Carry the WHOLE crew, not just the primary driver. Dropping `drivers[]` turned a team
            // leg into a solo one on the rebuild: the second driver vanished from their payslip and
            // the surviving driver silently moved from the team rate to the solo rate.
            const matchDrivers = Array.isArray(match?.drivers) ? match.drivers.filter(Boolean) : [];
            const primaryDriver = match?.driver || matchDrivers[0] || null;
            const driversArr = [...matchDrivers];
            if (primaryDriver && !driversArr.some((d) => String(d) === String(primaryDriver))) {
                driversArr.unshift(primaryDriver);
            }
            const newTrip = new Trip({
                tenantId,
                order: order._id,
                trip_no: i + 1,
                start_stop_index: seg.start_stop_index,
                end_stop_index: seg.end_stop_index,
                driver: primaryDriver,
                drivers: driversArr,
                truck: match?.truck || null,
                trailer: match?.trailer || null,
                carrier: match?.carrier || null,
                start_location: seg.start_location,
                end_location: seg.end_location,
                miles: seg.miles || 0,
                totalDistance: seg.totalDistance || 0,
                distance_unit: seg.distance_unit || 'mi',
                rate_per_mile: rate,
                // Carry the matched trip's pay currency with its rate — they are one snapshot.
                rate_currency: match?.rate_currency || 'USD',
                // The admin-typed per-leg settlement is money, not a display value: losing it here
                // re-split the pot across the rebuilt legs and moved what the owner is paid.
                settle_amount: normalizeSegmentSettle(match?.settle_amount),
                // The carrier side of the same rule: an admin-typed leg cost is money. Dropping it
                // re-split the order's carrier amount across the rebuilt legs and moved what the
                // carrier is owed. The payment state travels with it — a leg that was already paid
                // must not come back as pending.
                carrier_amount: normalizeSegmentSettle(match?.carrier_amount),
                carrier_revenue_items: Array.isArray(match?.carrier_revenue_items) ? match.carrier_revenue_items : [],
                carrier_payment_status: match?.carrier_payment_status || 'pending',
                carrier_payment_date: match?.carrier_payment_date || null,
                carrier_payment_method: match?.carrier_payment_method || null,
                carrier_payment_notes: match?.carrier_payment_notes || null,
                notes: match?.notes,
                instructions: match?.instructions,
                created_by: req.user._id
            });
            await newTrip.save();
            createdTrips.push(newTrip);
        }

        // Rebuilding the legs changes who runs which miles, so the order's owner columns and the
        // owner ledger have to be re-derived from the new legs — otherwise a mixed split keeps
        // settling to the trucks it had before the relay was removed.
        {
            const rebuiltTruckIds = [...new Set(createdTrips.map((t) => t.truck).filter(Boolean).map(String))];
            const truckMap = new Map();
            if (rebuiltTruckIds.length > 0) {
                const trucksInUse = await Truck.find({ _id: { $in: rebuiltTruckIds }, tenantId })
                    .select('ownerOperated ownerOperator')
                    .lean();
                trucksInUse.forEach((t) => truckMap.set(String(t._id), t));
            }
            // Removing a relay can change WHO runs the order, not just how far — the order is
            // re-read from the rebuilt legs through the one definition (utils/orderFromLegs.js).
            const { owner: ownerFields, costFields } = await resyncOrderFromLegs({
                tenantId, order, trips: createdTrips, truckMap, req,
            });

            // Freeze each leg's share back onto its trip (same reason as splitOrder).
            const carrierTripCost = costFields.carrier?.tripCost;
            for (const t of createdTrips) {
                let touched = false;
                if (ownerFields.tripSettle?.has(String(t._id))) {
                    t.settle_amount = ownerFields.tripSettle.get(String(t._id));
                    touched = true;
                }
                if (carrierTripCost?.has(String(t._id))) {
                    t.carrier_amount = carrierTripCost.get(String(t._id));
                    touched = true;
                }
                if (touched) await t.save();
            }
        }

        logActivity(req, {
            action: 'DELETE',
            module: 'order',
            description: `Deleted trip and rebuilt ${createdTrips.length} trip(s)`,
            resourceId: req.params?.tripId || req.body?.tripId,
        });
        res.json({ status: true, message: 'Trip deleted, locations & trips updated', trips: createdTrips, removed_location_index: removedIndex });
    } catch (error) {
        console.error('Delete Trip Error:', error);
        res.status(500).json({ status: false, message: 'Server error deleting trip' });
    }
};

exports.ignoreEmptyMove = async (req, res) => {
    try {
        const { truckId, driverId, after_trip_id, before_trip_id } = req.body;
        const tenantId = req.user.tenantId;

        if (!after_trip_id || !before_trip_id) {
            return res.status(400).json({ status: false, message: 'Missing trip references' });
        }

        const existing = await IgnoredEmptyMove.findOne({ tenantId, after_trip: after_trip_id, before_trip: before_trip_id, ...(truckId ? { truck: truckId } : { driver: driverId }) });
        if (existing) {
            return res.json({ status: true, message: 'Already ignored' });
        }

        await IgnoredEmptyMove.create({
            tenantId,
            truck: truckId || null,
            driver: driverId || null,
            after_trip: after_trip_id,
            before_trip: before_trip_id
        });

        res.json({ status: true, message: 'Empty move ignored' });
    } catch (error) {
        res.status(500).json({ status: false, message: 'Server error ignoring empty move' });
    }
};

exports.saveEmptyMoveNote = async (req, res) => {
    try {
        const { truckId, driverId, after_trip_id, before_trip_id, note } = req.body;
        const tenantId = req.user.tenantId;

        if (!after_trip_id || !before_trip_id) {
            return res.status(400).json({ status: false, message: 'Missing trip references' });
        }

        const filter = {
            tenantId,
            after_trip: after_trip_id,
            before_trip: before_trip_id,
            ...(truckId ? { truck: truckId } : { driver: driverId })
        };

        if (!note || note.trim() === '') {
            await EmptyMoveNote.deleteOne(filter);
        } else {
            await EmptyMoveNote.findOneAndUpdate(
                filter,
                { note, updatedAt: Date.now() },
                { upsert: true, new: true }
            );
        }

        res.json({ status: true, message: 'Note saved successfully' });
    } catch (error) {
        res.status(500).json({ status: false, message: 'Server error saving empty move note' });
    }
};

/* ── Rate confirmation, per LEG ─────────────────────────────────────────────────────────────────
   GET /order/:orderId/leg/:tripId/rate-confirmation/pdf

   A rate confirmation is a contract with ONE carrier for the work THEY do. An order can now be
   split across two carriers and our own truck, so sending the whole order's paperwork would tell a
   carrier about stops they never see and quote a rate that is not theirs.

   Rendered on the SERVER from the order and trip ids, for the same reason the customer invoice is
   (see orderController.customerInvoicePdf): the permission check, the tenant scope and the numbers
   are then decided here rather than posted in as markup. `/order/generate-pdf` still serves the
   order-level rate confirmation the app already had; it is not a boundary and must not be treated
   as one.                                                                                        */

// Who may send a carrier their rate confirmation. Deliberately the people who book carriers — a
// dispatcher working the outsourcing module does this as ordinary work — plus accounting, who chase
// what was agreed. A plain driver, or a user with no relevant permission, may not.
const canDownloadRateCon = (user) => {
  if (!user) return false;
  if (user.is_admin === 1 || Number(user.role) === 3 || user.isTenantAdmin) return true;
  const perms = Array.isArray(user.permissions) ? user.permissions : [];
  return perms.includes('outsourcing') || perms.includes('carriers')
    || perms.includes('subadmin') || perms.includes('accounting');
};

exports.legRateConfirmationPdf = async (req, res) => {
    try {
        const tenantId = req.tenantId || req.user?.tenantId;
        if (!tenantId) {
            return res.status(400).json({ status: false, message: 'Tenant context is required.' });
        }
        if (!canDownloadRateCon(req.user)) {
            return res.status(403).json({ status: false, message: 'You do not have permission to download rate confirmations.' });
        }

        // Scoped exactly like order_detail: tenant, not deleted, inside the caller's modules.
        const criteria = {
            _id: req.params.orderId,
            tenantId,
            $or: [{ deletedAt: null }, { deletedAt: '' }, { deletedAt: { $exists: false } }],
        };
        if (Array.isArray(req.allowedOrderTypes) && req.allowedOrderTypes.length > 0) {
            criteria.order_type = { $in: req.allowedOrderTypes };
        }
        const order = await Order.findOne(criteria).populate('customer').lean();
        if (!order) {
            return res.status(404).json({ status: false, message: 'Order not found.' });
        }

        // The leg must belong to THIS order — never trust the trip id alone to carry the scope.
        const trip = await Trip.findOne({ _id: req.params.tripId, order: order._id, tenantId, deletedAt: null })
            .populate('carrier')
            .populate('trailer', 'unitNumber type')
            .lean();
        if (!trip) {
            return res.status(404).json({ status: false, message: 'That leg is not on this order.' });
        }
        if (!trip.carrier) {
            return res.status(400).json({
                status: false,
                code: 'leg_has_no_carrier',
                message: 'This leg runs on your own truck. A rate confirmation is a contract with an outside carrier.',
            });
        }

        // Real miles for the leg — never trip.miles, which is legacy and often kilometres.
        const allLegs = await Trip.find({ tenantId, order: order._id, deletedAt: null })
            .select('_id carrier miles totalDistance total_km').lean();
        const rawTotal = allLegs.reduce(
            (a, t) => a + Math.max(Number(t?.totalDistance || t?.miles || t?.total_km || 0), 0), 0);
        const legMiles = deriveTripMiles(trip, Number(order.totalDistance || 0), rawTotal);

        // Does this carrier run the whole order, or only part of it? A carrier reading a document
        // that lists two of five stops needs to be told why, or it looks like a mistake.
        const isPartial = allLegs.some((t) => String(t._id) !== String(trip._id)
            && String(t.carrier || '') !== String(trip.carrier?._id || trip.carrier || ''));

        const companyId = order.company || req.user?.company?._id || req.user?.company || null;
        const company = companyId
            ? await Company.findOne({ _id: companyId, tenantId }).lean()
            : await Company.findOne({ tenantId }).lean();

        const { resolveCompanyLogoBase64 } = require('../utils/pdfBranding');
        const { buildRateConHtml, buildRateConNo } = require('../utils/rateConHtml');
        const logoBase64 = await resolveCompanyLogoBase64(company);

        const issuedAt = new Date();
        const rateConNo = buildRateConNo({ order, trip, company, tenantId });
        const html = buildRateConHtml({
            order, trip, company, rateConNo, issuedAt, logoBase64, legMiles, isPartial, tenantId,
        });

        const { launchBrowser, hardenPage } = require('../utils/puppeteer');
        let browser = null;
        try {
            browser = await launchBrowser();
            const page = await browser.newPage();
            await hardenPage(page);
            await page.setViewport({ width: 794, height: 1123, deviceScaleFactor: 1 });
            await page.setContent(html, { waitUntil: 'load', timeout: 20000 }).catch(() => {});
            const pdfBuffer = await page.pdf({
                format: 'A4',
                printBackground: true,
                margin: { top: 0, bottom: 0, left: 0, right: 0 },
            });
            await browser.close();
            browser = null;

            logActivity(req, {
                action: 'DOWNLOAD',
                module: 'order',
                description: `Downloaded rate confirmation ${rateConNo} (leg ${trip.trip_no}) for ${trip.carrier?.name || 'carrier'}`,
                resourceId: order._id,
                resourceName: `#${order.serial_no ?? ''}`,
            });

            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', `attachment; filename="rate-confirmation-${rateConNo}.pdf"`);
            // `res.end`, not `res.send`. Puppeteer 24 returns a Uint8Array rather than a Buffer, and
            // `res.send` JSON-SERIALISES a Uint8Array — the download arrived as a 9.7 MB
            // `{"0":37,"1":80,...}` blob instead of a PDF. Every other PDF route in this codebase
            // already uses `res.end`; this one was the exception.
            return res.end(Buffer.from(pdfBuffer));
        } finally {
            if (browser) await browser.close().catch(() => {});
        }
    } catch (error) {
        console.error('Rate confirmation PDF error:', error);
        if (error?.code === 'chrome_missing') {
            return res.status(500).json({ status: false, code: 'chrome_missing', message: error.message });
        }
        return res.status(500).json({ status: false, message: 'Failed to generate the rate confirmation.' });
    }
};

exports._canDownloadRateCon = canDownloadRateCon;
