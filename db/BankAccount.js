const mongoose = require('mongoose');
const { NUDGE_MAX_MM } = require('../utils/chequeHtml');

// The account a cheque is drawn on. A cheque book belongs to a bank account,
// not to the company — its pre-printed numbers run per account, which is why
// cheque numbering and uniqueness are scoped to this record.
const schema = new mongoose.Schema({
    tenantId: { type: String, required: true, index: true },
    company: { type: mongoose.Schema.Types.ObjectId, ref: 'companies' },
    // Label the operator picks from: "RBC Operating", "TD Payroll".
    name: { type: String, required: [true, 'Please enter an account name.'], trim: true },
    bankName: { type: String, trim: true, default: '' },
    accountNo: { type: String, trim: true, default: '' },
    currency: { type: String, enum: ['USD', 'CAD', 'INR', ''], default: '' },
    // Where this account's cheque book starts; the counter is seeded from it.
    chequeStart: { type: Number, default: 1001, min: 1 },

    // ---- How this account's cheque book is printed -------------------------
    //
    // 'blank'      — plain paper. We draw the whole document ourselves. A
    //                record of the payment, never a negotiable instrument.
    // 'preprinted' — the bank's own stock. The bank name, logo, security
    //                pattern, signature line, MICR line and the cheque number
    //                are ALREADY on the paper; we print only the variable
    //                fields into the empty boxes. We never draw any of the
    //                pre-printed marks — that is the bank's paper, not ours.
    printMode: { type: String, enum: ['blank', 'preprinted'], default: 'blank' },

    // Which band of the sheet carries the cheque itself. Laser cheque stock
    // comes in exactly these three: cheque on top / middle / bottom, with the
    // remaining bands as remittance stubs.
    chequePosition: { type: String, enum: ['top', 'middle', 'bottom'], default: 'top' },
    // Height of the cheque band. CPA 006 caps a business cheque at 3.75in;
    // 3.5in is the common laser stock.
    chequeHeightIn: { type: Number, default: 3.5, min: 2.75, max: 3.75 },

    // Printer feed drift, in millimetres. Every printer pulls the sheet a
    // fraction differently, and cheque stock is numbered — a misfed sheet is a
    // void cheque. The alignment sheet finds these; they are never guessed.
    offsetXmm: { type: Number, default: 0, min: -NUDGE_MAX_MM, max: NUDGE_MAX_MM },
    offsetYmm: { type: Number, default: 0, min: -NUDGE_MAX_MM, max: NUDGE_MAX_MM },

    // Pre-printed stock already carries its number; printing ours on top of it
    // would put two different numbers on one cheque.
    printChequeNumber: { type: Boolean, default: false },

    // Which date order this stock's guidance boxes expect. CPA 006 §6 permits
    // exactly these three and forbids slashes and two-digit years, so it is a
    // choice between valid forms rather than a free format string. The wrong
    // one puts the digits in the wrong boxes.
    dateFormat: { type: String, enum: ['YYYYMMDD', 'MMDDYYYY', 'DDMMYYYY'], default: 'YYYYMMDD' },

    // Sparse per-field position overrides, merged over the CPA-derived defaults
    // in utils/chequeHtml.js. The amount fields are spec-mandated so they rarely
    // move; the date and payee positions are the ones CPA 006 leaves flexible,
    // and are what a particular stock is most likely to disagree with.
    // Defaults live ONLY in the renderer — two copies would drift.
    layoutOverrides: { type: mongoose.Schema.Types.Mixed, default: null },
    active: { type: Boolean, default: true },
    notes: { type: String, trim: true, default: '' },
    createdAt: { type: Date, default: Date.now },
    deletedAt: { type: Date },
    created_by: { type: mongoose.Schema.Types.ObjectId, ref: 'users' },
});

schema.index({ tenantId: 1, name: 1 });

// Where the cheque band sits on the sheet, in inches from the sheet's top.
// Everything else is measured from the band's own edges, which is how CPA 006
// specifies a cheque — so the same numbers hold wherever the band is.
schema.methods.chequeBandTopIn = function (sheetHeightIn = 11) {
    const h = Number(this.chequeHeightIn) || 3.5;
    if (this.chequePosition === 'bottom') return Math.max(sheetHeightIn - h, 0);
    if (this.chequePosition === 'middle') return Math.max((sheetHeightIn - h) / 2, 0);
    return 0;
};

// The print settings a renderer needs, with every default resolved — so the
// renderer never has to know what a missing field means.
schema.methods.printSpec = function () {
    return {
        printMode: this.printMode || 'blank',
        chequePosition: this.chequePosition || 'top',
        chequeHeightIn: Number(this.chequeHeightIn) || 3.5,
        bandTopIn: this.chequeBandTopIn(),
        // Clamped on read as well: a value stored before the limit was
        // tightened must not push the amount off the paper.
        offsetXmm: Math.max(-NUDGE_MAX_MM, Math.min(NUDGE_MAX_MM, Number(this.offsetXmm) || 0)),
        offsetYmm: Math.max(-NUDGE_MAX_MM, Math.min(NUDGE_MAX_MM, Number(this.offsetYmm) || 0)),
        printChequeNumber: !!this.printChequeNumber,
        dateFormat: this.dateFormat || 'YYYYMMDD',
        // The renderer needs the account's own currency to decide whether a
        // cheque needs a currency designation (CPA 006 §11).
        currency: this.currency || '',
        label: this.printedLabel(),
    };
};

// The label printed on the cheque and stored as the `fromAccount` snapshot.
schema.methods.printedLabel = function () {
    const last4 = String(this.accountNo || '').replace(/[^0-9]/g, '').slice(-4);
    return [this.name, last4 ? `••${last4}` : ''].filter(Boolean).join(' ');
};

const BankAccount = mongoose.model('bank_accounts', schema);
module.exports = BankAccount;
