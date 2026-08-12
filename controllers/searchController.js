const Order = require('../db/Order');
const Customer = require('../db/Customer');
const Carrier = require('../db/Carrier');
const Truck = require('../db/Truck');
const Trailer = require('../db/Trailer');
const User = require('../db/Users');
const DriverProfile = require('../db/DriverProfile');
const OwnerOperator = require('../db/OwnerOperator');

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeCompanyId(req) {
  const raw = req.user?.company?._id || req.user?.company;
  return raw ? String(raw) : null;
}

const NOT_DELETED = { $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }] };

// How many docs we pull per collection before scoring. Display limit is applied
// after ranking, and the same scan feeds the order-by-relation lookup.
const SCAN_LIMIT = 200;

/**
 * Searchable field table — one definition per entity, used to BUILD the Mongo
 * query and to SCORE the results, so the two can never drift apart.
 * weight = how much a hit on that field means (name/number high, address low).
 */
const FIELD_SETS = {
  customers: [
    { path: 'name', weight: 100 },
    { path: 'customerCode', weight: 95 },
    { path: 'email', weight: 85 },
    { path: 'secondary_email', weight: 85 },
    { path: 'emails.email', weight: 85 },
    { path: 'phone', weight: 80, phone: true },
    { path: 'secondary_phone', weight: 80, phone: true },
    { path: 'address', weight: 40 },
    { path: 'city', weight: 45 },
    { path: 'state', weight: 35 },
    { path: 'country', weight: 30 },
    { path: 'zipcode', weight: 45 }
  ],
  carriers: [
    { path: 'name', weight: 100 },
    { path: 'mc_code', weight: 95 },
    { path: 'carrierID', weight: 95 },
    { path: 'email', weight: 85 },
    { path: 'secondary_email', weight: 85 },
    { path: 'emails.email', weight: 85 },
    { path: 'phone', weight: 80, phone: true },
    { path: 'secondary_phone', weight: 80, phone: true },
    { path: 'location', weight: 45 },
    { path: 'address', weight: 40 },
    { path: 'city', weight: 45 },
    { path: 'state', weight: 35 },
    { path: 'country', weight: 30 },
    { path: 'zipcode', weight: 45 }
  ],
  ownerOperators: [
    { path: 'fullName', weight: 100 },
    { path: 'companyName', weight: 90 },
    { path: 'ownerOperatorId', weight: 95 },
    { path: 'email', weight: 85 },
    { path: 'phone', weight: 80, phone: true },
    { path: 'address', weight: 40 },
    { path: 'city', weight: 45 },
    { path: 'state', weight: 35 },
    { path: 'zipcode', weight: 45 },
    { path: 'notes', weight: 25 }
  ],
  drivers: [
    { path: 'name', weight: 100 },
    { path: 'corporateID', weight: 95 },
    { path: 'email', weight: 85 },
    { path: 'phone', weight: 80, phone: true },
    { path: 'position', weight: 40 },
    { path: 'address', weight: 35 },
    { path: 'city', weight: 40 },
    { path: 'state', weight: 30 },
    { path: 'zipcode', weight: 40 }
  ],
  driverProfiles: [
    { path: 'emails.email', weight: 85 },
    { path: 'phones.phone', weight: 80, phone: true },
    { path: 'licenseNumber', weight: 95 }
  ],
  trucks: [
    { path: 'plateNumber', weight: 100 },
    { path: 'unitNumber', weight: 95 },
    { path: 'truckNumber', weight: 95 },
    { path: 'vin', weight: 90 },
    { path: 'make', weight: 55 },
    { path: 'model', weight: 55 },
    { path: 'capacity', weight: 35 },
    { path: 'notes', weight: 25 },
    { path: 'year', weight: 40, numeric: { min: 1900, max: 2100 } }
  ],
  trailers: [
    { path: 'plateNumber', weight: 100 },
    { path: 'unitNumber', weight: 95 },
    { path: 'vin', weight: 90 },
    { path: 'licenseNumber', weight: 90 },
    { path: 'type', weight: 55 },
    { path: 'make', weight: 50 },
    { path: 'model', weight: 50 },
    { path: 'notes', weight: 25 },
    { path: 'length', weight: 35, numeric: { min: 1, max: 200 } }
  ],
  orders: [
    { path: 'serial_no', weight: 100, numeric: { min: 1, max: 99999999 }, numericAsText: true },
    { path: 'customer_order_no', weight: 95 },
    { path: 'company_name', weight: 80 },
    { path: 'shipping_details.reference', weight: 90 },
    { path: 'shipping_details.locations.referenceNo', weight: 90 },
    { path: 'shipping_details.locations.location', weight: 55 },
    { path: 'shipping_details.locations.address', weight: 50 },
    { path: 'shipping_details.locations.city', weight: 55 },
    { path: 'order_status', weight: 35 },
    { path: 'notes', weight: 25 }
  ]
};

