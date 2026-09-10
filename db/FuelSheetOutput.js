const mongoose = require('mongoose');

/**
 * A published, branded price sheet — what actually went out to a customer.
 *
 * This is a SNAPSHOT, not a view. The rows, the rules that produced them, the
 * vendor's own figures and the branding are all copied in at publish time, so
 * re-rendering the document a month later reproduces exactly what the customer was
 * sent even after the margin profile has been edited or the vendor sheet archived.
 * Same reason a payslip snapshots its rates.
 *
 * Published sheets are never edited. A correction is a NEW version that supersedes
 * the old one, and the old one keeps its numbers.
 */

const rowSchema = new mongoose.Schema({
    rowNo: { type: Number, required: true },
    text: { type: mongoose.Schema.Types.Mixed, default: {} },
    // integer micro-units of `unit`
    baseInt: { type: Number },        // what the vendor charged (kept for audit even when not printed)
    marginInt: { type: Number },      // the margin actually applied, after rounding
    finalInt: { type: Number },       // what the customer pays
    taxes: { type: Map, of: Number, default: {} },
    totalInt: { type: Number },
    ruleIndex: { type: Number },
    rule: { type: mongoose.Schema.Types.Mixed },   // the rule as it read at publish time
}, { _id: false });

const schema = new mongoose.Schema({
    tenantId: { type: String, required: true, index: true },
    company: { type: mongoose.Schema.Types.ObjectId, ref: 'companies' },

    sheet: { type: mongoose.Schema.Types.ObjectId, ref: 'fuel_price_sheets', required: true },
    profile: { type: mongoose.Schema.Types.ObjectId, ref: 'fuel_margin_profiles', default: null },
    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'customers', default: null },

    title: { type: String, trim: true },
    version: { type: Number, default: 1 },

    vendor: { type: String, required: true },
    vendorLabel: { type: String },
    unit: { type: String, required: true },
    currency: { type: String, required: true },
    dp: { type: Number, required: true },
    effectiveDate: { type: String },     // bare YYYY-MM-DD, as on the vendor sheet
    effectiveTo: { type: String },

    // what was rendered, and how
    columns: { type: mongoose.Schema.Types.Mixed, default: [] },
    baseColumn: { type: String },
    taxColumns: { type: [String], default: [] },
    totalColumn: { type: String, default: null },
    showVendorCost: { type: Boolean, default: false },
    profileSnapshot: { type: mongoose.Schema.Types.Mixed, default: {} },
    brandingSnapshot: { type: mongoose.Schema.Types.Mixed, default: {} },
    rows: { type: [rowSchema], default: [] },
    totals: { type: mongoose.Schema.Types.Mixed, default: {} },

    file: {
        name: { type: String },
        url: { type: String },
        size: { type: Number },
    },

    status: { type: String, enum: ['published', 'superseded'], default: 'published' },
    supersededBy: { type: mongoose.Schema.Types.ObjectId, ref: 'fuel_sheet_outputs', default: null },

    publishedAt: { type: Date, default: Date.now },
    createdAt: { type: Date, default: Date.now },
    deletedAt: { type: Date },
    created_by: { type: mongoose.Schema.Types.ObjectId, ref: 'users' },
}, { minimize: false });

schema.index({ tenantId: 1, publishedAt: -1 });
schema.index({ tenantId: 1, sheet: 1, version: -1 });
schema.index({ tenantId: 1, customer: 1, publishedAt: -1 });

const FuelSheetOutput = mongoose.model('fuel_sheet_outputs', schema);
module.exports = FuelSheetOutput;
