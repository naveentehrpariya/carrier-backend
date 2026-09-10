/**
 * Reusable backup helper for migration scripts.
 * Dumps selected fields of given collections to db_backups/<label>-<timestamp>/.
 *
 * Restore is straightforward: each <collection>.json holds an array of
 * { _id, ...fields } that can be re-applied with updateOne by _id.
 */
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

/**
 * @param {string} label        Folder prefix, e.g. 'roles-backup'
 * @param {Array<{collection:string, projection:object}>} specs
 * @returns {Promise<string>}    Absolute path of the backup folder
 */
async function backupCollections(label, specs) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(__dirname, '..', '..', 'db_backups', `${label}-${stamp}`);
  fs.mkdirSync(dir, { recursive: true });
  const projections = {};

  for (const { collection, projection } of specs) {
    const docs = await mongoose.connection.db
      .collection(collection)
      .find({}, { projection })
      .toArray();
    const serializable = docs.map(d => ({ ...d, _id: d._id.toString() }));
    fs.writeFileSync(path.join(dir, `${collection}.json`), JSON.stringify(serializable, null, 2));
    console.log(`  📦 backed up ${collection} — ${docs.length} docs`);
    projections[collection] = Object.keys(projection || {}).filter((k) => k !== '_id');
  }

  // The projection has to be recorded SEPARATELY, because JSON cannot express it.
  // A field that no document carried at backup time is absent from every row, so it is
  // indistinguishable from a field that was never asked for — and a restore would then leave a
  // column the migration ADDED sitting on the record for ever. That is exactly the case a backfill
  // creates: order_parties existed on nothing before the migration and on 743 orders after it.
  fs.writeFileSync(path.join(dir, '_projection.json'), JSON.stringify(projections, null, 2));

  console.log(`  ✅ Backup folder: ${dir}\n`);
  return dir;
}

module.exports = { backupCollections };
