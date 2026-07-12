/**
 * Backfill the driver pay-currency snapshot fields.
 *
 * USAGE:
 *   node scripts/migrate-driver-rate-currency.js            # DRY RUN (no writes)
 *   node scripts/migrate-driver-rate-currency.js --apply    # backup, then migrate
 *
 * Before this feature, driver rates (ratePerMileSolo/Team, cityHoursRate) and driver deduction
 * amounts were bare numbers that every code path ASSUMED were USD. Now each carries an explicit
 * currency. Existing rows predate the field, so the only correct value for them is 'USD' — that is
 * literally what the old code computed with.
 *
 * Backfills:
 *   driver_profiles.rateCurrency   -> 'USD'   (the driver's locked pay currency)
 *   driver_deductions.currency     -> 'USD'   (currency of amount/rate on that row)
 *   driver_salaries.rateCurrency   -> 'USD'   (currency of the soloRate/teamRate/cityRate snapshot)
 *
 * Idempotent — rows that already have a value are left alone.
 */
require('dotenv').config();
const connectDB = require('../db/config');
const DriverProfile = require('../db/DriverProfile');
const DriverDeduction = require('../db/DriverDeduction');
const DriverSalary = require('../db/DriverSalary');
const { backupCollections } = require('./_backupHelper');

// A row needs backfilling when the field is absent or empty. Anything already set (including a
// deliberate 'CAD') is left untouched.
const MISSING = { $in: [null, ''] };

const TARGETS = [
  { label: 'driver_profiles.rateCurrency', Model: DriverProfile, field: 'rateCurrency' },
  { label: 'driver_deductions.currency', Model: DriverDeduction, field: 'currency' },
  { label: 'driver_salaries.rateCurrency', Model: DriverSalary, field: 'rateCurrency' },
];

async function migrate() {
  try {
    const apply = process.argv.includes('--apply');
    await connectDB();
    console.log('Connected to MongoDB');
    console.log(apply
      ? '\n🔧 APPLY MODE — will back up then write changes\n'
      : '\n🔍 DRY RUN — no changes will be written (use --apply to migrate)\n');

    if (apply) {
      console.log('Creating backup before migration...');
      await backupCollections('driver-rate-currency-backup', [
        { collection: 'driver_profiles', projection: { _id: 1, user: 1, tenantId: 1, rateCurrency: 1, ratePerMileSolo: 1, ratePerMileTeam: 1, cityHoursRate: 1 } },
        { collection: 'driver_deductions', projection: { _id: 1, driver: 1, tenantId: 1, currency: 1, amount: 1, rate: 1 } },
        { collection: 'driver_salaries', projection: { _id: 1, driver: 1, tenantId: 1, currency: 1, rateCurrency: 1, soloRate: 1, teamRate: 1, cityRate: 1 } },
      ]);
    }

    let totalUpdated = 0;
    for (const { label, Model, field } of TARGETS) {
      const filter = { $or: [{ [field]: { $exists: false } }, { [field]: MISSING }] };
      const pending = await Model.countDocuments(filter);
      const total = await Model.estimatedDocumentCount();

      if (apply && pending > 0) {
        const res = await Model.updateMany(filter, { $set: { [field]: 'USD' } });
        console.log(`  ${label.padEnd(30)} set 'USD' on ${res.modifiedCount}/${total}`);
        totalUpdated += res.modifiedCount;
      } else {
        console.log(`  ${label.padEnd(30)} ${pending}/${total} need backfill${pending === 0 ? ' (nothing to do)' : ''}`);
        totalUpdated += pending;
      }
    }

    console.log(apply
      ? `\n✅ Backfilled ${totalUpdated} rows to 'USD'.`
      : `\n🔍 Dry run complete — ${totalUpdated} rows would be set to 'USD'. Run with --apply to write changes.`);
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

migrate();
