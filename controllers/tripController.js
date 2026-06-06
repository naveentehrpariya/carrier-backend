const Trip = require('../db/Trip');
const Order = require('../db/Order');
const User = require('../db/Users');
const DriverProfile = require('../db/DriverProfile');
const Truck = require('../db/Truck');
const TruckExpense = require('../db/TruckExpense');
const IgnoredEmptyMove = require('../db/IgnoredEmptyMove');
const EmptyMoveNote = require('../db/EmptyMoveNote');
const mongoose = require('mongoose');
const axios = require('axios');
const { logActivity } = require('../utils/activityLogger');

const emptyDistanceCache = new Map();

function getGoogleApiKey() {
    return (
        process.env.GOOGLE_MAP_API_KEY ||
        process.env.GOOGLE_MAPS_API_KEY ||
        process.env.GOOGLE_API_KEY ||
        process.env.GOOGLE_KEY ||
        ''
    );
}

async function getMilesBetweenLocations(from, to) {
    const a = String(from || '').trim();
    const b = String(to || '').trim();
    if (!a || !b) return null;
    const key = `${a}||${b}`;
    if (emptyDistanceCache.has(key)) return emptyDistanceCache.get(key);
    const apiKey = getGoogleApiKey();
    if (!apiKey) return null;
    const url =
        `https://maps.googleapis.com/maps/api/directions/json?origin=${encodeURIComponent(a)}` +
        `&destination=${encodeURIComponent(b)}&key=${encodeURIComponent(apiKey)}`;
    const resp = await axios.get(url);
    const route = resp.data?.routes?.[0];
    const legs = route?.legs;
    const meters = Array.isArray(legs) ? legs.reduce((acc, l) => acc + (Number(l?.distance?.value) || 0), 0) : 0;
    const miles = meters ? meters / 1609.344 : 0;
    const rounded = Number.isFinite(miles) ? Number(miles.toFixed(2)) : null;
    emptyDistanceCache.set(key, rounded);
    return rounded;
}

