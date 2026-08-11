const ActivityLog = require('../db/ActivityLog');
const AuditChainState = require('../db/AuditChainState');
const catchAsync = require('../utils/catchAsync');
const { computeHash, logActivity } = require('../utils/activityLogger');

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Who may read the audit trail.
 *
 * The trail contains every user's actions, amounts and approximate locations, so
 * it is not general staff reading. Accounting and sub-admins need it because they
 * are the ones reconciling reports against it.
 */
function hasAuditAccess(req) {
  const u = req.user || {};
  const perms = Array.isArray(u.permissions) ? u.permissions : [];
  return (
    u.is_admin === 1 ||
    Number(u.role) === 3 ||
    u.isTenantAdmin === true ||
    perms.includes('subadmin') ||
    perms.includes('accounting')
  );
}

function requireAudit(req, res) {
  const tenantId = req.tenantId || req.user?.tenantId;
  if (!tenantId) {
    res.status(400).json({ status: false, message: 'Tenant context required.' });
    return null;
  }
  if (!hasAuditAccess(req)) {
    res.status(403).json({ status: false, message: 'You are not allowed to view the audit trail.' });
    return null;
  }
  return tenantId;
}

/** Shared filter builder so the list, the CSV export and the counts never drift. */
function buildLogFilter(tenantId, query) {
  const {
    module, action, userId, search, startDate, endDate,
    critical, changedField, resourceId, source,
  } = query;

  const filter = { tenantId };

  if (module) filter.module = module;
  if (action) filter.action = action;
  if (userId) filter.userId = userId;
  if (resourceId) filter.resourceId = String(resourceId);
  if (source) filter.source = source;
  // Only the money-rewriting subset (FX edits, rate changes, edits after payment).
  if (critical === 'true' || critical === true) filter.critical = true;
  // "Show me everything that ever touched settle_amount."
  if (changedField) filter.changedFields = changedField;

  if (startDate || endDate) {
    filter.createdAt = {};
    if (startDate) filter.createdAt.$gte = new Date(startDate);
    if (endDate) {
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
      filter.createdAt.$lte = end;
    }
  }

  if (search) {
    const safeSearch = escapeRegex(search);
    // Pushed onto $and, not assigned to $or — an assignment would clobber any
    // other $or the filter grows later.
    filter.$and = [{
      $or: [
        { description: { $regex: safeSearch, $options: 'i' } },
        { userName: { $regex: safeSearch, $options: 'i' } },
        { resourceName: { $regex: safeSearch, $options: 'i' } },
        { userEmail: { $regex: safeSearch, $options: 'i' } },
        { changedFields: { $regex: safeSearch, $options: 'i' } },
      ],
    }];
  }

  return filter;
}

/**
 * GET /api/tenant-admin/activity-logs
 * Query: page, limit, module, action, userId, search, startDate, endDate,
 *        critical, changedField, resourceId, source
 */
exports.getActivityLogs = catchAsync(async (req, res) => {
  const tenantId = requireAudit(req, res);
  if (!tenantId) return;

  const filter = buildLogFilter(tenantId, req.query);

  const pageNum = Math.max(1, parseInt(req.query.page || 1));
  const limitNum = Math.min(100, Math.max(1, parseInt(req.query.limit || 20)));
  const skip = (pageNum - 1) * limitNum;

  const [logs, total, criticalCount] = await Promise.all([
    ActivityLog.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limitNum).lean(),
    ActivityLog.countDocuments(filter),
    ActivityLog.countDocuments({ ...filter, critical: true }),
  ]);

  return res.status(200).json({
    status: true,
    data: logs,
    meta: {
      total,
      criticalCount,
      page: pageNum,
      limit: limitNum,
      totalPages: Math.ceil(total / limitNum),
    },
  });
});

/**
 * GET /api/tenant-admin/activity-logs/resource/:module/:id
 * Everything that ever happened to one record, oldest first.
 *
 * This is the endpoint that makes a disputed number answerable: open the order,
 * the payslip or the driver and read its whole history in order.
 */
