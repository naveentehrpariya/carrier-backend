const catchAsync = require('../utils/catchAsync');

// Stub controller — analytics endpoints pending implementation
const notImplemented = catchAsync(async (req, res) => {
  res.status(501).json({ status: false, message: 'Not implemented yet' });
});

module.exports = {
  getPlatformOverview: notImplemented,
  getTenantsAnalytics: notImplemented,
  getRevenueAnalytics: notImplemented,
  getUsageAnalytics: notImplemented,
  getGrowthAnalytics: notImplemented,
};