// Order the UI renders sections in. People look up a customer or a carrier far
// more often than they look up an order by its stops, so entities come first
// and orders sit at the bottom (a strong direct hit still surfaces as `best`).
const SECTION_ORDER = [
  { key: 'customers', title: 'Customers' },
  { key: 'carriers', title: 'Carriers' },
  { key: 'drivers', title: 'Drivers' },
  { key: 'employees', title: 'Employees' },
  { key: 'ownerOperators', title: 'Owner Operators' },
  { key: 'trucks', title: 'Trucks' },
  { key: 'trailers', title: 'Trailers' },
  { key: 'orders', title: 'Orders' }
];

// Caps keep a pasted wall of text from turning into a giant regex query.
const MAX_QUERY_LENGTH = 120;
const MAX_TOKENS = 6;
const MAX_PHONE_DIGITS = 15;

/** "3058941118" also matches "(305) 894-1118" — separators are ignored. */
function looseDigitsRegex(digits) {
  return new RegExp(digits.slice(0, MAX_PHONE_DIGITS).split('').map((d) => escapeRegex(d)).join('\\D*'), 'i');
}

/** Every token must match SOME field (AND across tokens, OR across fields). */
function buildFieldQuery(tokens, fields, qDigits) {
  const and = tokens.map((token) => {
    const r = new RegExp(escapeRegex(token), 'i');
    const or = [];
    for (const f of fields) {
      if (f.numeric) {
        const num = Number(token);
        if (Number.isFinite(num) && num >= f.numeric.min && num <= f.numeric.max) {
          or.push({ [f.path]: num });
        }
        if (f.numericAsText && /\d/.test(token)) {
          or.push({
            $expr: { $regexMatch: { input: { $toString: `$${f.path}` }, regex: escapeRegex(token) } }
          });
        }
        continue;
      }
      or.push({ [f.path]: r });
    }
    return or.length ? { $or: or } : null;
  }).filter(Boolean);

  // Phone typed with separators, or stored with them.
  if (qDigits && qDigits.length >= 4) {
    const loose = looseDigitsRegex(qDigits);
    const phoneFields = fields.filter((f) => f.phone);
    if (phoneFields.length) {
      and.push({ $or: phoneFields.map((f) => ({ [f.path]: loose })) });
    }
  }
  return and;
}

function valuesAtPath(doc, path) {
  const parts = path.split('.');
  let current = [doc];
  for (const part of parts) {
    const next = [];
    for (const node of current) {
      if (node === null || node === undefined) continue;
      if (Array.isArray(node)) {
        for (const item of node) {
          if (item && typeof item === 'object') next.push(item[part]);
        }
      } else if (typeof node === 'object') {
        next.push(node[part]);
      }
    }
    current = next.flat();
  }
  return current.filter((v) => v !== null && v !== undefined && v !== '');
}

/** 0 → no match, 1 → exact. Everything between is how close the hit is. */
function matchStrength(value, ctx) {
  const text = String(value).toLowerCase();
  if (!text) return 0;
  if (text === ctx.q) return 1;
  if (text.startsWith(ctx.q)) return 0.85;
  if (ctx.wordRegex && ctx.wordRegex.test(text)) return 0.7;
  if (text.includes(ctx.q)) return 0.55;
  if (ctx.tokens.length > 1) {
    const hits = ctx.tokens.filter((t) => text.includes(t)).length;
    if (hits === ctx.tokens.length) return 0.45;
    if (hits) return 0.2 * (hits / ctx.tokens.length);
  }
  if (ctx.digits && ctx.digits.length >= 4) {
    const digitsOnly = text.replace(/[^0-9]/g, '');
    if (digitsOnly && digitsOnly.includes(ctx.digits)) return 0.6;
  }
  return 0;
}