exports.getResourceHistory = catchAsync(async (req, res) => {
  const tenantId = requireAudit(req, res);
  if (!tenantId) return;

  const { module, id } = req.params;
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit || 200)));

  const logs = await ActivityLog.find({ tenantId, module, resourceId: String(id) })
    .sort({ createdAt: 1 })
    .limit(limit)
    .lean();

  return res.status(200).json({
    status: true,
    data: logs,
    meta: { module, resourceId: String(id), count: logs.length },
  });
});

/**
 * GET /api/tenant-admin/activity-logs/verify
 * Walk the tenant's hash chain and report the first break.
 *
 * Two independent failures are detected:
 *   - a gap in `seq`  -> an entry was deleted
 *   - a hash mismatch -> an entry's content was altered, or the one before it was
 *
 * Entries written before the chain existed are counted as `legacy`, not as
 * tampering — see scripts/migrate-activity-log-hash-chain.js.
 */
exports.verifyActivityChain = catchAsync(async (req, res) => {
  const tenantId = requireAudit(req, res);
  if (!tenantId) return;

  const state = await AuditChainState.findOne({ tenantId }).lean();
  const genesisSeq = state?.genesisSeq ?? 1;

  // Streamed, not loaded. The whole point of this collection is that it grows
  // without bound, and `before`/`after` payloads make each row non-trivial —
  // materialising every entry to check it would be the one query that takes the
  // app down. The { tenantId, seq } index makes this an ordered index walk.
  // The select must carry every field chainPayload() hashes, or verification
  // would compare against a different document than the one that was signed.
  const cursor = ActivityLog.find({ tenantId, seq: { $ne: null } })
    .sort({ seq: 1 })
    .select('seq prevHash hash chainStatus createdAt tenantId userId userName userEmail onBehalfOf action module model resourceId resourceName description changedFields before after details critical ipAddress location source')
    .lean()
    .cursor();

  // Cap what is RETAINED, not what is counted: a badly broken chain could
  // otherwise build an unbounded array while streaming.
  const MAX_REPORTED_PROBLEMS = 200;
  const problems = [];
  let problemCount = 0;
  const reportProblem = (p) => {
    problemCount += 1;
    if (problems.length < MAX_REPORTED_PROBLEMS) problems.push(p);
  };
  let totalEntries = 0;
  let verified = 0;
  let legacy = 0;
  let expectedPrevHash = '';
  let expectedSeq = null;

  for (let entry = await cursor.next(); entry != null; entry = await cursor.next()) {
    totalEntries += 1;
    if (expectedSeq !== null && entry.seq !== expectedSeq) {
      reportProblem({
        type: 'gap',
        expectedSeq,
        foundSeq: entry.seq,
        missing: entry.seq - expectedSeq,
        at: entry.createdAt,
        message: `${entry.seq - expectedSeq} entr${entry.seq - expectedSeq === 1 ? 'y is' : 'ies are'} missing before #${entry.seq}.`,
      });
    }
    expectedSeq = entry.seq + 1;

    if (entry.chainStatus === 'legacy' || entry.seq < genesisSeq) {
      legacy += 1;
      expectedPrevHash = entry.hash || '';
      continue;
    }

    const recomputed = computeHash(entry);
    if (recomputed !== entry.hash) {
      reportProblem({
        type: 'content_altered',
        seq: entry.seq,
        at: entry.createdAt,
        by: entry.userName,
        message: `Entry #${entry.seq} does not match its own hash — its content was changed after it was written.`,
      });
    } else if (entry.prevHash !== expectedPrevHash) {
      reportProblem({
        type: 'link_broken',
        seq: entry.seq,
        at: entry.createdAt,
        message: `Entry #${entry.seq} does not link to the entry before it — something was removed or reordered.`,
      });
    } else {
      verified += 1;
    }

    expectedPrevHash = entry.hash || '';
  }

  const unchained = await ActivityLog.countDocuments({ tenantId, chainStatus: 'unchained' });

  return res.status(200).json({
    status: true,
    data: {
      intact: problemCount === 0,
      totalEntries,
      verified,
      legacy,
      // Written when the chain head could not be reserved. Not tampering, but
      // these entries are not covered by the proof either.
      unchained,
      problems: problems.slice(0, 50),
      problemCount,
      checkedAt: new Date(),
    },
  });
});

/**
 * GET /api/tenant-admin/activity-logs/export
 * Server-side CSV over the same filter as the list — the client-side export only
 * ever saw the current page.
 */
