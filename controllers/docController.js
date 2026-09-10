/**
 * Typed document metadata + expiry alerts for trucks, trailers and employees/drivers.
 *
 * Docs used to be bare file uploads (FleetDoc / EmployeeDoc). They now carry
 * docType / docNumber / issueDate / expiryDate so the app can say WHAT a file
 * is and warn BEFORE it expires. A doc may exist with no file at all — the
 * client records the licence number and expiry the day the driver is hired,
 * the scan can follow later.
 */
const mongoose = require('mongoose');
const catchAsync = require('../utils/catchAsync');
const FleetDoc = require('../db/FleetDoc');
const EmployeeDoc = require('../db/EmployeeDoc');
const Truck = require('../db/Truck');
const Trailer = require('../db/Trailer');
const Users = require('../db/Users');
const OwnerOperator = require('../db/OwnerOperator');
const DriverProfile = require('../db/DriverProfile');
const Carrier = require('../db/Carrier');
const Customer = require('../db/Customer');
const Vendor = require('../db/Vendor');
const {
  customerVisibilityOr, hasCarrierAccess, hasVendorAccess,
} = require('../utils/entityVisibility');
const fileupload = require('../utils/fileupload');
const { logChange } = require('../utils/activityLogger');

const DOC_TYPES = [
  'license', 'rc', 'insurance', 'permit', 'fitness', 'puc',
  'pan', 'aadhaar', 'voter_id', 'passport',
  // Commercial paperwork. A carrier packet is the reason this feature reaches past
  // the fleet: an operating authority never expires, a certificate of insurance does,
  // and handing a load to a carrier whose COI lapsed is a liability, not a nuisance.
  'w9', 'authority', 'coi', 'agreement', 'noa', 'credit_app', 'tax_exempt',
  'other',
];

/**
 * Every extra field any document type can carry (frontend `utils/docTypes.js`
 * decides which type shows which). The backend deliberately does NOT encode the
 * per-type layout — it only guarantees the keys are known and the values are
 * short strings, so the two sides cannot drift into disagreeing about a shape.
 */
const DOC_FIELD_KEYS = [
  'holderName', 'fatherName', 'dob', 'gender', 'bloodGroup', 'address',
  'surname', 'givenName', 'nationality', 'placeOfIssue',
  'ownerName', 'makerModel', 'chassisNo', 'engineNo', 'fuelType', 'vehicleClass', 'vehicleNo',
  'insurer', 'insuredName', 'coverType', 'sumInsured',
  'permitType', 'issuingAuthority', 'testDate', 'centre',
  // Commercial documents
  'mcNumber', 'dotNumber', 'taxId', 'coverageType', 'coverageAmount',
  'agreementStart', 'safetyRating', 'legalName',
];
const MAX_FIELD_CHARS = 120;
const KINDS = ['truck', 'trailer', 'owner_operator', 'carrier', 'customer', 'vendor', 'employee'];

// Same rule as authController.hasStaffDirectoryAccess — a licence, passport or PAN
// is personal data and stays HR-gated.
const hasStaffDocAccess = (user) => {
  if (!user) return false;
  if (user.is_admin === 1 || Number(user.role) === 3 || user.isTenantAdmin) return true;
  const perms = Array.isArray(user.permissions) ? user.permissions : [];
  return perms.includes('employees') || perms.includes('subadmin');
};

// A truck's RC or insurance is not personal data — whoever can see the truck can see
// that it is about to expire. A plain driver (permission `driver` only) gets nothing.
const hasFleetDocAccess = (user) => {
  if (!user) return false;
  if (hasStaffDocAccess(user)) return true;
  const perms = Array.isArray(user.permissions) ? user.permissions : [];
  return perms.includes('regular') || perms.includes('outsourcing');
};

const isValidObjectId = (id) => mongoose.Types.ObjectId.isValid(String(id || ''));

/**
 * Pull typed-doc metadata out of a request body. Returns { fields, error }.
 * Only keys present in the body are returned, so a PUT can send just the
 * fields it wants to change (absent means "leave it alone" — same rule as
 * editCustomer.assigned_to).
 */
