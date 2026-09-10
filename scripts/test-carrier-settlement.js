/**
 * Offline tests for the per-leg carrier settlement math. No database, no server.
 *
 *   node scripts/test-carrier-settlement.js
 *
 * The rules being pinned down here are the ones that cost money when they are wrong:
 *   - a typed leg amount is taken off the top, exactly as typed
 *   - the remainder is shared by REAL miles, and only among carrier legs
 *   - our own legs are never paid from the carrier pot, but still count toward the route
 *   - a single-carrier order keeps reading the order's own columns (nothing already invoiced moves)
 *   - a legacy order's base-currency pot is divided back by fx_to_usd before being compared with
 *     typed overrides, never read as if it were already the input currency
 *   - leg shares always add back up to the pot
 */
const assert = require('assert');
const {
  resolveOrderCarrierState, resolveCarrierPot, allocateTripCarrierCost,
  buildOrderCarrierLegs, resolveOrderCarrierFields, rollupCarrierPaymentStatus,
} = require('../utils/carrierSettlement');

let pass = 0;
let fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  FAIL ${name}\n         ${e.message}`); }
};
const near = (a, b, eps = 0.01) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

// A leg's real miles are derived from the ORDER's km and the leg's share of the raw total, so the
// fixtures below give each leg a raw distance and let deriveTripMiles do the rest — exactly as
// production does. 160.9344 km = 100 miles, so the numbers stay readable.
const leg = (id, opts = {}) => ({ _id: id, totalDistance: opts.raw ?? 100, ...opts });
const ORDER_KM = 321.8688; // 200 miles

console.log('\ncarrier settlement — leg allocation\n');

t('no carrier legs: state is empty and fields are zeroed', () => {
  const trips = [leg('a'), leg('b')];
  const st = resolveOrderCarrierState(trips);
  assert.strictEqual(st.hasCarrierLeg, false);
  assert.strictEqual(st.hasFleetLeg, true);
  const f = resolveOrderCarrierFields({ order: { carrier_amount: 500 }, trips });
  assert.strictEqual(f.carrier_amount, 0);
  assert.strictEqual(f.carrier, null);
  assert.deepStrictEqual(f.carriers, []);
});

t('single carrier, no fleet leg: order columns are left alone', () => {
  const trips = [leg('a', { carrier: 'c1' }), leg('b', { carrier: 'c1' })];
  const order = { carrier: 'c1', carrier_amount: 1422.35, input_carrier_amount: 2000, input_currency: 'cad', fx_to_usd: 0.711173, totalDistance: ORDER_KM };
  const f = resolveOrderCarrierFields({ order, trips });
  assert.strictEqual(f.carrier_amount, 1422.35, 'base cost must not be recomputed');
  assert.strictEqual(f.input_carrier_amount, 2000, 'typed cost must not be recomputed');
  assert.strictEqual(f.isMixedCarrier, false); // the settlement state's own computed flag, not a column
  assert.strictEqual(f.tripCost.size, 0, 'nothing frozen onto a non-split order');
});

t('single carrier legacy leg carries costOriginal null', () => {
  const trips = [leg('a', { carrier: 'c1' })];
  const { legs } = buildOrderCarrierLegs({ order: { carrier_amount: 900, totalDistance: ORDER_KM }, trips });
  assert.strictEqual(legs.get('c1').costOriginal, null, 'null = read the order, do not re-derive');
});

t('mixed: carrier leg + our leg — pot goes entirely to the carrier leg', () => {
  const trips = [leg('mine'), leg('theirs', { carrier: 'c1' })];
  const order = { input_carrier_amount: 1000, input_currency: 'usd', fx_to_usd: 1, totalDistance: ORDER_KM };
  const { rows } = allocateTripCarrierCost({ order, trips });
  const mine = rows.find((r) => r.trip._id === 'mine');
  const theirs = rows.find((r) => r.trip._id === 'theirs');
  near(mine.cost, 0);
  near(theirs.cost, 1000, 0.001);
  near(mine.miles, 100);
  near(theirs.miles, 100);
});

t('two carriers, equal miles: pot splits in half', () => {
  const trips = [leg('a', { carrier: 'c1' }), leg('b', { carrier: 'c2' })];
  const order = { input_carrier_amount: 1000, input_currency: 'usd', fx_to_usd: 1, totalDistance: ORDER_KM };
  const { rows } = allocateTripCarrierCost({ order, trips });
  near(rows[0].cost, 500);
  near(rows[1].cost, 500);
});

t('two carriers, 3:1 miles: pot splits by real miles', () => {
  const trips = [leg('a', { carrier: 'c1', raw: 150 }), leg('b', { carrier: 'c2', raw: 50 })];
  const order = { input_carrier_amount: 800, input_currency: 'usd', fx_to_usd: 1, totalDistance: ORDER_KM };
  const { rows } = allocateTripCarrierCost({ order, trips });
  near(rows[0].cost, 600);
  near(rows[1].cost, 200);
});

t('typed override comes off the top; remainder splits by miles', () => {
  const trips = [
    leg('a', { carrier: 'c1', carrier_amount: 300 }),
    leg('b', { carrier: 'c2' }),
    leg('c', { carrier: 'c3' }),
  ];
  const order = { input_carrier_amount: 1000, input_currency: 'usd', fx_to_usd: 1, totalDistance: ORDER_KM };
  const { rows } = allocateTripCarrierCost({ order, trips });
  near(rows[0].cost, 300, 0.001);
  near(rows[1].cost, 350);
  near(rows[2].cost, 350);
  near(rows.reduce((a, r) => a + r.cost, 0), 1000, 0.01);
});

t('a typed ZERO is an instruction, not an absent value', () => {
  const trips = [leg('a', { carrier: 'c1', carrier_amount: 0 }), leg('b', { carrier: 'c2' })];
  const order = { input_carrier_amount: 900, input_currency: 'usd', fx_to_usd: 1, totalDistance: ORDER_KM };
  const { rows } = allocateTripCarrierCost({ order, trips });
  near(rows[0].cost, 0, 0.001);
  near(rows[1].cost, 900, 0.01);
});

t('overrides above the pot are paid in full; remainder clamps at zero', () => {
  const trips = [leg('a', { carrier: 'c1', carrier_amount: 900 }), leg('b', { carrier: 'c2' })];
  const order = { input_carrier_amount: 500, input_currency: 'usd', fx_to_usd: 1, totalDistance: ORDER_KM };
  const { rows, pot } = allocateTripCarrierCost({ order, trips });
  near(rows[0].cost, 900, 0.001);
  near(rows[1].cost, 0, 0.001);
  // Over-allocation is a real state the caller must refuse — prove it is detectable.
  assert.ok(pot.overrideTotal > pot.amount, 'over-allocation must be visible to the caller');
});

t('legacy order: base pot is divided back by fx before meeting typed overrides', () => {
  // CA$2,000 typed originally, stored only as US$1,422.35 with fx 0.711173.
  const trips = [leg('a', { carrier: 'c1' }), leg('b', { carrier: 'c2' })];
  const order = { carrier_amount: 1422.35, input_carrier_amount: 0, input_currency: 'cad', fx_to_usd: 0.711173, totalDistance: ORDER_KM };
  const potNoOverride = resolveCarrierPot(order, trips);
  near(potNoOverride.amount, 1422.35, 0.01);
  assert.strictEqual(potNoOverride.fxToBase, 1, 'with no typed override the pot stays in base');

  const withOverride = [leg('a', { carrier: 'c1', carrier_amount: 500 }), leg('b', { carrier: 'c2' })];
  const pot = resolveCarrierPot(order, withOverride);
  near(pot.amount, 2000, 0.5, 'base must be converted back to the input currency');
  near(pot.fxToBase, 0.711173, 0.000001);
});

t('mixed order: base cost is the sum of the carrier legs, converted once', () => {
  const trips = [leg('mine'), leg('a', { carrier: 'c1' }), leg('b', { carrier: 'c2' })];
  const order = { input_carrier_amount: 1000, input_currency: 'cad', fx_to_usd: 0.711173, totalDistance: ORDER_KM * 1.5 };
  const f = resolveOrderCarrierFields({ order, trips });
  near(f.input_carrier_amount, 1000, 0.02);
  near(f.carrier_amount, 1000 * 0.711173, 0.02);
  assert.strictEqual(f.carrier, null, 'two carriers means no single carrier column');
  assert.deepStrictEqual(f.carriers, ['c1', 'c2']);
  assert.strictEqual(f.tripCost.size, 2, 'only the carrier legs are frozen');
});

t('frozen leg shares add back up to the order cost (no drift on re-read)', () => {
  const trips = [leg('mine'), leg('a', { carrier: 'c1', raw: 70 }), leg('b', { carrier: 'c2', raw: 30 })];
  const order = { input_carrier_amount: 1000, input_currency: 'usd', fx_to_usd: 1, totalDistance: ORDER_KM * 2 };
  const f = resolveOrderCarrierFields({ order, trips });
  const sum = [...f.tripCost.values()].reduce((a, b) => a + b, 0);
  near(sum, f.input_carrier_amount, 0.01);

  // Re-read with the shares frozen onto the legs: the answer must not move.
  const frozen = trips.map((t2) => (f.tripCost.has(String(t2._id))
    ? { ...t2, carrier_amount: f.tripCost.get(String(t2._id)) }
    : t2));
  const again = resolveOrderCarrierFields({ order: { ...order, input_carrier_amount: f.input_carrier_amount }, trips: frozen });
  near(again.input_carrier_amount, f.input_carrier_amount, 0.01);
});

t('a leg with no miles at all still gets an equal share, never NaN', () => {
  const trips = [leg('a', { carrier: 'c1', raw: 0 }), leg('b', { carrier: 'c2', raw: 0 })];
  const order = { input_carrier_amount: 600, input_currency: 'usd', fx_to_usd: 1, totalDistance: 0 };
  const { rows } = allocateTripCarrierCost({ order, trips });
  rows.forEach((r) => assert.ok(Number.isFinite(r.cost), 'cost must be a number'));
  near(rows[0].cost + rows[1].cost, 600, 0.01);
});

console.log('\ncarrier payment rollup\n');

t('no carrier leg -> null (caller keeps the stored status)', () => {
  assert.strictEqual(rollupCarrierPaymentStatus([leg('a')]), null);
});
t('every carrier leg paid -> paid', () => {
  assert.strictEqual(rollupCarrierPaymentStatus([
    leg('a', { carrier: 'c1', carrier_payment_status: 'paid' }),
    leg('b', { carrier: 'c2', carrier_payment_status: 'paid' }),
  ]), 'paid');
});
t('one of two paid -> partial (never "paid")', () => {
  assert.strictEqual(rollupCarrierPaymentStatus([
    leg('a', { carrier: 'c1', carrier_payment_status: 'paid' }),
    leg('b', { carrier: 'c2', carrier_payment_status: 'pending' }),
  ]), 'partial');
});
t('none paid -> pending', () => {
  assert.strictEqual(rollupCarrierPaymentStatus([
    leg('a', { carrier: 'c1' }),
    leg('b', { carrier: 'c2', carrier_payment_status: 'pending' }),
  ]), 'pending');
});
t('a fleet leg does not dilute the rollup', () => {
  assert.strictEqual(rollupCarrierPaymentStatus([
    leg('mine'),
    leg('a', { carrier: 'c1', carrier_payment_status: 'paid' }),
  ]), 'paid');
});
t('legs agreeing on a non-paid status keep it', () => {
  assert.strictEqual(rollupCarrierPaymentStatus([
    leg('a', { carrier: 'c1', carrier_payment_status: 'hold' }),
    leg('b', { carrier: 'c2', carrier_payment_status: 'hold' }),
  ]), 'hold');
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
