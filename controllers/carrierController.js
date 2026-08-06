const catchAsync = require("../utils/catchAsync");
const APIFeatures  = require("../utils/APIFeatures");
const Carrier = require("../db/Carrier");
const JSONerror = require("../utils/jsonErrorHandler");
const logger = require("../utils/logger");
const axios = require("axios");
const { checkCarrierLimit } = require("../middlewares/planLimitsMiddleware");
const { logActivity } = require("../utils/activityLogger");
const { resolveRouteDistance } = require("../utils/routeDistance");

exports.addCarrier = catchAsync(async (req, res, next) => {
  const isAdmin = req.user?.is_admin === 1 || Number(req.user?.role) === 3;
  const canWrite = req.user?.permissions?.includes('carriers_write') || req.user?.permissions?.includes('subadmin');
  if (req.user && !isAdmin && !canWrite) {
    return res.status(403).json({ status: false, message: "You are not authorized to add carriers." });
  }

  const { name, phone, email, emails, location, country, state, city, zipcode, secondary_email, secondary_phone, mc_code } = req.body;
  const tenantId = req.tenantId || req.user?.tenantId;
  if (!tenantId) {
    return res.status(400).json({ status: false, message: "Tenant context is required." });
  }
  const companyId = req.user?.company?._id || req.user?.company || null;
  const existingCarrier = await Carrier.findOne({ tenantId, ...(companyId ? { company: companyId } : {}), mc_code });
    if (existingCarrier) {
    return res.status(200).json({
      status: false,
      message:"MC code already exists. Please use a different MC code." 
    });
  }

  let carrierID;
  let isUnique = false;
  while (!isUnique) {
    carrierID = `CR_ID${Math.floor(100000 + Math.random() * 900000)}`;
    const existingUser = await Carrier.findOne({ tenantId, ...(companyId ? { company: companyId } : {}), carrierID });
    if (!existingUser) {
      isUnique = true;
    }
  }

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

  const result = await Carrier.create({
    name: name,
    email: email,
    secondary_email: secondary_email,
    secondary_phone: secondary_phone,
    emails: emailsArray,
    location: location,
    phone: phone,
    carrierID: carrierID,
    country: country,
    state: state,
    city: city,
    zipcode: zipcode,
    created_by: req.user._id,
    mc_code: mc_code,
    company: companyId,
    tenantId,
  });
  logActivity(req, {
    action: 'CREATE',
    module: 'carrier',
    description: `Added carrier "${result.name}" (MC: ${result.mc_code})`,
    resourceId: result._id,
    resourceName: result.name,
  });
  return res.send({
    status: true,
    carrier: result,
    message: "Carrier has been added.",
  });
});

exports.carriers_listing = catchAsync(async (req, res) => {

    const { search } = req.query;
    const queryObj = {
      $or: [{ deletedAt: null }]
    };
    const tenantId = req.tenantId || req.user?.tenantId;
    if (!tenantId) {
      return res.status(400).json({ status: false, message: "Tenant context is required.", carriers: [], totalDocuments: 0 });
    }
    queryObj.tenantId = tenantId;
    // Admin, accountant, and users with outsourcing/carriers permission see all carriers in the tenant
    const isAdmin = req.user?.is_admin === 1 || Number(req.user?.role) === 3;
    const carrierPerms = ['carriers', 'carriers_write', 'outsourcing', 'accounting', 'subadmin'];
    const hasCarriersAccess = Array.isArray(req.user?.permissions) &&
      carrierPerms.some(p => req.user.permissions.includes(p));
    if (!isAdmin && !hasCarriersAccess && req.user?.company) queryObj.company = req.user.company._id;

    if (search && search.length >1) {
      const safeSearch = search.trim().replace(/[.*+?^${}()|[\\]\\]/g, '\\$&');
      const isNumber = !isNaN(search);
      if (isNumber) {
        queryObj.mc_code = { $regex: new RegExp(safeSearch, 'i') };
      } else {
        queryObj.name = { $regex: new RegExp(safeSearch, 'i') };
      }
    }

    let Query = new APIFeatures(Carrier.find(queryObj).populate('created_by'), req.query ).sort();
    const { query, totalDocuments, page, limit, totalPages } = await Query.paginate();
    const data = await query;
    res.json({
      status: true,
      carriers: data,
      totalDocuments : totalDocuments,
      page : page,
      per_page : limit,
      totalPages : totalPages,
      message: data.length ? undefined : "No files found"
    });
});

