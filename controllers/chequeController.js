const catchAsync = require('../utils/catchAsync');
const logger = require('../utils/logger');
const { ORDER_SHAPE_FIELDS } = require('../utils/orderParty');
const PaymentCheque = require('../db/PaymentCheque');
const Vendor = require('../db/Vendor');
const Carrier = require('../db/Carrier');
const Customer = require('../db/Customer');
const Users = require('../db/Users');
const OwnerOperator = require('../db/OwnerOperator');
const Counter = require('../db/Counter');
const BankAccount = require('../db/BankAccount');
const ChequeApplication = require('../db/ChequeApplication');
const PaymentLogs = require('../db/PaymentLogs');
const Order = require('../db/Order');
const Trip = require('../db/Trip');
const DriverSalary = require('../db/DriverSalary');
const OwnerOperatorSalary = require('../db/OwnerOperatorSalary');
const { logActivity, logChange } = require('../utils/activityLogger');
const {
  buildChequeHtml, buildChequeBatchHtml, amountToWords,
  buildPreprintedSheetsHtml, buildAlignmentSheetHtml,
} = require('../utils/chequeHtml');
const { hasChequeAccess } = require('./vendorController');
const { carrierOrderMatch, rollupCarrierPaymentStatus } = require('../utils/carrierSettlement');

const notDeleted = { $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }] };
const escapeRegex = (s) => String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const joinAddress = (parts) => parts.map((p) => String(p || '').trim()).filter(Boolean);

// One resolver per payee type: how to load the record, its display name, and the
// address block printed under the name on the cheque.
const PAYEE_RESOLVERS = {
  vendor: {
    async find(tenantId) {
      const rows = await Vendor.find({ tenantId, ...notDeleted }).sort({ name: 1 }).lean();
      return rows.map((v) => ({ _id: v._id, name: v.name, sub: v.code, address: addr(v) }));
    },
    async one(tenantId, id) {
      const v = await Vendor.findOne({ _id: id, tenantId, ...notDeleted }).lean();
      return v && { name: v.name, address: addr(v) };
    },
  },
  carrier: {
    async find(tenantId) {
      const rows = await Carrier.find({ tenantId, ...notDeleted }).sort({ name: 1 }).lean();
      return rows.map((c) => ({ _id: c._id, name: c.name, sub: c.mc_code, address: addrCarrier(c) }));
    },
    async one(tenantId, id) {
      const c = await Carrier.findOne({ _id: id, tenantId, ...notDeleted }).lean();
      return c && { name: c.name, address: addrCarrier(c) };
    },
  },
  customer: {
    async find(tenantId) {
      const rows = await Customer.find({ tenantId, ...notDeleted }).sort({ name: 1 }).lean();
      return rows.map((c) => ({ _id: c._id, name: c.name, sub: c.email, address: addr(c) }));
    },
    async one(tenantId, id) {
      const c = await Customer.findOne({ _id: id, tenantId, ...notDeleted }).lean();
      return c && { name: c.name, address: addr(c) };
    },
  },
  driver: {
    async find(tenantId) {
      // Inactive people are INCLUDED here, unlike every other picker in the app.
      // A picker assigns future work; this one pays for work already done, and a
      // final settlement cheque to someone who just left is routine. They are
      // flagged so nobody picks a leaver by accident.
      const rows = await Users.find({ tenantId, permissions: 'driver', ...notDeletedUser })
        .setOptions({ includeInactive: true }).sort({ name: 1 }).lean();
      return rows.map(personPayee);
    },
    async one(tenantId, id) {
      const u = await Users.findOne({ _id: id, tenantId, permissions: 'driver' }).setOptions({ includeInactive: true }).lean();
      return u && { name: u.name, address: joinAddress([u.address]).join('\n') };
    },
  },
  employee: {
    async find(tenantId) {
      // Inactive included for the same reason as drivers — final pay.
      const rows = await Users.find({ tenantId, permissions: { $ne: 'driver' }, ...notDeletedUser })
        .setOptions({ includeInactive: true }).sort({ name: 1 }).lean();
      return rows.map(personPayee);
    },
    async one(tenantId, id) {
      const u = await Users.findOne({ _id: id, tenantId }).setOptions({ includeInactive: true }).lean();
      return u && { name: u.name, address: joinAddress([u.address]).join('\n') };
    },
  },
  truck_owner: {
    async find(tenantId) {
      const rows = await OwnerOperator.find({ tenantId, ...notDeleted }).sort({ fullName: 1 }).lean();
      return rows.map((o) => ({
        _id: o._id,
        name: o.fullName,
        sub: o.companyName || o.ownerOperatorId,
        address: addr(o),
        inactive: o.status && o.status !== 'active',
      }));
    },
    async one(tenantId, id) {
      const o = await OwnerOperator.findOne({ _id: id, tenantId, ...notDeleted }).lean();
      return o && { name: o.fullName, address: addr(o) };
    },
  },
};

// A soft-deleted person is gone; an inactive one has simply left.
const notDeletedUser = { $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }] };

const personPayee = (u) => ({
  _id: u._id,
  name: u.name,
  sub: u.corporateID,
  address: joinAddress([u.address]).join('\n'),
  inactive: u.status !== 'active',
});

function addr(r) {
  const line2 = joinAddress([r.city, r.state, r.zipcode]).join(' ');
  return joinAddress([r.address, line2, r.country]).join('\n');
}
function addrCarrier(c) {
  const line2 = joinAddress([c.city, c.state, c.zipcode]).join(' ');
  return joinAddress([c.location, line2, c.country]).join('\n');
}

// null when the period is fine, else the message to show.
const checkPeriod = (from, to) => {
  if (!from || !to) return null;
  const a = new Date(from);
  const b = new Date(to);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return null;
  return a > b ? 'The period "From" date is after the "To" date.' : null;
};

// Mint the next free cheque number for a tenant (or one bank account).
//
// The counter does not know about numbers typed by hand, so a candidate can be
// taken. On the FIRST collision the counter is fast-forwarded past the highest
// numeric cheque number already in the scope — after that one bump the loop
// never grinds through a long run of taken numbers, no matter how many were
// entered manually.
async function allocateChequeNo(tenantId, accountId, account) {
  const counterKey = accountId ? `cheque_no_acct:${accountId}` : 'cheque_no';
  const start = account && Number(account.chequeStart) >= 1 ? Math.floor(account.chequeStart) : 1001;
  let bumped = false;
  for (let i = 0; i < 25; i++) {
    const candidate = String(await Counter.nextSeq(tenantId, counterKey, start));
    const taken = await PaymentCheque.findOne({ tenantId, bankAccount: accountId, chequeNo: candidate }).select('_id').lean();
    if (!taken) return candidate;
    if (!bumped) {
      bumped = true;
      const [maxRow] = await PaymentCheque.aggregate([
        { $match: { tenantId, bankAccount: accountId, chequeNo: { $regex: /^[0-9]+$/ } } },
        { $project: { n: { $toLong: '$chequeNo' } } },
        { $group: { _id: null, max: { $max: '$n' } } },
      ]);
      if (maxRow && Number.isFinite(Number(maxRow.max))) {
        await Counter.bumpTo(tenantId, counterKey, Number(maxRow.max));
      }
    }
  }
  return null;
}

