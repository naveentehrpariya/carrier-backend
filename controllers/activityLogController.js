const ActivityLog = require('../db/ActivityLog');
const catchAsync = require('../utils/catchAsync');

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * GET /api/tenant-admin/activity-logs
 * Query params:
 *   page, limit, module, action, userId, search, startDate, endDate
 */
exports.getActivityLogs = catchAsync(async (req, res) => {
  const tenantId = req.tenantId || req.user?.tenantId;
  if (!tenantId) {
    return res.status(400).json({ status: false, message: 'Tenant context required.' });
  }

  const {
    page = 1,
    limit = 20,
    module,
    action,
    userId,
    search,
    startDate,
    endDate,
  } = req.query;

  const filter = { tenantId };

  if (module) filter.module = module;
  if (action) filter.action = action;
  if (userId) filter.userId = userId;

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
    filter.$or = [
      { description: { $regex: safeSearch, $options: 'i' } },
      { userName: { $regex: safeSearch, $options: 'i' } },
      { resourceName: { $regex: safeSearch, $options: 'i' } },
      { userEmail: { $regex: safeSearch, $options: 'i' } },
    ];
  }

  const pageNum = Math.max(1, parseInt(page));
  const limitNum = Math.min(100, Math.max(1, parseInt(limit)));
  const skip = (pageNum - 1) * limitNum;

  const [logs, total] = await Promise.all([
    ActivityLog.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limitNum)
      .lean(),
    ActivityLog.countDocuments(filter),
  ]);

  return res.status(200).json({
    status: true,
    data: logs,
    meta: {
      total,
      page: pageNum,
      limit: limitNum,
      totalPages: Math.ceil(total / limitNum),
    },
  });
});

/**
 * GET /api/tenant-admin/activity-logs/summary
 * Returns counts per module and action for dashboard widgets
 */
exports.getActivitySummary = catchAsync(async (req, res) => {
  const tenantId = req.tenantId || req.user?.tenantId;
  if (!tenantId) {
    return res.status(400).json({ status: false, message: 'Tenant context required.' });
  }

  const { days = 30 } = req.query;
  const since = new Date();
  since.setDate(since.getDate() - parseInt(days));

  const [byModule, byAction, recentUsers] = await Promise.all([
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
  ]);

  return res.status(200).json({
    status: true,
    data: { byModule, byAction, recentUsers },
  });
});

/**
 * GET /api/tenant-admin/activity-logs/users
 * Returns distinct users who have activity logs (for filter dropdown)
 */
exports.getLogUsers = catchAsync(async (req, res) => {
  const tenantId = req.tenantId || req.user?.tenantId;
  if (!tenantId) {
    return res.status(400).json({ status: false, message: 'Tenant context required.' });
  }

  const users = await ActivityLog.aggregate([
    { $match: { tenantId, userId: { $ne: null } } },
    { $group: { _id: '$userId', name: { $first: '$userName' }, email: { $first: '$userEmail' } } },
    { $sort: { name: 1 } },
  ]);

  return res.status(200).json({ status: true, data: users });
});