const mongoose = require('mongoose');

const PAYEE_TYPES = ['vendor', 'carrier', 'customer', 'driver', 'truck_owner', 'employee'];

// Standalone cheque register. Deliberately NOT reconciled with carrier payment
// status / payslip paidAmount — a cheque records what was printed and handed
// over; payroll keeps its own books (scoped decision, v1).
const schema = new mongoose.Schema({
    tenantId: { type: String, required: true, index: true },
    company: { type: mongoose.Schema.Types.ObjectId, ref: 'companies' },

    payeeType: { type: String, enum: PAYEE_TYPES, required: true },
    payeeId: { type: mongoose.Schema.Types.ObjectId, required: true },
    // Snapshot at create time — the printed cheque must not change when the
    // payee record is later edited or deleted.
    payeeName: { type: String, required: true, trim: true },
    payeeAddress: { type: String, trim: true, default: '' },

    // The account the cheque is drawn on. Optional — legacy cheques and
    // tenants who never set accounts up keep working; `fromAccount` below is
    // the printed snapshot label either way.
    bankAccount: { type: mongoose.Schema.Types.ObjectId, ref: 'bank_accounts', default: null },

    // Auto-minted (per bank account when one is chosen, else per tenant), but
    // editable — physical cheque books carry pre-printed numbers.
    chequeNo: { type: String, required: true, trim: true },
    referenceNo: { type: String, trim: true, default: '' },

    // Advance period the payment covers (optional, like the reference app).
    periodFrom: { type: Date },
    periodTo: { type: Date },

    country: { type: String, trim: true, default: '' },
    state: { type: String, trim: true, default: '' },
    note: { type: String, trim: true, default: '' },
    fromAccount: { type: String, trim: true, default: '' },

    currency: { type: String, enum: ['USD', 'CAD', 'INR'], default: 'CAD' },
    amount: { type: Number, required: true, min: [0.01, 'Amount must be greater than zero.'] },
    // Snapshot of the printed words line — recomputed on edit while still 'issued'.
    amountInWords: { type: String, default: '' },

    paymentMethod: { type: String, default: 'cheque' },
    paymentDate: { type: Date, default: Date.now },

    // Void, never delete — a printed cheque that vanishes is an audit hole.
    // Lifecycle: issued -> printed -> cleared (the bank honoured it) or
    // bounced (it came back). cleared/bounced only ever follow printed.
    status: { type: String, enum: ['issued', 'printed', 'void', 'cleared', 'bounced'], default: 'issued' },
    printedAt: { type: Date },
    voidedAt: { type: Date },
    voidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'users' },
    voidReason: { type: String, trim: true },
    clearedAt: { type: Date },
    clearedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'users' },
    bouncedAt: { type: Date },
    bouncedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'users' },
    bounceReason: { type: String, trim: true },

    createdAt: { type: Date, default: Date.now },
    deletedAt: { type: Date },
    created_by: { type: mongoose.Schema.Types.ObjectId, ref: 'users' },
});

// Unique PER ACCOUNT, not per tenant: two cheque books from two banks
// legitimately carry the same pre-printed numbers. Legacy cheques (no account)
// all share bankAccount:null and stay unique among themselves.
schema.index({ tenantId: 1, bankAccount: 1, chequeNo: 1 }, { unique: true });
schema.index({ tenantId: 1, payeeType: 1, payeeId: 1 });
schema.index({ tenantId: 1, paymentDate: -1 });

const PaymentCheque = mongoose.model('payment_cheques', schema);
PaymentCheque.PAYEE_TYPES = PAYEE_TYPES;
module.exports = PaymentCheque;
