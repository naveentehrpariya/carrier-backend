const mongoose = require('mongoose');

// One row per order the driver ran in the period — snapshot of that order's contribution.
const driverOrderBreakdownSchema = new mongoose.Schema(
  {
    order: { type: mongoose.Schema.Types.ObjectId, ref: 'orders', required: true },
    serial_no: { type: Number, default: null },
    trips: { type: Number, default: 0 },
    miles: { type: Number, default: 0 },          // this driver's share, real miles
    km: { type: Number, default: 0 },
    rateType: { type: String, enum: ['solo', 'team', 'mixed', 'none'], default: 'none' },
    rateUsed: { type: Number, default: 0 },        // USD/mile applied
    pay: { type: Number, default: 0 },             // converted to currency
    originalPay: { type: Number, default: 0 },     // USD
    fxRate: { type: Number, default: 1 },
  },
  { _id: false }
);

const driverSalarySchema = new mongoose.Schema(
  {
    tenantId: { type: String, required: true, index: true },
    company: { type: mongoose.Schema.Types.ObjectId, ref: 'companies' },
    driver: { type: mongoose.Schema.Types.ObjectId, ref: 'users', required: true, index: true },
    month: { type: Number, required: true, min: 1, max: 12, index: true },
    year: { type: Number, required: true, min: 2000, max: 9999, index: true },
    currency: { type: String, default: 'USD' },

    // Rate snapshot (USD)
    soloRate: { type: Number, default: 0 },
    teamRate: { type: Number, default: 0 },
    cityRate: { type: Number, default: 0 },

    // Totals (in `currency`)
    totalTrips: { type: Number, default: 0 },
    totalMiles: { type: Number, default: 0 },
    totalKm: { type: Number, default: 0 },
    tripPay: { type: Number, default: 0 },         // converted
    cityHours: { type: Number, default: 0 },
    cityPay: { type: Number, default: 0 },         // converted
    deductionTotal: { type: Number, default: 0 },  // per-date DriverDeduction 'deduct' rows, converted
    additionTotal: { type: Number, default: 0 },   // per-date DriverDeduction 'add' (non-city) rows, converted

    // Lifecycle (parity with owner)
    basePayable: { type: Number, default: 0 },     // tripPay + cityPay - deductionTotal
    previousDueAdded: { type: Number, default: 0 },
    manualDeduction: { type: Number, default: 0 },
    manualAddition: { type: Number, default: 0 },
    finalPayable: { type: Number, default: 0 },
    paidAmount: { type: Number, default: 0 },
    dueAmount: { type: Number, default: 0 },
    paymentStatus: { type: String, enum: ['pending', 'partial', 'paid'], default: 'pending', index: true },

    orderBreakdown: [driverOrderBreakdownSchema],
    generatedAt: { type: Date, default: Date.now },
    generatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'users' },
    notes: { type: String, default: '' },
  },
  { timestamps: true }
);

driverSalarySchema.index({ tenantId: 1, driver: 1, month: 1, year: 1 }, { unique: true });
driverSalarySchema.index({ tenantId: 1, month: 1, year: 1 });

module.exports = mongoose.model('driversalaries', driverSalarySchema);