const parseAmount = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100) / 100;
};

// GET /cheques/payees?type=carrier — payee dropdown for the cheque form.
exports.chequePayees = catchAsync(async (req, res) => {
  if (!hasChequeAccess(req.user)) {
    return res.status(403).json({ status: false, message: 'You are not authorized to manage cheques.' });
  }
  const tenantId = req.tenantId || req.user?.tenantId;
  if (!tenantId) return res.status(400).json({ status: false, message: 'Tenant context is required.' });
  const resolver = PAYEE_RESOLVERS[req.query.type];
  if (!resolver) return res.status(400).json({ status: false, message: 'Invalid payee type.' });
  const payees = await resolver.find(tenantId);
  return res.json({ status: true, payees });
});

// POST /cheques/add
exports.createCheque = catchAsync(async (req, res) => {
  if (!hasChequeAccess(req.user)) {
    return res.status(403).json({ status: false, message: 'You are not authorized to manage cheques.' });
  }
  const tenantId = req.tenantId || req.user?.tenantId;
  if (!tenantId) return res.status(400).json({ status: false, message: 'Tenant context is required.' });

  const { payeeType, payeeId, referenceNo, periodFrom, periodTo, country, state, note, fromAccount, currency, paymentDate } = req.body;
  const resolver = PAYEE_RESOLVERS[payeeType];
  if (!resolver) return res.status(400).json({ status: false, message: 'Invalid payee type.' });
  if (!payeeId) return res.status(400).json({ status: false, message: 'Please select who to pay.' });

  const amount = parseAmount(req.body.amount);
  if (amount === null) return res.status(400).json({ status: false, code: 'negative_amount', message: 'Amount must be a positive number.' });

  const cur = String(currency || 'CAD').toUpperCase();
  if (!['USD', 'CAD', 'INR'].includes(cur)) {
    return res.status(400).json({ status: false, message: 'Invalid currency.' });
  }

  // A period that runs backwards prints nonsense on the advance line.
  const periodError = checkPeriod(periodFrom, periodTo);
  if (periodError) return res.status(400).json({ status: false, code: 'period_backwards', message: periodError });

  const payee = await resolver.one(tenantId, payeeId);
  if (!payee) return res.status(404).json({ status: false, message: 'Payee not found.' });

  // Same reference to the same payee twice is the classic double-payment, but a
  // split payment against one invoice is legitimate — so warn, never block.
  // Mirrors the duplicate-reference rule on orders.
  if (!req.body.confirm_duplicate && String(referenceNo || '').trim()) {
    const dupes = await PaymentCheque.find({
      tenantId,
      payeeType,
      payeeId,
      referenceNo: String(referenceNo).trim(),
      // A void or bounced cheque paid nobody — re-issuing against the same
      // reference is exactly what happens after a bounce.
      status: { $nin: ['void', 'bounced'] },
      ...notDeleted,
    }).select('chequeNo amount currency paymentDate').limit(5).lean();
    if (dupes.length) {
      return res.status(409).json({
        status: false,
        code: 'duplicate_reference',
        message: `${payee.name} already has ${dupes.length === 1 ? 'a cheque' : `${dupes.length} cheques`} with reference ${String(referenceNo).trim()}.`,
        existing: dupes,
      });
    }
  }

  // The account the cheque is drawn on. Numbering and uniqueness are scoped to
  // it — two cheque books from two banks carry the same pre-printed numbers.
  let account = null;
  if (req.body.bankAccount) {
    account = await BankAccount.findOne({ _id: req.body.bankAccount, tenantId, ...notDeleted });
    if (!account) return res.status(404).json({ status: false, message: 'Bank account not found.' });
  }
  const accountId = account ? account._id : null;

  // Auto-minted, but a typed number (pre-printed cheque book) wins.
  const typedNo = String(req.body.chequeNo || '').trim();
  let chequeNo = typedNo;
  if (chequeNo) {
    // A typed number that is already used is the operator's own mistake, and
    // they can fix it — say exactly which number is taken.
    const clash = await PaymentCheque.findOne({ tenantId, bankAccount: accountId, chequeNo }).select('_id').lean();
    if (clash) {
      return res.status(409).json({ status: false, code: 'cheque_no_taken', message: `Cheque No. ${chequeNo} already exists on this account.` });
    }
  } else {
    chequeNo = await allocateChequeNo(tenantId, accountId, account);
    if (!chequeNo) {
      return res.status(409).json({ status: false, code: 'cheque_no_taken', message: 'Could not allocate a free cheque number. Enter one manually.' });
    }
  }

  const chequeFields = () => ({
    tenantId,
    company: req.user?.company?._id || req.user?.company || null,
    payeeType,
    payeeId,
    payeeName: payee.name,
    payeeAddress: payee.address || '',
    bankAccount: accountId,
    chequeNo,
    referenceNo: referenceNo || '',
    periodFrom: periodFrom || undefined,
    periodTo: periodTo || undefined,
    country: country || '',
    state: state || '',
    note: note || '',
    // The printed "drawn on" label: the account's own label when one is
    // chosen, else whatever the operator typed.
    fromAccount: account ? account.printedLabel() : (fromAccount || ''),
    currency: cur,
    amount,
    amountInWords: amountToWords(amount),
    paymentMethod: 'cheque',
    paymentDate: paymentDate || new Date(),
    created_by: req.user?._id,
  });

  let cheque;
  // Two writers can pass the pre-check together; the unique index catches the
  // loser. An auto-minted loser just takes the next number instead of erroring.
  for (let attempt = 0; attempt < 3 && !cheque; attempt++) {
    try {
      cheque = await PaymentCheque.create(chequeFields());
    } catch (err) {
      if (!(err && err.code === 11000)) throw err;
      if (typedNo) {
        return res.status(409).json({ status: false, code: 'cheque_no_taken', message: `Cheque No. ${chequeNo} already exists on this account.` });
      }
      chequeNo = await allocateChequeNo(tenantId, accountId, account);
      if (!chequeNo) {
        return res.status(409).json({ status: false, code: 'cheque_no_taken', message: 'Could not allocate a free cheque number. Enter one manually.' });
      }
    }
  }
  if (!cheque) {
    return res.status(409).json({ status: false, code: 'cheque_no_taken', message: 'Could not allocate a free cheque number. Enter one manually.' });
  }

  logChange(req, {
    model: 'PaymentCheque', module: 'cheque', after: cheque.toObject(),
    resourceId: cheque._id, resourceName: `Cheque #${chequeNo}`,
    description: `Cheque #${chequeNo} for ${payee.name} — ${cur} ${amount.toFixed(2)}`,
  });

  return res.json({ status: true, message: 'Cheque saved.', cheque });
});

