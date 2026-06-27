/**
 * Re-sync every tenant ADMIN's module permissions + allowedModules from the tenant's PLAN.
 *
 * Why: tenants created by the old super-admin `createTenant` got BOTH modules
 * (regular + outsourcing) hardcoded, plus were missing `role: 3` / `isTenantAdmin`.
 * That let an admin manage modules its plan never included. This brings existing
 * admins in line with the plan-driven rule now enforced at runtime.
 *
 * USAGE:
 *   node scripts/migrate-resync-admin-modules-from-plan.js          # DRY RUN (no writes)
 *   node scripts/migrate-resync-admin-modules-from-plan.js --apply  # backup, then migrate
 *
 * Rules (per tenant, for each admin user — is_admin===1 OR role===3):
 *   - planModules = tenant.subscription.allowedModules, else the plan doc's allowedModules,
 *     else BOTH (backward-compat: an unconfigured plan is treated as full access).
 *   - Module perms follow the plan:
 *       regular     present  ⇢ keep/add 'regular'              ; absent ⇢ remove 'regular'
 *       outsourcing present  ⇢ keep/add 'outsourcing','carriers','carriers_write'
 *                    absent  ⇢ remove those three
 *   - Feature perms (accounting, customers, customers_write, employees, subadmin, invoices, …)
 *     are PRESERVED untouched.
 *   - allowedModules is set to planModules.
 *   - Ensure role:3 and isTenantAdmin:true (so tenant-admin auth gate passes).
 * Idempotent — admins already in sync are left unchanged.
 */
require('dotenv').config();
const connectDB = require('../db/config');
const User = require('../db/Users');
const Tenant = require('../db/Tenant');
const SubscriptionPlan = require('../db/SubscriptionPlan');
const { backupCollections } = require('./_backupHelper');

const VALID = ['outsourcing', 'regular'];
const OUTSOURCING_PERMS = ['outsourcing', 'carriers', 'carriers_write'];

const clean = (arr) =>
  (Array.isArray(arr) ? arr : []).map((m) => String(m).toLowerCase().trim()).filter((m) => VALID.includes(m));

async function resolvePlanModules(tenant) {
  const fromTenant = clean(tenant?.subscription?.allowedModules);
  if (fromTenant.length) return fromTenant;

  const planRef = tenant?.subscription?.plan || tenant?.subscription?.planSlug || null;
  if (planRef) {
    let plan = null;
    if (typeof planRef === 'string') plan = await SubscriptionPlan.findOne({ slug: planRef }).lean();
    else plan = await SubscriptionPlan.findById(planRef).lean();
    const mods = clean(plan?.allowedModules);
    if (mods.length) return mods;
  }
  return [...VALID]; // backward-compat: unconfigured plan ⇒ full access
}

// Returns the corrected permissions array given current perms + plan modules.
function syncPerms(perms, planModules) {
  let next = (Array.isArray(perms) ? perms : []).slice();

  // regular
  if (planModules.includes('regular')) {
    if (!next.includes('regular')) next.push('regular');
  } else {
    next = next.filter((p) => p !== 'regular');
  }

  // outsourcing (+ carrier feature perms tied to it)
  if (planModules.includes('outsourcing')) {
    OUTSOURCING_PERMS.forEach((p) => { if (!next.includes(p)) next.push(p); });
  } else {
    next = next.filter((p) => !OUTSOURCING_PERMS.includes(p));
  }

  return next;
}

const sameSet = (a, b) => a.length === b.length && [...a].sort().join('|') === [...b].sort().join('|');

async function migrate() {
  const apply = process.argv.includes('--apply');
  await connectDB();
  console.log('Connected to MongoDB');
  console.log(apply ? '\n🔧 APPLY MODE — will back up then write changes\n'
                    : '\n🔍 DRY RUN — no changes written (use --apply)\n');

  if (apply) {
    console.log('Backing up users (perms/modules/role/isTenantAdmin)...');
    await backupCollections('admin-modules-resync-backup', [
      { collection: 'users', projection: { _id: 1, tenantId: 1, role: 1, is_admin: 1, isTenantAdmin: 1, permissions: 1, allowedModules: 1 } },
    ]);
  }

  const tenants = await Tenant.find({}).lean();
  console.log(`Found ${tenants.length} tenants.\n`);

  const summary = { tenants: 0, adminsUpdated: 0, adminsInSync: 0, noAdmins: 0 };

  for (const tenant of tenants) {
    const planModules = await resolvePlanModules(tenant);
    summary.tenants++;

    const admins = await User.find(
      { tenantId: tenant.tenantId, $or: [{ is_admin: 1 }, { role: 3 }] },
      null,
      { includeInactive: true }
    );

    if (!admins.length) { summary.noAdmins++; continue; }

    for (const admin of admins) {
      const curPerms = Array.isArray(admin.permissions) ? admin.permissions : [];
      const nextPerms = syncPerms(curPerms, planModules);
      const curModules = clean(admin.allowedModules);

      const needPerms = !sameSet(curPerms, nextPerms);
      const needModules = !sameSet(curModules, planModules);
      const needRole = Number(admin.role) !== 3;
      const needFlag = admin.isTenantAdmin !== true;

      if (!needPerms && !needModules && !needRole && !needFlag) { summary.adminsInSync++; continue; }

      console.log(`  ${apply ? 'FIX ' : '[DRY] '}${admin.email || admin._id}  tenant=${tenant.tenantId}  plan=[${planModules.join(', ')}]`);
      if (needPerms)   console.log(`        perms:   [${curPerms.join(', ')}] -> [${nextPerms.join(', ')}]`);
      if (needModules) console.log(`        modules: [${curModules.join(', ')}] -> [${planModules.join(', ')}]`);
      if (needRole)    console.log(`        role -> 3`);
      if (needFlag)    console.log(`        isTenantAdmin -> true`);

      if (apply) {
        admin.permissions = nextPerms;
        admin.allowedModules = planModules;
        admin.role = 3;
        admin.isTenantAdmin = true;
        await admin.save();
      }
      summary.adminsUpdated++;
    }
  }

  console.log('\n— Summary —');
  console.log(`Tenants processed : ${summary.tenants}`);
  console.log(`Tenants w/o admin : ${summary.noAdmins}`);
  console.log(`Admins updated    : ${summary.adminsUpdated}${apply ? '' : ' (dry run)'}`);
  console.log(`Admins in sync    : ${summary.adminsInSync}`);
  if (!apply) console.log('\nRun again with --apply to write these changes.');

  process.exit(0);
}

migrate().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