function parseDocMeta(body = {}) {
  const fields = {};
  if ('docType' in body) {
    const t = body.docType === null || body.docType === '' ? null : String(body.docType);
    if (t !== null && !DOC_TYPES.includes(t)) return { error: `Invalid docType. Allowed: ${DOC_TYPES.join(', ')}` };
    fields.docType = t;
  }
  if ('docTypeLabel' in body) {
    fields.docTypeLabel = body.docTypeLabel ? String(body.docTypeLabel).slice(0, 60) : null;
  }
  if ('docNumber' in body) {
    fields.docNumber = body.docNumber ? String(body.docNumber).slice(0, 60) : null;
  }
  for (const key of ['issueDate', 'expiryDate']) {
    if (!(key in body)) continue;
    if (body[key] === null || body[key] === '') { fields[key] = null; continue; }
    const d = new Date(body[key]);
    if (Number.isNaN(d.getTime())) return { error: `Invalid ${key}` };
    fields[key] = d;
  }
  if (fields.issueDate && fields.expiryDate && fields.expiryDate < fields.issueDate) {
    return { error: 'Expiry date cannot be before issue date' };
  }
  if ('docFields' in body) {
    // Multipart can only carry strings, so the object arrives JSON-encoded there.
    let raw = body.docFields;
    if (typeof raw === 'string') {
      const trimmed = raw.trim();
      if (trimmed === '' || trimmed === 'null' || trimmed === 'undefined') raw = null;
      else {
        try { raw = JSON.parse(trimmed); } catch { return { error: 'Invalid document fields' }; }
      }
    }
    if (raw === null || raw === undefined) {
      fields.docFields = null;
    } else if (typeof raw !== 'object' || Array.isArray(raw)) {
      return { error: 'Invalid document fields' };
    } else {
      const clean = {};
      for (const [key, value] of Object.entries(raw)) {
        if (!DOC_FIELD_KEYS.includes(key)) return { error: `Unknown document field: ${key}` };
        if (value === null || value === undefined || value === '') continue;
        if (typeof value === 'object') return { error: `Invalid value for ${key}` };
        clean[key] = String(value).slice(0, MAX_FIELD_CHARS);
      }
      fields.docFields = Object.keys(clean).length ? clean : null;
    }
  }
  return { fields };
}

/** Resolve model + entity check for a kind. Returns { Model, entity } or null. */
async function resolveKind(kind, entityId, tenantId, user) {
  if (kind === 'truck') {
    const entity = await Truck.findOne({ _id: entityId, tenantId, deletedAt: null }).select('_id plateNumber truckNumber unitNumber').lean();
    return entity ? { Model: FleetDoc, entity, fleetType: 'truck' } : null;
  }
  if (kind === 'trailer') {
    const entity = await Trailer.findOne({ _id: entityId, tenantId, deletedAt: null }).select('_id plateNumber unitNumber type').lean();
    return entity ? { Model: FleetDoc, entity, fleetType: 'trailer' } : null;
  }
  if (kind === 'owner_operator') {
    const entity = await OwnerOperator.findOne({ _id: entityId, tenantId, deletedAt: null }).select('_id fullName companyName').lean();
    return entity ? { Model: FleetDoc, entity, fleetType: 'owner_operator' } : null;
  }
  if (kind === 'carrier') {
    const entity = await Carrier.findOne({ _id: entityId, tenantId, deletedAt: null }).select('_id name company_name mc_code').lean();
    return entity ? { Model: FleetDoc, entity, fleetType: 'carrier' } : null;
  }
  if (kind === 'customer') {
    // Scoped, not just tenant-filtered: a customer this user may not see must not
    // become addressable through its documents.
    const criteria = { _id: entityId, tenantId, deletedAt: null };
    const scope = customerVisibilityOr(user);
    if (scope) criteria.$or = scope;
    const entity = await Customer.findOne(criteria).select('_id name company_name').lean();
    return entity ? { Model: FleetDoc, entity, fleetType: 'customer' } : null;
  }
  if (kind === 'vendor') {
    const entity = await Vendor.findOne({ _id: entityId, tenantId, deletedAt: null }).select('_id name code').lean();
    return entity ? { Model: FleetDoc, entity, fleetType: 'vendor' } : null;
  }
  if (kind === 'employee') {
    const entity = await Users.findOne({ _id: entityId, tenantId }, null, { includeInactive: true }).select('_id name').lean();
    return entity ? { Model: EmployeeDoc, entity } : null;
  }
  return null;
}

