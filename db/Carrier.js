const mongoose = require('mongoose');
const schema = new mongoose.Schema({
    tenantId: { 
        type: String, 
        required: true, 
        index: true,
    },
    company: { type: mongoose.Schema.Types.ObjectId, ref: 'companies' },
    name: {
        type: String,
        required: [true, 'Please enter Carrier Name.'],
    },
    mc_code: {
        type: String,
        required: [true, 'Please enter MC code.'],
    },
    phone: {
        type: String,
        required: [true, 'Please enter carrier contact number.'],
    },
    email: {
        type: String,
        required: [true, 'Please enter carrier email address.'],
    },
    secondary_phone: {
        type: String,
    },
    secondary_email: {
        type: String,
    },
    emails: [{
        email: {
            type: String,
            required: true,
            trim: true,
            lowercase: true,
        },
        is_primary: {
            type: Boolean,
            default: false
        },
        created_at: {
            type: Date,
            default: Date.now
        }
    }],
    country: {
        type: String,
        required: [true, 'Please enter carrier country.'],
    },
    state: {
        type: String,
        required: [true, 'Please enter carrier state.'],
    },
    city: {
        type: String,
        required: [true, 'Please enter carrier city.'],
    },
    zipcode: {
        type: String,
        required: [true, 'Please enter carrier zipcode.'],
    },
    location: {
        type: String,
        required: [true, 'Please enter carrier location.'],
    },
    carrierID: {
        type: String
    },
    createdAt: {
       type: Date,
       default: Date.now
   },
   deletedAt: {type: Date},
   created_by: { type: mongoose.Schema.Types.ObjectId, ref: 'users' },
},{
    toJSON: { virtuals: true },
    toObject: { virtuals: true }
});

// Compound indexes for multi-tenant performance
// Email/carrierID unique per company (not per tenant) — same email allowed in
// different companies; carrier listings are company-scoped.
schema.index({ tenantId: 1, company: 1, email: 1 }, { unique: true });
schema.index({ tenantId: 1, company: 1, carrierID: 1 }, { unique: true });
schema.index({ tenantId: 1, mc_code: 1 });
schema.index({ tenantId: 1, createdAt: -1 });

const Carrier = mongoose.model('carriers', schema);
module.exports = Carrier;