exports.exportActivityLogs = catchAsync(async (req, res) => {
  const tenantId = requireAudit(req, res);
  if (!tenantId) return;

  const filter = buildLogFilter(tenantId, req.query);
  const limit = Math.min(50000, Math.max(1, parseInt(req.query.limit || 10000)));

  const logs = await ActivityLog.find(filter).sort({ createdAt: -1 }).limit(limit).lean();

  const cell = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    // Leading =, +, - or @ makes a spreadsheet treat the cell as a formula.
    const guarded = /^[=+\-@]/.test(s) ? `'${s}` : s;
    return `"${guarded.replace(/"/g, '""')}"`;
  };

  const header = [
    'seq', 'timestamp', 'user', 'email', 'onBehalfOf', 'action', 'module',
    'resource', 'description', 'changedFields', 'before', 'after',
    'critical', 'ip', 'location', 'locationApprox', 'chainStatus',
  ];

  const rows = logs.map((l) => [
    l.seq, l.createdAt?.toISOString?.() || l.createdAt,
    l.userName, l.userEmail,
    l.onBehalfOf?.userName ? `${l.onBehalfOf.userName} (${l.onBehalfOf.type})` : '',
    l.action, l.module,
    l.resourceName || l.resourceId || '',
    l.description,
    (l.changedFields || []).join('; '),
    l.before ? JSON.stringify(l.before) : '',
    l.after ? JSON.stringify(l.after) : '',
    l.critical ? 'yes' : '',
    l.ipAddress,
    l.location?.label || '',
    l.location?.label ? 'approximate' : '',
    l.chainStatus,
  ].map(cell).join(','));

  const csv = [header.map(cell).join(','), ...rows].join('\n');

  logActivityExport(req, tenantId, logs.length);

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="activity-logs-${Date.now()}.csv"`);
  // BOM so Excel reads UTF-8 names correctly.
  return res.status(200).send(`﻿${csv}`);
});

/** Exporting the trail is itself an auditable act. */
function logActivityExport(req, tenantId, count) {
  logActivity(req, {
    action: 'EXPORT',
    module: 'audit',
    tenantId,
    description: `Exported ${count} audit log entr${count === 1 ? 'y' : 'ies'} as CSV`,
    details: { count, filters: req.query },
  });
}

/**
 * GET /api/tenant-admin/activity-logs/summary
 * Counts per module and action for the dashboard widgets.
 */
exports.getActivitySummary = catchAsync(async (req, res) => {
  const tenantId = requireAudit(req, res);
  if (!tenantId) return;

  const { days = 30 } = req.query;
  const since = new Date();
  since.setDate(since.getDate() - parseInt(days));

  const [byModule, byAction, recentUsers, criticalRecent] = await Promise.all([
    ActivityLog.aggregate([
      { $match: { tenantId, createdAt: { $gte: since } } },
      { $group: { _id: '$module', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]),
    ActivityLog.aggregate([
      { $match: { tenantId, createdAt: { $gte: since } } },
      { $group: { _id: '$action', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]),
    ActivityLog.aggregate([
      { $match: { tenantId, createdAt: { $gte: since } } },
      { $group: { _id: { userId: '$userId', userName: '$userName', userEmail: '$userEmail' }, count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 5 },
    ]),
    ActivityLog.find({ tenantId, critical: true, createdAt: { $gte: since } })
      .sort({ createdAt: -1 })
      .limit(10)
      .select('createdAt userName action module description changedFields resourceName resourceId')
      .lean(),
  ]);

  return res.status(200).json({
    status: true,
    data: { byModule, byAction, recentUsers, criticalRecent },
  });
});

/**
 * GET /api/tenant-admin/activity-logs/users
 * Distinct users who have activity, for the filter dropdown.
 */
exports.getLogUsers = catchAsync(async (req, res) => {
  const tenantId = requireAudit(req, res);
  if (!tenantId) return;

  const users = await ActivityLog.aggregate([
    { $match: { tenantId, userId: { $ne: null } } },
    { $group: { _id: '$userId', name: { $first: '$userName' }, email: { $first: '$userEmail' } } },
    { $sort: { name: 1 } },
  ]);

  return res.status(200).json({ status: true, data: users });
});