function entityLabel(kind, e) {
  if (!e) return '—';
  if (kind === 'truck') return e.unitNumber || e.truckNumber || e.plateNumber || 'Truck';
  if (kind === 'trailer') return e.unitNumber || e.plateNumber || e.type || 'Trailer';
  if (kind === 'owner_operator') return e.fullName || e.companyName || 'Owner Operator';
  if (kind === 'carrier') return e.name || e.company_name || 'Carrier';
  if (kind === 'customer') return e.name || e.company_name || 'Customer';
  if (kind === 'vendor') return e.name || e.code || 'Vendor';
  return e.name || 'Employee';
}

/** Employee-doc writes: HR or the employee's own record. Fleet-doc writes: any tenant user (same as upload routes). */
function canWriteEmployeeDoc(req, employeeId) {
  return hasStaffDocAccess(req.user) || String(req.user?._id || '') === String(employeeId || '');
}

/**
 * A commercial record's documents follow that record's own audience, not the fleet's.
 * A dispatcher who cannot open a customer must not be able to read their credit
 * application; `resolveKind` already scopes the customer lookup, so reaching one here
 * means the user can see it.
 */
function canWriteCommercialDoc(req, kind) {
  if (kind === 'carrier') return hasCarrierAccess(req.user);
  if (kind === 'vendor') return hasVendorAccess(req.user);
  if (kind === 'customer') return true; // resolveKind applied the visibility scope
  return false;
}
const COMMERCIAL_KINDS = ['carrier', 'customer', 'vendor'];

// ---------------------------------------------------------------------------
// POST /docs/:kind/:entityId — metadata-only document (no file)
// ---------------------------------------------------------------------------
const createDoc = catchAsync(async (req, res) => {
  const { kind, entityId } = req.params;
  const tenantId = req.tenantId || req.user?.tenantId;
  if (!tenantId) return res.status(400).json({ status: false, message: 'Tenant context is required.' });
  if (!KINDS.includes(kind)) return res.status(400).json({ status: false, message: 'Invalid document kind.' });
  if (!isValidObjectId(entityId)) return res.status(400).json({ status: false, message: 'Invalid entity id.' });

  const resolved = await resolveKind(kind, entityId, tenantId, req.user);
  if (!resolved) return res.status(404).json({ status: false, message: `${kind} not found.` });
  if (kind === 'employee' && !canWriteEmployeeDoc(req, entityId)) {
    return res.status(403).json({ status: false, message: 'You are not authorized to manage these documents.' });
  }
  if (COMMERCIAL_KINDS.includes(kind) && !canWriteCommercialDoc(req, kind)) {
    return res.status(403).json({ status: false, message: 'You are not authorized to manage these documents.' });
  }

  const { fields, error } = parseDocMeta(req.body);
  if (error) return res.status(400).json({ status: false, message: error });
  if (!fields.docType) return res.status(400).json({ status: false, message: 'docType is required.' });
  if (fields.docType === 'other' && !fields.docTypeLabel) {
    return res.status(400).json({ status: false, message: 'A label is required for "other" documents.' });
  }

  const base = {
    tenantId,
    name: req.body.name ? String(req.body.name).slice(0, 120) : (fields.docTypeLabel || fields.docType),
    added_by: req.user._id,
    ...fields,
  };

  if (req.files?.attachment?.[0]) {
    const uploadResponse = await fileupload(req.files.attachment[0]);
    if (uploadResponse?.file) {
      base.name = req.body.name ? String(req.body.name).slice(0, 120) : uploadResponse.file.originalname;
      base.mime = uploadResponse.mime;
      base.filename = uploadResponse.filename;
      base.url = uploadResponse.url;
      base.size = String(uploadResponse.size || '');
    } else {
      return res.status(500).json({ status: false, message: 'File upload failed.' });
    }
  }

  let doc;
  if (kind === 'employee') {
    doc = await EmployeeDoc.create({ ...base, user: entityId, company: req.user?.company?._id || req.user?.company || null });
  } else {
    doc = await FleetDoc.create({ ...base, type: resolved.fleetType, entityId });
  }

  logChange(req, {
    model: kind === 'employee' ? 'EmployeeDoc' : 'FleetDoc',
    module: kind === 'employee' ? 'employees' : 'fleet',
    action: 'CREATE',
    after: doc.toObject(),
    description: `Added ${fields.docType}${fields.docNumber ? ` ${fields.docNumber}` : ''} for ${kind} ${entityLabel(kind, resolved.entity)}`,
    resourceId: doc._id,
    resourceName: entityLabel(kind, resolved.entity),
  });

  return res.status(201).json({ status: true, message: 'Document added.', document: doc });
});

