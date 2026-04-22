const catchAsync = require("../utils/catchAsync");
const APIFeatures  = require("../utils/APIFeatures");
const Customer = require("../db/Customer");
const JSONerror = require("../utils/jsonErrorHandler");
const logger = require("../utils/logger");
const { checkCustomerLimit } = require("../middlewares/planLimitsMiddleware");

exports.addCustomer = catchAsync(async (req, res, next) => {
  const hasCustomersPermission = req.user?.permissions?.includes('customers') || req.user?.permissions?.includes('subadmin');
  const isAdmin = req.user?.is_admin === 1 && req.user?.role === 3;
  if (req.user && !isAdmin && !hasCustomersPermission) {
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

  const existingCustomer = await Customer.findOne({
    tenantId,
    ...(companyId ? { company: companyId } : {}),
    $or: [{ phone }, { email }]
  });

  if (existingCustomer) {
    return res.status(200).json({
      status: false,
      message: existingCustomer.phone === phone 
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
    if (email) {
      emailsArray.push({ email, is_primary: true, created_at: new Date() });
    }
    if (secondary_email) {
      emailsArray.push({ email: secondary_email, is_primary: false, created_at: new Date() });
    }
  }

 await Customer.syncIndexes();
 const normalizedAssignedTo = assigned_to ? assigned_to : null;
 Customer.create({
   name: name,
   email: email,
   secondary_email: secondary_email,
   secondary_phone: secondary_phone,
   emails: emailsArray,
   customerCode: newCustomerNo,
   phone: phone,
   address: address,
   country: country,
   state: state,
   city: city,
   tenantId,
   company: companyId,
   zipcode: zipcode,
   assigned_to: normalizedAssignedTo,
   created_by:req.user._id,
 }).then(result => {
   res.send({
     status: true,
     customers :result,
     message: "Customer has been added.",
   });
 }).catch(err => {
   JSONerror(res, err, next);
   logger(err);
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
  if (req.user && req.user.company) {
    queryObj.company = req.user.company._id;
  }

  const hasCustomersPermission = req.user?.permissions?.includes('customers') || req.user?.permissions?.includes('subadmin');
  if ((req.user && req.user.is_admin === 1 && req.user.role === 3) || hasCustomersPermission) {
  } else {
     queryObj.$or = [
      { assigned_to: req.user._id },
      { assigned_to: null },
      { assigned_to: { $exists: false } },
    ];
  }

  if (search && search.length >1) {
    const safeSearch = search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const isNumber = !isNaN(search);
    if (isNumber) {
      queryObj.customerCode = { $regex: new RegExp(safeSearch, 'i') };
    } else {
      queryObj.name = { $regex: new RegExp(safeSearch, 'i') };
    }
  }

  let Query = new APIFeatures(
    Customer.find(queryObj).populate('assigned_to'),
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
  const criteria = { _id: req.params.id };
  if (req.tenantId) criteria.tenantId = req.tenantId;
  if (req.user && req.user.company) criteria.company = req.user.company._id;
  
  // Add access control - non-admin staff can only view customers assigned to them
  const hasCustomersPermission = req.user?.permissions?.includes('customers') || req.user?.permissions?.includes('subadmin');
  const isAdmin = req.user && req.user.is_admin === 1 && req.user.role === 3;
  if (req.user && !isAdmin && !hasCustomersPermission) {
    criteria.$or = [
      { assigned_to: req.user._id },
      { assigned_to: null },
      { assigned_to: { $exists: false } },
    ];
  }
  
  const customer = await Customer.findOne(criteria).populate('assigned_to');
  if(!customer){ 
    res.send({
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
  
  if (mc_code) {
    const existingCustomer = await Customer.findOne({ mc_code: mc_code, _id: { $ne: req.params.id }, ...(req.tenantId ? { tenantId: req.tenantId } : {}) });
    if (existingCustomer) {
      return res.status(200).send({
        status: false,
        message: "MC Code must be unique. This MC Code is already in use.",
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
    if (email) {
      emailsArray.push({ email, is_primary: true, created_at: new Date() });
    }
    if (secondary_email) {
      emailsArray.push({ email: secondary_email, is_primary: false, created_at: new Date() });
    }
  }

  await Customer.syncIndexes();
  const updateQuery = { _id: req.params.id };
  if (req.tenantId) updateQuery.tenantId = req.tenantId;
  if (req.user && req.user.company) updateQuery.company = req.user.company._id;
  const hasCustomersPermission = req.user?.permissions?.includes('customers') || req.user?.permissions?.includes('subadmin');
  const isAdmin = req.user && req.user.is_admin === 1 && req.user.role === 3;
  if (req.user && !isAdmin && !hasCustomersPermission) {
    updateQuery.$or = [
      { assigned_to: req.user._id },
      { assigned_to: null },
      { assigned_to: { $exists: false } },
    ];
  }
  const normalizedAssignedTo = assigned_to ? assigned_to : null;
  const updatedUser = await Customer.findOneAndUpdate(updateQuery, {
    name: name,
    email: email,
    secondary_email: secondary_email,
    secondary_phone: secondary_phone,
    emails: emailsArray,
    mc_code: mc_code,
    phone: phone,
    address: address,
    country: country,
    state: state,
    city: city,
    assigned_to: normalizedAssignedTo,
    zipcode: zipcode,
    created_by:req.user._id,
  }, {
    new: true, 
    runValidators: true,
  });

  if(!updatedUser){ 
    res.send({
      status: false,
      customer : updatedUser,
      message: "Failed to update customer information.",
    });
  } 
  res.send({
    status: true,
    error : updatedUser,
    message: "Customer has been updated.",
  });
});

exports.deleteCustomer = catchAsync(async (req, res) => {
    try {
      const criteria = { _id: req.params.id };
      if (req.tenantId) criteria.tenantId = req.tenantId;
      if (req.user && req.user.company) criteria.company = req.user.company._id;
      const hasCustomersPermission = req.user?.permissions?.includes('customers') || req.user?.permissions?.includes('subadmin');
      const isAdmin = req.user && req.user.is_admin === 1 && req.user.role === 3;
      if (req.user && !isAdmin && !hasCustomersPermission) {
        criteria.$or = [
          { assigned_to: req.user._id },
          { assigned_to: null },
          { assigned_to: { $exists: false } },
        ];
      }
      const customer = await Customer.findOne(criteria);
      if (!customer) {
        return res.status(404).json({
          status: false,
          error: 'customer not found.',
        });
      }
      customer.deletedAt = Date.now();
      const result = await customer.save();
      if (result) {
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
