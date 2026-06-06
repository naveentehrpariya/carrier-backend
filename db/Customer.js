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
        required: [true, 'Please enter customer name.'],
    },
    customerCode: {
        type: String,
    },
    secondary_phone: {
        type: String,
    },
    phone: {
        type: String,
        required: [true, 'Please enter customer contact number.'],
    },
    email: {
        type: String,
        unique: true,
        required: [true, 'Please enter customer email address.'],
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
    address: {
        type: String,
        required: [true, 'Please enter customer address.'],
    },
    country: {
        type: String,
        required: [true, 'Please enter customer country.'],
    },
    state: {
        type: String,
        required: [true, 'Please enter customer state.'],
    },
    city: {
        type: String,
        required: [true, 'Please enter customer city.'],
    },
    
    zipcode: {
        type: String,
        required: [true, 'Please enter customer zipcode.'],
    },
    createdAt: {
       type: Date,
       default: Date.now
   },
   deletedAt: {type: Date},
   created_by: { type: mongoose.Schema.Types.ObjectId, ref: 'users' },
   assigned_to: { type: mongoose.Schema.Types.ObjectId, ref: 'users' },
},{
    toJSON: { virtuals: true },
    toObject: { virtuals: true }
});

// Compound indexes for multi-tenant performance
schema.index({ tenantId: 1, email: 1 }, { unique: true });
schema.index({ tenantId: 1, customerCode: 1 });
schema.index({ tenantId: 1, createdAt: -1 });

const Customer = mongoose.model('customers', schema);
module.exports = Customer;
