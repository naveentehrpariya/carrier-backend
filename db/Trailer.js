const mongoose = require('mongoose');

const trailerSchema = new mongoose.Schema({
  tenantId: { 
    type: String, 
    required: true, 
    index: true,
  },
  company: { type: mongoose.Schema.Types.ObjectId, ref: 'companies' },
  plateNumber: { type: String, required: true },
  unitNumber: { type: String },
  vin: { type: String },
  licenseNumber: { type: String },
  type: { type: String },
  length: { type: Number },
  make: { type: String },
  model: { type: String },
  ratePerMile: { type: Number, default: 0 },
  notes: { type: String },
  isActive: { type: Boolean, default: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'users' },
  createdAt: { type: Date, default: Date.now },
  deletedAt: { type: Date, default: null }
}, {
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

trailerSchema.index({ tenantId: 1, plateNumber: 1 }, { unique: true });
trailerSchema.index({ tenantId: 1, type: 1 });
trailerSchema.index({ tenantId: 1, createdAt: -1 });

const Trailer = mongoose.model('trailers', trailerSchema);
module.exports = Trailer;
