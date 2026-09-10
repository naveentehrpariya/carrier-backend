/**
 * A projection that pulls MONEY off an order must also pull its SHAPE.
 *
 *   node scripts/test-order-shape-projection.js
 *
 * No database, no server — this reads the source.
 *
 * WHY THIS TEST EXISTS. Money on an order is read through its shape: a mixed order's cost is the
 * sum of two sides, its commission is earned on part of the revenue, and both are decided by
 * `order_parties`. When a `.select()` names `carrier_amount` but forgets `order_parties`, nothing
 * throws and nothing reads as empty — the order simply reads as a *different* order, and a mixed
 * order's carrier cost disappears from the figures.
 *
 * That has already shipped twice here: once in the finance report projections and once in the
 * dashboard stats, both found by hand long after the fact. A silent wrong number is the worst
 * possible failure for this codebase, so the rule is enforced mechanically instead of remembered.
 *
 * THE RULE: any `.select(...)` naming a money column must also name `order_parties`.
 *
 * It is deliberately blunt. A projection that reads money but not shape is either a bug or a place
 * that should be using a narrower select — both worth a look. Add a field to `EXEMPT_REASONS` with
 * the reason if a case is genuinely fine.
 */
const fs = require('fs');
const path = require('path');

const ROOTS = ['controllers', 'utils'];
const MONEY_FIELDS = ['carrier_amount', 'settle_amount', 'cost_amount', 'owner_profit'];
const SHAPE_FIELD = 'order_parties';

/**
 * Selects that name a money column but legitimately do not need the shape, with the reason.
 * Keyed by the exact projection string so a later edit to that select re-trips the check.
 */
const EXEMPT_REASONS = new Map([
  // The party lock compares leg parties; it never computes an order's money.
  ['order_type lock customer_payment_status carrier_payment_status serial_no',
   'payment-lock preflight — reads statuses, computes no money'],
]);

let pass = 0;
let fail = 0;
const failures = [];

function checkFile(file) {
  const src = fs.readFileSync(file, 'utf8');

  // Every .select('…') / .select("…") in the file, with the line it sits on. Multi-line selects are
  // built by string concatenation in this codebase, so join continuation lines first.
  const flat = src.replace(/'\s*\n\s*\+\s*'/g, '');
  const lines = flat.split('\n');

  lines.forEach((line, i) => {
    // Backticks included: a projection that interpolates ORDER_SHAPE_FIELDS is a template literal,
    // and a checker blind to those would pass every file it had just "fixed".
    const m = line.match(/\.select\(\s*(['"`])([^'"`]*)\1/);
    if (!m) return;
    const projection = m[2];
    if (!projection.trim()) return;

    // Only ORDER projections. A leg carries `settle_amount` and `carrier_amount` too, and has no
    // `order_parties` at all. Walk UPWARD to the nearest model call rather than using a fixed
    // window: these are chained builders, and a query with four `.populate()` lines between the
    // model and its `.select()` is normal — a 4-line window silently missed the finance reports,
    // which are exactly the projections this test was written for.
    let model = null;
    for (let j = i; j >= 0 && j > i - 40; j--) {
      const q = lines[j].match(/\b([A-Z][A-Za-z0-9_]*)\s*\.\s*(?:find|findOne|findById|aggregate|countDocuments)\s*\(/);
      if (q) { model = q[1]; break; }
    }
    if (model !== 'Order' && model !== 'OrderModel') return;

    const money = MONEY_FIELDS.filter((f) => new RegExp(`\\b${f}\\b`).test(projection));
    if (!money.length) return;

    // An exclusion projection ("-field") is not pulling money.
    if (projection.trim().startsWith('-')) return;

    pass++;
    // Either the field is named outright, or the shared constant is interpolated — that constant
    // IS the field list, so a select carrying it cannot be missing the shape.
    if (new RegExp(`\\b${SHAPE_FIELD}\\b`).test(projection)) return;
    if (projection.includes('${ORDER_SHAPE_FIELDS}')) return;
    if (EXEMPT_REASONS.has(projection.trim())) return;

    pass--;
    fail++;
    failures.push({
      file: path.relative(path.join(__dirname, '..'), file),
      line: i + 1,
      money: money.join(', '),
      projection: projection.length > 150 ? `${projection.slice(0, 150)}…` : projection,
    });
  });
}

function walk(dir) {
  fs.readdirSync(dir, { withFileTypes: true }).forEach((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return walk(full);
    if (e.isFile() && e.name.endsWith('.js')) checkFile(full);
  });
}

console.log('\norder projections: money implies shape\n');
ROOTS.forEach((r) => {
  const dir = path.join(__dirname, '..', r);
  if (fs.existsSync(dir)) walk(dir);
});

if (!fail) {
  console.log(`  ok   ${pass} money projection(s) all carry ${SHAPE_FIELD}`);
} else {
  failures.forEach((f) => {
    console.log(`  FAIL ${f.file}:${f.line}`);
    console.log(`         selects ${f.money} but not ${SHAPE_FIELD}`);
    console.log(`         ${f.projection}`);
  });
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail) {
  console.log(`A mixed order read through one of these is missing its carrier cost.`);
  console.log(`Add ${SHAPE_FIELD} to the projection, or record the reason in EXEMPT_REASONS.\n`);
}
process.exit(fail ? 1 : 0);
