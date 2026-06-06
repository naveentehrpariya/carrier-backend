const mongoose = require('mongoose');

const emptyMoveNoteSchema = new mongoose.Schema({
    tenantId: { type: String, required: true, index: true },
    truck: { type: mongoose.Schema.Types.ObjectId, ref: 'trucks' },
    driver: { type: mongoose.Schema.Types.ObjectId, ref: 'users' },
    after_trip: { type: mongoose.Schema.Types.ObjectId, ref: 'trips', required: true },
    before_trip: { type: mongoose.Schema.Types.ObjectId, ref: 'trips', required: true },
    note: { type: String, default: '' },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('empty_move_notes', emptyMoveNoteSchema);
