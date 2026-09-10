const mongoose = require('mongoose');

/**
 * One uploaded vendor fuel price sheet, as parsed.
 *
 * The parsed rows are embedded rather than kept in their own collection: a sheet is
 * always read whole (to price it, to preview it, to render it) and the biggest real
 * vendor file is 350 rows, so there is nothing to gain from a second round trip.
 *
 * MONEY IS STORED AS INTEGER MICRO-UNITS of the sheet's own unit (1e-6), exactly as
 * utils/fuelParsers produces it. `unit` and `currency` travel with the sheet and are
 * never rewritten — a price whose unit can change silently is the same class of bug
 * as an order amount whose currency can.
 */

const valueSchema = new mongoose.Schema({
    // integer micro-units; `dp` is how many decimals the vendor printed
    int: { type: Number, required: true },
    dp: { type: Number, required: true },
}, { _id: false });

const rowSchema = new mongoose.Schema({
    rowNo: { type: Number, required: true },
    page: { type: Number },
    sourceRow: { type: Number },        // spreadsheet row, when the source was XLSX
    text: { type: mongoose.Schema.Types.Mixed, default: {} },   // site name, region, product, ...
    money: { type: Map, of: valueSchema, default: {} },
    // Row-level notes from the parser. `severity: 'info'` (e.g. the vendor's own
    // penny rounding) is reported but never blocks publishing.
    flags: [{
        code: { type: String },
        message: { type: String },
        severity: { type: String },
    }],
    rawLine: { type: String },          // what the source actually said, kept for audit
}, { _id: false });

const schema = new mongoose.Schema({
    tenantId: { type: String, required: true, index: true },
    company: { type: mongoose.Schema.Types.ObjectId, ref: 'companies' },

    vendor: { type: String, required: true },        // parser id, e.g. 'flying_j_cad'
    vendorLabel: { type: String, required: true },

    // How to read every number on this sheet. NULL until confirmed on a sheet whose
    // layout this app does not know — see `generic` below.
    unit: { type: String, default: null, enum: ['per_litre', 'cents_per_litre', 'per_gallon', null] },
    currency: { type: String, default: null, enum: ['CAD', 'USD', 'INR', null] },
    dp: { type: Number, default: null },

    // Which column a margin applies to, and how to render the rest.
    baseColumn: { type: String, default: null },

    // A sheet read by the generic table reader: its columns were worked out from the
    // file, not from a template, so nothing about it is trusted until a person
    // confirms which column is the price and what unit it is in. `mappingRequired`
    // blocks publishing until then.
    generic: { type: Boolean, default: false },
    mappingRequired: { type: Boolean, default: false },
    mappedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'users', default: null },
    mappedAt: { type: Date, default: null },
    columns: [{
        key: { type: String, required: true },
        label: { type: String, required: true },
        kind: { type: String, enum: ['text', 'money'], required: true },
        role: { type: String, default: 'info' },     // base | tax | total | reference | info
    }],

    // Calendar dates, stored as bare YYYY-MM-DD. Never a Date: timezone maths on a
    // printed effective date is how a sheet dated the 9th gets filed on the 8th.
    effectiveDate: { type: String },
    effectiveTo: { type: String },

    sheetName: { type: String },      // XLSX worksheet actually read
    sheetIndex: { type: Number },
    availableSheets: [{
        index: { type: Number },
        name: { type: String },
        effectiveDate: { type: String },
    }],

    meta: { type: mongoose.Schema.Types.Mixed, default: {} },   // vendor banner, notices, product line
    rows: { type: [rowSchema], default: [] },
    stats: { type: mongoose.Schema.Types.Mixed, default: {} },

    // Everything the parser wanted to say. `unparsed` MUST be empty before a sheet
    // can be published — a line that looked like data and did not become a row means
    // a site is missing from the sheet the client sends out.
    warnings: [{
        code: { type: String },
        message: { type: String },
        context: { type: mongoose.Schema.Types.Mixed },
    }],
    unparsed: [{
        text: { type: String },
        context: { type: mongoose.Schema.Types.Mixed },
    }],

    sourceFile: {
        name: { type: String },
        url: { type: String },
        size: { type: Number },
        mime: { type: String },
    },

    status: { type: String, enum: ['parsed', 'archived'], default: 'parsed' },

    createdAt: { type: Date, default: Date.now },
    deletedAt: { type: Date },
    created_by: { type: mongoose.Schema.Types.ObjectId, ref: 'users' },
}, { minimize: false });

schema.index({ tenantId: 1, createdAt: -1 });
schema.index({ tenantId: 1, vendor: 1, effectiveDate: -1 });

const FuelPriceSheet = mongoose.model('fuel_price_sheets', schema);
module.exports = FuelPriceSheet;
