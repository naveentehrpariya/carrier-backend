const catchAsync = require('../utils/catchAsync');

// Stub controller — billing endpoints pending implementation
const notImplemented = catchAsync(async (req, res) => {
  res.status(501).json({ status: false, message: 'Not implemented yet' });
});

module.exports = {
  getBillingOverview: notImplemented,
  getInvoices: notImplemented,
  getSubscriptions: notImplemented,
  updateSubscription: notImplemented,
  sendInvoice: notImplemented,
};