async function enrichEmptyMiles(logs, maxCalls = 25) {
    let calls = 0;
    for (const item of logs) {
        if (item.type !== 'empty') continue;
        if (calls >= maxCalls) break;
        if (typeof item.miles === 'number') continue;
        try {
            const miles = await getMilesBetweenLocations(item.from_location, item.to_location);
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

exports.splitOrder = async (req, res) => {
    try {
        const { orderId, segments } = req.body;
        const tenantId = req.user.tenantId;

        const order = await Order.findOne({ _id: orderId, tenantId });
        if (!order) {
            return res.status(404).json({ status: false, message: 'Order not found' });
        }

        // Remove existing trips for this order before re-splitting
        await Trip.deleteMany({ order: orderId, tenantId });
        
        const createdTrips = [];
        for (let i = 0; i < segments.length; i++) {
            const seg = segments[i];
            
            // Get driver's current rate if not provided
            let rate = seg.rate_per_mile;
            if (!rate && seg.driver) {
                const profile = await DriverProfile.findOne({ user: seg.driver, tenantId });
                rate = profile?.ratePerMile || 0;
            }

            // Ensure drivers array always contains the primary driver (fix for trip lookup)
            const primaryDriver = seg.driver || (seg.drivers && seg.drivers.length > 0 ? seg.drivers[0] : null);
            const driversArr = Array.isArray(seg.drivers) ? [...seg.drivers] : [];
            if (primaryDriver && !driversArr.some((d) => String(d) === String(primaryDriver))) {
                driversArr.unshift(primaryDriver);
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
                notes: seg.notes,
                instructions: seg.instructions,
                created_by: req.user._id
            });
            
            await trip.save();
            createdTrips.push(trip);
        }

        logActivity(req, {
            action: 'UPDATE',
            module: 'order',
            description: `Split order into ${createdTrips.length} trip(s) (Order ID: ${orderId})`,
            resourceId: orderId,
            resourceName: `Order #${order.serial_no}`,
            details: { tripCount: createdTrips.length },
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
            .sort({ trip_no: 1 });

        res.json({ status: true, trips });
    } catch (error) {
        res.status(500).json({ status: false, message: 'Server error fetching trips' });
    }
};

exports.updateTrip = async (req, res) => {
    try {
        const { tripId } = req.params;
        const tenantId = req.user.tenantId;
        const updateData = req.body;

        const trip = await Trip.findOneAndUpdate(
            { _id: tripId, tenantId },
            { ...updateData, updatedAt: Date.now() },
            { new: true }
        );

        if (!trip) {
            return res.status(404).json({ status: false, message: 'Trip not found' });
        }

        logActivity(req, {
            action: 'UPDATE',
            module: 'order',
            description: `Updated trip #${trip.trip_no} (Trip ID: ${tripId})`,
            resourceId: tripId,
            resourceName: `Trip #${trip.trip_no}`,
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

function buildTripLogItem(trip) {
    const order = trip.order;
    const startMeta = extractLocMeta(order, trip.start_stop_index);
    const endMeta = extractLocMeta(order, trip.end_stop_index);
    const miles = Number(trip.miles || 0);
    const orderTotalDistance = Number(order?.totalDistance || 0);
    const orderTotalAmount = Number(order?.total_amount || 0);
    const gross = orderTotalDistance > 0 ? (orderTotalAmount * miles) / orderTotalDistance : 0;
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

function withEmptyMoves(trips) {
    const items = [];
    let prev = null;
    for (const t of trips) {
        const cur = buildTripLogItem(t);
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
        let logs = wantEmptyMiles ? withEmptyMoves(scoped) : scoped.map(buildTripLogItem);

        if (wantEmptyMiles) {
            await enrichEmptyMiles(logs);
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
        let logs = wantEmptyMiles ? withEmptyMoves(scoped) : scoped.map(buildTripLogItem);

        if (wantEmptyMiles) {
            await enrichEmptyMiles(logs);
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
        const driverObjId = new mongoose.Types.ObjectId(driverId);
        // Match trips where driver is in drivers[] OR in single driver field (covers both storage patterns)
        const match = {
            tenantId,
            deletedAt: null,
            $or: [{ drivers: driverObjId }, { driver: driverObjId }]
        };
        if (from || to) {
            match.createdAt = {};
            if (from) match.createdAt.$gte = new Date(from);
            if (to) match.createdAt.$lte = new Date(to);
        }
        const driverProfile = await DriverProfile.findOne({ tenantId, user: driverId }).lean();
        const soloRate = Number(driverProfile?.ratePerMileSolo ?? driverProfile?.ratePerMile ?? 0) || 0;
        const teamRate = Number(driverProfile?.ratePerMileTeam ?? driverProfile?.ratePerMile ?? 0) || 0;

        const pipeline = [
            { $match: match },
            { $addFields: {
                // Count drivers from the drivers[] array. If empty but driver field set, treat as 1 (solo).
                driverCount: {
                    $cond: [
                        { $gt: [{ $size: { $ifNull: ['$drivers', []] } }, 0] },
                        { $size: '$drivers' },
                        1
                    ]
                }
            }},
            { $addFields: {
                driverCountEffective: { $max: ['$driverCount', 1] }
            }},
            { $addFields: {
                myMiles: { $divide: [{ $ifNull: ['$miles', 0] }, '$driverCountEffective'] },
                myKm: { $divide: [{ $ifNull: ['$total_km', 0] }, '$driverCountEffective'] },
                rateType: { $cond: [{ $gt: ['$driverCountEffective', 1] }, 'team', 'solo'] },
                rateUsed: { $cond: [{ $gt: ['$driverCountEffective', 1] }, teamRate, soloRate] }
            }},
            { $addFields: {
                myPay: { $multiply: ['$myMiles', '$rateUsed'] }
            }}
        ];

        const summary = await Trip.aggregate([
            ...pipeline,
            { $group: {
                _id: null,
                totalTrips: { $sum: 1 },
                totalMiles: { $sum: '$myMiles' },
                totalKm: { $sum: '$myKm' },
                totalPay: { $sum: '$myPay' }
            } }
        ]);

        const byOrder = await Trip.aggregate([
            ...pipeline,
            { $group: {
                _id: '$order',
                miles: { $sum: '$myMiles' },
                km: { $sum: '$myKm' },
                trips: { $sum: 1 },
                pay: { $sum: '$myPay' },
                rateUsed: { $max: '$rateUsed' },
                rateType: { $last: '$rateType' }
            } },
            {
                $lookup: {
                    from: 'orders',
                    localField: '_id',
                    foreignField: '_id',
                    as: 'orderDoc'
                }
            },
            { $unwind: { path: '$orderDoc', preserveNullAndEmptyArrays: true } },
            { $addFields: { orderSerial: '$orderDoc.serial_no' } },
            { $project: { orderDoc: 0 } },
            { $sort: { trips: -1 } }
        ]);

        const computedPay = summary[0] ? summary[0].totalPay : 0;
        const baseSummary = summary[0] || { totalTrips: 0, totalMiles: 0, totalKm: 0 };
        res.json({
            status: true,
            summary: { ...baseSummary, totalPay: computedPay, soloRate, teamRate },
            byOrder
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
        const logs = withEmptyMoves(scoped);
        await enrichEmptyMiles(logs);
        
        const emptyTrips = logs.filter(l => l.type === 'empty' && !ignoredSet.has(`${l.after_trip_id}_${l.before_trip_id}`)).map((e, idx) => ({
            _id: `empty_${idx}`,
            type: 'empty',
            miles: Number(e.miles || 0),
            km: Number(e.miles || 0) * 1.60934,
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

        const summary = await Trip.aggregate([
            { $match: match },
            { $group: {
                _id: null,
                totalTrips: { $sum: 1 },
                totalMiles: { $sum: { $ifNull: ['$miles', 0] } },
                totalKm: { $sum: { $ifNull: ['$total_km', 0] } }
            } }
        ]);
        
        const byOrder = await Trip.aggregate([
            { $match: match },
            { $group: {
                _id: '$order',
                miles: { $sum: { $ifNull: ['$miles', 0] } },
                km: { $sum: { $ifNull: ['$total_km', 0] } },
                trips: { $sum: 1 }
            } },
            {
                $lookup: {
                    from: 'orders',
                    localField: '_id',
                    foreignField: '_id',
                    as: 'orderDoc'
                }
            },
            { $unwind: { path: '$orderDoc', preserveNullAndEmptyArrays: true } },
            { $addFields: { orderSerial: '$orderDoc.serial_no', type: 'trip' } },
            { $project: { orderDoc: 0 } },
            { $sort: { trips: -1 } }
        ]);
        
        const finalSummary = summary[0] || { totalTrips: 0, totalMiles: 0, totalKm: 0 };
        finalSummary.totalMiles += emptyTripsTotalMiles;
        finalSummary.totalKm += emptyTripsTotalKm;
        
        // Merge normal order trips and empty trips
        const combinedByOrder = [...byOrder, ...emptyTrips];

        res.json({ status: true, summary: finalSummary, byOrder: combinedByOrder });
    } catch (error) {
        res.status(500).json({ status: false, message: 'Server error summarizing truck trips' });
    }
};

exports.getTrucksGrossEarnings = async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const companyIdRaw = req.user?.company?._id || req.user?.company;
        const companyId =
            companyIdRaw && mongoose.Types.ObjectId.isValid(String(companyIdRaw))
                ? new mongoose.Types.ObjectId(String(companyIdRaw))
                : null;
        const permissions = req.user?.permissions || [];
        if (!(req.user?.is_admin === 1 || permissions.includes('orders') || permissions.includes('accounting'))) {
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

        const pipeline = [
            { $match: match },
            {
                $lookup: {
                    from: 'orders',
                    localField: 'order',
                    foreignField: '_id',
                    as: 'orderDoc'
                }
            },
            { $unwind: '$orderDoc' },
            ...(companyId ? [{ $match: { 'orderDoc.company': companyId } }] : []),
            {
                $addFields: {
                    orderDistance: { $ifNull: ['$orderDoc.totalDistance', 0] },
                    orderAmount: { $ifNull: ['$orderDoc.total_amount', 0] },
                    tripMiles: { $ifNull: ['$miles', 0] }
                }
            },
            {
                $addFields: {
                    gross: {
                        $cond: [
                            { $gt: ['$orderDistance', 0] },
                            { $multiply: ['$orderAmount', { $divide: ['$tripMiles', '$orderDistance'] }] },
                            0
                        ]
                    }
                }
            },
            { $sort: { updatedAt: -1, createdAt: -1 } },
            {
                $group: {
                    _id: '$truck',
                    totalTrips: { $sum: 1 },
                    totalMiles: { $sum: '$tripMiles' },
                    totalGross: { $sum: '$gross' },
                    lastTripAt: { $first: '$updatedAt' },
                    lastLocation: { $first: '$end_location' },
                    lastDriver: { $first: '$driver' }
                }
            }
        ];

        const agg = await Trip.aggregate(pipeline);
        const byTruck = new Map(agg.map((r) => [String(r._id), r]));

        const truckFilter = { tenantId, deletedAt: null };
        if (companyId) truckFilter.company = companyId;
        const trucks = await Truck.find(truckFilter).select('_id plateNumber unitNumber').lean();

        const driverIds = agg.map((r) => r.lastDriver).filter(Boolean);
        const drivers = driverIds.length
            ? await User.find({ _id: { $in: driverIds } }).select('_id name corporateID').lean()
            : [];
        const driverMap = new Map(drivers.map((d) => [String(d._id), d]));

        // Aggregate expenses per truck for this period
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
                    $group: {
                        _id: '$truck',
                        totalExpenses: { $sum: '$amount' }
                    }
                }
            ])
            : [];
        const expenseMap = new Map(expenseAgg.map((e) => [String(e._id), e.totalExpenses]));

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
                lastTripAt: row?.lastTripAt || null,
                lastLocation: row?.lastLocation || '',
                lastDriver: lastDriver ? { _id: lastDriver._id, name: lastDriver.name, corporateID: lastDriver.corporateID } : null
            };
        });

        result.sort((a, b) => (b.totalGross || 0) - (a.totalGross || 0));
        res.json({ status: true, from: start, to: end, trucks: result });
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
        if (!(req.user?.is_admin === 1 || permissions.includes('orders') || permissions.includes('accounting'))) {
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

        const pipeline = [
            { $match: match },
            {
                $lookup: {
                    from: 'orders',
                    localField: 'order',
                    foreignField: '_id',
                    as: 'orderDoc'
                }
            },
            { $unwind: '$orderDoc' },
            ...(companyId ? [{ $match: { 'orderDoc.company': companyId } }] : []),
            {
                $addFields: {
                    orderDistance: { $ifNull: ['$orderDoc.totalDistance', 0] },
                    orderAmount: { $ifNull: ['$orderDoc.total_amount', 0] },
                    tripMiles: { $ifNull: ['$miles', 0] }
                }
            },
            {
                $addFields: {
                    gross: {
                        $cond: [
                            { $gt: ['$orderDistance', 0] },
                            { $multiply: ['$orderAmount', { $divide: ['$tripMiles', '$orderDistance'] }] },
                            0
                        ]
                    }
                }
            },
            {
                $group: {
                    _id: '$order',
                    orderSerial: { $first: '$orderDoc.serial_no' },
                    orderTotalAmount: { $first: '$orderDoc.total_amount' },
                    orderTotalDistance: { $first: '$orderDoc.totalDistance' },
                    orderCurrency: { $first: '$orderDoc.revenue_currency' },
                    trips: { $sum: 1 },
                    miles: { $sum: '$tripMiles' },
                    gross: { $sum: '$gross' },
                    lastTripAt: { $max: '$updatedAt' }
                }
            },
            { $sort: { lastTripAt: -1 } }
        ];

        const rows = await Trip.aggregate(pipeline);

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
        }).sort({ isFixed: -1, date: -1 }).lean();

        const expenseByType = {};
        let totalExpenses = 0;
        for (const e of expenseRows) {
            expenseByType[e.type] = (expenseByType[e.type] || 0) + Number(e.amount || 0);
            totalExpenses += Number(e.amount || 0);
        }

        const summary = rows.reduce(
            (acc, r) => {
                acc.totalTrips += Number(r.trips || 0);
                acc.totalMiles += Number(r.miles || 0);
                acc.totalGross += Number(r.gross || 0);
                return acc;
            },
            { totalTrips: 0, totalMiles: 0, totalGross: 0 }
        );
        summary.totalExpenses = totalExpenses;
        summary.profit = summary.totalGross - totalExpenses;

        res.json({ status: true, from: start, to: end, summary, orders: rows, expenses: expenseRows, expenseByType });
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

        // Capture existing trips (except the deleted one) for assignment carry-over
        const existing = await Trip.find({ order: order._id, tenantId }).lean();

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
            const newTrip = new Trip({
                tenantId,
                order: order._id,
                trip_no: i + 1,
                start_stop_index: seg.start_stop_index,
                end_stop_index: seg.end_stop_index,
                driver: match?.driver || null,
                truck: match?.truck || null,
                trailer: match?.trailer || null,
                carrier: match?.carrier || null,
                start_location: seg.start_location,
                end_location: seg.end_location,
                miles: seg.miles || 0,
                totalDistance: seg.totalDistance || 0,
                distance_unit: seg.distance_unit || 'mi',
                rate_per_mile: rate,
                notes: match?.notes,
                instructions: match?.instructions,
                created_by: req.user._id
            });
            await newTrip.save();
            createdTrips.push(newTrip);
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
