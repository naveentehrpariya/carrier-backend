/**
 * READ-ONLY. Run this AFTER migrate-order-party.js --apply to prove the migration did what it said.
 *
 * USAGE:
 *   node scripts/verify-order-party.js
 *   node scripts/verify-order-party.js --tenant=<tenantId>
 *   node scripts/verify-order-party.js --baseline=db_backups/order-party-backup-<stamp>
 *
 * Three checks, in order of how badly a failure would hurt:
 *
 *  1. MONEY UNCHANGED   — with --baseline, every money column captured in the pre-migration backup
 *                         is compared against the live row. The migration is only allowed to write
 *                         labels; a single moved cent here is a failure, not a rounding note.
 *  2. STAMP CORRECT     — order_parties / isMixedType re-derived from the legs must equal what is
 *                         stored. This is what makes the stamp trustworthy rather than decorative.
 *  3. STAMP COMPLETE    — every order that CAN be read carries a stamp. An unstamped readable order
 *                         means the migration missed it.
 *
 * Exit code is non-zero if any check fails, so it can gate a deploy.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
mongoose.set('autoIndex', false);   // read-only: never build an index as a side effect
const Order = require('../db/Order');
const Trip = require('../db/Trip');
const Truck = require('../db/Truck');
const { resolveOrderState } = require('../utils/orderParty');
require('../db/ActivityLog');

const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};

/* The columns that existed BEFORE this work. Deliberately does NOT include `cost_amount` /
 * `input_cost_amount`: those are new, so every pre-deploy backup has them absent, and the moment the
 * code starts writing them every order would read as "money moved with no audit entry" and fail all
 * 776. They are derived from these columns anyway — if none of these moved, neither did the cost. */
const MONEY_FIELDS = [
  'total_amount', 'carrier_amount', 'settle_amount',
  'input_total_amount', 'input_carrier_amount', 'input_settle_amount',
];

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const cents = (v) => Math.round(num(v) * 100);

