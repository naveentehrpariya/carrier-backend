const catchAsync = require("../utils/catchAsync");
const APIFeatures  = require("../utils/APIFeatures");
const Customer = require("../db/Customer");
const JSONerror = require("../utils/jsonErrorHandler");
const logger = require("../utils/logger");
const { checkCustomerLimit } = require("../middlewares/planLimitsMiddleware");
const { logActivity } = require("../utils/activityLogger");

exports.addCustomer = catchAsync(async (req, res, next) => {
  const isAdmin = req.user?.is_admin === 1 || Number(req.user?.role) === 3;
  const canWrite = req.user?.permissions?.includes('customers_write') || req.user?.permissions?.includes('subadmin');
  if (req.user && !isAdmin && !canWrite) {
    return res.status(403).json({ status: false, message: "You are not authorized to add customers." });
  }

  const { name, phone, 
    assigned_to,
    secondary_email,
    secondary_phone,
    email, emails, address, country, state, city, zipcode } = req.body;
  const tenantId = req.tenantId || req.user?.tenantId;
  if (!tenantId) {
    return res.status(400).json({ status: false, message: "Tenant context is required." });
  }
  const companyId = req.user?.company?._id || req.user?.company || null;

  const trimmedName = String(name || '').trim();
  const trimmedEmail = String(email || '').trim().toLowerCase();
  const trimmedPhone = String(phone || '').trim();
  const trimmedCountry = String(country || '').trim();
  const trimmedAddress = String(address || '').trim();
  const trimmedSecondaryEmail = secondary_email ? String(secondary_email).trim().toLowerCase() : undefined;
  const trimmedSecondaryPhone = secondary_phone ? String(secondary_phone).trim() : undefined;

  const existingCustomer = await Customer.findOne({
    tenantId,
    ...(companyId ? { company: companyId } : {}),
    $or: [{ phone: trimmedPhone }, { email: trimmedEmail }]
  });

  if (existingCustomer) {
    return res.status(200).json({
      status: false,
      message: existingCustomer.phone === trimmedPhone 
        ? "Phone number exists. Please use a different phone number." 
        : "Email address already exists. Please use a different email.",
    });
  }

  // let customerCode;
  // let isUnique = false;
  // while (!isUnique) {
  //   customerCode = `${Math.floor(10000 + Math.random() * 90000)}`;
  //   const existingUser = await Customer.findOne({ customerCode });
  //   if (!existingUser) {
  //     isUnique = true;
  //   }
  // }

  const lastCustomer = await Customer.findOne({ tenantId, ...(companyId ? { company: companyId } : {}) }).sort({ customerCode: -1 });
  const newCustomerNo = lastCustomer ? parseInt(lastCustomer.customerCode) + 1 : 1000;

  // Process emails array - maintain backward compatibility
  let emailsArray = [];
  
  // If new emails array is provided, use it
  if (emails && Array.isArray(emails) && emails.length > 0) {
    emailsArray = emails.map((emailItem, index) => ({
      email: emailItem.email || emailItem, // Support both object and string format
      is_primary: emailItem.is_primary || index === 0, // First email is primary by default
      created_at: new Date()
    }));
  } else {
    // Fallback to legacy fields for backward compatibility
    if (trimmedEmail) {
      emailsArray.push({ email: trimmedEmail, is_primary: true, created_at: new Date() });
    }
    if (trimmedSecondaryEmail) {
      emailsArray.push({ email: trimmedSecondaryEmail, is_primary: false, created_at: new Date() });
    }
  }

 // Normalize assigned_to to a clean array of ObjectIds. Empty is allowed —
 // unassigned customers are visible to company users with `regular` permission.
 const assignedToArray = Array.isArray(assigned_to)
   ? assigned_to.filter(Boolean)
   : assigned_to ? [assigned_to] : [];
 const result = await Customer.create({
   name: trimmedName,
   email: trimmedEmail,
   secondary_email: trimmedSecondaryEmail,
   secondary_phone: trimmedSecondaryPhone,
   emails: emailsArray,
   customerCode: newCustomerNo,
   phone: trimmedPhone,
   address: trimmedAddress,
   country: trimmedCountry,
   state: state ? String(state).trim() : undefined,
   city: city ? String(city).trim() : undefined,
   tenantId,
   company: companyId,
   zipcode: zipcode ? String(zipcode).trim() : undefined,
   assigned_to: assignedToArray,
   created_by:req.user._id,
 });
 logActivity(req, {
   action: 'CREATE',
   module: 'customer',
   description: `Added customer "${result.name}"`,
   resourceId: result._id,
   resourceName: result.name,
 });
 return res.send({
   status: true,
   customers: result,
   message: "Customer has been added.",
 });
});

