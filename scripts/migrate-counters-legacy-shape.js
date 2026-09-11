/**
 * Repair the `counters` collection so its unique index can be built.
 *
 *   node scripts/migrate-counters-legacy-shape.js            # dry run
 *   node scripts/migrate-counters-legacy-shape.js --apply
 *
 * THE FAULT
 * ---------
 * Order serials used to be minted by a counter keyed on a STRING `_id` (`serial_no:<tenant>`) with
 * a `sequence_value` field. `db/Counter.js` — the one implementation that survived — keys on
 * `{tenantId, key}` with a `seq`, and declares `{tenantId: 1, key: 1}` UNIQUE.
 *
 * The legacy documents carry neither `tenantId` nor `key`. In MongoDB a missing field indexes as
 * null, so all of them collide on the single key `{tenantId: null, key: null}` — and `Counter.init()`
 * (which `nextSeq` awaits on purpose, so concurrent upserts cannot mint the same number) therefore
 * fails with E11000 and takes EVERY order creation down with it:
 *
 *   Serial number generation failed: Index build failed: ... E11000 duplicate key error
 *   collection: carrier.counters index: tenantId_1_key_1 dup key: { tenantId: null, key: null }
 *
 * THE FIX
 * -------
 * Carry each legacy value onto a document of the new shape, then delete the legacy rows, then build
 * the index. The value is carried rather than recomputed even though `generateUniqueSerialNumber`
 * bumps the counter from the highest existing order anyway: on this database the two happen to be
 * equal (1795 and 1077), and a fix that silently depends on that coincidence would hand out a
 * number twice on any database where they are not.
 *
 * Only documents with NO `key` field are touched — a real counter (cheque numbers, vendor codes) is
 * never a candidate.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const APPLY = process.argv.includes('--apply');
const ORDER_SERIAL_KEY = 'order_serial';

/* `_id` of a legacy per-tenant order counter → the tenant it belongs to. Anything else legacy is
 * reported and dropped without being carried: see the notes where they are classified below. */
const LEGACY_TENANT_PREFIX = 'serial_no:';

(async () => {
  const uri = process.env.DB_URL_OFFICE || process.env.MONGODB_URI;
  if (!uri) { console.error('No DB_URL_OFFICE / MONGODB_URI in the environment.'); process.exit(1); }

  // db/config connects with autoIndex:true, which would try to build this very index as a side
  // effect of loading a model — the thing that is currently failing.
  await mongoose.connect(uri, { autoIndex: false });
  const col = mongoose.connection.db.collection('counters');
  console.log(`Connected to ${mongoose.connection.name}${APPLY ? '' : '   (DRY RUN)'}\n`);

  const all = await col.find({}).toArray();
  const legacy = all.filter((d) => d.key === undefined || d.key === null);
  const modern = all.filter((d) => !(d.key === undefined || d.key === null));

  console.log(`counters: ${all.length} document(s) — ${modern.length} of the current shape, ${legacy.length} legacy`);
  if (!legacy.length) {
    console.log('Nothing to repair.');
    await ensureIndex(col);
    await mongoose.connection.close();
    return;
  }

  /* Classify before deciding. A counter that cannot be attributed to a tenant cannot be carried:
   *   - `serial_no` (no tenant) predates multi-tenancy. Its successor is the per-tenant row, which
   *     is higher, so carrying it would either do nothing or push a tenant's numbering FORWARD past
   *     numbers nobody issued.
   *   - anything below 1000 is not an order serial at all (serials start at 1001). */
  const carry = [];
  const drop = [];
  for (const d of legacy) {
    const id = String(d._id);
    const seq = Number(d.sequence_value);
    if (id.startsWith(LEGACY_TENANT_PREFIX) && Number.isFinite(seq) && seq >= 1000) {
      carry.push({ tenantId: id.slice(LEGACY_TENANT_PREFIX.length), key: ORDER_SERIAL_KEY, seq, _legacyId: id });
    } else {
      drop.push({ id, seq: d.sequence_value, why: id.startsWith(LEGACY_TENANT_PREFIX) ? 'below the first serial (1001)' : 'names no tenant' });
    }
  }

  console.log('\nCarry forward:');
  for (const c of carry) {
    const max = await maxSerial(c.tenantId);
    const note = max === null ? 'no orders' : (max === c.seq ? `matches highest order ${max}` : `highest order is ${max}`);
    console.log(`  ${c._legacyId}  →  {tenantId: "${c.tenantId}", key: "${ORDER_SERIAL_KEY}", seq: ${c.seq}}   (${note})`);
    if (max !== null && max > c.seq) {
      console.log(`     counter is BEHIND the data — raising it to ${max} so a number cannot be issued twice.`);
      c.seq = max;
    }
  }
  console.log('\nDelete without carrying:');
  drop.forEach((d) => console.log(`  ${d.id}  (sequence_value ${d.seq}) — ${d.why}`));

  const backupDir = path.join(__dirname, '..', '..', 'db_backups', `counters-legacy-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  console.log(`\nBackup: ${backupDir}/counters.json`);

  if (!APPLY) {
    console.log('\nDRY RUN — nothing written. Re-run with --apply.');
    await mongoose.connection.close();
    return;
  }

  fs.mkdirSync(backupDir, { recursive: true });
  fs.writeFileSync(path.join(backupDir, 'counters.json'), JSON.stringify(all, null, 2));

  /* Order matters. The legacy rows have to be gone BEFORE the unique index is built, and the
   * carried rows have to be written AFTER it exists — otherwise the write that the index is meant
   * to protect happens unprotected. */
  const ids = legacy.map((d) => d._id);
  const del = await col.deleteMany({ _id: { $in: ids } });
  console.log(`\ndeleted ${del.deletedCount} legacy document(s)`);

  await ensureIndex(col);

  for (const c of carry) {
    await col.updateOne(
      { tenantId: c.tenantId, key: c.key },
      { $max: { seq: c.seq }, $setOnInsert: { tenantId: c.tenantId, key: c.key } },
      { upsert: true },
    );
    console.log(`  carried ${c.tenantId} → seq ${c.seq}`);
  }

  console.log('\nFinal state:');
  (await col.find({}).toArray()).forEach((d) => console.log('  ', JSON.stringify(d)));
  await mongoose.connection.close();
})().catch(async (e) => {
  console.error('\nFAILED:', e.message);
  try { await mongoose.connection.close(); } catch (_) {}
  process.exit(1);
});

async function maxSerial(tenantId) {
  const row = await mongoose.connection.db.collection('orders')
    .find({ tenantId }, { projection: { serial_no: 1 } }).sort({ serial_no: -1 }).limit(1).toArray();
  const n = Number(row[0]?.serial_no);
  return Number.isFinite(n) ? n : null;
}

async function ensureIndex(col) {
  const before = await col.indexes();
  if (before.some((i) => i.name === 'tenantId_1_key_1')) { console.log('\nUnique index already present.'); return; }
  if (!APPLY) { console.log('\nWould build the unique index {tenantId: 1, key: 1}.'); return; }
  await col.createIndex({ tenantId: 1, key: 1 }, { unique: true, name: 'tenantId_1_key_1' });
  console.log('\nBuilt unique index tenantId_1_key_1.');
}
