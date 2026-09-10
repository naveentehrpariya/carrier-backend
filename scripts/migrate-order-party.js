/**
 * Stamp every order with WHO GETS PAID for it — `order_parties` and `isMixedType` — and, where the
 * legs disagree with the stored column, correct `order_type`.
 *
 * USAGE:
 *   node scripts/migrate-order-party.js                       # DRY RUN (default, no writes)
 *   node scripts/migrate-order-party.js --tenant=<tenantId>
 *   node scripts/migrate-order-party.js --apply               # backup, then write
 *   node scripts/migrate-order-party.js --apply --allow-type-change
 *
 * WHAT IT WRITES
 *   order_parties   [] -> subset of ['company','owner','carrier'], read from the order's legs
 *   isMixedType     a carrier leg AND a fleet leg on the same order
 *   order_type      ONLY when it disagrees with what the legs say, and only with
 *                   --allow-type-change. Without that flag a disagreement is reported and skipped.
 *
 * WHAT IT NEVER DOES
 *   It does not touch a single money column. `order_type` is a label; carrier_amount,
 *   settle_amount, input_* and every payslip stay exactly as they are. The money-invariant check
 *   below proves that per order rather than asserting it: the cost, profit and commission an order
 *   reports must be identical before and after, or the order is skipped and listed.
 *
 * WHAT IT SKIPS
 *   Orders whose type cannot be read at all (no legs AND no carrier/truck on the order). The stored
 *   type is kept. On the live database that is 33 of 776 — all of them incomplete orders that
 *   already appear in "orders needing attention".
 *
 * Idempotent: re-running writes nothing once the fields match.
 * Reverse with: node scripts/restore-backup.js --from=order-party-backup --apply
 */
require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../db/config');
const Order = require('../db/Order');
const Trip = require('../db/Trip');
const Truck = require('../db/Truck');
require('../db/Users'); // registers the 'users' model that created_by populates
const { resolveOrderState } = require('../utils/orderParty');
const { backupCollections } = require('./_backupHelper');

const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const money = (n) => Math.round(num(n) * 100) / 100;

/**
 * The three figures an order reports that depend on `order_type`, computed exactly the way the
 * Order model's virtuals compute them. If any of these moves, the migration has changed money and
 * the order must not be written.
 */
function moneySnapshot(order, orderType) {
  const totalAmount = num(order.total_amount);
  const isOutsourcing = orderType === 'outsourcing';
  const isOwnerOperated = orderType === 'regular' && order.isOwnerOperatedTruck;

  let profit;
  let commission;
  if (isOwnerOperated) {
    profit = totalAmount - num(order.settle_amount);
    commission = 0;
  } else {
    const carrierAmount = isOutsourcing ? num(order.carrier_amount) : 0;
    const rate = isOutsourcing ? num(order.created_by?.staff_commision) : 0;
    const net = totalAmount - carrierAmount;
    commission = net * (rate / 100);
    profit = net - commission;
  }
  const cost = isOwnerOperated ? num(order.settle_amount)
    : (isOutsourcing ? num(order.carrier_amount) : 0);

  return { cost: money(cost), profit: money(profit), commission: money(commission) };
}

const sameMoney = (a, b) =>
  a.cost === b.cost && a.profit === b.profit && a.commission === b.commission;

const sameParties = (a, b) =>
  Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i]);

