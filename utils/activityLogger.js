const ActivityLog = require('../db/ActivityLog');

/**
 * Log an activity for a tenant.
 *
 * @param {Object} req        - Express request (used to extract user, IP, UA)
 * @param {Object} options
 * @param {string} options.action      - 'CREATE' | 'UPDATE' | 'DELETE' | 'STATUS_CHANGE' | 'LOGIN' | 'LOGOUT' | 'PAYMENT' | 'UPLOAD' | 'EXPORT' | 'OTHER'
 * @param {string} options.module      - 'order' | 'customer' | 'carrier' | 'employee' | 'company' | 'payment' | 'file' | 'auth' | 'settings'
 * @param {string} options.description - Human-readable description of the action
 * @param {string} [options.resourceId]   - ID of the affected resource
 * @param {string} [options.resourceName] - Name/label of the affected resource
 * @param {Object} [options.details]      - Any extra metadata (changed fields, old/new values, etc.)
 * @param {string} [options.tenantId]     - Override tenantId (falls back to req.tenantId)
 */
async function logActivity(req, { action, module, description, resourceId, resourceName, details }) {
  try {
    const tenantId = req?.tenantId || req?.user?.tenantId;
    if (!tenantId) return; // Never log without a tenant context

    const user = req?.user;
    const ipAddress =
      req?.headers?.['x-forwarded-for']?.split(',')[0]?.trim() ||
      req?.connection?.remoteAddress ||
      req?.socket?.remoteAddress ||
      '';
    const userAgent = req?.headers?.['user-agent'] || '';

    await ActivityLog.create({
      tenantId,
      userId: user?._id || user?.id || null,
      userName: user?.name || 'System',
      userEmail: user?.email || '',
      userRole: user?.role ?? null,
      action,
      module,
      description,
      resourceId: resourceId ? String(resourceId) : null,
      resourceName: resourceName || '',
      details: details || {},
      ipAddress,
      userAgent,
    });
  } catch (err) {
    // Never let logging failures break the main flow
    console.error('[ActivityLogger] Failed to write log:', err.message);
  }
}

module.exports = { logActivity };