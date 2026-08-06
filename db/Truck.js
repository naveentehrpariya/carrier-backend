const mongoose = require('mongoose');

const truckSchema = new mongoose.Schema({
  tenantId: { 
    type: String, 
    required: true, 
    index: true,
  },
  company: { type: mongoose.Schema.Types.ObjectId, ref: 'companies' },
  plateNumber: { type: String, required: true },
  truckNumber: { type: String },
  unitNumber: { type: String },
  make: { type: String },
  model: { type: String },
  year: { type: Number },
  vin: { type: String },
  capacity: { type: String },
  ownerOperated: { type: Boolean, default: false, index: true },
  ownerOperator: { type: mongoose.Schema.Types.ObjectId, ref: 'owneroperators', default: null },
  ownerOperatorAssignedAt: { type: Date, default: null },
  notes: { type: String },
  // Fixed monthly expenses auto-added each month
  insuranceMonthly: { type: Number, default: 0 },
  parkingMonthly: { type: Number, default: 0 },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'users' },
  createdAt: { type: Date, default: Date.now },
  deletedAt: { type: Date, default: null }
}, {
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// Unique only among live trucks — a soft-deleted truck must not block re-adding the same plate.
truckSchema.index(
  { tenantId: 1, plateNumber: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } }
);
truckSchema.index({ tenantId: 1, vin: 1 });
truckSchema.index({ tenantId: 1, createdAt: -1 });
truckSchema.index({ tenantId: 1, ownerOperator: 1 });

truckSchema.pre('validate', function (next) {
  if (!this.ownerOperated) {
    this.ownerOperator = null;
    this.ownerOperatorAssignedAt = null;
    return next();
  }

  if (this.ownerOperated && this.ownerOperator && !this.ownerOperatorAssignedAt) {
    this.ownerOperatorAssignedAt = new Date();
  }
  next();
});

const Truck = mongoose.model('trucks', truckSchema);
module.exports = Truck;
