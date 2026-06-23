const mongoose = require('mongoose');
const validator = require('validator');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const Company = require('./Company');

const schema = new mongoose.Schema({
    tenantId: { 
        type: String, 
        required: true, 
        index: true,
    },
    company: { type: mongoose.Schema.Types.ObjectId, ref: 'companies' },
    name: {
        type: String,
        required: [true, 'Please enter your name.'],
    },
    email: {
        type: String,
        required: [true, 'Please enter your email address.'],
        lowercase: true,
        validate: [validator.isEmail, 'Please provide a valid email address.'],
        // NOTE: No global unique — multi-tenant: uniqueness is enforced by
        // the compound index { tenantId, email } defined below
    },
    avatar: {type: String},
    status: {
        type: String,
        default: "active",
        index: true 
    },
    staff_commision: {
        type: Number,
    },
    corporateID: { 
        type: String,
        required: [true, 'Corporate ID can not be empty.'],
        unique: true,
        index: true 
    },
    position : { 
        type: String,
    },
    is_admin: {
        type: Number,
        default:0
    },
    isSuper: {
        type: String,
        default:0
    },
    created_by: { type: mongoose.Schema.Types.ObjectId, ref: 'users' },
    password: {
        type: String,
        required: [true, 'Please enter your password.'],
        select: false
    },
    // confirmPassword: {
    //     type: String,
    //     required: true,
    //     required: [true, 'Please re-enter your password.'],
    //     select: false,
    //     validate: {
    //         validator: function (val) { return val === this.password },
    //         message: "Passwords did't matched."
    //     }
    // },
    

    // additonal fields
    phone: {
        type:String,
        required:[true, 'Please enter your phone number.'],
    },
    country: {
        type:String,
        required:[true, 'Please enter your country.'],
    },
    address: {
        type:String,
        required:[true, 'Please enter your address.'],
    },
    state: {
        type:String,
        default: '',
    },
    city: {
        type:String,
        default: '',
    },
    zipcode: {
        type:String,
        default: '',
    },

    permissions: {
        type: [String],
        default: []
    },
    allowedModules: {
        type: [String],
        enum: ['outsourcing', 'regular'],
        default: []
    },
    modulesCustomized: {
        type: Boolean,
        default: false
    },

    createdAt: {
        type: Date,
        default: Date.now   // function reference, not invocation — called per-document
    },
    changedPasswordAt: Date,
    passwordResetToken: String,
    resetTokenExpire: Date,
    deletedAt: {
        type: Date
    },

},{
    toJSON: { virtuals: true },
    toObject: { virtuals: true }
});

 

schema.pre('save', async function (next) {
    if (!this.isModified('password')) return next();
    this.password = await bcrypt.hash(this.password, 12);
    this.confirmPassword = undefined;
});

schema.pre(/^find/, function (next) {
    const opts = (this.getOptions && this.getOptions()) || this.options || {};
    if (opts.includeInactive === true) return next();
    this.where({ status: 'active', $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }] });
    next();
});

schema.methods.checkPassword = async function (pass, hash) {
    return await bcrypt.compare(pass, hash);
}

schema.methods.createPasswordResetToken = async function () {
    const token = crypto.randomBytes(32).toString('hex');
    this.passwordResetToken = crypto.createHash('sha256').update(token).digest('hex');
    this.resetTokenExpire = Date.now() + 10 * 60 * 1000;
    return token;
}

// schema.virtual('company').get(async function () {
//     const companydetails = await Company.findById(this.company_id);
//     return companydetails;
// });

// Static method for consistent active user filtering
schema.statics.activeFilter = function(tenantId, extra = {}) {
    return {
        tenantId,
        status: 'active',
        $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
        ...extra
    };
};

// Compound indexes for multi-tenant performance
schema.index({ tenantId: 1, email: 1 }, { unique: true });
schema.index({ tenantId: 1, corporateID: 1 }, { unique: true });
schema.index({ tenantId: 1, role: 1 });
schema.index({ tenantId: 1, status: 1 });
schema.index({ tenantId: 1, status: 1, deletedAt: 1 });


const User = mongoose.model('users', schema);
module.exports = User;