// ---------------------------------------------------------------------------
// PUT /docs/:kind/update/:docId — edit metadata (renewals edit expiry here)
// ---------------------------------------------------------------------------
const updateDoc = catchAsync(async (req, res) => {
  const { kind, docId } = req.params;
  const tenantId = req.tenantId || req.user?.tenantId;
  if (!tenantId) return res.status(400).json({ status: false, message: 'Tenant context is required.' });
  if (!KINDS.includes(kind)) return res.status(400).json({ status: false, message: 'Invalid document kind.' });
  if (!isValidObjectId(docId)) return res.status(400).json({ status: false, message: 'Invalid document id.' });

  const Model = kind === 'employee' ? EmployeeDoc : FleetDoc;
  const criteria = { _id: docId, tenantId, deletedAt: null };
  if (kind !== 'employee') criteria.type = kind;
  const before = await Model.findOne(criteria).lean();
  if (!before) return res.status(404).json({ status: false, message: 'Document not found.' });
  if (kind === 'employee' && !canWriteEmployeeDoc(req, before.user)) {
    return res.status(403).json({ status: false, message: 'You are not authorized to manage these documents.' });
  }
  if (COMMERCIAL_KINDS.includes(kind)) {
    if (!canWriteCommercialDoc(req, kind)) {
      return res.status(403).json({ status: false, message: 'You are not authorized to manage these documents.' });
    }
    // The row carries no assignment of its own — re-resolve the record it hangs off.
    const stillVisible = await resolveKind(kind, before.entityId, tenantId, req.user);
    if (!stillVisible) return res.status(404).json({ status: false, message: 'Document not found.' });
  }

  const { fields, error } = parseDocMeta(req.body);
  if (error) return res.status(400).json({ status: false, message: error });

  const effectiveType = 'docType' in fields ? fields.docType : before.docType;
  const effectiveLabel = 'docTypeLabel' in fields ? fields.docTypeLabel : before.docTypeLabel;
  if (effectiveType === 'other' && (!effectiveLabel || !String(effectiveLabel).trim())) {
    return res.status(400).json({ status: false, message: 'A label is required for "other" documents.' });
  }

  // Cross-check against stored dates when only one side is in the payload.
  const issue = 'issueDate' in fields ? fields.issueDate : before.issueDate;
  const expiry = 'expiryDate' in fields ? fields.expiryDate : before.expiryDate;
  if (issue && expiry && new Date(expiry) < new Date(issue)) {
    return res.status(400).json({ status: false, message: 'Expiry date cannot be before issue date' });
  }
  if ('name' in req.body) fields.name = req.body.name ? String(req.body.name).slice(0, 120) : before.name;

  if (req.files?.attachment?.[0]) {
    const uploadResponse = await fileupload(req.files.attachment[0]);
    if (uploadResponse?.file) {
      fields.name = req.body.name ? String(req.body.name).slice(0, 120) : uploadResponse.file.originalname;
      fields.mime = uploadResponse.mime;
      fields.filename = uploadResponse.filename;
      fields.url = uploadResponse.url;
      fields.size = String(uploadResponse.size || '');
    } else {
      return res.status(500).json({ status: false, message: 'File upload failed.' });
    }
  }

  fields.updatedAt = new Date();
  fields.updatedBy = req.user._id;

  const doc = await Model.findOneAndUpdate(criteria, { $set: fields }, { new: true, runValidators: true });
  if (!doc) return res.status(404).json({ status: false, message: 'Document not found.' });

  logChange(req, {
    model: kind === 'employee' ? 'EmployeeDoc' : 'FleetDoc',
    module: kind === 'employee' ? 'employees' : 'fleet',
    before,
    after: doc.toObject(),
    resourceId: doc._id,
    resourceName: doc.docNumber || doc.name || String(doc._id),
  });

  return res.json({ status: true, message: 'Document updated.', document: doc });
});

