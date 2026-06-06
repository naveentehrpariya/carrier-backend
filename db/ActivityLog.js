const mongoose = require('mongoose');

const activityLogSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    index: true,
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'users',
    index: true,
  },
  userName: {
    type: String,
    default: 'System',
  },
  userEmail: {
    type: String,
    default: '',
  },
  userRole: {
    type: Number,
    default: null,
  },
  // Action type: CREATE, UPDATE, DELETE, STATUS_CHANGE, LOGIN, LOGOUT, PAYMENT, UPLOAD, EXPORT
  action: {
    type: String,
    required: true,
    enum: ['CREATE', 'UPDATE', 'DELETE', 'STATUS_CHANGE', 'LOGIN', 'LOGOUT', 'PAYMENT', 'UPLOAD', 'EXPORT', 'OTHER'],
    index: true,
  },
  // Module: order, customer, carrier, employee, company, payment, file, auth, settings
  module: {
    type: String,
    required: true,
    index: true,
  },
  resourceId: {
    type: String,
    default: null,
  },
  resourceName: {
    type: String,
    default: '',
  },
  description: {
    type: String,
    required: true,
  },
  // Stores changed fields: { field: { old, new } } or any relevant metadata
  details: {
    type: mongoose.Schema.Types.Mixed,
    default: {},
  },
  ipAddress: {
    type: String,
    default: '',
  },
  userAgent: {
    type: String,
    default: '',
  },
}, {
  timestamps: { createdAt: 'createdAt', updatedAt: false },
});

// Compound indexes for fast tenant-scoped queries
activityLogSchema.index({ tenantId: 1, createdAt: -1 });
activityLogSchema.index({ tenantId: 1, module: 1, createdAt: -1 });
activityLogSchema.index({ tenantId: 1, action: 1, createdAt: -1 });
activityLogSchema.index({ tenantId: 1, userId: 1, createdAt: -1 });

// Auto-expire logs after 1 year (optional, remove if you want permanent logs)
// activityLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 31536000 });

module.exports = mongoose.model('ActivityLog', activityLogSchema);