exports.customers_listing = catchAsync(async (req, res) => {

  const { search } = req.query;
  const queryObj = { deletedAt: null };
  const tenantId = req.tenantId || req.user?.tenantId;
  if (!tenantId) {
    return res.status(400).json({ status: false, message: "Tenant context is required.", customers: [], totalDocuments: 0 });
  }
  queryObj.tenantId = tenantId;

  const perms    = Array.isArray(req.user?.permissions) ? req.user.permissions : [];
  const isAdmin  = req.user?.is_admin === 1 || Number(req.user?.role) === 3 || perms.includes('subadmin');
  const hasAccounting = perms.includes('accounting');

  if (isAdmin || hasAccounting) {
    // Admin / Subadmin / Accounting → see ALL customers in the tenant
  } else {
    // Everyone else → customers assigned to them, PLUS unassigned customers in
    // their own company if they have the `regular` orders permission.
    const visibility = [{ assigned_to: req.user._id }];
    if (perms.includes('regular')) {
      const myCompany = req.user?.company?._id || req.user?.company || null;
      if (myCompany) {
        visibility.push({
          company: myCompany,
          $or: [{ assigned_to: { $size: 0 } }, { assigned_to: { $exists: false } }],
        });
      }
    }
    queryObj.$or = visibility;
  }

  if (search && search.length >1) {
    const safeSearch = search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const searchRegex = new RegExp(safeSearch, 'i');
    queryObj.$and = queryObj.$and || [];
    queryObj.$and.push({
      $or: [
        { name: searchRegex },
        { customerCode: searchRegex },
        { email: searchRegex },
        { secondary_email: searchRegex },
        { 'emails.email': searchRegex },
        { phone: searchRegex },
        { secondary_phone: searchRegex }
      ]
    });
  }

  let Query = new APIFeatures(
    Customer.find(queryObj).populate('assigned_to', '_id name email phone role is_admin'),
    req.query
  ).sort();
     
  const { query, totalDocuments, page, limit, totalPages } = await Query.paginate();
  const data = await query;
  res.json({
    status: true,
    totalDocuments: totalDocuments,
    customers: data,
    page : page,
    per_page : limit,
    totalPages : totalPages,
    message: data.length ? undefined : "No customers found"
  });
});

exports.customerDetails = catchAsync(async (req, res, next) => {
  // Scope by tenant + assignment only (mirror customers_listing).
  // Do NOT filter by company — listing doesn't, and many customers have no
  // company set, which wrongly denied access to legitimately-assigned ones.
  const tenantIdDet = req.tenantId || req.user?.tenantId;
  if (!tenantIdDet) {
    return res.status(400).send({ status: false, result: null, message: 'Tenant context missing.' });
  }
  const criteria = { _id: req.params.id, tenantId: tenantIdDet };

  const permsD = Array.isArray(req.user?.permissions) ? req.user.permissions : [];
  const isAdminDet = req.user?.is_admin === 1 || Number(req.user?.role) === 3 || permsD.includes('subadmin');
  const hasAccountingDet = permsD.includes('accounting');
  if (!isAdminDet && !hasAccountingDet) {
    // Assigned customers, plus unassigned ones in their company if they hold
    // the `regular` orders permission (mirrors listing visibility).
    const visibilityDet = [{ assigned_to: req.user._id }];
    if (permsD.includes('regular')) {
      const myCompanyDet = req.user?.company?._id || req.user?.company || null;
      if (myCompanyDet) {
        visibilityDet.push({
          company: myCompanyDet,
          $or: [{ assigned_to: { $size: 0 } }, { assigned_to: { $exists: false } }],
        });
      }
    }
    criteria.$or = visibilityDet;
  }

  const customer = await Customer.findOne(criteria).populate('assigned_to', '_id name email phone role is_admin');
  if(!customer){
    return res.send({
      status: false,
      result : null,
      message: "Customer not found or not authorized",
    });
  }
  res.send({
    status: true,
    result : customer,
    message: "Customer details retrieved.",
  });
});

