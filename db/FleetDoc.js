const mongoose = require('mongoose');

const fleetDocSchema = new mongoose.Schema({
  tenantId: { 
    type: String, 
    required: true, 
    index: true,
  },
  type: { type: String, enum: ['truck', 'trailer'], required: true, index: true },
  entityId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  name: { type: String },
  mime: { type: String },
  size: { type: String },
  filename: { type: String },
  url: { type: String },
  added_by: { type: mongoose.Schema.Types.ObjectId, ref: 'users' },
  createdAt: { type: Date, default: Date.now },
  deletedAt: { type: Date, default: null }
});

fleetDocSchema.index({ tenantId: 1, type: 1, entityId: 1, createdAt: -1 });

const FleetDoc = mongoose.model('fleet_docs', fleetDocSchema);
module.exports = FleetDoc;

