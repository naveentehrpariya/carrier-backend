const Order = require('../db/Order');
const Customer = require('../db/Customer');
const Carrier = require('../db/Carrier');
const Truck = require('../db/Truck');
const Trailer = require('../db/Trailer');
const User = require('../db/Users');

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeCompanyId(req) {
  const raw = req.user?.company?._id || req.user?.company;
  return raw ? String(raw) : null;
}

exports.globalSearch = async (req, res) => {
  try {
    const tenantId = req.tenantId || req.user?.tenantId;
    if (!tenantId) {
      return res.status(400).json({
        status: false,
        message: 'Tenant context is required',
        q: String(req.query.q || '').trim(),
        results: { orders: [], customers: [], carriers: [], trucks: [], trailers: [], drivers: [] }
      });
    }
    const companyId = normalizeCompanyId(req);
    const q = String(req.query.q || '').trim();
    const limit = Math.min(Math.max(Number(req.query.limit) || 5, 1), 25);

    if (!q || q.length < 2) {
      return res.json({
        status: true,
        q,
        results: { orders: [], customers: [], carriers: [], trucks: [], trailers: [], drivers: [] }
      });
    }

    const tokens = q
      .split(/\s+/)
      .map((t) => t.trim())
      .filter((t) => t.length >= 2);
    const tokenRegexes = tokens.map((t) => new RegExp(escapeRegex(t), 'i'));
    const regex = new RegExp(escapeRegex(q), 'i');
    const qDigits = q.replace(/[^0-9]/g, '');
    const qSerial = qDigits ? Number.parseInt(qDigits, 10) : null;
    const baseTenant = { tenantId };
    const baseCompany = companyId ? { company: companyId } : {};

  const allowedModules = Array.isArray(req.user?.allowedModules) 
      ? req.user.allowedModules.map(m => String(m).toLowerCase()) 
      : ['outsourcing', 'regular'];

    const userPermissions = Array.isArray(req.user?.permissions)
      ? req.user.permissions.map(m => String(m).toLowerCase())
      : [];

    const hasOutsourcing = allowedModules.includes('outsourcing') || userPermissions.includes('outsourcing');
    const hasRegular = allowedModules.includes('regular') || userPermissions.includes('regular');
    const hasCarriersAccess = userPermissions.includes('carriers') || userPermissions.includes('subadmin') || req.user?.is_admin === 1 || hasOutsourcing;
    const hasCustomersAccess = userPermissions.includes('customers') || userPermissions.includes('subadmin') || req.user?.is_admin === 1;
    const hasEmployeesAccess = userPermissions.includes('employees') || userPermissions.includes('subadmin') || req.user?.is_admin === 1 || hasRegular;

    const orderQuery = {
      ...baseTenant,
      ...baseCompany,
      $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }]
    };
    const orderTypes = [];
    if (hasOutsourcing) orderTypes.push('outsourcing');
    if (hasRegular) orderTypes.push('regular');
    
    if (orderTypes.length === 1) {
      orderQuery.order_type = orderTypes[0];
    } else if (orderTypes.length === 0) {
      // If neither, technically shouldn't match anything, but we can set a dummy
      orderQuery.order_type = 'none';
    }

    // Text fields an order can be found by: its own numbers, the customer's order
    // number, the order-level reference, per-stop reference numbers and the
    // pickup/delivery addresses.
    const ORDER_TEXT_FIELDS = [
      'company_name',
      'customer_order_no',
      'shipping_details.reference',
      'shipping_details.locations.referenceNo',
      'shipping_details.locations.location',
      'shipping_details.locations.address',
      'shipping_details.locations.city',
    ];
    const orderFieldsMatching = (r) => ORDER_TEXT_FIELDS.map((f) => ({ [f]: r }));

    const orderTokenAnd = tokenRegexes.map((r) => ({ $or: orderFieldsMatching(r) }));
    const orderOr = orderFieldsMatching(regex);
    if (Number.isFinite(qSerial)) orderOr.push({ serial_no: qSerial });

    const carrierOr = tokenRegexes.map((r) => ({ $or: [{ name: r }, { email: r }, { phone: r }, { mc_code: r }, { carrierID: r }] }));
    if (qDigits && qDigits.length >= 4) {
      carrierOr.push({ $or: [{ phone: new RegExp(escapeRegex(qDigits), 'i') }, { mc_code: new RegExp(escapeRegex(qDigits), 'i') }] });
    }

    const customerOr = tokenRegexes.map((r) => ({ $or: [{ name: r }, { email: r }, { phone: r }, { customerCode: r }] }));
    if (qDigits && qDigits.length >= 4) {
      customerOr.push({ $or: [{ phone: new RegExp(escapeRegex(qDigits), 'i') }, { customerCode: new RegExp(escapeRegex(qDigits), 'i') }] });
    }

    const driverOr = tokenRegexes.map((r) => ({ $or: [{ name: r }, { email: r }, { phone: r }, { corporateID: r }, { address: r }] }));
    if (qDigits && qDigits.length >= 4) {
      driverOr.push({ $or: [{ phone: new RegExp(escapeRegex(qDigits), 'i') }, { corporateID: new RegExp(escapeRegex(qDigits), 'i') }] });
    }
    if (qDigits && qDigits.length >= 2) {
      orderOr.push({
        $expr: {
          $regexMatch: {
            input: { $toString: '$serial_no' },
            regex: escapeRegex(qDigits)
          }
        }
      });
    }
    orderQuery.$and = [
      {
        $or: [
          ...(orderTokenAnd.length > 0 ? [{ $and: orderTokenAnd }] : []),
          ...(orderOr.length > 0 ? [{ $or: orderOr }] : [])
        ]
      }
    ];

    const [orders, customers, carriers, trucks, trailers, drivers] = await Promise.all([
      Order.find(orderQuery)
        .select('_id serial_no customer_order_no company_name order_type total_amount order_status createdAt shipping_details')
        .sort({ createdAt: -1 })
        .limit(limit)
        .lean(),
      (hasCustomersAccess ? Customer.find({
        ...baseTenant,
        ...baseCompany,
        $and: [
          { $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }] },
          ...(customerOr.length > 0 ? [{ $or: customerOr }] : [])
        ]
      })
        .select('_id name email phone customerCode address')
        .sort({ createdAt: -1 })
        .limit(limit)
        .lean() : Promise.resolve([])),
      (hasCarriersAccess ? Carrier.find({
        ...baseTenant,
        ...baseCompany,
        $and: [
          { $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }] },
          ...(carrierOr.length > 0 ? [{ $or: carrierOr }] : [])
        ]
      })
        .select('_id name email phone mc_code carrierID location')
        .sort({ createdAt: -1 })
        .limit(limit)
        .lean() : Promise.resolve([])),
      (hasRegular ? Truck.find({
        ...baseTenant,
        ...baseCompany,
        $and: [
          { $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }] },
          ...tokenRegexes.map((r) => ({ $or: [{ plateNumber: r }, { truckNumber: r }, { unitNumber: r }, { vin: r }, { make: r }, { model: r }] }))
        ]
      })
        .select('_id plateNumber truckNumber unitNumber vin make model year')
        .sort({ createdAt: -1 })
        .limit(limit)
        .lean() : Promise.resolve([])),
      (hasRegular ? Trailer.find({
        ...baseTenant,
        ...baseCompany,
        $and: [
          { $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }] },
          ...tokenRegexes.map((r) => ({ $or: [{ plateNumber: r }, { unitNumber: r }, { vin: r }, { licenseNumber: r }, { type: r }, { make: r }, { model: r }] }))
        ]
      })
        .select('_id plateNumber unitNumber vin licenseNumber type make model length')
        .sort({ createdAt: -1 })
        .limit(limit)
        .lean() : Promise.resolve([])),
      (hasEmployeesAccess ? User.find({
        ...baseTenant,
        ...baseCompany,
        role: 0,
        $and: [
          { $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }] },
          ...(driverOr.length > 0 ? [{ $or: driverOr }] : [])
        ]
      })
        .select('_id name email phone corporateID address')
        .sort({ createdAt: -1 })
        .limit(limit)
        .lean() : Promise.resolve([]))
    ]);

    return res.json({
      status: true,
      q,
      results: {
        orders,
        customers,
        carriers,
        trucks,
        trailers,
        drivers
      }
    });
  } catch (err) {
    return res.status(500).json({ status: false, message: 'Search failed' });
  }
};