async function migrate() {
  const apply = process.argv.includes('--apply');
  const allowTypeChange = process.argv.includes('--allow-type-change');
  const tenant = arg('tenant');
  const verbose = process.argv.includes('--verbose');

  await connectDB();
  console.log('Connected to MongoDB');
  console.log(apply
    ? '\nAPPLY MODE — will back up, then write\n'
    : '\nDRY RUN — nothing will be written (use --apply)\n');

  const filter = { $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }] };
  if (tenant) filter.tenantId = tenant;

  if (apply) {
    console.log('Backing up before any write...');
    await backupCollections('order-party-backup', [{
      collection: 'orders',
      projection: {
        _id: 1, tenantId: 1, serial_no: 1,
        order_type: 1, order_parties: 1, isMixedType: 1,
        // Captured so a restore can PROVE the money did not move, not just undo the labels.
        carrier_amount: 1, settle_amount: 1, total_amount: 1,
        input_carrier_amount: 1, input_settle_amount: 1, input_total_amount: 1,
        isOwnerOperatedTruck: 1, isMixedOwner: 1,
      },
    }]);
  }

  const orders = await Order.find(filter)
    .select('_id tenantId serial_no order_type order_parties isMixedType isOwnerOperatedTruck carrier truck driver drivers ownerOperator total_amount carrier_amount settle_amount created_by')
    .populate('created_by', 'staff_commision')
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
  const trucks = await Truck.find({ _id: { $in: truckIds } })
    .select('_id ownerOperated ownerOperator').lean();
  const truckMap = new Map(trucks.map((t) => [String(t._id), t]));

  const stats = {
    alreadyCorrect: 0, stamped: 0, typeChanged: 0, typeChangeHeld: 0,
    skippedUnreadable: 0, skippedMoneyMoved: 0, mixed: 0,
  };
  const typeChanges = [];
  const moneyMoved = [];
  const ops = [];

  for (const o of orders) {
    const legs = tripsByOrder.get(String(o._id)) || [];
    const state = resolveOrderState({ order: o, trips: legs, truckMap });

    if (!state.resolved) {
      stats.skippedUnreadable++;
      continue;
    }
    if (state.isMixedType) stats.mixed++;

    const storedType = String(o.order_type || '');
    const typeDiffers = state.order_type !== storedType;

    // The invariant. `order_type` decides which column an order calls its cost, so a change of type
    // is a change of money unless the other columns happen to agree. Prove it per order.
    if (typeDiffers) {
      const before = moneySnapshot(o, storedType);
      const after = moneySnapshot(o, state.order_type);
      if (!sameMoney(before, after)) {
        stats.skippedMoneyMoved++;
        moneyMoved.push({ o, before, after, derived: state.order_type });
        continue;
      }
      if (!allowTypeChange) {
        stats.typeChangeHeld++;
        typeChanges.push({ o, derived: state.order_type, held: true });
        continue;
      }
      typeChanges.push({ o, derived: state.order_type, held: false });
      stats.typeChanged++;
    }

    const set = {};
    if (!sameParties(o.order_parties, state.order_parties)) set.order_parties = state.order_parties;
    // Written even when it is false. A schema default only applies to NEW documents, so leaving it
    // out keeps the field ABSENT on every existing order — and `{ isMixedType: false }` does not
    // match an absent field, which would quietly drop every legacy order out of an indexed query.
    if (o.isMixedType === undefined || o.isMixedType === null || Boolean(o.isMixedType) !== state.isMixedType) {
      set.isMixedType = state.isMixedType;
    }
    if (typeDiffers && allowTypeChange) set.order_type = state.order_type;

    if (!Object.keys(set).length) { stats.alreadyCorrect++; continue; }

    stats.stamped++;
    if (verbose && stats.stamped <= 15) {
      console.log(`  #${o.serial_no} ${o.tenantId}: ${JSON.stringify(set)}`);
    }
    ops.push({ updateOne: { filter: { _id: o._id }, update: { $set: set } } });
  }

  console.log('RESULT');
  console.log('------');
  console.log(`  already correct        ${String(stats.alreadyCorrect).padStart(5)}`);
  console.log(`  ${apply ? 'stamped              ' : 'would stamp          '}  ${String(stats.stamped).padStart(5)}  order_parties / isMixedType`);
  console.log(`  mixed orders found     ${String(stats.mixed).padStart(5)}  carrier leg + fleet leg`);
  console.log(`  type corrected         ${String(stats.typeChanged).padStart(5)}`);
  console.log(`  type change HELD       ${String(stats.typeChangeHeld).padStart(5)}  (pass --allow-type-change to write these)`);
  console.log(`  skipped: unreadable    ${String(stats.skippedUnreadable).padStart(5)}  stored type kept`);
  console.log(`  skipped: money moves   ${String(stats.skippedMoneyMoved).padStart(5)}  NEVER written — needs a human`);

  if (typeChanges.length) {
    console.log(`\nType differences (${typeChanges.length})`);
    console.log('-------------------------');
    typeChanges.slice(0, 40).forEach(({ o, derived, held }) => {
      console.log(`  #${o.serial_no} ${o.tenantId}: ${o.order_type || '(none)'} -> ${derived}${held ? '   [held]' : ''}`);
    });
  }

  if (moneyMoved.length) {
    console.log(`\nSKIPPED — the type change would move money (${moneyMoved.length})`);
    console.log('----------------------------------------------------');
    moneyMoved.slice(0, 40).forEach(({ o, before, after, derived }) => {
      console.log(`  #${o.serial_no} ${o.tenantId}: ${o.order_type} -> ${derived}`);
      console.log(`      cost ${before.cost} -> ${after.cost} | profit ${before.profit} -> ${after.profit} | commission ${before.commission} -> ${after.commission}`);
    });
  }

  if (!apply) {
    console.log(`\nDry run complete. ${ops.length} order(s) would be written. Re-run with --apply.\n`);
    return;
  }

  if (!ops.length) {
    console.log('\nNothing to write.\n');
    return;
  }

  // Chunked so one oversized bulk write cannot fail the whole run halfway through.
  let written = 0;
  for (let i = 0; i < ops.length; i += 500) {
    const chunk = ops.slice(i, i + 500);
    const res = await Order.bulkWrite(chunk, { ordered: false });
    written += res.modifiedCount || 0;
  }
  console.log(`\nWrote ${written} order(s).`);
  console.log('Undo with: node scripts/restore-backup.js --from=order-party-backup --apply\n');
}

migrate()
  .catch((e) => { console.error('Migration failed:', e); process.exitCode = 1; })
  .finally(async () => {
    await mongoose.connection.close().catch(() => {});
    process.exit(process.exitCode || 0);
  });
