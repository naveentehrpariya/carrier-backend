const mongoose = require('mongoose');

// The measured distance of one empty move (the truck driving from where one load ended to where
// the next began). Persisted because the move is now PAID: Google returns a slightly different
// route call-to-call, and re-measuring on every read would move a driver's pay — and the owner's
// deduction — each time the payslip was regenerated. Same rule as a saved leg: measured once,
// re-measured only when its endpoints change.
const emptyMoveMilesSchema = new mongoose.Schema({
  tenantId: { type: String, required: true, index: true },
  after_trip: { type: mongoose.Schema.Types.ObjectId, ref: 'trips', required: true },
  before_trip: { type: mongoose.Schema.Types.ObjectId, ref: 'trips', required: true },
  from_location: { type: String, default: '' },
  to_location: { type: String, default: '' },
  miles: { type: Number, default: null },
  measuredAt: { type: Date, default: Date.now },
});

emptyMoveMilesSchema.index({ tenantId: 1, after_trip: 1, before_trip: 1 }, { unique: true });

module.exports = mongoose.model('empty_move_miles', emptyMoveMilesSchema);
