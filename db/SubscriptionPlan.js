const mongoose = require('mongoose');

const subscriptionPlanSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Plan name is required'],
    trim: true
  },
  slug: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    index: true
  },
  description: {
    type: String,
    required: [true, 'Plan description is required']
  },

  // Add plan limits including max users
  limits: {
    maxUsers: {
      type: Number,
      default: 10,
      min: [0, 'Limit cannot be negative']
    },
    maxOrders: {
      type: Number,
      default: 1000,
      min: [0, 'Limit cannot be negative']
    },
    maxCustomers: {
      type: Number,
      default: 1000,
      min: [0, 'Limit cannot be negative']
    },
    maxCarriers: {
      type: Number,
      default: 500,
      min: [0, 'Limit cannot be negative']
    }
  },
  allowedModules: {
    type: [String],
    enum: ['outsourcing', 'regular'],
    default: ['outsourcing', 'regular']
  },

  // Pricing. Base price is the monthly amount; quarterly/yearly are derived from it
  // (months * monthlyPrice) then reduced by the matching cycle discount percentage.
  monthlyPrice: {
    type: Number,
    default: 0,
    min: [0, 'Price cannot be negative']
  },
  currency: {
    type: String,
    default: 'USD',
    uppercase: true,
    trim: true
  },
  // Percentage off per billing cycle (0-100). monthly usually 0.
  discounts: {
    monthly: { type: Number, default: 0, min: 0, max: 100 },
    quarterly: { type: Number, default: 0, min: 0, max: 100 },
    yearly: { type: Number, default: 0, min: 0, max: 100 }
  },
  features: {
    type: [String],
    required: true,
    default: []
  },
  isActive: {
    type: Boolean,
    default: true,
    index: true
  },
  isPublic: {
    type: Boolean,
    default: false,
    index: true
  },

  metadata: {
    type: Map,
    of: String
  },
  createdAt: {
    type: Date,
    default: Date.now,
    index: true
  },
  updatedAt: {
    type: Date,
    default: Date.now
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'superadmins'
  }
}, {
  toJSON: { virtuals: true },
  toObject: { virtuals: true },
  timestamps: { updatedAt: 'updatedAt' }
});

// Indexes for performance
subscriptionPlanSchema.index({ isActive: 1, isPublic: 1 });

// Pre-save middleware to generate slug
subscriptionPlanSchema.pre('save', function(next) {
  if (!this.slug && this.name) {
    const base = this.name
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
    this.slug = base;
  }
  this.updatedAt = Date.now();
  next();
});

// Static method to find active public plans
subscriptionPlanSchema.statics.findActivePublicPlans = function() {
  return this.find({
    isActive: true,
    isPublic: true
  }).sort({ name: 1 });
};

// Static method to find plan by slug
subscriptionPlanSchema.statics.findBySlug = function(slug) {
  return this.findOne({ slug, isActive: true });
};

// Method to check if plan has feature
subscriptionPlanSchema.methods.hasFeature = function(feature) {
  return this.features.includes(feature);
};

// Method to check if plan has a module or feature permission
subscriptionPlanSchema.methods.hasPermission = function(permission) {
  return (
    (Array.isArray(this.allowedModules) && this.allowedModules.includes(permission)) ||
    (Array.isArray(this.features) && this.features.includes(permission))
  );
};

// Query middleware to only return active plans by default (skip for superadmin operations)
subscriptionPlanSchema.pre(/^find/, function(next) {
  // Don't apply filter if isActive is explicitly set in query or if querying by _id
  if (!this.getQuery().hasOwnProperty('isActive') && !this.getQuery()._id) {
    this.find({ isActive: { $ne: false } });
  }
  next();
});

const SubscriptionPlan = mongoose.model('subscription_plans', subscriptionPlanSchema);
module.exports = SubscriptionPlan;