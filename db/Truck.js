const mongoose = require('mongoose');

const truckSchema = new mongoose.Schema({
  tenantId: { 
    type: String, 
    required: true, 
    index: true,
  },
  company: { type: mongoose.Schema.Types.ObjectId, ref: 'companies' },
  plateNumber: { type: String, required: true },
  unitNumber: { type: String },
  make: { type: String },
  model: { type: String },
  year: { type: Number },
  vin: { type: String },
  capacity: { type: String },
  notes: { type: String },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'users' },
  createdAt: { type: Date, default: Date.now },
  deletedAt: { type: Date, default: null }
}, {
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

truckSchema.index({ tenantId: 1, plateNumber: 1 }, { unique: true });
truckSchema.index({ tenantId: 1, vin: 1 });
truckSchema.index({ tenantId: 1, createdAt: -1 });

const Truck = mongoose.model('trucks', truckSchema);
module.exports = Truck;
