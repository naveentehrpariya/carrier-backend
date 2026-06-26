/**
 * Backfill: sync regular orders' truck/trailer/driver(s) from their first trip.
 *
 * Context: trip planning (POST /order/split) used to write assets onto Trip docs
 * only, never back onto the Order. So orders assigned via trip planning show blank
 * truck/trailer/driver on the edit form. This copies the first trip's assets onto
 * the order where the order is missing them.
 *
 * Safe to re-run. Only fills order fields that are empty (won't clobber existing
 * order-level assignments).
 *
 * Usage:
 *   node backend/scripts/backfill-order-assets-from-trips.js
 *   node backend/scripts/backfill-order-assets-from-trips.js --apply
 */

require('dotenv').config();
const mongoose = require('mongoose');

const DB_URI = process.env.DB_URL_OFFICE || process.env.MONGODB_URI;
if (!DB_URI) {
  console.error('No DB_URL_OFFICE / MONGODB_URI in environment.');
  process.exit(1);
}

const DRY_RUN = !process.argv.includes('--apply');
if (DRY_RUN) {
  console.log('[DRY RUN] Pass --apply to actually write changes.\n');
}

async function run() {
  await mongoose.connect(DB_URI);
  console.log('Connected to MongoDB.\n');

  const orders = mongoose.connection.collection('orders');
  const trips = mongoose.connection.collection('trips');

  const cursor = orders.find({
    order_type: 'regular',
    $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
  });

  let scanned = 0;
  let updated = 0;

  while (await cursor.hasNext()) {
    const order = await cursor.next();
    scanned++;

    const needsTruck = !order.truck;
    const needsTrailer = !order.trailer;
    const needsDriver = !order.driver && (!Array.isArray(order.drivers) || order.drivers.length === 0);
    if (!needsTruck && !needsTrailer && !needsDriver) continue;

    // First trip (lowest trip_no) for this order
    const firstTrip = await trips
      .find({ order: order._id, deletedAt: null })
      .sort({ trip_no: 1, createdAt: 1 })
      .limit(1)
      .toArray();
    const trip = firstTrip[0];
    if (!trip) continue;

    const set = {};
    if (needsTruck && trip.truck) set.truck = trip.truck;
    if (needsTrailer && trip.trailer) set.trailer = trip.trailer;
    if (needsDriver) {
      const tripDrivers = Array.isArray(trip.drivers) ? trip.drivers.filter(Boolean) : [];
      const primary = trip.driver || tripDrivers[0] || null;
      if (primary) {
        set.driver = primary;
        set.drivers = tripDrivers.length > 0 ? tripDrivers : [primary];
      }
    }

    if (Object.keys(set).length === 0) continue;

    console.log(`Order #${order.serial_no} (${order._id}) ←`, set);
    updated++;
    if (!DRY_RUN) {
      await orders.updateOne({ _id: order._id }, { $set: set });
    }
  }

  console.log(`\nScanned ${scanned} regular orders. ${DRY_RUN ? 'Would update' : 'Updated'} ${updated}.`);
  await mongoose.disconnect();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
