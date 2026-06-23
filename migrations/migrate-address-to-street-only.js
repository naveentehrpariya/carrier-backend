/**
 * Migration: strip city/state/zip/country out of legacy address strings.
 *
 * Context: old records stored Google `formatted_address` in the address field
 * (e.g. "123 Main St, Los Angeles, CA 90001, United States") AND separately in
 * country/state/city/zipcode columns. New records store a street-only address.
 * When the UI shows "address + city + state + country" merged, legacy rows show
 * the city/state/country twice. This migration removes the duplicated tail from
 * the address string, leaving the street line only.
 *
 * Strategy (conservative — never destroys the street):
 *   - split the address on commas
 *   - walk from the END, dropping any segment that matches the row's own
 *     country / state / city column value, or that contains the zipcode
 *   - stop at the first segment that doesn't match (that's the street)
 *   - the FIRST segment is always kept
 *   - row is only updated if something was actually removed and a non-empty
 *     street line remains
 *
 * Collections handled:
 *   customers       address   + country/state/city/zipcode
 *   carriers        location  + country/state/city/zipcode
 *   users           address   + country/state/city/zipcode (drivers/employees)
 *   owneroperators  address   + country/state/city/zipcode
 *
 * Dry-run by default (prints what WOULD change). Pass --apply to write.
 * Run: node backend/migrations/migrate-address-to-street-only.js [--apply]
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const mongoose = require('mongoose');
const connectDB = require('../db/config');

const APPLY = process.argv.includes('--apply');

// One segment is part of the duplicated tail if it equals a known column value
// (country/state/city) or contains the zipcode.
function isTailSegment(seg, { country, state, city, zipcode }) {
  const s = String(seg).trim().toLowerCase();
  if (!s) return true;
  const eq = (v) => v && s === String(v).trim().toLowerCase();
  if (eq(country) || eq(state) || eq(city)) return true;
  if (zipcode && s.includes(String(zipcode).trim().toLowerCase())) return true;
  return false;
}

// Returns the street-only line, or null if nothing should change.
function stripToStreet(addr, cols) {
  if (!addr || typeof addr !== 'string') return null;
  const segments = addr.split(',').map((p) => p.trim()).filter((p) => p !== '');
  if (segments.length <= 1) return null; // single segment = already street-only

  let end = segments.length;
  // Never drop the first segment (street). Walk back while tail matches.
  while (end > 1 && isTailSegment(segments[end - 1], cols)) {
    end -= 1;
  }
  if (end === segments.length) return null; // nothing removed

  const street = segments.slice(0, end).join(', ').trim();
  if (!street) return null;
  if (street === addr.trim()) return null;
  return street;
}

async function migrateCollection(db, { name, field }) {
  const coll = db.collection(name);
  const cursor = coll.find({ [field]: { $type: 'string', $ne: '' } });

  let scanned = 0;
  let changed = 0;
  const samples = [];

  while (await cursor.hasNext()) {
    const doc = await cursor.next();
    scanned += 1;
    const cols = {
      country: doc.country,
      state: doc.state,
      city: doc.city,
      zipcode: doc.zipcode,
    };
    const street = stripToStreet(doc[field], cols);
    if (!street) continue;

    changed += 1;
    if (samples.length < 8) {
      samples.push({ from: doc[field], to: street });
    }
    if (APPLY) {
      await coll.updateOne({ _id: doc._id }, { $set: { [field]: street } });
    }
  }

  console.log(`\n[${name}.${field}] scanned ${scanned}, ${APPLY ? 'updated' : 'would update'} ${changed}`);
  samples.forEach((s) => {
    console.log(`   - "${s.from}"`);
    console.log(`     → "${s.to}"`);
  });
  return changed;
}

async function run() {
  await connectDB();
  console.log(`Connected. Mode: ${APPLY ? 'APPLY (writing changes)' : 'DRY-RUN (no writes — pass --apply to write)'}`);

  const db = mongoose.connection.db;
  const targets = [
    { name: 'customers', field: 'address' },
    { name: 'carriers', field: 'location' },
    { name: 'users', field: 'address' },
    { name: 'owneroperators', field: 'address' },
  ];

  let total = 0;
  for (const t of targets) {
    total += await migrateCollection(db, t);
  }

  console.log(`\n${APPLY ? 'Applied' : 'Would apply'} ${total} updates total.`);
  await mongoose.connection.close();
  process.exit(0);
}

run().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
