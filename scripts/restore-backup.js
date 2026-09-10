/**
 * Restore a db_backups/<label>-<timestamp>/ folder produced by scripts/_backupHelper.js.
 *
 * USAGE:
 *   node scripts/restore-backup.js --list
 *   node scripts/restore-backup.js --from=<folder-name-or-path>              # DRY RUN
 *   node scripts/restore-backup.js --from=<folder-name-or-path> --apply      # write
 *   node scripts/restore-backup.js --from=... --collection=orders --apply    # one collection
 *
 * _backupHelper writes each collection as an array of { _id, ...projected fields }. A restore is
 * therefore an $set of exactly those projected fields, matched by _id — it never deletes documents
 * and never touches a field the backup did not capture. That is the whole point: a migration that
 * only rewrites `order_type` can be undone without reverting unrelated edits made since.
 *
 * A field that was ABSENT in the backup but exists now is $unset, so a backfilled column really
 * does disappear on restore. `_id` is never written.
 *
 * Dry run by default. Prints a per-collection diff count and, with --verbose, the first few
 * documents that would actually change.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const connectDB = require('../db/config');

const BACKUP_ROOT = path.join(__dirname, '..', '..', 'db_backups');

const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};

function listBackups() {
  if (!fs.existsSync(BACKUP_ROOT)) {
    console.log(`No backup folder at ${BACKUP_ROOT}`);
    return [];
  }
  const dirs = fs
    .readdirSync(BACKUP_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  return dirs;
}

function resolveFolder(from) {
  const direct = path.isAbsolute(from) ? from : path.join(BACKUP_ROOT, from);
  if (fs.existsSync(direct) && fs.statSync(direct).isDirectory()) return direct;
  // Allow a label prefix: pick the newest folder that starts with it.
  const match = listBackups().filter((d) => d.startsWith(from)).pop();
  if (match) return path.join(BACKUP_ROOT, match);
  return null;
}

// Mongo returns ObjectIds/Dates as objects; the backup holds their JSON form. Compare on the JSON
// form of both sides so an unchanged ObjectId is not reported as a difference.
const norm = (v) => {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (v instanceof mongoose.Types.ObjectId) return v.toString();
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map(norm);
  if (typeof v === 'object') {
    const out = {};
    Object.keys(v).sort().forEach((k) => { out[k] = norm(v[k]); });
    return out;
  }
  return v;
};
const same = (a, b) => JSON.stringify(norm(a)) === JSON.stringify(norm(b));

async function run() {
  const apply = process.argv.includes('--apply');
  const verbose = process.argv.includes('--verbose');
  const only = arg('collection');
  const from = arg('from');

  if (process.argv.includes('--list') || !from) {
    const dirs = listBackups();
    console.log(`\nBackups in ${BACKUP_ROOT}:\n`);
    if (!dirs.length) console.log('  (none)');
    dirs.forEach((d) => {
      const files = fs.readdirSync(path.join(BACKUP_ROOT, d)).filter((f) => f.endsWith('.json') && f !== '_projection.json');
      console.log(`  ${d}  [${files.map((f) => f.replace(/\.json$/, '')).join(', ')}]`);
    });
    if (!from) console.log('\nPass --from=<folder> to restore one.\n');
    return;
  }

  const dir = resolveFolder(from);
  if (!dir) {
    console.error(`Backup folder not found: ${from}`);
    process.exitCode = 1;
    return;
  }

  await connectDB();
  console.log('Connected to MongoDB');
  console.log(apply ? '\nAPPLY MODE — will write restored values\n' : '\nDRY RUN — no changes written (use --apply)\n');
  console.log(`Restoring from: ${dir}\n`);

  let projectionMap = null;
  const projectionFile = path.join(dir, '_projection.json');
  if (fs.existsSync(projectionFile)) {
    try { projectionMap = JSON.parse(fs.readFileSync(projectionFile, 'utf8')); } catch { projectionMap = null; }
  }
  console.log(projectionMap
    ? 'Projection recorded with this backup — fields added since can be removed.\n'
    : 'No _projection.json in this backup (older format) — falling back to the union of keys.\n');

  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .filter((f) => f !== '_projection.json')
    .filter((f) => !only || f === `${only}.json`);

  if (!files.length) {
    console.error(only ? `No ${only}.json in that backup.` : 'No .json files in that backup.');
    process.exitCode = 1;
    return;
  }

  let grandChanged = 0;
  let grandMissing = 0;

  for (const file of files) {
    const collection = file.replace(/\.json$/, '');
    const rows = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    const col = mongoose.connection.db.collection(collection);

    // JSON drops absent fields, so the rows alone cannot tell us which fields the backup PROJECTED.
    // _backupHelper records the projection in _projection.json for exactly this reason: a column
    // that no document carried at backup time (a field a migration is about to ADD) is absent from
    // every row, and without the recorded projection a restore would leave it in place for ever.
    // Older backups predate that file — fall back to the union of keys, which is correct for every
    // field that at least one document had.
    const projected = new Set();
    if (projectionMap && Array.isArray(projectionMap[collection])) {
      projectionMap[collection].forEach((k) => { if (k !== '_id') projected.add(k); });
    } else {
      rows.forEach((r) => Object.keys(r).forEach((k) => { if (k !== '_id') projected.add(k); }));
    }

    let changed = 0;
    let missing = 0;
    let identical = 0;
    const samples = [];

    for (const row of rows) {
      const { _id, ...fields } = row;
      let oid;
      try {
        oid = new mongoose.Types.ObjectId(_id);
      } catch {
        oid = _id;
      }
      const current = await col.findOne({ _id: oid });
      if (!current) {
        missing++;
        continue;
      }

      const set = {};
      const unset = {};
      projected.forEach((k) => {
        const want = Object.prototype.hasOwnProperty.call(fields, k) ? fields[k] : undefined;
        if (want === undefined) {
          // Absent in the backup: only an actual value needs removing.
          if (current[k] !== undefined) unset[k] = '';
          return;
        }
        if (same(current[k], want)) return;
        set[k] = want;
      });

      if (!Object.keys(set).length && !Object.keys(unset).length) {
        identical++;
        continue;
      }

      changed++;
      if (samples.length < 5) {
        samples.push({
          _id,
          fields: Object.keys({ ...set, ...unset }).map((k) => `${k}: ${JSON.stringify(norm(current[k]))} -> ${Object.prototype.hasOwnProperty.call(unset, k) ? '(unset)' : JSON.stringify(fields[k])}`),
        });
      }

      if (apply) {
        const update = {};
        if (Object.keys(set).length) update.$set = set;
        if (Object.keys(unset).length) update.$unset = unset;
        await col.updateOne({ _id: oid }, update);
      }
    }

    grandChanged += changed;
    grandMissing += missing;

    console.log(`  ${collection}: ${rows.length} in backup | ${identical} already match | ${changed} ${apply ? 'restored' : 'would change'} | ${missing} no longer exist`);
    if (verbose && samples.length) {
      samples.forEach((s) => {
        console.log(`      ${s._id}`);
        s.fields.forEach((f) => console.log(`        ${f}`));
      });
    }
  }

  console.log(`\n${apply ? 'Restored' : 'Would restore'}: ${grandChanged} document(s). ${grandMissing} backed-up document(s) no longer exist (not recreated).`);
  if (!apply && grandChanged) console.log('Re-run with --apply to write.\n');
}

run()
  .catch((e) => {
    console.error('Restore failed:', e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.connection.close().catch(() => {});
    process.exit(process.exitCode || 0);
  });
