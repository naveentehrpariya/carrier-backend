const catchAsync = require('../utils/catchAsync');
const Vendor = require('../db/Vendor');
const Counter = require('../db/Counter');
const { logChange } = require('../utils/activityLogger');

// Same gate as cheques: vendors exist to be paid, so this is accounting turf.
const hasChequeAccess = (user) => (
  user?.is_admin === 1
  || Number(user?.role) === 3
  || user?.isTenantAdmin === true
  || user?.permissions?.includes('accounting')
  || user?.permissions?.includes('subadmin')
);

const escapeRegex = (s) => String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const notDeleted = { $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }] };

exports.hasChequeAccess = hasChequeAccess;

exports.addVendor = catchAsync(async (req, res) => {
  if (!hasChequeAccess(req.user)) {
    return res.status(403).json({ status: false, message: 'You are not authorized to manage vendors.' });
  }
  const tenantId = req.tenantId || req.user?.tenantId;
  if (!tenantId) return res.status(400).json({ status: false, message: 'Tenant context is required.' });

  const { name, phone, email, emails, address, city, state, country, zipcode, notes } = req.body;
  const trimmedName = String(name || '').trim();
  if (!trimmedName) return res.status(400).json({ status: false, message: 'Please enter vendor name.' });

  let emailsArray = [];
  if (Array.isArray(emails) && emails.length > 0) {
    emailsArray = emails
      .map((e, i) => ({ email: String(e?.email || e || '').trim().toLowerCase(), is_primary: e?.is_primary || i === 0 }))
      .filter((e) => e.email);
  } else if (email) {
    emailsArray = [{ email: String(email).trim().toLowerCase(), is_primary: true }];
  }

  // V1000, V1001, ... — atomic per-tenant counter, race-safe.
  const seq = await Counter.nextSeq(tenantId, 'vendor_code', 1000);
  const code = `V${seq}`;

  const vendor = await Vendor.create({
    tenantId,
    company: req.user?.company?._id || req.user?.company || null,
    code,
    name: trimmedName,
    phone: phone ? String(phone).trim() : undefined,
    email: emailsArray[0]?.email,
    emails: emailsArray,
    address, city, state, country, zipcode, notes,
    created_by: req.user?._id,
  });

  logChange(req, {
    model: 'Vendor', module: 'vendor', after: vendor.toObject(),
    resourceId: vendor._id, resourceName: `${code} ${trimmedName}`,
    description: `Vendor ${code} (${trimmedName}) created`,
  });

  return res.json({ status: true, message: 'Vendor added.', vendor });
});

exports.vendors_listing = catchAsync(async (req, res) => {
  if (!hasChequeAccess(req.user)) {
    return res.status(403).json({ status: false, message: 'You are not authorized to view vendors.' });
  }
  const tenantId = req.tenantId || req.user?.tenantId;
  if (!tenantId) return res.status(400).json({ status: false, message: 'Tenant context is required.' });

  const criteria = { tenantId, ...notDeleted };
  const search = String(req.query.search || '').trim();
  if (search.length >= 2) {
    const rx = new RegExp(escapeRegex(search), 'i');
    criteria.$and = [{
      $or: [
        { name: rx }, { code: rx }, { phone: rx }, { email: rx },
        { 'emails.email': rx }, { city: rx }, { state: rx }, { notes: rx },
      ],
    }];
  }

  const vendors = await Vendor.find(criteria).sort({ createdAt: -1 }).lean();
  return res.json({ status: true, vendors });
});

exports.updateVendor = catchAsync(async (req, res) => {
  if (!hasChequeAccess(req.user)) {
    return res.status(403).json({ status: false, message: 'You are not authorized to manage vendors.' });
  }
  const tenantId = req.tenantId || req.user?.tenantId;
  if (!tenantId) return res.status(400).json({ status: false, message: 'Tenant context is required.' });

  const before = await Vendor.findOne({ _id: req.params.id, tenantId, ...notDeleted }).lean();
  if (!before) return res.status(404).json({ status: false, message: 'Vendor not found.' });

  const { name, phone, email, emails, address, city, state, country, zipcode, notes } = req.body;
  const update = {};
  if (name !== undefined) {
    const trimmedName = String(name || '').trim();
    if (!trimmedName) return res.status(400).json({ status: false, message: 'Vendor name cannot be empty.' });
    update.name = trimmedName;
  }
  if (phone !== undefined) update.phone = String(phone || '').trim();
  if (Array.isArray(emails)) {
    update.emails = emails
      .map((e, i) => ({ email: String(e?.email || e || '').trim().toLowerCase(), is_primary: e?.is_primary || i === 0 }))
      .filter((e) => e.email);
    update.email = update.emails[0]?.email || '';
  } else if (email !== undefined) {
    update.email = String(email || '').trim().toLowerCase();
  }
  ['address', 'city', 'state', 'country', 'zipcode', 'notes'].forEach((k) => {
    if (req.body[k] !== undefined) update[k] = req.body[k];
  });
  // code is never editable — cheque history references it.

  const vendor = await Vendor.findOneAndUpdate(
    { _id: req.params.id, tenantId },
    { $set: update },
    { new: true, runValidators: true }
  );

  logChange(req, {
    model: 'Vendor', module: 'vendor', before, after: vendor.toObject(),
    resourceId: vendor._id, resourceName: `${vendor.code} ${vendor.name}`,
  });

  return res.json({ status: true, message: 'Vendor updated.', vendor });
});

exports.deleteVendor = catchAsync(async (req, res) => {
  if (!hasChequeAccess(req.user)) {
    return res.status(403).json({ status: false, message: 'You are not authorized to manage vendors.' });
  }
  const tenantId = req.tenantId || req.user?.tenantId;
  if (!tenantId) return res.status(400).json({ status: false, message: 'Tenant context is required.' });

  const before = await Vendor.findOne({ _id: req.params.id, tenantId, ...notDeleted }).lean();
  if (!before) return res.status(404).json({ status: false, message: 'Vendor not found.' });

  const vendor = await Vendor.findOneAndUpdate(
    { _id: req.params.id, tenantId },
    { $set: { deletedAt: new Date() } },
    { new: true }
  );

  logChange(req, {
    model: 'Vendor', module: 'vendor', before, after: vendor.toObject(),
    resourceId: vendor._id, resourceName: `${vendor.code} ${vendor.name}`,
    description: `Vendor ${vendor.code} (${vendor.name}) deleted`,
  });

  return res.json({ status: true, message: 'Vendor removed. Existing cheques keep their snapshot.' });
});
