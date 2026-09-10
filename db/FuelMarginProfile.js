const mongoose = require('mongoose');

/**
 * A reusable set of margin rules — "what we add to the vendor's price".
 *
 * Kept as a saved profile because the vendor sheets arrive daily or weekly, and
 * retyping the margin every time IS the manual work this feature exists to remove.
 *
 * A FLAT rule is expressed in the sheet's OWN unit: 0.05 means five cents a litre on
 * the Flying J sheet (dollars/litre) but five hundredths of a cent on the AVAAL feed
 * (cents/litre). So a profile that contains any flat rule records the `unit` it was
 * written for, and the controller refuses to apply it to a sheet in another unit.
 * A percent-only profile is unit-agnostic and carries unit `any`.
 */

const ruleSchema = new mongoose.Schema({
    // site > product > region > global; among equal specificity the first listed wins
    scope: { type: String, required: true, enum: ['global', 'region', 'product', 'site'] },
    match: { type: String, trim: true, default: '' },   // '' only for a global rule
    mode: { type: String, required: true, enum: ['flat', 'percent'], default: 'flat' },
    direction: { type: String, required: true, enum: ['add', 'subtract'], default: 'add' },
    // Stored as typed, e.g. "0.0500" or "2.5". Parsed to integer micro-units by
    // utils/fuelMargin#normalizeRule, which is the only thing allowed to interpret it.
    value: { type: String, required: true },
    note: { type: String, trim: true },
}, { _id: false });

const schema = new mongoose.Schema({
    tenantId: { type: String, required: true, index: true },
    company: { type: mongoose.Schema.Types.ObjectId, ref: 'companies' },

    name: { type: String, required: [true, 'Please name this margin profile.'], trim: true },

    // Optional narrowing. A profile left open applies to any sheet whose unit matches.
    vendor: { type: String, default: null },
    unit: { type: String, required: true, enum: ['per_litre', 'cents_per_litre', 'per_gallon', 'any'] },

    // One upload can produce a different sheet per customer.
    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'customers', default: null },

    rules: { type: [ruleSchema], validate: [(v) => v && v.length > 0, 'A margin profile needs at least one rule.'] },

    // 'recompute' rebuilds each tax column from the row's own effective rate, so the
    // published total adds up. 'preserve' keeps the vendor's tax figures as printed.
    taxMode: { type: String, enum: ['recompute', 'preserve'], default: 'recompute' },
    roundingDp: { type: Number, default: null, min: 0, max: 6 },   // null = follow the sheet

    // Whether the published sheet shows what the vendor charged us next to what we
    // charge. Off by default: a customer copy should not carry our cost.
    showVendorCost: { type: Boolean, default: false },

    notes: { type: String, trim: true },

    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date },
    deletedAt: { type: Date },
    created_by: { type: mongoose.Schema.Types.ObjectId, ref: 'users' },
    updated_by: { type: mongoose.Schema.Types.ObjectId, ref: 'users' },
});

schema.index({ tenantId: 1, name: 1 });
schema.index({ tenantId: 1, customer: 1 });

const FuelMarginProfile = mongoose.model('fuel_margin_profiles', schema);
module.exports = FuelMarginProfile;