async function run() {
  const tenant = arg('tenant');
  const baseline = arg('baseline');
  const verbose = process.argv.includes('--verbose');

  const uri = process.env.DB_URL_OFFICE || process.env.MONGODB_URI;
  if (!uri) throw new Error('DB_URL_OFFICE / MONGODB_URI is not set.');
  await mongoose.connect(uri, { maxPoolSize: 5, serverSelectionTimeoutMS: 30000, autoIndex: false });
  console.log('Connected to MongoDB — READ ONLY.\n');

  const filter = { $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }] };
  if (tenant) filter.tenantId = tenant;

  const orders = await Order.find(filter)
    .select(`_id tenantId serial_no order_type order_parties isMixedType isOwnerOperatedTruck carrier truck driver drivers ownerOperator ${MONEY_FIELDS.join(' ')}`)
    .lean();
  console.log(`Orders in scope: ${orders.length}${tenant ? ` (tenant ${tenant})` : ''}\n`);
  if (!orders.length) return;

  const trips = await Trip.find({ order: { $in: orders.map((o) => o._id) }, deletedAt: null })
    .select('_id order truck carrier').lean();
  const tripsByOrder = new Map();
  trips.forEach((t) => {
    const k = String(t.order);
    if (!tripsByOrder.has(k)) tripsByOrder.set(k, []);
    tripsByOrder.get(k).push(t);
  });
  const truckIds = [...new Set(trips.map((t) => t.truck).filter(Boolean).map(String))];
  const trucks = await Truck.find({ _id: { $in: truckIds } }).select('_id ownerOperated ownerOperator').lean();
  const truckMap = new Map(trucks.map((t) => [String(t._id), t]));

  let failures = 0;

  /* ── 1. money unchanged ─────────────────────────────────────────────── */
  console.log('1. MONEY UNCHANGED');
  console.log('------------------');
  if (!baseline) {
    console.log('   skipped — pass --baseline=<backup folder> to compare against the pre-migration snapshot.');
    console.log('   (list them with: node scripts/restore-backup.js --list)');
  } else {
    const dir = path.isAbsolute(baseline) ? baseline : path.join(__dirname, '..', '..', baseline);
    const file = path.join(dir, 'orders.json');
    if (!fs.existsSync(file)) {
      console.log(`   FAIL — no orders.json in ${dir}`);
      failures++;
    } else {
      const before = JSON.parse(fs.readFileSync(file, 'utf8'));
      const liveById = new Map(orders.map((o) => [String(o._id), o]));
      let compared = 0;
      const moved = [];
      for (const b of before) {
        const live = liveById.get(String(b._id));
        if (!live) continue;
        compared++;
        const fields = MONEY_FIELDS
          .filter((f) => Object.prototype.hasOwnProperty.call(b, f) || live[f] !== undefined)
          .filter((f) => cents(b[f]) !== cents(live[f]));
        if (!fields.length) continue;
        moved.push({
          _id: String(b._id), serial_no: b.serial_no, tenantId: b.tenantId, fields,
          diffs: fields.map((f) => `${f}: ${num(b[f])} -> ${num(live[f])}`),
        });
      }
      console.log(`   compared ${compared} order(s) against the backup`);

      /* WHO MOVED IT — the audit trail, not the column names.
       *
       * This compares against a MOMENT IN TIME on a LIVE database, so ten days of ordinary trading
       * shows up here and used to fail the check forever, which made the script useless as the
       * deploy gate it exists to be. Splitting by column does not work either: a dispatcher
       * re-quoting a load moves `carrier_amount` too.
       *
       * The honest distinction is the trail. Every human edit writes a hash-chained ActivityLog
       * entry naming the fields it changed; a migration writes none. So money that moved WITH an
       * entry is business, and money that moved with NO entry is the alarming case — something
       * rewrote money leaving no record, which is exactly what a bad migration looks like. */
      const stamp = path.basename(dir).replace(/^.*?-(\d{4}-\d{2}-\d{2}T)/, '$1').replace(/-(\d{2})-(\d{2})-(\d{3})Z$/, ':$1:$2.$3Z');
      const since = new Date(stamp);
      const sinceValid = !Number.isNaN(since.getTime());

      const explained = [];
      const unexplained = [];
      if (moved.length) {
        const ActivityLog = mongoose.model('ActivityLog');
        for (const m of moved) {
          const entry = sinceValid
            ? await ActivityLog.findOne({
              resourceId: m._id,
              createdAt: { $gte: since },
              changedFields: { $in: m.fields },
            }).sort({ createdAt: -1 }).select('createdAt userName userId changedFields').lean()
            : null;
          if (entry) explained.push({ ...m, entry });
          else unexplained.push(m);
        }
      }

      if (!moved.length) {
        console.log('   PASS — not one money column moved.');
      } else if (!unexplained.length) {
        console.log(`   PASS — ${explained.length} order(s) moved, every one of them by a person:`);
        explained.slice(0, 20).forEach((r) => {
          const who = r.entry.userName || r.entry.userId || 'unknown';
          console.log(`     #${r.serial_no} ${r.tenantId}: ${r.entry.createdAt.toISOString().slice(0, 16)} by ${who}`);
          console.log(`        ${r.diffs.join(' | ')}`);
        });
        console.log('   Nothing moved money without leaving a trail, which is what a migration fault');
        console.log('   would look like.');
      } else {
        failures++;
        console.log(`   FAIL — ${unexplained.length} order(s) moved money with NO audit entry behind it:`);
        unexplained.slice(0, 20).forEach((r) => console.log(`     #${r.serial_no} ${r.tenantId}: ${r.diffs.join(' | ')}`));
        if (explained.length) {
          console.log(`   (${explained.length} other order(s) moved, each with a person's audit entry — those are business.)`);
        }
        console.log('   Read the full history of one with:');
        console.log('     GET /api/tenant-admin/activity-logs/resource/order/<orderId>');
      }
    }
  }

  /* ── 2. stamp correct ───────────────────────────────────────────────── */
  console.log('\n2. STAMP CORRECT');
  console.log('----------------');
  let wrongStamp = 0;
  let typeDisagrees = 0;
  let unreadable = 0;
  let stampedOk = 0;
  const wrongRows = [];
  const typeRows = [];

  for (const o of orders) {
    const legs = tripsByOrder.get(String(o._id)) || [];
    const state = resolveOrderState({ order: o, trips: legs, truckMap });
    if (!state.resolved) { unreadable++; continue; }

    const stored = Array.isArray(o.order_parties) ? o.order_parties : [];
    const partiesMatch = stored.length === state.order_parties.length
      && stored.every((v, i) => v === state.order_parties[i]);
    const mixedMatch = Boolean(o.isMixedType) === state.isMixedType;

    if (!partiesMatch || !mixedMatch) {
      wrongStamp++;
      wrongRows.push({ o, state, stored });
      continue;
    }
    stampedOk++;
    // Not a failure: the migration deliberately does not flip a type (see migrate-order-party.js).
    // Reported so a real disagreement is visible rather than assumed away.
    if (state.order_type !== String(o.order_type || '')) {
      typeDisagrees++;
      typeRows.push({ o, derived: state.order_type });
    }
  }

  console.log(`   correct       ${String(stampedOk).padStart(5)}`);
  console.log(`   WRONG         ${String(wrongStamp).padStart(5)}`);
  console.log(`   unreadable    ${String(unreadable).padStart(5)}  (no legs and no carrier/truck — stamp not expected)`);
  if (wrongStamp) {
    failures++;
    console.log('   FAIL — stored stamp does not match what the legs say:');
    wrongRows.slice(0, verbose ? 100 : 20).forEach(({ o, state, stored }) => {
      console.log(`     #${o.serial_no} ${o.tenantId}: stored=[${stored.join(',')}] mixed=${Boolean(o.isMixedType)}  ->  derived=[${state.order_parties.join(',')}] mixed=${state.isMixedType}`);
    });
  } else {
    console.log('   PASS');
  }

  if (typeDisagrees) {
    console.log(`\n   NOTE — ${typeDisagrees} order(s) have a stored order_type the legs disagree with.`);
    console.log('   Not a failure: the migration never flips a type. These need a human.');
    typeRows.slice(0, 20).forEach(({ o, derived }) =>
      console.log(`     #${o.serial_no} ${o.tenantId}: stored=${o.order_type} derived=${derived}`));
  }

  /* ── 3. stamp complete ──────────────────────────────────────────────── */
  console.log('\n3. STAMP COMPLETE');
  console.log('-----------------');
  const missing = orders.filter((o) => {
    const legs = tripsByOrder.get(String(o._id)) || [];
    const state = resolveOrderState({ order: o, trips: legs, truckMap });
    return state.resolved && (!Array.isArray(o.order_parties) || o.order_parties.length === 0);
  });
  if (missing.length) {
    failures++;
    console.log(`   FAIL — ${missing.length} readable order(s) carry no stamp. The migration missed them.`);
    missing.slice(0, 20).forEach((o) => console.log(`     #${o.serial_no} ${o.tenantId}`));
  } else {
    console.log('   PASS — every readable order is stamped.');
  }

  console.log(`\n${failures ? `${failures} CHECK(S) FAILED` : 'ALL CHECKS PASSED'}\n`);
  if (failures) process.exitCode = 1;
}

run()
  .catch((e) => { console.error('Verify failed:', e); process.exitCode = 1; })
  .finally(async () => {
    await mongoose.connection.close().catch(() => {});
    process.exit(process.exitCode || 0);
  });