// ---------------------------------------------------------------------------
// POST /docs/:kind/remove/:docId — soft delete
// ---------------------------------------------------------------------------
const removeDoc = catchAsync(async (req, res) => {
  const { kind, docId } = req.params;
  const tenantId = req.tenantId || req.user?.tenantId;
  if (!tenantId) return res.status(400).json({ status: false, message: 'Tenant context is required.' });
  if (!KINDS.includes(kind)) return res.status(400).json({ status: false, message: 'Invalid document kind.' });
  if (!isValidObjectId(docId)) return res.status(400).json({ status: false, message: 'Invalid document id.' });

  const Model = kind === 'employee' ? EmployeeDoc : FleetDoc;
  const criteria = { _id: docId, tenantId, deletedAt: null };
  if (kind !== 'employee') criteria.type = kind;
  const before = await Model.findOne(criteria).lean();
  if (!before) return res.status(404).json({ status: false, message: 'Document not found.' });
  if (kind === 'employee' && !canWriteEmployeeDoc(req, before.user)) {
    return res.status(403).json({ status: false, message: 'You are not authorized to manage these documents.' });
  }
  if (COMMERCIAL_KINDS.includes(kind)) {
    if (!canWriteCommercialDoc(req, kind)) {
      return res.status(403).json({ status: false, message: 'You are not authorized to manage these documents.' });
    }
    // The row carries no assignment of its own — re-resolve the record it hangs off.
    const stillVisible = await resolveKind(kind, before.entityId, tenantId, req.user);
    if (!stillVisible) return res.status(404).json({ status: false, message: 'Document not found.' });
  }

  await Model.updateOne(criteria, { $set: { deletedAt: new Date(), updatedBy: req.user._id, updatedAt: new Date() } });

  logChange(req, {
    model: kind === 'employee' ? 'EmployeeDoc' : 'FleetDoc',
    module: kind === 'employee' ? 'employees' : 'fleet',
    action: 'DELETE',
    before,
    after: null,
    description: `Removed document ${before.docNumber || before.name || docId}`,
    resourceId: before._id,
    resourceName: before.docNumber || before.name || String(before._id),
  });

  return res.json({ status: true, message: 'Document removed.' });
});

// ---------------------------------------------------------------------------
// GET /alerts/document-expiry — everything expired or expiring within 30 days
// ---------------------------------------------------------------------------
const DAY_MS = 24 * 60 * 60 * 1000;

function expiryStatus(expiryDate, now) {
  // Calendar-date diff, not millisecond diff — a Sep 2 expiry is not "expired"
  // while it is still Sep 2 somewhere. Same rule as the cheque dates.
  const d = new Date(expiryDate);
  const expiryDay = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const days = Math.round((expiryDay - today) / DAY_MS);
  if (days < 0) return { status: 'expired', daysLeft: days };
  if (days <= 7) return { status: 'week', daysLeft: days };
  return { status: 'month', daysLeft: days };
}

