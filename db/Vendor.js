const mongoose = require('mongoose');

const schema = new mongoose.Schema({
    tenantId: { type: String, required: true, index: true },
    company: { type: mongoose.Schema.Types.ObjectId, ref: 'companies' },
    // V1000, V1001, ... minted from the per-tenant counter at create time.
    code: { type: String, required: true },
    name: {
        type: String,
        required: [true, 'Please enter vendor name.'],
        trim: true,
    },
    phone: { type: String, trim: true },
    email: { type: String, trim: true, lowercase: true },
    emails: [{
        email: { type: String, required: true, trim: true, lowercase: true },
        is_primary: { type: Boolean, default: false },
        created_at: { type: Date, default: Date.now },
    }],
    // Address prints on the cheque under the payee name.
    address: { type: String, trim: true },
    city: { type: String, trim: true },
    state: { type: String, trim: true },
    country: { type: String, trim: true },
    zipcode: { type: String, trim: true },
    notes: { type: String, trim: true },
    createdAt: { type: Date, default: Date.now },
    deletedAt: { type: Date },
    created_by: { type: mongoose.Schema.Types.ObjectId, ref: 'users' },
});

schema.index({ tenantId: 1, code: 1 }, { unique: true });
schema.index({ tenantId: 1, createdAt: -1 });

const Vendor = mongoose.model('vendors', schema);
module.exports = Vendor;
