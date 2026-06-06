const mongoose = require('mongoose');

const ownerOperatorFxRateSchema = new mongoose.Schema(
  {
    tenantId: { type: String, required: true, index: true },
    month: { type: Number, required: true, min: 1, max: 12, index: true },
    year: { type: Number, required: true, min: 2000, max: 9999, index: true },
    sourceCurrency: { type: String, required: true, uppercase: true, trim: true },
    targetCurrency: { type: String, required: true, uppercase: true, trim: true, index: true },
    rate: { type: Number, required: true, min: 0 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'users' },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'users' },
  },
  { timestamps: true }
);

ownerOperatorFxRateSchema.index(
  { tenantId: 1, year: 1, month: 1, sourceCurrency: 1, targetCurrency: 1 },
  { unique: true }
);

module.exports = mongoose.model('owneroperatorfxrates', ownerOperatorFxRateSchema);
