/**
 * Backfill the mixed-owner split fields on orders.
 *
 * USAGE:
 *   node scripts/migrate-order-mixed-owner.js            # DRY RUN (no writes)
 *   node scripts/migrate-order-mixed-owner.js --apply    # backup, then migrate
 *
 * Owner settlement used to be order-level: one order, one owner operator (`Order.ownerOperator`).
 * An order can now be split across several trucks, so it also carries:
 *   isMixedOwner    -> true when more than one settlement party runs the order
 *   ownerOperators  -> every owner with a leg on the order
 *
 * Every EXISTING order predates the split guard being lifted, so it has exactly one settlement party.
 * The only correct backfill is isMixedOwner=false and ownerOperators=[ownerOperator] (or []). No
 * money moves: a non-mixed order keeps reading its own settle/price columns.
 *
 * Idempotent — orders that already carry the fields are left alone.
 */
require('dotenv').config();
const connectDB = require('../db/config');
const Order = require('../db/Order');
const { backupCollections } = require('./_backupHelper');

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
      await backupCollections('order-mixed-owner-backup', [
        {
          collection: 'orders',
          projection: { _id: 1, tenantId: 1, serial_no: 1, ownerOperator: 1, ownerOperators: 1, isMixedOwner: 1, isOwnerOperatedTruck: 1, settle_amount: 1 },
        },
      ]);
    }

    const flagFilter = { isMixedOwner: { $exists: false } };
    const ownersFilter = {
      ownerOperator: { $ne: null },
      $or: [{ ownerOperators: { $exists: false } }, { ownerOperators: { $size: 0 } }],
    };

    const total = await Order.estimatedDocumentCount();
    const pendingFlag = await Order.countDocuments(flagFilter);
    const pendingOwners = await Order.countDocuments(ownersFilter);

    if (!apply) {
      console.log(`  orders.isMixedOwner            ${pendingFlag}/${total} need backfill${pendingFlag === 0 ? ' (nothing to do)' : ''}`);
      console.log(`  orders.ownerOperators          ${pendingOwners}/${total} need backfill${pendingOwners === 0 ? ' (nothing to do)' : ''}`);
      console.log(`\n🔍 Dry run complete — run with --apply to write changes.`);
      process.exit(0);
    }

    const flagRes = await Order.updateMany(flagFilter, { $set: { isMixedOwner: false } });
    console.log(`  orders.isMixedOwner            set false on ${flagRes.modifiedCount}/${total}`);

    // ownerOperators mirrors the single owner the order was already settled to.
    const ownersRes = await Order.updateMany(ownersFilter, [
      { $set: { ownerOperators: ['$ownerOperator'] } },
    ]);
    console.log(`  orders.ownerOperators          seeded from ownerOperator on ${ownersRes.modifiedCount}/${total}`);

    console.log(`\n✅ Backfill complete.`);
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

migrate();
