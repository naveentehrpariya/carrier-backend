/**
 * One-off: move every USD driver to CAD, converting their stored rates.
 *
 * USAGE:
 *   node scripts/migrate-driver-rate-currency-usd-to-cad.js                 # DRY RUN
 *   node scripts/migrate-driver-rate-currency-usd-to-cad.js --apply         # backup, then write
 *   node scripts/migrate-driver-rate-currency-usd-to-cad.js --rate=1.37     # force the FX rate
 *   node scripts/migrate-driver-rate-currency-usd-to-cad.js --tenant=acme   # one tenant only
 *   node scripts/migrate-driver-rate-currency-usd-to-cad.js --decimals=4    # rounding (default 2)
 *   node scripts/migrate-driver-rate-currency-usd-to-cad.js --include-deleted
 *
 * WHY THIS IS SAFE FOR HISTORY
 * `DriverProfile.rateCurrency` is documented as locked after create because trips snapshot
 * `rate_per_mile` from the profile. That lock protects OLD money — and old money is already
 * pinned by its own snapshot columns:
 *   Trip.rate_currency        currency of that trip's rate_per_mile / total_driver_pay
 *   DriverDeduction.currency  currency of that deduction row
 *   DriverSalary.rateCurrency currency of that payslip's rate snapshot
 * Those rows keep saying USD, so already-generated payslips and owner settlements do not move.
 * Only NEW trips/deductions/payslips pick up the profile's currency — which is the point.
 * Nothing outside `driver_profiles` is touched by this script.
 *
 * The rates themselves are converted (0.60 USD/mi -> 0.82 CAD/mi), not relabelled, so a driver's
 * take-home stays the same in real terms.
 *
 * Idempotent: drivers already on CAD (or INR) are skipped.
 */
require('dotenv').config();
const connectDB = require('../db/config');
const DriverProfile = require('../db/DriverProfile');
const Users = require('../db/Users');
const { ensureMonthlyFxRates } = require('../controllers/ownerOperatorController');
const { getFxRatesMap } = require('../utils/fx');
const { backupCollections } = require('./_backupHelper');

const RATE_FIELDS = ['ratePerMile', 'ratePerMileSolo', 'ratePerMileTeam', 'cityHoursRate'];

function argValue(name) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=').trim() : null;
}

function round(value, decimals) {
  const f = 10 ** decimals;
  return Math.round((Number(value) || 0) * f) / f;
}

async function migrate() {
  const apply = process.argv.includes('--apply');
  const includeDeleted = process.argv.includes('--include-deleted');
  const tenantArg = argValue('tenant');
  const rateArg = Number(argValue('rate')) || null;
  const decimals = Number(argValue('decimals') || 2);

  if (rateArg !== null && !(rateArg > 0)) throw new Error('--rate must be a positive number');
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 6) throw new Error('--decimals must be 0-6');

  await connectDB();
  console.log('Connected to MongoDB');
  console.log(apply
    ? '\n🔧 APPLY MODE — will back up then write changes\n'
    : '\n🔍 DRY RUN — no changes written (use --apply to migrate)\n');

  // A driver is on USD when the field says so or predates the field entirely (legacy = USD).
  const filter = {
    $or: [{ rateCurrency: 'USD' }, { rateCurrency: { $exists: false } }, { rateCurrency: { $in: [null, ''] } }],
  };
  if (tenantArg) filter.tenantId = tenantArg;
  if (!includeDeleted) filter.deletedAt = null;

  const profiles = await DriverProfile.find(filter)
    .select('tenantId user rateCurrency ratePerMile ratePerMileSolo ratePerMileTeam cityHoursRate deletedAt')
    .lean();

  if (profiles.length === 0) {
    console.log('Nothing to do — no USD drivers found.');
    process.exit(0);
  }

  const users = await Users.find({ _id: { $in: profiles.map((p) => p.user).filter(Boolean) } })
    .select('name email')
    .lean();
  const userById = new Map(users.map((u) => [String(u._id), u]));

  // One FX rate per tenant, from the same monthly ConversionRate table the app pays from, so the
  // converted rate matches what every other screen would have shown this month.
  // A dry run stays strictly read-only: ensureMonthlyFxRates() would upsert a ConversionRate row.
  const now = new Date();
  const month = now.getMonth() + 1;
  const year = now.getFullYear();
  const rateByTenant = new Map();
  for (const tenantId of new Set(profiles.map((p) => p.tenantId))) {
    if (rateArg) {
      rateByTenant.set(tenantId, rateArg);
      continue;
    }
    const fx = apply
      ? await ensureMonthlyFxRates(tenantId, month, year, 'CAD', ['USD'])
      : await getFxRatesMap(tenantId, month, year, 'CAD');
    rateByTenant.set(tenantId, Number(fx?.get('USD') || 0));
  }

  const unresolved = [...rateByTenant.entries()].filter(([, r]) => !(r > 0)).map(([t]) => t);
  if (unresolved.length) {
    // Never fall back to 1:1 — that would silently cut every driver's pay by ~27%.
    console.error(`❌ No stored USD->CAD rate for ${month}/${year} on tenant(s): ${unresolved.join(', ')}`);
    console.error('   Re-run with --rate=<value>, or with --apply (which fetches + stores the month rate).');
    process.exit(1);
  }

  if (apply) {
    console.log('Creating backup before migration...');
    await backupCollections('driver-usd-to-cad-backup', [
      {
        collection: 'driver_profiles',
        projection: {
          _id: 1, tenantId: 1, user: 1, rateCurrency: 1,
          ratePerMile: 1, ratePerMileSolo: 1, ratePerMileTeam: 1, cityHoursRate: 1,
        },
      },
    ]);
  }

  let updated = 0;
  let lastTenant = null;
  for (const p of profiles) {
    const fxRate = rateByTenant.get(p.tenantId);
    if (p.tenantId !== lastTenant) {
      console.log(`\n[${p.tenantId}]  USD -> CAD @ ${fxRate}`);
      lastTenant = p.tenantId;
    }

    const u = userById.get(String(p.user));
    const set = { rateCurrency: 'CAD' };
    const parts = [];
    for (const field of RATE_FIELDS) {
      const before = Number(p[field] || 0);
      const after = round(before * fxRate, decimals);
      set[field] = after;
      if (before) parts.push(`${field} ${before} -> ${after}`);
    }

    console.log(`  ${(u?.name || u?.email || String(p.user)).padEnd(28)} ${parts.join(' | ') || '(all rates 0)'}`);

    if (apply) {
      await DriverProfile.updateOne({ _id: p._id }, { $set: set });
      updated += 1;
    }
  }

  console.log(apply
    ? `\n✅ Switched ${updated} driver(s) to CAD with converted rates.`
    : `\n🔍 Dry run complete — ${profiles.length} driver(s) would move to CAD. Run with --apply to write.`);
  process.exit(0);
}

migrate().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
