const mongoose = require('mongoose');

const ownerOperatorSchema = new mongoose.Schema(
  {
    tenantId: {
      type: String,
      required: true,
      index: true,
    },
    company: { type: mongoose.Schema.Types.ObjectId, ref: 'companies' },
    ownerOperatorId: {
      type: String,
      required: true,
      trim: true,
    },
    fullName: {
      type: String,
      required: true,
      trim: true,
    },
    companyName: {
      type: String,
      default: '',
      trim: true,
    },
    phone: {
      type: String,
      required: true,
      trim: true,
    },
    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
    },
    address: {
      type: String,
      default: '',
      trim: true,
    },
    country: {
      type: String,
      default: '',
      trim: true,
    },
    state: {
      type: String,
      default: '',
      trim: true,
    },
    city: {
      type: String,
      default: '',
      trim: true,
    },
    zipcode: {
      type: String,
      default: '',
      trim: true,
    },
    status: {
      type: String,
      enum: ['active', 'inactive'],
      default: 'active',
      index: true,
    },
    notes: {
      type: String,
      default: '',
      trim: true,
    },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'users' },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'users' },
    deletedAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

ownerOperatorSchema.index({ tenantId: 1, ownerOperatorId: 1 }, { unique: true });
ownerOperatorSchema.index({ tenantId: 1, email: 1 });
ownerOperatorSchema.index({ tenantId: 1, fullName: 1 });
ownerOperatorSchema.index({ tenantId: 1, createdAt: -1 });

module.exports = mongoose.model('owneroperators', ownerOperatorSchema);