exports.updateCustomer = catchAsync(async (req, res, next) => {
  const { name, secondary_email, secondary_phone, mc_code, phone, email, emails, address, country, state, city, zipcode, assigned_to } = req.body;

  const tenantIdUpd = req.tenantId || req.user?.tenantId;
  if (!tenantIdUpd) {
    return res.status(400).send({ status: false, message: 'Tenant context missing.' });
  }

  const trimmedName = name ? String(name).trim() : undefined;
  const trimmedEmail = email ? String(email).trim().toLowerCase() : undefined;
  const trimmedPhone = phone ? String(phone).trim() : undefined;
  const trimmedCountry = country ? String(country).trim() : undefined;
  const trimmedAddress = address ? String(address).trim() : undefined;
  const trimmedState = state !== undefined ? String(state).trim() : undefined;
  const trimmedCity = city !== undefined ? String(city).trim() : undefined;
  const trimmedZipcode = zipcode !== undefined ? String(zipcode).trim() : undefined;
  const trimmedSecondaryEmail = secondary_email ? String(secondary_email).trim().toLowerCase() : undefined;
  const trimmedSecondaryPhone = secondary_phone ? String(secondary_phone).trim() : undefined;

  if (mc_code) {
    const trimmedMc = String(mc_code).trim();
    const existingCustomer = await Customer.findOne({ mc_code: trimmedMc, _id: { $ne: req.params.id }, tenantId: tenantIdUpd });
    if (existingCustomer) {
      return res.status(200).send({
        status: false,
        message: "MC Code must be unique. This MC Code is already in use.",
      });
    }
  }

  if (trimmedEmail || trimmedPhone) {
    const companyId = req.user?.company?._id || req.user?.company || null;
    const query = {
      _id: { $ne: req.params.id },
      tenantId: tenantIdUpd,
      ...(companyId ? { company: companyId } : {})
    };
    const orCond = [];
    if (trimmedEmail) orCond.push({ email: trimmedEmail });
    if (trimmedPhone) orCond.push({ phone: trimmedPhone });
    query.$or = orCond;

    const existingCustomer = await Customer.findOne(query);
    if (existingCustomer) {
      return res.status(200).json({
        status: false,
        message: existingCustomer.phone === trimmedPhone 
          ? "Phone number exists. Please use a different phone number." 
          : "Email address already exists. Please use a different email.",
      });
    }
  }

  // Process emails array - maintain backward compatibility
  let emailsArray = [];
  
  // If new emails array is provided, use it
  if (emails && Array.isArray(emails) && emails.length > 0) {
    emailsArray = emails.map((emailItem, index) => ({
      email: emailItem.email || emailItem, // Support both object and string format
      is_primary: emailItem.is_primary || index === 0, // First email is primary by default
      created_at: emailItem.created_at || new Date()
    }));
  } else {
    // Fallback to legacy fields for backward compatibility
    if (trimmedEmail) {
      emailsArray.push({ email: trimmedEmail, is_primary: true, created_at: new Date() });
    }
    if (trimmedSecondaryEmail) {
      emailsArray.push({ email: trimmedSecondaryEmail, is_primary: false, created_at: new Date() });
    }
  }

  const updateQuery = { _id: req.params.id, tenantId: tenantIdUpd };
  const isAdminUpd = req.user?.is_admin === 1 || Number(req.user?.role) === 3 || req.user?.permissions?.includes('subadmin');
  const canWriteUpd = req.user?.permissions?.includes('customers_write');
  if (req.user && !isAdminUpd && !canWriteUpd) {
    return res.status(403).json({ status: false, message: "You are not authorized to update customers." });
  }
  // Non-admin writers may only update customers assigned to them.
  if (req.user && !isAdminUpd) {
    updateQuery.assigned_to = req.user._id;
  }
  // An ABSENT `assigned_to` means "leave the assignment alone", not "unassign everyone". Writing
  // [] on every partial update silently widened visibility: an unassigned customer is shared with
  // every `regular` user in the company (see the visibility table in CLAUDE.md). Sending an
  // explicit empty array still unassigns — that is a deliberate act.
  const assignedToProvided = typeof assigned_to !== 'undefined' && assigned_to !== null;
  const assignedToArrayUpd = Array.isArray(assigned_to)
    ? assigned_to.filter(Boolean)
    : assigned_to ? [assigned_to] : [];
  const updatedUser = await Customer.findOneAndUpdate(updateQuery, {
    name: trimmedName,
    email: trimmedEmail,
    secondary_email: trimmedSecondaryEmail,
    secondary_phone: trimmedSecondaryPhone,
    emails: emailsArray,
    mc_code: mc_code ? String(mc_code).trim() : undefined,
    phone: trimmedPhone,
    address: trimmedAddress,
    country: trimmedCountry,
    state: trimmedState,
    city: trimmedCity,
    ...(assignedToProvided ? { assigned_to: assignedToArrayUpd } : {}),
    zipcode: trimmedZipcode,
    // `created_by` is who created the record — deliberately NOT touched here. Overwriting it with
    // the editor erased the original creator on every save; who edited is in the activity log.
  }, {
    new: true, 
    runValidators: true,
  });

  if(!updatedUser){
    return res.send({
      status: false,
      customer: null,
      message: "Failed to update customer information.",
    });
  }
  logActivity(req, {
    action: 'UPDATE',
    module: 'customer',
    description: `Updated customer "${updatedUser.name}"`,
    resourceId: updatedUser._id,
    resourceName: updatedUser.name,
  });
  return res.send({
    status: true,
    customer: updatedUser,
    message: "Customer has been updated.",
  });
});