function buildListFilter(req, tenantId) {
  const criteria = { tenantId, ...notDeleted };
  const and = [];
  const { payeeType, payeeId, status, month, year, search, startDate, endDate } = req.query;

  if (payeeType && PAYEE_RESOLVERS[payeeType]) criteria.payeeType = payeeType;
  if (payeeId) criteria.payeeId = payeeId;
  if (status && ['issued', 'printed', 'void', 'cleared', 'bounced'].includes(status)) criteria.status = status;

  const y = Number(year);
  const m = Number(month); // 1-12
  if (y && m >= 1 && m <= 12) {
    criteria.paymentDate = { $gte: new Date(Date.UTC(y, m - 1, 1)), $lt: new Date(Date.UTC(y, m, 1)) };
  } else if (y) {
    criteria.paymentDate = { $gte: new Date(Date.UTC(y, 0, 1)), $lt: new Date(Date.UTC(y + 1, 0, 1)) };
  } else if (startDate || endDate) {
    criteria.paymentDate = {};
    if (startDate) criteria.paymentDate.$gte = new Date(startDate);
    if (endDate) criteria.paymentDate.$lte = new Date(endDate);
  }

  const term = String(search || '').trim();
  if (term.length >= 2) {
    const rx = new RegExp(escapeRegex(term), 'i');
    // Pushed onto $and — never overwrite the soft-delete $or.
    and.push({ $or: [{ chequeNo: rx }, { referenceNo: rx }, { payeeName: rx }, { note: rx }] });
  }
  if (and.length) criteria.$and = and;
  return criteria;
}

// GET /cheques/listings
exports.listCheques = catchAsync(async (req, res) => {
  if (!hasChequeAccess(req.user)) {
    return res.status(403).json({ status: false, message: 'You are not authorized to view cheques.' });
  }
  const tenantId = req.tenantId || req.user?.tenantId;
  if (!tenantId) return res.status(400).json({ status: false, message: 'Tenant context is required.' });

  const criteria = buildListFilter(req, tenantId);
  const limit = Math.min(Number(req.query.limit) || 200, 500);
  const cheques = await PaymentCheque.find(criteria)
    .sort({ paymentDate: -1, createdAt: -1 })
    .limit(limit)
    // The book a cheque is drawn on decides what paper has to be in the tray,
    // so the register has to be able to say it before anyone hits print.
    .populate({ path: 'bankAccount', select: 'name printMode' })
    .populate({ path: 'created_by', select: 'name', options: { includeInactive: true } })
    .lean();

  // Totals per currency — never add two currencies into one number. Void and
  // bounced cheques paid nobody, so they stay out.
  const totals = {};
  for (const c of cheques) {
    if (c.status === 'void' || c.status === 'bounced') continue;
    totals[c.currency] = Math.round(((totals[c.currency] || 0) + c.amount) * 100) / 100;
  }

  // What each cheque has been applied to — the difference is the "unapplied"
  // balance the register shows.
  if (cheques.length) {
    const appliedRows = await ChequeApplication.aggregate([
      { $match: { tenantId, cheque: { $in: cheques.map((c) => c._id) }, $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }] } },
      { $group: { _id: '$cheque', applied: { $sum: '$amount' }, count: { $sum: 1 } } },
    ]);
    const appliedById = new Map(appliedRows.map((r) => [String(r._id), r]));
    for (const c of cheques) {
      const row = appliedById.get(String(c._id));
      c.appliedAmount = Math.round((row?.applied || 0) * 100) / 100;
      c.applicationCount = row?.count || 0;
      c.unappliedAmount = Math.round((c.amount - c.appliedAmount) * 100) / 100;
    }
  }

  // A silently truncated list reads as "these are all the cheques", and the
  // totals underneath it would then be wrong. Say so instead.
  return res.json({
    status: true,
    cheques,
    totals,
    count: cheques.length,
    limit,
    truncated: cheques.length === limit,
  });
});

// GET /cheques/counts?payeeType=carrier — payeeId -> cheque count, for the
// highlighted button on listing pages. Void cheques still count (history exists).
exports.chequeCounts = catchAsync(async (req, res) => {
  if (!hasChequeAccess(req.user)) {
    return res.json({ status: true, counts: {} }); // listing pages must not break on 403
  }
  const tenantId = req.tenantId || req.user?.tenantId;
  if (!tenantId) return res.status(400).json({ status: false, message: 'Tenant context is required.' });
  const payeeType = req.query.payeeType;
  if (!PAYEE_RESOLVERS[payeeType]) return res.status(400).json({ status: false, message: 'Invalid payee type.' });

  const rows = await PaymentCheque.aggregate([
    // Void excluded: the green badge means "this payee has been paid", and a
    // voided cheque paid nobody.
    { $match: { tenantId, payeeType, status: { $nin: ['void', 'bounced'] }, $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }] } },
    { $group: { _id: '$payeeId', count: { $sum: 1 } } },
  ]);
  const counts = {};
  rows.forEach((r) => { counts[String(r._id)] = r.count; });
  return res.json({ status: true, counts });
});

// POST /cheques/update/:id — only while still 'issued'.
exports.updateCheque = catchAsync(async (req, res) => {
  if (!hasChequeAccess(req.user)) {
    return res.status(403).json({ status: false, message: 'You are not authorized to manage cheques.' });
  }
  const tenantId = req.tenantId || req.user?.tenantId;
  if (!tenantId) return res.status(400).json({ status: false, message: 'Tenant context is required.' });

  const before = await PaymentCheque.findOne({ _id: req.params.id, tenantId, ...notDeleted }).lean();
  if (!before) return res.status(404).json({ status: false, message: 'Cheque not found.' });
  if (before.status !== 'issued') {
    return res.status(409).json({ status: false, code: 'cheque_not_editable', message: `A ${before.status} cheque cannot be edited. Void it and create a new one.` });
  }

  const update = {};
  if (req.body.amount !== undefined) {
    const amount = parseAmount(req.body.amount);
    if (amount === null) return res.status(400).json({ status: false, code: 'negative_amount', message: 'Amount must be a positive number.' });
    update.amount = amount;
    update.amountInWords = amountToWords(amount);
  }
  if (req.body.currency !== undefined) {
    const cur = String(req.body.currency).toUpperCase();
    if (!['USD', 'CAD', 'INR'].includes(cur)) return res.status(400).json({ status: false, message: 'Invalid currency.' });
    update.currency = cur;
  }
  if (req.body.chequeNo !== undefined) {
    const chequeNo = String(req.body.chequeNo).trim();
    if (!chequeNo) return res.status(400).json({ status: false, message: 'Cheque No. cannot be empty.' });
    if (chequeNo !== before.chequeNo) {
      const clash = await PaymentCheque.findOne({ tenantId, bankAccount: before.bankAccount || null, chequeNo, _id: { $ne: before._id } }).select('_id').lean();
      if (clash) {
        return res.status(409).json({ status: false, code: 'cheque_no_taken', message: `Cheque No. ${chequeNo} already exists on this account.` });
      }
    }
    update.chequeNo = chequeNo;
  }
  ['referenceNo', 'country', 'state', 'note', 'fromAccount'].forEach((k) => {
    if (req.body[k] !== undefined) update[k] = String(req.body[k] || '');
  });
  ['periodFrom', 'periodTo', 'paymentDate'].forEach((k) => {
    if (req.body[k] !== undefined) update[k] = req.body[k] || undefined;
  });
  {
    // Compare the resulting state, so changing only one end is still checked.
    const from = update.periodFrom !== undefined ? update.periodFrom : before.periodFrom;
    const to = update.periodTo !== undefined ? update.periodTo : before.periodTo;
    const periodError = checkPeriod(from, to);
    if (periodError) return res.status(400).json({ status: false, code: 'period_backwards', message: periodError });
  }
  // payee is never editable — void and re-issue instead.

  let cheque;
  try {
    cheque = await PaymentCheque.findOneAndUpdate(
      { _id: req.params.id, tenantId },
      { $set: update },
      { new: true, runValidators: true }
    );
  } catch (err) {
    if (err && err.code === 11000) {
      return res.status(409).json({ status: false, code: 'cheque_no_taken', message: `Cheque No. ${update.chequeNo} already exists.` });
    }
    throw err;
  }

  logChange(req, {
    model: 'PaymentCheque', module: 'cheque', before, after: cheque.toObject(),
    resourceId: cheque._id, resourceName: `Cheque #${cheque.chequeNo}`,
  });

  return res.json({ status: true, message: 'Cheque updated.', cheque });
});