const documentExpiryAlerts = catchAsync(async (req, res) => {
  const tenantId = req.tenantId || req.user?.tenantId;
  if (!tenantId) return res.status(400).json({ status: false, message: 'Tenant context is required.' });
  // Fleet documents and personal documents have different audiences — a dispatcher
  // needs to know the truck's RC lapses on Friday; only HR sees a driver's passport.
  const seeStaff = hasStaffDocAccess(req.user);
  const seeFleet = hasFleetDocAccess(req.user);
  const seeCarrier = hasCarrierAccess(req.user);
  const seeVendor = hasVendorAccess(req.user);
  // Customers are not gated by a permission but by ASSIGNMENT — everyone sees some,
  // most people see only theirs. `customerScope` null means "all of them".
  const customerScope = customerVisibilityOr(req.user);
  if (!seeStaff && !seeFleet && !seeCarrier && !seeVendor) {
    return res.status(403).json({ status: false, message: 'You are not authorized to view document alerts.' });
  }

  const now = new Date();
  const horizon = new Date(now.getTime() + 30 * DAY_MS);
  const expiring = { $ne: null, $lte: horizon };

  const [fleetDocs, employeeDocs, driverProfiles] = await Promise.all([
    // One collection, several audiences — ask only for the types this user may read.
    (() => {
      const types = [];
      if (seeFleet) types.push('truck', 'trailer', 'owner_operator');
      if (seeCarrier) types.push('carrier');
      if (seeVendor) types.push('vendor');
      types.push('customer'); // scoped below by assignment, never by permission
      return FleetDoc.find({ tenantId, deletedAt: null, expiryDate: expiring, type: { $in: types } })
        .sort({ expiryDate: 1 }).lean();
    })(),
    seeStaff ? EmployeeDoc.find({ tenantId, deletedAt: null, expiryDate: expiring }).sort({ expiryDate: 1 }).lean() : [],
    // Driver licences recorded on the profile, not as a doc row. Users pre-find
    // hook hides inactive users when we join below, so a departed driver never alerts.
    seeStaff ? DriverProfile.find({ tenantId, licenseExpiry: expiring }).select('user licenseNumber licenseExpiry').lean() : [],
  ]);

  // Join entity names in three set lookups — never a populate per doc.
  const truckIds = fleetDocs.filter(d => d.type === 'truck').map(d => d.entityId);
  const trailerIds = fleetDocs.filter(d => d.type === 'trailer').map(d => d.entityId);
  const ownerIds = fleetDocs.filter(d => d.type === 'owner_operator').map(d => d.entityId);
  const carrierIds = fleetDocs.filter(d => d.type === 'carrier').map(d => d.entityId);
  const customerIds = fleetDocs.filter(d => d.type === 'customer').map(d => d.entityId);
  const vendorIds = fleetDocs.filter(d => d.type === 'vendor').map(d => d.entityId);
  const userIds = [
    ...employeeDocs.map(d => d.user),
    ...driverProfiles.map(p => p.user),
  ].filter(Boolean);

  // A customer the user may not see is simply never looked up, so its documents
  // find no entity below and are dropped — the same path a deleted record takes.
  const customerCriteria = { _id: { $in: customerIds }, tenantId, deletedAt: null };
  if (customerScope) customerCriteria.$or = customerScope;

  const [trucks, trailers, owners, users, carriers, customers, vendors] = await Promise.all([
    truckIds.length ? Truck.find({ _id: { $in: truckIds }, tenantId, deletedAt: null }).select('plateNumber truckNumber unitNumber').lean() : [],
    trailerIds.length ? Trailer.find({ _id: { $in: trailerIds }, tenantId, deletedAt: null }).select('plateNumber unitNumber type').lean() : [],
    ownerIds.length ? OwnerOperator.find({ _id: { $in: ownerIds }, tenantId, deletedAt: null }).select('fullName companyName').lean() : [],
    userIds.length ? Users.find({ _id: { $in: userIds }, tenantId }).select('name').lean() : [],
    carrierIds.length ? Carrier.find({ _id: { $in: carrierIds }, tenantId, deletedAt: null }).select('name company_name').lean() : [],
    customerIds.length ? Customer.find(customerCriteria).select('name company_name').lean() : [],
    vendorIds.length ? Vendor.find({ _id: { $in: vendorIds }, tenantId, deletedAt: null }).select('name code').lean() : [],
  ]);
  const entityMaps = {
    truck: new Map(trucks.map(t => [String(t._id), t])),
    trailer: new Map(trailers.map(t => [String(t._id), t])),
    owner_operator: new Map(owners.map(o => [String(o._id), o])),
    carrier: new Map(carriers.map(c => [String(c._id), c])),
    customer: new Map(customers.map(c => [String(c._id), c])),
    vendor: new Map(vendors.map(v => [String(v._id), v])),
  };
  const userMap = new Map(users.map(u => [String(u._id), u]));

  const items = [];
  for (const d of fleetDocs) {
    const entity = entityMaps[d.type]?.get(String(d.entityId));
    if (!entity) continue; // deleted record, or a customer this user may not see
    items.push({
      source: 'fleet_doc', docId: d._id, kind: d.type,
      docType: d.docType, docTypeLabel: d.docTypeLabel, docNumber: d.docNumber,
      name: d.name, expiryDate: d.expiryDate,
      entity: { id: d.entityId, label: entityLabel(d.type, entity) },
      ...expiryStatus(d.expiryDate, now),
    });
  }
  for (const d of employeeDocs) {
    const u = userMap.get(String(d.user));
    if (!u) continue; // inactive/removed employee
    items.push({
      source: 'employee_doc', docId: d._id, kind: 'employee',
      docType: d.docType, docTypeLabel: d.docTypeLabel, docNumber: d.docNumber,
      name: d.name, expiryDate: d.expiryDate,
      entity: { id: d.user, label: u.name || 'Employee' },
      ...expiryStatus(d.expiryDate, now),
    });
  }
  // Deliberately a SEPARATE query, not a filter over `employeeDocs`: that list only
  // holds docs already expiring within 30 days, so a renewed licence (expiring years
  // out) was absent from it and the stale profile date kept alerting forever.
  const profileUserIds = driverProfiles.map(p => p.user).filter(Boolean);
  const licenceDocs = profileUserIds.length
    ? await EmployeeDoc.find({
        tenantId, deletedAt: null, docType: 'license', user: { $in: profileUserIds },
        // Only a doc that records an expiry can replace the profile's date. One
        // captured with just a licence number has nothing to alert on, and
        // silencing the profile for it would hide a real expiry.
        expiryDate: { $ne: null },
      }).select('user').lean()
    : [];
  const employeeLicenseUserIds = new Set(licenceDocs.map(d => String(d.user)));
  for (const p of driverProfiles) {
    const u = userMap.get(String(p.user));
    if (!u) continue;
    // A typed licence document is the better record — the profile field is the legacy
    // fallback, so it never speaks for a driver who has one.
    if (employeeLicenseUserIds.has(String(p.user))) continue;
    items.push({
      source: 'driver_profile', docId: p._id, kind: 'driver',
      docType: 'license', docTypeLabel: null, docNumber: p.licenseNumber || null,
      name: 'Driver licence (profile)', expiryDate: p.licenseExpiry,
      entity: { id: p.user, label: u.name || 'Driver' },
      ...expiryStatus(p.licenseExpiry, now),
    });
  }

  items.sort((a, b) => new Date(a.expiryDate) - new Date(b.expiryDate));
  const counts = {
    expired: items.filter(i => i.status === 'expired').length,
    week: items.filter(i => i.status === 'week').length,
    month: items.filter(i => i.status === 'month').length,
    total: items.length,
  };

  // Worst status per entity, so a list page can flag the row itself without
  // asking for every truck's documents one by one.
  const RANK = { month: 1, week: 2, expired: 3 };
  const byEntity = {};
  for (const it of items) {
    const key = String(it.entity?.id || '');
    if (!key) continue;
    const prev = byEntity[key];
    if (!prev || RANK[it.status] > RANK[prev.status]) {
      byEntity[key] = { status: it.status, daysLeft: it.daysLeft, expiryDate: it.expiryDate, docType: it.docType, docTypeLabel: it.docTypeLabel, count: 0 };
    }
  }
  for (const it of items) {
    const key = String(it.entity?.id || '');
    if (byEntity[key]) byEntity[key].count += 1;
  }

  return res.json({ status: true, items, counts, byEntity });
});

module.exports = { createDoc, updateDoc, removeDoc, documentExpiryAlerts, parseDocMeta, DOC_TYPES, DOC_FIELD_KEYS };