exports.deleteCustomer = catchAsync(async (req, res) => {
    try {
      const tenantIdDel = req.tenantId || req.user?.tenantId;
      if (!tenantIdDel) {
        return res.status(400).json({ status: false, message: 'Tenant context missing.' });
      }
      const criteria = { _id: req.params.id, tenantId: tenantIdDel };
      const isAdminDel = req.user?.is_admin === 1 || Number(req.user?.role) === 3 || req.user?.permissions?.includes('subadmin');
      const canWriteDel = req.user?.permissions?.includes('customers_write');
      if (req.user && !isAdminDel && !canWriteDel) {
        return res.status(403).json({ status: false, message: "You are not authorized to delete customers." });
      }
      // Non-admin writers may only delete customers assigned to them.
      if (req.user && !isAdminDel) {
        criteria.assigned_to = req.user._id;
      }
      const customer = await Customer.findOne(criteria);
      if (!customer) {
        return res.status(404).json({
          status: false,
          error: 'customer not found.',
        });
      }
      // Free email + phone so they can be re-used for a new customer in this company
      const delTs = Date.now();
      if (customer.email && !String(customer.email).startsWith('deleted_')) {
        customer.email = `deleted_${delTs}_${customer.email}`;
      }
      if (customer.phone && !String(customer.phone).startsWith('deleted_')) {
        customer.phone = `deleted_${delTs}_${customer.phone}`;
      }
      customer.deletedAt = Date.now();
      const result = await customer.save();
      if (result) {
        logActivity(req, {
          action: 'DELETE',
          module: 'customer',
          description: `Deleted customer "${customer.name}"`,
          resourceId: customer._id,
          resourceName: customer.name,
        });
        return res.status(200).json({
          status: true,
          message: `customer has been removed.`,
          customer: result,
        });
      } else {
        return res.status(400).json({
          status: false,
          customer: null,
          error: 'Something went wrong in removing the customer. Please try again.',
        });
      }
  } catch (error) {
    return res.status(500).json({
      status: false,
      message: error.message,
      error: error
    });
  }
});
