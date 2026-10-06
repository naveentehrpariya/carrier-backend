/**
 * Tenant-wide reports, analytics, finance and exports list EVERY order, customer and
 * carrier in the tenant. They were gated only in the frontend (Overview calls analytics
 * "when admin", /finance is a RoleBasedRoute) — the API answered any logged-in employee.
 * Privileged audience only: admin / role=3 / tenant admin / sub-admin / accounting.
 */
const { hasTenantReportAccess } = require('../utils/orderVisibility');

function requireTenantReportAccess(req, res, next) {
  if (hasTenantReportAccess(req)) return next();
  return res.status(403).json({
    status: false,
    forbidden: true,
    message: "You don't have permission to view company-wide reports.",
  });
}

module.exports = { requireTenantReportAccess };
