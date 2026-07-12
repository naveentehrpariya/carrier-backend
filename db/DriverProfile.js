const mongoose = require('mongoose');
const validator = require('validator');

const driverProfileSchema = new mongoose.Schema({
  tenantId: { 
    type: String, 
    required: true, 
    index: true,
  },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'users', required: true, index: true },
  emails: [{
    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      validate: [validator.isEmail, 'Please provide a valid email address.'],
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
  phones: [{
    phone: {
      type: String,
      required: true,
      trim: true
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
  // Currency the three rates below are entered/stored in. Chosen once at driver creation and
  // LOCKED thereafter — trips snapshot `rate_per_mile` from these rates, so letting it change
  // would silently reinterpret every historic trip snapshot. Legacy rows have no value: they
  // were always USD, hence the default.
  rateCurrency: { type: String, enum: ['USD', 'CAD', 'INR'], default: 'USD' },
  ratePerMile: { type: Number, default: 0 },
  ratePerMileSolo: { type: Number, default: 0 },
  ratePerMileTeam: { type: Number, default: 0 },
  cityHoursRate: { type: Number, default: 0 },
  licenseNumber: { type: String },
  licenseState: { type: String },
  licenseIssueDate: { type: Date },
  licenseExpiry: { type: Date },
  notes: { type: String },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'users' },
  createdAt: { type: Date, default: Date.now },
  deletedAt: { type: Date, default: null }
}, {
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

driverProfileSchema.index({ tenantId: 1, user: 1 }, { unique: true });

const DriverProfile = mongoose.model('driver_profiles', driverProfileSchema);
module.exports = DriverProfile;