function scoreDoc(doc, fields, ctx) {
  let best = 0;
  let extra = 0;
  const matchedFields = [];
  for (const f of fields) {
    for (const value of valuesAtPath(doc, f.path)) {
      const strength = matchStrength(value, ctx);
      if (!strength) continue;
      const fieldScore = strength * (f.weight || 50);
      if (fieldScore > best) best = fieldScore;
      else extra += fieldScore * 0.15;
      matchedFields.push({ field: f.path, value: String(value).slice(0, 120) });
      break; // one hit per field is enough
    }
  }
  if (!best) return null;
  const created = doc.updatedAt || doc.createdAt;
  const recency = created ? Math.max(0, 5 - (Date.now() - new Date(created).getTime()) / (1000 * 60 * 60 * 24 * 90)) : 0;
  return { score: Math.round((best + extra + recency) * 100) / 100, matchedFields: matchedFields.slice(0, 3) };
}

function rank(docs, fields, ctx, limit, { baseScore = 0, decorate } = {}) {
  const scored = [];
  for (const doc of docs) {
    const result = scoreDoc(doc, fields, ctx);
    const score = result ? result.score : baseScore;
    if (!score) continue;
    const item = { ...doc, _score: score, _matches: result ? result.matchedFields : [] };
    if (decorate) decorate(item, !!result);
    scored.push(item);
  }
  scored.sort((a, b) => b._score - a._score || new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  return scored.slice(0, limit);
}

// Query building + ranking are pure — exported so they can be exercised
// without a DB connection.
exports._internals = { FIELD_SETS, SECTION_ORDER, buildFieldQuery, valuesAtPath, matchStrength, scoreDoc, rank, looseDigitsRegex };

exports.globalSearch = async (req, res) => {
  const emptyResults = () => ({
    orders: [], customers: [], carriers: [], trucks: [], trailers: [],
    drivers: [], employees: [], ownerOperators: []
  });

  try {
    const tenantId = req.tenantId || req.user?.tenantId;
    const q = String(req.query.q || '').trim().slice(0, MAX_QUERY_LENGTH);
    if (!tenantId) {
      return res.status(400).json({
        status: false,
        message: 'Tenant context is required',
        q,
        results: emptyResults(),
        sections: [],
        counts: {},
        total: 0
      });
    }
    const companyId = normalizeCompanyId(req);
    const limit = Math.min(Math.max(Number(req.query.limit) || 5, 1), 25);
    const typeFilter = String(req.query.type || '').trim();

    if (!q || q.length < 2) {
      return res.json({ status: true, q, results: emptyResults(), sections: [], counts: {}, total: 0, best: null });
    }

    const tokens = q.split(/\s+/).map((t) => t.trim()).filter((t) => t.length >= 2).slice(0, MAX_TOKENS);
    const searchTokens = tokens.length ? tokens : [q];
    const qDigits = q.replace(/[^0-9]/g, '');

    const ctx = {
      q: q.toLowerCase(),
      tokens: searchTokens.map((t) => t.toLowerCase()),
      digits: qDigits,
      wordRegex: new RegExp(`\\b${escapeRegex(q.toLowerCase())}`, 'i')
    };

    const allowedModules = Array.isArray(req.user?.allowedModules)
      ? req.user.allowedModules.map((m) => String(m).toLowerCase())
      : ['outsourcing', 'regular'];

    const userPermissions = Array.isArray(req.user?.permissions)
      ? req.user.permissions.map((m) => String(m).toLowerCase())
      : [];

    const hasOutsourcing = allowedModules.includes('outsourcing') || userPermissions.includes('outsourcing');
    const hasRegular = allowedModules.includes('regular') || userPermissions.includes('regular');

    // Gating access checks
    const customerPerms = userPermissions;
    const customerIsAdmin = req.user?.is_admin === 1 || Number(req.user?.role) === 3 || customerPerms.includes('subadmin');
    const customerHasAccounting = customerPerms.includes('accounting');
    const hasCustomersAccess = customerIsAdmin || customerHasAccounting || customerPerms.includes('customers');

    const carrierPermsList = ['carriers', 'carriers_write', 'outsourcing', 'accounting', 'subadmin'];
    const userHasCarriersAccess = userPermissions.some((p) => carrierPermsList.includes(p));
    const carrierIsAdmin = req.user?.is_admin === 1 || Number(req.user?.role) === 3;
    const hasCarriersAccess = carrierIsAdmin || userHasCarriersAccess;

    const hasEmployeesAccess = userPermissions.includes('employees') || userPermissions.includes('subadmin') || req.user?.is_admin === 1 || hasRegular;
    const isAdminUser = req.user?.is_admin === 1 || Number(req.user?.role) === 3;
    const hasStaffDirectoryAccess = isAdminUser || userPermissions.includes('employees') || userPermissions.includes('subadmin');

    const wants = (key) => !typeFilter || typeFilter === key;

    // ---- queries -------------------------------------------------------
    const customerQuery = {
      tenantId,
      $and: [NOT_DELETED, ...buildFieldQuery(searchTokens, FIELD_SETS.customers, qDigits)]
    };
    if (!customerIsAdmin && !customerHasAccounting) {
      const visibility = [{ assigned_to: req.user?._id }];
      if (customerPerms.includes('regular') && companyId) {
        visibility.push({
          company: companyId,
          $or: [{ assigned_to: { $size: 0 } }, { assigned_to: { $exists: false } }]
        });
      }
      customerQuery.$and.push({ $or: visibility });
    }

    const carrierQuery = {
      tenantId,
      $and: [NOT_DELETED, ...buildFieldQuery(searchTokens, FIELD_SETS.carriers, qDigits)]
    };
    if (!carrierIsAdmin && !userHasCarriersAccess && companyId) {
      carrierQuery.$and.push({ company: companyId });
    }

    const truckQuery = {
      tenantId,
      $and: [NOT_DELETED, ...buildFieldQuery(searchTokens, FIELD_SETS.trucks, qDigits)]
    };
    if (companyId) truckQuery.company = companyId;

    const trailerQuery = {
      tenantId,
      $and: [NOT_DELETED, ...buildFieldQuery(searchTokens, FIELD_SETS.trailers, qDigits)]
    };
    if (companyId) trailerQuery.company = companyId;

    const ownerOperatorQuery = {
      tenantId,
      $and: [NOT_DELETED, ...buildFieldQuery(searchTokens, FIELD_SETS.ownerOperators, qDigits)]
    };
    if (companyId) {
      ownerOperatorQuery.$and.push({
        $or: [{ company: companyId }, { company: null }, { company: { $exists: false } }]
      });
    }

    const profileQuery = {
      tenantId,
      $and: [NOT_DELETED, ...buildFieldQuery(searchTokens, FIELD_SETS.driverProfiles, qDigits)]
    };

    const [rawCustomers, rawCarriers, rawOwnerOperators, matchingProfiles, rawTrucks, rawTrailers] = await Promise.all([
      hasCustomersAccess && wants('customers')
        ? Customer.find(customerQuery)
          .select('_id name email phone customerCode address city state country zipcode secondary_email secondary_phone emails createdAt')
          .limit(SCAN_LIMIT).lean()
        : Promise.resolve([]),

      hasCarriersAccess && wants('carriers')
        ? Carrier.find(carrierQuery)
          .select('_id name email phone mc_code carrierID location address city state country zipcode secondary_email secondary_phone emails createdAt')
          .limit(SCAN_LIMIT).lean()
        : Promise.resolve([]),

      hasRegular && wants('ownerOperators')
        ? OwnerOperator.find(ownerOperatorQuery)
          .select('_id fullName companyName ownerOperatorId email phone address city state zipcode status notes createdAt')
          .limit(SCAN_LIMIT).lean()
        : Promise.resolve([]),

      hasEmployeesAccess
        ? DriverProfile.find(profileQuery).select('user licenseNumber emails phones').limit(SCAN_LIMIT).lean()
        : Promise.resolve([]),

      hasRegular && wants('trucks')
        ? Truck.find(truckQuery)
          .select('_id plateNumber truckNumber unitNumber vin make model year capacity notes createdAt')
          .limit(SCAN_LIMIT).lean()
        : Promise.resolve([]),

      hasRegular && wants('trailers')
        ? Trailer.find(trailerQuery)
          .select('_id plateNumber unitNumber vin licenseNumber type make model length notes createdAt')
          .limit(SCAN_LIMIT).lean()
        : Promise.resolve([])
    ]);

    // ---- people (drivers + other staff) --------------------------------
    const profileUserIds = matchingProfiles.map((p) => p.user).filter(Boolean);
    const peopleMatch = [];
    const peopleFieldAnd = buildFieldQuery(searchTokens, FIELD_SETS.drivers, qDigits);
    if (peopleFieldAnd.length) peopleMatch.push({ $and: peopleFieldAnd });
    if (profileUserIds.length) peopleMatch.push({ _id: { $in: profileUserIds } });

    let rawPeople = [];
    if (hasEmployeesAccess && peopleMatch.length) {
      const peopleQuery = {
        tenantId,
        $and: [NOT_DELETED, { $or: peopleMatch }]
      };
      if (companyId) peopleQuery.company = companyId;
      rawPeople = await User.find(peopleQuery)
        .select('_id name email phone corporateID address city state zipcode position permissions role is_admin createdAt')
        .limit(SCAN_LIMIT)
        .lean();
    }

    const isDriverUser = (u) => (Array.isArray(u.permissions) && u.permissions.includes('driver')) || Number(u.role) === 0;
    const profileById = new Map(matchingProfiles.map((p) => [String(p.user), p]));
    const withProfile = (u) => {
      const profile = profileById.get(String(u._id));
      return profile ? { ...u, licenseNumber: profile.licenseNumber, emails: profile.emails, phones: profile.phones } : u;
    };
    const rawDrivers = rawPeople.filter(isDriverUser).map(withProfile);
    const rawEmployees = hasStaffDirectoryAccess ? rawPeople.filter((u) => !isDriverUser(u)) : [];

    // ---- rank entities -------------------------------------------------
    const driverFields = [...FIELD_SETS.drivers, ...FIELD_SETS.driverProfiles];
    const customers = rank(rawCustomers, FIELD_SETS.customers, ctx, limit);
    const carriers = rank(rawCarriers, FIELD_SETS.carriers, ctx, limit);
    const ownerOperators = rank(rawOwnerOperators, FIELD_SETS.ownerOperators, ctx, limit);
    const trucks = rank(rawTrucks, FIELD_SETS.trucks, ctx, limit);
    const trailers = rank(rawTrailers, FIELD_SETS.trailers, ctx, limit);
    // A driver matched only through their DriverProfile still deserves a slot.
    const drivers = wants('drivers') ? rank(rawDrivers, driverFields, ctx, limit, { baseScore: 55 }) : [];
    const employees = wants('employees') ? rank(rawEmployees, FIELD_SETS.drivers, ctx, limit) : [];

    // ---- orders (direct fields + everything matched above) -------------
    let orders = [];
    if (wants('orders')) {
      const orderQuery = {
        tenantId,
        $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }]
      };
      const orderTypes = [];
      if (hasOutsourcing) orderTypes.push('outsourcing');
      if (hasRegular) orderTypes.push('regular');
      if (orderTypes.length === 1) orderQuery.order_type = orderTypes[0];
      else if (orderTypes.length === 0) orderQuery.order_type = 'none';

      orderQuery.$and = [];
      if (companyId) {
        orderQuery.$and.push({
          $or: [{ company: companyId }, { company: null }, { company: { $exists: false } }]
        });
      }

      const orderDirectAnd = buildFieldQuery(searchTokens, FIELD_SETS.orders, qDigits);
      const orderMatch = [];
      if (orderDirectAnd.length) orderMatch.push({ $and: orderDirectAnd });

      const relationIds = {
        customer: rawCustomers.map((d) => d._id),
        carrier: rawCarriers.map((d) => d._id),
        driver: rawDrivers.map((d) => d._id),
        truck: rawTrucks.map((d) => d._id),
        trailer: rawTrailers.map((d) => d._id),
        ownerOperator: rawOwnerOperators.map((d) => d._id)
      };
      if (relationIds.customer.length) orderMatch.push({ customer: { $in: relationIds.customer } });
      if (relationIds.carrier.length) orderMatch.push({ carrier: { $in: relationIds.carrier } });
      if (relationIds.driver.length) {
        orderMatch.push({ driver: { $in: relationIds.driver } });
        orderMatch.push({ drivers: { $in: relationIds.driver } });
      }
      if (relationIds.truck.length) orderMatch.push({ truck: { $in: relationIds.truck } });
      if (relationIds.trailer.length) orderMatch.push({ trailer: { $in: relationIds.trailer } });
      if (relationIds.ownerOperator.length) {
        orderMatch.push({ ownerOperator: { $in: relationIds.ownerOperator } });
        orderMatch.push({ ownerOperators: { $in: relationIds.ownerOperator } });
      }

      if (orderMatch.length) {
        orderQuery.$and.push({ $or: orderMatch });

        const rawOrders = await Order.find(orderQuery)
          .select('_id serial_no customer_order_no company_name order_type total_amount order_status createdAt shipping_details customer carrier truck trailer driver drivers ownerOperator ownerOperators notes')
          .sort({ createdAt: -1 })
          .limit(SCAN_LIMIT)
          .lean();

        const idSet = (list) => new Set(list.map(String));
        const relSets = {
          customer: idSet(relationIds.customer),
          carrier: idSet(relationIds.carrier),
          driver: idSet(relationIds.driver),
          truck: idSet(relationIds.truck),
          trailer: idSet(relationIds.trailer),
          ownerOperator: idSet(relationIds.ownerOperator)
        };
        const matchVia = (order) => {
          if (order.customer && relSets.customer.has(String(order.customer))) return 'customer';
          if (order.carrier && relSets.carrier.has(String(order.carrier))) return 'carrier';
          const orderDrivers = [order.driver, ...(order.drivers || [])].filter(Boolean).map(String);
          if (orderDrivers.some((d) => relSets.driver.has(d))) return 'driver';
          if (order.truck && relSets.truck.has(String(order.truck))) return 'truck';
          if (order.trailer && relSets.trailer.has(String(order.trailer))) return 'trailer';
          const owners = [order.ownerOperator, ...(order.ownerOperators || [])].filter(Boolean).map(String);
          if (owners.some((o) => relSets.ownerOperator.has(o))) return 'ownerOperator';
          return null;
        };

        orders = rank(rawOrders, FIELD_SETS.orders, ctx, limit, {
          baseScore: 30,
          decorate: (item, direct) => {
            item._matchVia = direct ? 'direct' : (matchVia(item) || 'related');
            delete item.customer;
            delete item.carrier;
            delete item.truck;
            delete item.trailer;
            delete item.driver;
            delete item.drivers;
            delete item.ownerOperator;
            delete item.ownerOperators;
          }
        });
      }
    }

    const results = { orders, customers, carriers, trucks, trailers, drivers, employees, ownerOperators };
    const sections = SECTION_ORDER
      .map(({ key, title }) => ({ key, title, count: results[key].length, items: results[key] }))
      .filter((s) => s.count > 0);

    const counts = Object.fromEntries(Object.entries(results).map(([k, v]) => [k, v.length]));
    const total = Object.values(counts).reduce((sum, n) => sum + n, 0);

    // Best overall hit — this is what makes "1125" still jump straight to the
    // order even though orders render last.
    let best = null;
    for (const section of sections) {
      const top = section.items[0];
      if (top && (!best || top._score > best.item._score)) best = { type: section.key, item: top };
    }
    if (best && best.item._score < 60) best = null;

    return res.json({ status: true, q, results, sections, counts, total, best });
  } catch (err) {
    console.error('Search failed:', err);
    return res.status(500).json({ status: false, message: 'Search failed' });
  }
};