exports.deleteCarrier = catchAsync(async (req, res) => {
    const isAdminDel = req.user?.is_admin === 1 || Number(req.user?.role) === 3;
    const canWriteDel = req.user?.permissions?.includes('carriers_write') || req.user?.permissions?.includes('subadmin');
    if (req.user && !isAdminDel && !canWriteDel) {
      return res.status(403).json({ status: false, message: "You are not authorized to delete carriers." });
    }

    try {
      const tenantIdDel = req.tenantId || req.user?.tenantId;
      if (!tenantIdDel) {
        return res.status(400).json({ status: false, message: 'Tenant context missing.' });
      }
      const criteria = { _id: req.params.id, tenantId: tenantIdDel };
      const carrier = await Carrier.findOne(criteria);
      if (!carrier) {
        return res.status(404).json({
          status: false,
          error: 'Carrier not found.',
        });
      }
      
      // Free the email so it can be re-used for a new carrier in this company
      if (carrier.email && !String(carrier.email).startsWith('deleted_')) {
        carrier.email = `deleted_${Date.now()}_${carrier.email}`;
      }
      carrier.deletedAt = Date.now();
      const result = await carrier.save();
      if (result) {
        logActivity(req, {
          action: 'DELETE',
          module: 'carrier',
          description: `Deleted carrier "${carrier.name}" (MC: ${carrier.mc_code})`,
          resourceId: carrier._id,
          resourceName: carrier.name,
        });
        return res.status(200).json({
          status: true,
          message: `Carrier has been removed.`,
          carrier: result,
        });
      } else {
        return res.status(400).json({
          status: false,
          carrier: null,
          error: 'Something went wrong in removing the carrier. Please try again.',
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

exports.updateCarrier = catchAsync(async (req, res, next) => {
  const isAdminUpd = req.user?.is_admin === 1 || Number(req.user?.role) === 3;
  const canWriteUpd = req.user?.permissions?.includes('carriers_write') || req.user?.permissions?.includes('subadmin');
  if (req.user && !isAdminUpd && !canWriteUpd) {
    return res.status(403).json({ status: false, message: "You are not authorized to update carriers." });
  }

  try {
    const { mc_code, name, phone, email, emails, location, country, state, city, zipcode, secondary_email, secondary_phone } = req.body;
    const tenantIdChk = req.tenantId || req.user?.tenantId;
    if (!tenantIdChk) {
      return res.status(400).json({ status: false, message: 'Tenant context missing.' });
    }
    if (mc_code) {
      const existingCarrier = await Carrier.findOne({ mc_code: mc_code, _id: {$ne: req.params.id }, tenantId: tenantIdChk });
      if (existingCarrier) {
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
    // Build update object with processed emails
    const updateData = {
        name: name,
        email: email,
        location: location,
        phone: phone,
        country: country,
        state: state,
        city: city,
        zipcode: zipcode,
        mc_code: mc_code,
        secondary_email: secondary_email,
        secondary_phone: secondary_phone
    };

    // Include emails array if it was processed
    if (emailsArray.length > 0) {
      updateData.emails = emailsArray;
    }

    const tenantId = req.tenantId || req.user?.tenantId;
    if (!tenantId) {
      return res.status(400).json({ status: false, message: "Tenant context is required." });
    }
    const updateQuery = { _id: req.params.id, tenantId };
    const updatedUser = await Carrier.findOneAndUpdate(updateQuery, updateData, {
      new: true,
      runValidators: true,
    });
    if(!updatedUser){
      return res.send({
        status: false,
        carrier: null,
        message: "Failed to update carrier information.",
      });
    }
    logActivity(req, {
      action: 'UPDATE',
      module: 'carrier',
      description: `Updated carrier "${updatedUser.name}"`,
      resourceId: updatedUser._id,
      resourceName: updatedUser.name,
    });
    return res.send({
      status: true,
      carrier: updatedUser,
      message: "Carrier has been updated.",
    });
  } catch (error) {
    res.send({
      status: false,
      error :error,
      message: "Failed to update carrier information.",
    });
  }
});

exports.carrierDetail = catchAsync(async (req, res, next) => {
  const tenantId = req.tenantId || req.user?.tenantId;
  if (!tenantId) {
    return res.status(400).json({ status: false, message: "Tenant context is required." });
  }
  const criteria = { _id: req.params.id, tenantId };
  const c = await Carrier.findOne(criteria);
  if(!c){
    return res.send({
      status: false,
      result: null,
      message: "Carrier not found",
    });
  }
  res.send({
    status: true,
    result: c,
    message: "Carrier details retrieved.",
  });
});

exports.getDistance = async (req, res) => {
  const locations = req.body.locations;

  if (!locations || locations.length <= 1) {
    return res.status(200).json({
      status: false,
      msg: "At least 2 locations are required."
     });
  }
  const origin = locations[0];
  const destination = locations[locations?.length - 1];
  const waypoints = locations.slice(1, -1);

  try {
    // Routing honours the company's route_country_policy: a trip whose ends are in the same
    // country is kept inside that country, because Google's fastest route otherwise cuts across
    // the border and reports fewer miles than the truck actually drives.
    const tenantId = req.tenantId || req.user?.tenantId;
    const result = await resolveRouteDistance({
      origin,
      destination,
      waypoints,
      tenantId,
      optimizeWaypoints: true,
    });

    if (!result.ok) {
      return res.status(200).json({
        status: false,
        msg: result.error || "No route found between given locations.",
      });
    }

    res.json({
      status: true,
      msg: "Distance calculated successfully",
      origin,
      destination,
      waypoints,
      locations,
      totalKm: result.km.toFixed(2),
      totalMiles: result.miles.toFixed(2),
      totalDurationMin: Math.round(result.durationSeconds / 60),
      // Assumptions behind the number — stored on the order and shown as a badge, so a route
      // that had to cross a border is visible instead of silently baked into driver pay.
      crossesBorder: result.crossesBorder,
      countries: result.countries,
      homeCountry: result.homeCountry,
      routePolicy: result.policy,
      distanceSource: result.source,
      corridorUsed: result.corridorUsed,
    });
  } catch (error) {
    res.status(200).json({
      status: false,
      msg: error.response?.data?.error_message || error.message || "Failed to fetch route info"
    });
  }
};