// POST /cheques/void/:id {reason}
exports.voidCheque = catchAsync(async (req, res) => {
  if (!hasChequeAccess(req.user)) {
    return res.status(403).json({ status: false, message: 'You are not authorized to manage cheques.' });
  }
  const tenantId = req.tenantId || req.user?.tenantId;
  if (!tenantId) return res.status(400).json({ status: false, message: 'Tenant context is required.' });

  const reason = String(req.body.reason || '').trim();
  if (!reason) return res.status(400).json({ status: false, message: 'A reason is required to void a cheque.' });

  const before = await PaymentCheque.findOne({ _id: req.params.id, tenantId, ...notDeleted }).lean();
  if (!before) return res.status(404).json({ status: false, message: 'Cheque not found.' });
  if (before.status === 'void') return res.status(409).json({ status: false, message: 'Cheque is already void.' });
  if (before.status === 'cleared') return res.status(409).json({ status: false, code: 'cheque_settled', message: 'This cheque already cleared at the bank — it cannot be voided.' });
  if (before.status === 'bounced') return res.status(409).json({ status: false, code: 'cheque_settled', message: 'This cheque bounced — record a replacement instead of voiding it.' });

  const cheque = await PaymentCheque.findOneAndUpdate(
    { _id: req.params.id, tenantId },
    { $set: { status: 'void', voidedAt: new Date(), voidedBy: req.user?._id, voidReason: reason } },
    { new: true }
  );

  logChange(req, {
    model: 'PaymentCheque', module: 'cheque', before, after: cheque.toObject(),
    resourceId: cheque._id, resourceName: `Cheque #${cheque.chequeNo}`,
    description: `Cheque #${cheque.chequeNo} voided — ${reason}`,
    // Voiding an already-printed cheque rewrites money that may have left the building.
    critical: before.status === 'printed',
  });

  return res.json({ status: true, message: 'Cheque voided.', cheque });
});

