/**
 * Seed/refresh the catalog of subscription plans (Starter / Professional / Enterprise).
 * Replaces the old dummy plans. Idempotent: upserts by slug, so re-running updates prices/limits
 * without creating duplicates. Tenants already on a plan keep their snapshot until they renew.
 *
 * USAGE:
 *   node scripts/seed-subscription-plans.js            # DRY RUN (prints what it would write)
 *   node scripts/seed-subscription-plans.js --apply    # upsert plans
 *   node scripts/seed-subscription-plans.js --apply --deactivate-others  # also hide any other plans
 *
 * Pricing: monthlyPrice + per-cycle discount%. quarterly = 3*monthly*(1-q%), yearly = 12*monthly*(1-y%).
 */
require('dotenv').config();
const connectDB = require('../db/config');
const SubscriptionPlan = require('../db/SubscriptionPlan');
const { priceMatrix } = require('../utils/subscription');

const PLANS = [
  {
    name: 'Starter',
    slug: 'starter',
    description: 'For small teams getting started with fleet or carrier operations.',
    monthlyPrice: 49,
    currency: 'USD',
    discounts: { monthly: 0, quarterly: 5, yearly: 15 },
    limits: { maxUsers: 5, maxOrders: 200, maxCustomers: 100, maxCarriers: 50 },
    allowedModules: ['outsourcing', 'regular'],
    features: ['Order management', 'Customer management', 'Basic reporting', 'Email support'],
    isActive: true,
    isPublic: true
  },
  {
    name: 'Professional',
    slug: 'professional',
    description: 'For growing companies that need more volume and advanced reporting.',
    monthlyPrice: 99,
    currency: 'USD',
    discounts: { monthly: 0, quarterly: 5, yearly: 15 },
    limits: { maxUsers: 20, maxOrders: 1000, maxCustomers: 500, maxCarriers: 250 },
    allowedModules: ['outsourcing', 'regular'],
    features: ['Everything in Starter', 'Advanced analytics', 'Carrier management', 'Custom reports', 'Priority support'],
    isActive: true,
    isPublic: true
  },
  {
    name: 'Enterprise',
    slug: 'enterprise',
    description: 'Unlimited scale with dedicated support for large operations.',
    monthlyPrice: 249,
    currency: 'USD',
    discounts: { monthly: 0, quarterly: 10, yearly: 20 },
    // 0 == unlimited (per planLimitsMiddleware convention)
    limits: { maxUsers: 100, maxOrders: 0, maxCustomers: 0, maxCarriers: 0 },
    allowedModules: ['outsourcing', 'regular'],
    features: ['Everything in Professional', 'Unlimited orders', 'Advanced integrations', 'Custom branding', 'Dedicated support', 'SLA guarantee'],
    isActive: true,
    isPublic: true
  }
];

async function run() {
  const apply = process.argv.includes('--apply');
  const deactivateOthers = process.argv.includes('--deactivate-others');
  await connectDB();
  console.log('Connected to MongoDB');
  console.log(apply ? '\n🔧 APPLY MODE\n' : '\n🔍 DRY RUN (use --apply to write)\n');

  for (const plan of PLANS) {
    const prices = priceMatrix(plan).map((p) => `${p.cycle}:$${p.price}`).join('  ');
    console.log(`• ${plan.name} ($${plan.monthlyPrice}/mo)  ${prices}`);
    console.log(`    limits users=${plan.limits.maxUsers} orders=${plan.limits.maxOrders || '∞'} customers=${plan.limits.maxCustomers || '∞'} carriers=${plan.limits.maxCarriers || '∞'}`);
    if (apply) {
      await SubscriptionPlan.findOneAndUpdate(
        { slug: plan.slug },
        { $set: plan },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
    }
  }

  if (apply && deactivateOthers) {
    const keep = PLANS.map((p) => p.slug);
    const res = await SubscriptionPlan.updateMany(
      { slug: { $nin: keep }, isActive: { $ne: false } },
      { $set: { isActive: false } }
    );
    console.log(`\nDeactivated ${res.modifiedCount} other plan(s).`);
  }

  console.log(apply ? '\n✅ Plans seeded.' : '\nRun with --apply to write. Add --deactivate-others to hide old dummy plans.');
  process.exit(0);
}

run().catch((e) => { console.error('Seed failed:', e); process.exit(1); });
