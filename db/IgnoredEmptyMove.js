const mongoose = require('mongoose');

const ignoredEmptyMoveSchema = new mongoose.Schema({
    tenantId: { type: String, required: true, index: true },
    truck: { type: mongoose.Schema.Types.ObjectId, ref: 'trucks' },
    driver: { type: mongoose.Schema.Types.ObjectId, ref: 'users' },
    after_trip: { type: mongoose.Schema.Types.ObjectId, ref: 'trips', required: true },
    before_trip: { type: mongoose.Schema.Types.ObjectId, ref: 'trips', required: true },
    createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('ignored_empty_moves', ignoredEmptyMoveSchema);