// GET /cheques/:id/pdf — 3-per-page print. Marks the cheque printed.
exports.chequePdf = catchAsync(async (req, res) => {
  if (!hasChequeAccess(req.user)) {
    return res.status(403).json({ status: false, message: 'You are not authorized to print cheques.' });
  }
  const tenantId = req.tenantId || req.user?.tenantId;
  if (!tenantId) return res.status(400).json({ status: false, message: 'Tenant context is required.' });

  const cheque = await PaymentCheque.findOne({ _id: req.params.id, tenantId, ...notDeleted }).lean();
  if (!cheque) return res.status(404).json({ status: false, message: 'Cheque not found.' });

  // Looking at a cheque is not printing it. Marking `printed` locks the record
  // to void-only, so a dispatcher who opened the PDF to check an amount could
  // no longer correct it. `?preview=true` renders the same document and leaves
  // the status alone.
  const isPreview = String(req.query.preview || '') === 'true';

  try {
    // Same renderer as the batch route — one definition of "the printed cheque".
    const pdfBuffer = await renderChequePdf([cheque], tenantId);

    // First real print flips issued -> printed. A void cheque prints with the
    // watermark but stays void.
    if (!isPreview && cheque.status === 'issued') {
      await PaymentCheque.updateOne(
        { _id: cheque._id, tenantId, status: 'issued' },
        { $set: { status: 'printed', printedAt: new Date() } }
      );
    }

    logActivity(req, {
      action: 'DOWNLOAD',
      module: 'cheque',
      description: `${isPreview ? 'Previewed' : 'Printed'} cheque #${cheque.chequeNo} for ${cheque.payeeName} — ${cheque.currency} ${Number(cheque.amount).toFixed(2)}`,
      resourceId: cheque._id,
      resourceName: `Cheque #${cheque.chequeNo}`,
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="cheque-${cheque.chequeNo}${isPreview ? '-preview' : ''}.pdf"`);
    return res.end(pdfBuffer);
  } catch (err) {
    // The browser is closed by renderChequePdf's own finally block.
    if (err?.code === 'mixed_stock') {
      return res.status(409).json({ status: false, code: 'mixed_stock', message: `These cheques are drawn on different kinds of paper (${(err.detail || []).join(', ')}). Print one kind at a time — the printer tray has to change between them.` });
    }
    if (err?.code === 'chrome_missing') {
      return res.status(500).json({ status: false, code: 'chrome_missing', message: err.message });
    }
    logger(err);
    return res.status(500).json({ status: false, message: 'Failed to generate the cheque PDF.' });
  }
});

/**
 * Which stock each cheque prints on, and what it paid for.
 *
 * A batch can span two bank accounts with different stock, so the mode is
 * resolved PER CHEQUE, not once for the run. A cheque with no account (or an
 * account still set to plain paper) keeps the blank-paper document.
 */
async function resolvePrintEntries(tenantId, cheques) {
  // `bankAccount` is an id on the PDF routes (they read lean, unpopulated) but a
  // populated object on the register. Reading it one way only would silently
  // stringify to "[object Object]" the day the two paths are wired together.
  const accountIdOf = (c) => (c.bankAccount && c.bankAccount._id) ? String(c.bankAccount._id)
    : (c.bankAccount ? String(c.bankAccount) : null);
  const accountIds = [...new Set(cheques.map(accountIdOf).filter(Boolean))];
  const accounts = accountIds.length
    ? await BankAccount.find({ _id: { $in: accountIds }, tenantId })
    : [];
  const byId = new Map(accounts.map((a) => [String(a._id), a]));

  // The stubs say what the cheque paid for, which is the whole point of a stub.
  const apps = await ChequeApplication.find({
    tenantId,
    cheque: { $in: cheques.map((c) => c._id) },
    $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
  }).select('cheque targetLabel amount currency').lean();
  const appsByCheque = new Map();
  for (const a of apps) {
    const k = String(a.cheque);
    if (!appsByCheque.has(k)) appsByCheque.set(k, []);
    appsByCheque.get(k).push(a);
  }

  return cheques.map((c) => {
    const id = accountIdOf(c);
    const account = id ? byId.get(id) : null;
    return {
      cheque: c,
      account,
      spec: account ? account.printSpec() : null,
      layoutOverrides: account?.layoutOverrides || null,
      applications: appsByCheque.get(String(c._id)) || [],
    };
  });
}

// Renders a PDF from already-loaded cheque docs. Shared by the single and batch
// print routes so they can never drift into printing two different documents.
async function renderChequePdf(cheques, tenantId) {
  let html;
  const entries = tenantId ? await resolvePrintEntries(tenantId, cheques) : [];
  const preprinted = entries.filter((e) => e.spec && e.spec.printMode === 'preprinted');

  if (entries.length > 0 && preprinted.length > 0 && preprinted.length < entries.length) {
    // One job cannot span two kinds of paper: the operator would have to swap
    // trays half way through, and every misfed sheet of cheque stock is a void
    // cheque. Refused with the offending accounts named, not silently mixed.
    const err = new Error('mixed_stock');
    err.code = 'mixed_stock';
    err.detail = [...new Set(entries.map((e) => (e.spec?.printMode === 'preprinted' ? (e.account?.name || 'pre-printed stock') : 'plain paper')))];
    throw err;
  }

  if (preprinted.length > 0) {
    // ORDER IS NOT COSMETIC ON NUMBERED STOCK.
    //
    // Pre-printed sheets come off the stack in cheque-number order, so sheet 1
    // is physically 0887 whatever the operator clicked first. Printing in
    // click order puts one cheque's data on another cheque's paper — the whole
    // batch then carries numbers that disagree with the register, and every
    // sheet has to be voided. Sorted ascending by number so the paper and the
    // data line up.
    //
    // Only when every number is numeric: a book with lettered or prefixed
    // numbers has no order we can infer, so the caller's order stands.
    html = buildPreprintedSheetsHtml(orderForStock(preprinted));
  } else {
    html = cheques.length === 1 ? buildChequeHtml(cheques[0]) : buildChequeBatchHtml(cheques);
  }

  const { launchBrowser, hardenPage } = require('../utils/puppeteer');
  let browser = null;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    await hardenPage(page);
    await page.setContent(html, { waitUntil: 'load', timeout: 20000 }).catch(() => {});
    const pdfBuffer = await page.pdf({
      format: 'Letter',
      printBackground: true,
      margin: { top: 0, bottom: 0, left: 0, right: 0 },
    });
    await browser.close();
    browser = null;
    return pdfBuffer;
  } finally {
    if (browser) { try { await browser.close(); } catch (e) { /* noop */ } }
  }
}

const MAX_BATCH_CHEQUES = 100;

/** Sheets come off the stack in number order, so the data must be in that order too. */
function orderForStock(entries) {
  const nums = entries.map((e) => Number(String(e.cheque.chequeNo).trim()));
  if (!nums.every((n) => Number.isFinite(n))) return entries; // lettered book: no order to infer
  return [...entries].sort((a, b) => Number(a.cheque.chequeNo) - Number(b.cheque.chequeNo));
}

/**
 * Numbers missing from a run, so the operator can be told the stack in their
 * hand is not contiguous before they feed it. A gap means either a sheet is
 * already used or one is missing — both misalign every sheet after it.
 */
function stackGaps(chequeNos) {
  const nums = chequeNos.map((n) => Number(String(n).trim())).filter(Number.isFinite).sort((a, b) => a - b);
  if (nums.length !== chequeNos.length || nums.length < 2) return [];
  const gaps = [];
  for (let i = 1; i < nums.length; i++) {
    for (let n = nums[i - 1] + 1; n < nums[i] && gaps.length < 20; n++) {
      gaps.push(String(n).padStart(String(chequeNos[0]).trim().length, '0'));
    }
  }
  return gaps;
}

exports._test = { orderForStock, stackGaps };

// POST /cheques/print-batch {ids:[]} — one sheet per cheque, in the order the
// caller listed them. Same gate, same tenant scope, same DOWNLOAD audit trail.
exports.printChequeBatch = catchAsync(async (req, res) => {
  if (!hasChequeAccess(req.user)) {
    return res.status(403).json({ status: false, message: 'You are not authorized to print cheques.' });
  }
  const tenantId = req.tenantId || req.user?.tenantId;
  if (!tenantId) return res.status(400).json({ status: false, message: 'Tenant context is required.' });

  const ids = Array.isArray(req.body.ids) ? req.body.ids.filter(Boolean) : [];
  // Same rule as the single route: looking is not printing.
  const isPreview = req.body.preview === true || String(req.body.preview || '') === 'true';
  if (ids.length === 0) return res.status(400).json({ status: false, message: 'Select at least one cheque to print.' });
  if (ids.length > MAX_BATCH_CHEQUES) {
    return res.status(400).json({ status: false, message: `A batch is limited to ${MAX_BATCH_CHEQUES} cheques.` });
  }

  const found = await PaymentCheque.find({ _id: { $in: ids }, tenantId, ...notDeleted }).lean();
  if (found.length === 0) return res.status(404).json({ status: false, message: 'No cheques found.' });

  // Print in the order the caller asked for, not Mongo's — the operator is
  // feeding pre-numbered stock into a printer and the order is the whole point.
  const byId = new Map(found.map((c) => [String(c._id), c]));
  const cheques = ids.map((id) => byId.get(String(id))).filter(Boolean);

  try {
    const pdfBuffer = await renderChequePdf(cheques, tenantId);

    const issuedIds = isPreview ? [] : cheques.filter((c) => c.status === 'issued').map((c) => c._id);
    if (issuedIds.length) {
      await PaymentCheque.updateMany(
        { _id: { $in: issuedIds }, tenantId, status: 'issued' },
        { $set: { status: 'printed', printedAt: new Date() } }
      );
    }

    logActivity(req, {
      action: 'DOWNLOAD',
      module: 'cheque',
      description: `${isPreview ? 'Batch-previewed' : 'Batch-printed'} ${cheques.length} cheque(s): ${cheques.map((c) => `#${c.chequeNo}`).join(', ')}`,
      resourceName: `${cheques.length} cheques`,
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="cheques-batch-${cheques.length}${isPreview ? '-preview' : ''}.pdf"`);
    return res.end(pdfBuffer);
  } catch (err) {
    if (err?.code === 'mixed_stock') {
      return res.status(409).json({ status: false, code: 'mixed_stock', message: `These cheques are drawn on different kinds of paper (${(err.detail || []).join(', ')}). Print one kind at a time — the printer tray has to change between them.` });
    }
    if (err?.code === 'chrome_missing') {
      return res.status(500).json({ status: false, code: 'chrome_missing', message: err.message });
    }
    logger(err);
    return res.status(500).json({ status: false, message: 'Failed to generate the cheque PDF.' });
  }
});

/* ------------------------------------------------------------------ *
 * Bank lifecycle: cleared / bounced
 * ------------------------------------------------------------------ */

// POST /cheques/clear/:id {date?} — the bank honoured the cheque.
exports.markChequeCleared = catchAsync(async (req, res) => {
  if (!hasChequeAccess(req.user)) {
    return res.status(403).json({ status: false, message: 'You are not authorized to manage cheques.' });
  }
  const tenantId = req.tenantId || req.user?.tenantId;
  if (!tenantId) return res.status(400).json({ status: false, message: 'Tenant context is required.' });

  const before = await PaymentCheque.findOne({ _id: req.params.id, tenantId, ...notDeleted }).lean();
  if (!before) return res.status(404).json({ status: false, message: 'Cheque not found.' });
  if (before.status !== 'printed') {
    return res.status(409).json({ status: false, code: 'not_printed', message: `Only a printed cheque can clear — this one is ${before.status}.` });
  }
  let clearedAt = new Date();
  if (req.body.date) {
    const d = new Date(req.body.date);
    if (Number.isNaN(d.getTime())) return res.status(400).json({ status: false, message: 'Invalid cleared date.' });
    clearedAt = d;
  }

  const cheque = await PaymentCheque.findOneAndUpdate(
    { _id: before._id, tenantId, status: 'printed' },
    { $set: { status: 'cleared', clearedAt, clearedBy: req.user?._id } },
    { new: true }
  );
  if (!cheque) return res.status(409).json({ status: false, message: 'Cheque changed while updating — reload and retry.' });

  logChange(req, {
    model: 'PaymentCheque', module: 'cheque', before, after: cheque.toObject(),
    resourceId: cheque._id, resourceName: `Cheque #${cheque.chequeNo}`,
    description: `Cheque #${cheque.chequeNo} cleared at the bank`,
  });
  return res.json({ status: true, message: 'Cheque marked cleared.', cheque });
});

// POST /cheques/bounce/:id {reason} — the bank returned it. The money did NOT
// move, so the cheque leaves every total and badge — but any applications it
// carries now claim payments that never happened; the response says how many
// are left so the operator can remove them.
exports.markChequeBounced = catchAsync(async (req, res) => {
  if (!hasChequeAccess(req.user)) {
    return res.status(403).json({ status: false, message: 'You are not authorized to manage cheques.' });
  }
  const tenantId = req.tenantId || req.user?.tenantId;
  if (!tenantId) return res.status(400).json({ status: false, message: 'Tenant context is required.' });

  const reason = String(req.body.reason || '').trim();
  if (!reason) return res.status(400).json({ status: false, message: 'A reason is required to mark a cheque bounced.' });

  const before = await PaymentCheque.findOne({ _id: req.params.id, tenantId, ...notDeleted }).lean();
  if (!before) return res.status(404).json({ status: false, message: 'Cheque not found.' });
  // A cheque can bounce after it was thought cleared — banks reverse.
  if (!['printed', 'cleared'].includes(before.status)) {
    return res.status(409).json({ status: false, code: 'not_printed', message: `Only a printed or cleared cheque can bounce — this one is ${before.status}.` });
  }

  const cheque = await PaymentCheque.findOneAndUpdate(
    { _id: before._id, tenantId, status: before.status },
    { $set: { status: 'bounced', bouncedAt: new Date(), bouncedBy: req.user?._id, bounceReason: reason } },
    { new: true }
  );
  if (!cheque) return res.status(409).json({ status: false, message: 'Cheque changed while updating — reload and retry.' });

  const applicationsRemain = await ChequeApplication.countDocuments({
    tenantId, cheque: cheque._id, $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
  });

  logChange(req, {
    model: 'PaymentCheque', module: 'cheque', before, after: cheque.toObject(),
    resourceId: cheque._id, resourceName: `Cheque #${cheque.chequeNo}`,
    description: `Cheque #${cheque.chequeNo} bounced — ${reason}`,
    // The money everyone thought moved did not.
    critical: true,
  });
  return res.json({
    status: true,
    message: applicationsRemain
      ? `Cheque marked bounced. It is still applied to ${applicationsRemain} item(s) — remove those applications, the payments they recorded never happened.`
      : 'Cheque marked bounced.',
    cheque,
    applicationsRemain,
  });
});

/* ------------------------------------------------------------------ *
 * Applications — what a cheque paid for
 * ------------------------------------------------------------------ */

const APPLY_TARGET_BY_PAYEE = {
  carrier: 'order_carrier',
  driver: 'driver_salary',
  truck_owner: 'owner_salary',
};

const round2c = (n) => Math.round(Number(n || 0) * 100) / 100;

async function chequeAppliedTotal(tenantId, chequeId) {
  const [row] = await ChequeApplication.aggregate([
    { $match: { tenantId, cheque: chequeId, $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }] } },
    { $group: { _id: null, applied: { $sum: '$amount' } } },
  ]);
  return round2c(row?.applied || 0);
}

