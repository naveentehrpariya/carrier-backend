/**
 * Backfill `rate_currency` on trips from each trip's driver DriverProfile.rateCurrency.
 *
 * `Trip.rate_per_mile` / `total_driver_pay` are snapshots of the driver's locked pay rate, which
 * is NOT always USD. Screens used to label that number "USD" for everyone. This stamps each trip
 * with the currency its pay is actually in. No amount changes — only the label.
 *
 * Usage:
 *   node backend/scripts/migrate-trip-rate-currency.js          # dry run
 *   node backend/scripts/migrate-trip-rate-currency.js --apply  # write
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Trip = require('../db/Trip');
const DriverProfile = require('../db/DriverProfile');
const { getDriverRateCurrency } = require('../utils/distance');

const APPLY = process.argv.includes('--apply');

(async () => {
  const uri = process.env.DB_URL_OFFICE || process.env.MONGODB_URI;
  if (!uri) {
    console.error('No DB_URL_OFFICE / MONGODB_URI in env');
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log(`Connected. Mode: ${APPLY ? 'APPLY' : 'DRY RUN'}`);

  const trips = await Trip.find({
    $or: [{ rate_currency: { $exists: false } }, { rate_currency: null }, { rate_currency: '' }],
  }).select('_id tenantId driver drivers').lean();

  console.log(`Trips missing rate_currency: ${trips.length}`);
  if (!trips.length) {
    await mongoose.disconnect();
    return console.log('Nothing to do.');
  }

  const driverIds = [...new Set(trips.flatMap((t) => [t.driver, ...(t.drivers || [])]).filter(Boolean).map(String))];
  const profiles = driverIds.length
    ? await DriverProfile.find({ user: { $in: driverIds } }).select('user tenantId rateCurrency').lean()
    : [];
  const currencyByDriver = new Map(profiles.map((p) => [`${p.tenantId}|${String(p.user)}`, getDriverRateCurrency(p)]));

  const counts = {};
  const ops = trips.map((t) => {
    const primary = t.driver || (t.drivers || [])[0];
    const currency = (primary && currencyByDriver.get(`${t.tenantId}|${String(primary)}`)) || 'USD';
    counts[currency] = (counts[currency] || 0) + 1;
    return { updateOne: { filter: { _id: t._id }, update: { $set: { rate_currency: currency } } } };
  });

  console.log('Planned:', counts);

  if (APPLY) {
    const res = await Trip.bulkWrite(ops, { ordered: false });
    console.log(`Updated: ${res.modifiedCount}`);
  } else {
    console.log('Dry run — re-run with --apply to write.');
  }

  await mongoose.disconnect();
  console.log('Done.');
})().catch(async (err) => {
  console.error(err);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
