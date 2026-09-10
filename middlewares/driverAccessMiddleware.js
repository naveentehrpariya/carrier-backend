const catchAsync = require('../utils/catchAsync');

// Creating or editing a driver is a payroll write, not a contact-book edit: the profile carries
// the per-mile rates every trip snapshots, the pay currency that is locked for good at creation,
// and the HST registration that decides whether the payslip charges tax. These routes used to run
// on `validateToken + resolveTenant` alone, with no check in the controller either — so any
// authenticated tenant user could rewrite any driver's record, and a driver could POST their own
// id with a higher rate (or `taxEnabled` + a 100% tax rate) and inflate their next payslip.
//
// The gate deliberately stays wide. `/drivers` is reached with the `regular` module and AddOrder
// quick-adds a driver mid-order, so dispatchers create drivers as part of their normal work;
// narrowing this to HR would break that. What it excludes is the case that was actually dangerous:
// a plain driver (or anyone holding no staff permission at all) writing driver records.
const DRIVER_WRITE_PERMISSIONS = ['employees', 'subadmin', 'accounting', 'regular', 'outsourcing'];

// Editing your OWN driver record is the escalation this gate exists for — the fields on it decide
// what you are paid. Only HR-level roles may do it (an admin correcting their own record is a
// legitimate, and audited, act).
const SELF_EDIT_PERMISSIONS = ['employees', 'subadmin'];

const isAdminLevel = (user) =>
  Number(user?.is_admin) === 1 || Number(user?.role) === 3 || user?.isTenantAdmin === true;

const permsOf = (user) => (Array.isArray(user?.permissions) ? user.permissions : []);

const canWriteDrivers = (user) => {
  if (!user) return false;
  if (isAdminLevel(user)) return true;
  const perms = permsOf(user);
  return DRIVER_WRITE_PERMISSIONS.some((p) => perms.includes(p));
};

const canEditOwnDriverRecord = (user) => {
  if (!user) return false;
  if (isAdminLevel(user)) return true;
  const perms = permsOf(user);
  return SELF_EDIT_PERMISSIONS.some((p) => perms.includes(p));
};

const requireDriverWriteAccess = catchAsync(async (req, res, next) => {
  const tenantId = req.tenantId || req.user?.tenantId;
  if (!tenantId) {
    return res.status(400).json({ status: false, message: 'Tenant context is required.' });
  }
  if (!canWriteDrivers(req.user)) {
    return res.status(403).json({
      status: false,
      code: 'driver_write_denied',
      message: 'You are not allowed to add or edit drivers.',
    });
  }

  // A driver record names a user in the URL. Rewriting your own pay rates or tax registration is
  // an escalation no matter which permission got you through the check above.
  const targetId = req.params?.id;
  if (targetId && String(targetId) === String(req.user?._id) && !canEditOwnDriverRecord(req.user)) {
    return res.status(403).json({
      status: false,
      code: 'driver_self_edit_denied',
      message: 'You can not edit your own driver record. Ask an administrator.',
    });
  }
  next();
});

module.exports = { requireDriverWriteAccess, canWriteDrivers, canEditOwnDriverRecord };