// GET /cheques/:id/applications
exports.listChequeApplications = catchAsync(async (req, res) => {
  if (!hasChequeAccess(req.user)) {
    return res.status(403).json({ status: false, message: 'You are not authorized to manage cheques.' });
  }
  const tenantId = req.tenantId || req.user?.tenantId;
  if (!tenantId) return res.status(400).json({ status: false, message: 'Tenant context is required.' });

  const cheque = await PaymentCheque.findOne({ _id: req.params.id, tenantId, ...notDeleted }).lean();
  if (!cheque) return res.status(404).json({ status: false, message: 'Cheque not found.' });

  const applications = await ChequeApplication.find({
    tenantId, cheque: cheque._id, $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
  }).sort({ createdAt: -1 }).lean();
  const applied = round2c(applications.reduce((sum, a) => sum + a.amount, 0));
  return res.json({
    status: true,
    applications,
    applied,
    unapplied: round2c(cheque.amount - applied),
    currency: cheque.currency,
  });
});

// GET /cheques/:id/apply-targets — what this cheque COULD be applied to.
exports.chequeApplyTargets = catchAsync(async (req, res) => {
  if (!hasChequeAccess(req.user)) {
    return res.status(403).json({ status: false, message: 'You are not authorized to manage cheques.' });
  }
  const tenantId = req.tenantId || req.user?.tenantId;
  if (!tenantId) return res.status(400).json({ status: false, message: 'Tenant context is required.' });

  const cheque = await PaymentCheque.findOne({ _id: req.params.id, tenantId, ...notDeleted }).lean();
  if (!cheque) return res.status(404).json({ status: false, message: 'Cheque not found.' });

  const targetType = APPLY_TARGET_BY_PAYEE[cheque.payeeType] || null;
  let targets = [];

  if (targetType === 'order_carrier') {
    // Both filters are `$or`s, so they MUST go on `$and` — spreading one into the same object
    // literal as the other silently discards it (a later `$or` key overwrites the earlier one),
    // and the discarded one here was the carrier filter: every order in the tenant came back as a
    // payable target for this carrier. Same rule the order listings and search already follow.
    const orders = await Order.find({
      tenantId,
      $and: [
        carrierOrderMatch(cheque.payeeId),
        { $or: [{ deletedAt: null }, { deletedAt: '' }, { deletedAt: { $exists: false } }] },
      ],
    }).select(`serial_no carrier_payment_status input_carrier_amount input_currency carrier_amount revenue_currency createdAt ${ORDER_SHAPE_FIELDS}`)
      .sort({ createdAt: -1 }).limit(100).lean();
    targets = orders.map((o) => ({
      targetType,
      targetId: o._id,
      label: `Order #${o.serial_no ?? ''}`,
      amount: Number(o.input_carrier_amount) > 0 ? o.input_carrier_amount : o.carrier_amount,
      currency: Number(o.input_carrier_amount) > 0 ? String(o.input_currency || 'usd').toUpperCase() : String(o.revenue_currency || 'usd').toUpperCase(),
      paid: o.carrier_payment_status === 'paid',
      sub: `carrier payment ${o.carrier_payment_status || 'pending'}`,
    }));
  } else if (targetType === 'driver_salary') {
    const rows = await DriverSalary.find({ tenantId, driver: cheque.payeeId })
      .select('month year dueAmount owedAmount paymentStatus currency finalPayable paidAmount')
      .sort({ year: -1, month: -1 }).limit(24).lean();
    targets = rows.map((r) => ({
      targetType,
      targetId: r._id,
      label: `Payslip ${r.month}/${r.year}`,
      amount: r.dueAmount,
      currency: r.currency,
      paid: r.paymentStatus === 'paid',
      sub: `${r.paymentStatus} — due ${Number(r.dueAmount || 0).toFixed(2)} ${r.currency}`,
    }));
  } else if (targetType === 'owner_salary') {
    const rows = await OwnerOperatorSalary.find({ tenantId, ownerOperator: cheque.payeeId })
      .select('month year dueAmount paymentStatus currency finalPayable paidAmount')
      .sort({ year: -1, month: -1 }).limit(24).lean();
    targets = rows.map((r) => ({
      targetType,
      targetId: r._id,
      label: `Statement ${r.month}/${r.year}`,
      amount: r.dueAmount,
      currency: r.currency,
      paid: r.paymentStatus === 'paid',
      sub: `${r.paymentStatus} — due ${Number(r.dueAmount || 0).toFixed(2)} ${r.currency}`,
    }));
  }

  return res.json({ status: true, targetType, targets });
});

