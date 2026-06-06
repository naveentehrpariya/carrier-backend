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

  for (const { collection, projection } of specs) {
    const docs = await mongoose.connection.db
      .collection(collection)
      .find({}, { projection })
      .toArray();
    const serializable = docs.map(d => ({ ...d, _id: d._id.toString() }));
    fs.writeFileSync(path.join(dir, `${collection}.json`), JSON.stringify(serializable, null, 2));
    console.log(`  📦 backed up ${collection} — ${docs.length} docs`);
  }

  console.log(`  ✅ Backup folder: ${dir}\n`);
  return dir;
}

module.exports = { backupCollections };