// POST /cheques/:id/apply {targetId, amount, allowOverpay}
//
// Applying is a real payment write, not a note: an order application marks the
// order's carrier payment paid; a payslip application records a payment row in
// that payroll through the same core the payroll endpoints use. The link ids
// on the application row are what makes removal reverse exactly that write.
exports.applyCheque = catchAsync(async (req, res) => {
  if (!hasChequeAccess(req.user)) {
    return res.status(403).json({ status: false, message: 'You are not authorized to manage cheques.' });
  }
  const tenantId = req.tenantId || req.user?.tenantId;
  if (!tenantId) return res.status(400).json({ status: false, message: 'Tenant context is required.' });

  const cheque = await PaymentCheque.findOne({ _id: req.params.id, tenantId, ...notDeleted }).lean();
  if (!cheque) return res.status(404).json({ status: false, message: 'Cheque not found.' });
  if (!['issued', 'printed', 'cleared'].includes(cheque.status)) {
    return res.status(409).json({ status: false, code: 'cheque_not_applicable', message: `A ${cheque.status} cheque paid nobody — it cannot be applied.` });
  }

  const targetType = APPLY_TARGET_BY_PAYEE[cheque.payeeType];
  if (!targetType) {
    return res.status(400).json({ status: false, code: 'no_apply_targets', message: `${cheque.payeeType} cheques have nothing to apply to yet.` });
  }
  const targetId = req.body.targetId;
  if (!targetId) return res.status(400).json({ status: false, message: 'Pick what this cheque paid for.' });

  const amount = parseAmount(req.body.amount);
  if (amount === null) return res.status(400).json({ status: false, code: 'negative_amount', message: 'Amount must be a positive number.' });

  // Never apply more than the cheque has left — that would invent money.
  const applied = await chequeAppliedTotal(tenantId, cheque._id);
  const unapplied = round2c(cheque.amount - applied);
  if (amount - unapplied > 0.005) {
    return res.status(400).json({
      status: false,
      code: 'over_unapplied',
      message: `Only ${cheque.currency} ${unapplied.toFixed(2)} of this cheque is unapplied.`,
      unapplied,
      currency: cheque.currency,
    });
  }

  let targetLabel = '';
  let driverPaymentId = null;
  let ownerRecordId = null;

  if (targetType === 'order_carrier') {
    // See the note above: two `$or`s cannot share an object literal. Without `$and` the carrier
    // check was dropped and a cheque could be applied against an order this carrier never moved.
    const order = await Order.findOne({
      _id: targetId, tenantId,
      $and: [
        carrierOrderMatch(cheque.payeeId),
        { $or: [{ deletedAt: null }, { deletedAt: '' }, { deletedAt: { $exists: false } }] },
      ],
    });
    if (!order) return res.status(404).json({ status: false, message: 'Order not found for this carrier.' });
    const beforeOrder = order.toObject();

    // Mark legs belonging to this carrier as paid, then roll the order's status up from all legs
    const legUpdate = {
      carrier_payment_status: 'paid',
      carrier_payment_date: Date.now(),
      carrier_payment_method: 'cheque',
      carrier_payment_notes: `Cheque #${cheque.chequeNo}`,
      carrier_payment_updated_by: req.user?._id,
    };
    await Trip.updateMany({ tenantId, order: order._id, deletedAt: null, carrier: cheque.payeeId }, { $set: legUpdate });
    const allTrips = await Trip.find({ tenantId, order: order._id, deletedAt: null }).select('carrier carrier_payment_status').lean();
    const rolledStatus = rollupCarrierPaymentStatus(allTrips) || 'paid';
    const updatedOrder = await Order.findOneAndUpdate(
      { _id: order._id, tenantId },
      { $set: { ...legUpdate, carrier_payment_status: rolledStatus } },
      { new: true }
    );
    await PaymentLogs.create({
      tenantId,
      company: req.user?.company?._id || req.user?.company || null,
      order: order._id,
      method: 'cheque',
      status: 'paid',
      type: 'carrier',
      approval: 'approved',
      updated_by: req.user?._id,
    });
    logChange(req, {
      model: 'Order', module: 'order', action: 'PAYMENT',
      before: beforeOrder, after: updatedOrder.toObject(), logUnchanged: true,
      description: `Applied cheque #${cheque.chequeNo} — carrier payment marked paid on order #${order.serial_no}`,
      resourceId: order._id, resourceName: `#${order.serial_no ?? ''}`,
    });
    targetLabel = `Order #${order.serial_no ?? ''}`;
  } else if (targetType === 'driver_salary') {
    const salary = await DriverSalary.findOne({ _id: targetId, tenantId, driver: cheque.payeeId }).select('_id').lean();
    if (!salary) return res.status(404).json({ status: false, message: 'Payslip not found for this driver.' });
    const { recordDriverPaymentCore } = require('./driverSalaryController');
    const result = await recordDriverPaymentCore(req, {
      driverId: cheque.payeeId,
      salaryId: targetId,
      amount,
      currency: cheque.currency,
      date: cheque.paymentDate,
      notes: `Cheque #${cheque.chequeNo}`,
      method: 'cheque',
      allowOverpay: !!req.body.allowOverpay,
    });
    if (!result.ok) return res.status(result.status).json(result.body);
    driverPaymentId = result.payment._id;
    targetLabel = `Payslip ${result.salary.month}/${result.salary.year}`;
  } else if (targetType === 'owner_salary') {
    const salary = await OwnerOperatorSalary.findOne({ _id: targetId, tenantId, ownerOperator: cheque.payeeId }).select('_id').lean();
    if (!salary) return res.status(404).json({ status: false, message: 'Statement not found for this owner.' });
    const { recordOwnerPaymentCore } = require('./ownerOperatorController');
    const result = await recordOwnerPaymentCore(req, {
      salaryId: targetId,
      amount,
      currency: cheque.currency,
      notes: `Cheque #${cheque.chequeNo}`,
      allowOverpay: !!req.body.allowOverpay,
    });
    if (!result.ok) return res.status(result.status).json(result.body);
    ownerRecordId = result.record?._id || null;
    targetLabel = `Statement ${result.salary.month}/${result.salary.year}`;
  }

  const application = await ChequeApplication.create({
    tenantId,
    company: req.user?.company?._id || req.user?.company || null,
    cheque: cheque._id,
    chequeNo: cheque.chequeNo,
    targetType,
    targetId,
    targetLabel,
    amount,
    currency: cheque.currency,
    note: String(req.body.note || '').trim(),
    driverPayment: driverPaymentId,
    ownerRecord: ownerRecordId,
    createdBy: req.user?._id,
  });

  logChange(req, {
    model: 'ChequeApplication', module: 'cheque', after: application.toObject(),
    resourceId: cheque._id, resourceName: `Cheque #${cheque.chequeNo}`,
    description: `Cheque #${cheque.chequeNo}: ${cheque.currency} ${amount.toFixed(2)} applied to ${targetLabel}`,
  });

  const newApplied = round2c(applied + amount);
  return res.json({
    status: true,
    message: `Applied to ${targetLabel}.`,
    application,
    applied: newApplied,
    unapplied: round2c(cheque.amount - newApplied),
  });
});

// POST /cheques/applications/remove/:id — reverses exactly what the
// application wrote, then soft-deletes the row.
exports.removeChequeApplication = catchAsync(async (req, res) => {
  if (!hasChequeAccess(req.user)) {
    return res.status(403).json({ status: false, message: 'You are not authorized to manage cheques.' });
  }
  const tenantId = req.tenantId || req.user?.tenantId;
  if (!tenantId) return res.status(400).json({ status: false, message: 'Tenant context is required.' });

  const app = await ChequeApplication.findOne({
    _id: req.params.id, tenantId, $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
  });
  if (!app) return res.status(404).json({ status: false, message: 'Application not found.' });

  const warnings = [];
  if (app.targetType === 'order_carrier') {
    const order = await Order.findOne({ _id: app.targetId, tenantId });
    if (order) {
      const beforeOrder = order.toObject();
      const legUpdate = {
        carrier_payment_status: 'pending',
        carrier_payment_date: Date.now(),
        carrier_payment_method: '',
        carrier_payment_notes: `Cheque #${app.chequeNo} application removed`,
        carrier_payment_updated_by: req.user?._id,
      };
      const carrierFilter = app.payeeId ? { carrier: app.payeeId } : { carrier: { $ne: null } };
      await Trip.updateMany({ tenantId, order: order._id, deletedAt: null, ...carrierFilter }, { $set: legUpdate });
      const allTrips = await Trip.find({ tenantId, order: order._id, deletedAt: null }).select('carrier carrier_payment_status').lean();
      const rolledStatus = rollupCarrierPaymentStatus(allTrips) || 'pending';
      const updatedOrder = await Order.findOneAndUpdate(
        { _id: order._id, tenantId },
        { $set: { ...legUpdate, carrier_payment_status: rolledStatus } },
        { new: true }
      );
      await PaymentLogs.create({
        tenantId,
        company: req.user?.company?._id || req.user?.company || null,
        order: order._id,
        method: 'cheque',
        status: 'pending',
        type: 'carrier',
        approval: 'approved',
        updated_by: req.user?._id,
      });
      logChange(req, {
        model: 'Order', module: 'order', action: 'PAYMENT',
        before: beforeOrder, after: updatedOrder.toObject(), logUnchanged: true, critical: true,
        description: `Removed cheque #${app.chequeNo} application — carrier payment back to pending on order #${order.serial_no}`,
        resourceId: order._id, resourceName: `#${order.serial_no ?? ''}`,
      });
    } else {
      warnings.push('The order this application pointed at no longer exists.');
    }
  } else if (app.targetType === 'driver_salary' && app.driverPayment) {
    const { removeDriverPaymentCore } = require('./driverSalaryController');
    const result = await removeDriverPaymentCore(req, app.driverPayment);
    if (!result.ok && result.status !== 404) return res.status(result.status).json(result.body);
    if (!result.ok) warnings.push('The payroll payment was already removed on the payroll side.');
  } else if (app.targetType === 'owner_salary' && app.ownerRecord) {
    const { removeOwnerPaymentRecordCore } = require('./ownerOperatorController');
    const result = await removeOwnerPaymentRecordCore(req, app.ownerRecord);
    if (!result.ok && result.status !== 404) return res.status(result.status).json(result.body);
    if (!result.ok) warnings.push('The payroll payment was already removed on the payroll side.');
  }

  const beforeApp = app.toObject();
  app.deletedAt = new Date();
  await app.save();

  logChange(req, {
    model: 'ChequeApplication', module: 'cheque', before: beforeApp, after: app.toObject(),
    resourceId: app.cheque, resourceName: `Cheque #${app.chequeNo}`,
    description: `Cheque #${app.chequeNo}: application to ${app.targetLabel} removed (${app.currency} ${Number(app.amount).toFixed(2)})`,
    critical: true,
  });

  return res.json({ status: true, message: `Application to ${app.targetLabel} removed.`, warnings });
});
