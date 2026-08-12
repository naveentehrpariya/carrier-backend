const catchAsync = require("../utils/catchAsync");
const APIFeatures  = require("../utils/APIFeatures");
const Carrier = require("../db/Carrier");
const JSONerror = require("../utils/jsonErrorHandler");
const logger = require("../utils/logger");
const axios = require("axios");
const { checkCarrierLimit } = require("../middlewares/planLimitsMiddleware");
const { logActivity } = require("../utils/activityLogger");
const { resolveRouteDistance, getGoogleApiKey } = require("../utils/routeDistance");

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

  const trimmedName = String(name || '').trim();
  const trimmedEmail = email ? String(email).trim().toLowerCase() : undefined;
  const trimmedPhone = phone ? String(phone).trim() : undefined;
  const trimmedLocation = location ? String(location).trim() : undefined;
  const trimmedCountry = country ? String(country).trim() : undefined;
  const trimmedState = state ? String(state).trim() : undefined;
  const trimmedCity = city ? String(city).trim() : undefined;
  const trimmedZipcode = zipcode ? String(zipcode).trim() : undefined;
  const trimmedSecondaryEmail = secondary_email ? String(secondary_email).trim().toLowerCase() : undefined;
  const trimmedSecondaryPhone = secondary_phone ? String(secondary_phone).trim() : undefined;
  const trimmedMc = mc_code ? String(mc_code).trim() : undefined;

  const companyId = req.user?.company?._id || req.user?.company || null;
  const existingCarrier = await Carrier.findOne({ tenantId, ...(companyId ? { company: companyId } : {}), mc_code: trimmedMc });
  if (existingCarrier) {
    return res.status(200).json({
      status: false,
      message: "MC code already exists. Please use a different MC code." 
    });
  }

  if (trimmedEmail) {
    const existingEmail = await Carrier.findOne({ tenantId, ...(companyId ? { company: companyId } : {}), email: trimmedEmail });
    if (existingEmail) {
      return res.status(200).json({
        status: false,
        message: "Email already exists. Please use a different email address."
      });
    }
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
    if (trimmedEmail) {
      emailsArray.push({ email: trimmedEmail, is_primary: true, created_at: new Date() });
    }
    if (trimmedSecondaryEmail) {
      emailsArray.push({ email: trimmedSecondaryEmail, is_primary: false, created_at: new Date() });
    }
  }

  const result = await Carrier.create({
    name: trimmedName,
    email: trimmedEmail,
    secondary_email: trimmedSecondaryEmail,
    secondary_phone: trimmedSecondaryPhone,
    emails: emailsArray,
    location: trimmedLocation,
    phone: trimmedPhone,
    carrierID: carrierID,
    country: trimmedCountry,
    state: trimmedState,
    city: trimmedCity,
    zipcode: trimmedZipcode,
    created_by: req.user._id,
    mc_code: trimmedMc,
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
      const safeSearch = search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const searchRegex = new RegExp(safeSearch, 'i');
      queryObj.$and = queryObj.$and || [];
      queryObj.$and.push({
        $or: [
          { name: searchRegex },
          { mc_code: searchRegex },
          { carrierID: searchRegex },
          { email: searchRegex },
          { secondary_email: searchRegex },
          { 'emails.email': searchRegex },
          { phone: searchRegex },
          { secondary_phone: searchRegex },
          { location: searchRegex }
        ]
      });
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

    const trimmedName = name ? String(name).trim() : undefined;
    const trimmedEmail = email ? String(email).trim().toLowerCase() : undefined;
    const trimmedPhone = phone ? String(phone).trim() : undefined;
    const trimmedLocation = location ? String(location).trim() : undefined;
    const trimmedCountry = country ? String(country).trim() : undefined;
    const trimmedState = state !== undefined ? String(state).trim() : undefined;
    const trimmedCity = city !== undefined ? String(city).trim() : undefined;
    const trimmedZipcode = zipcode !== undefined ? String(zipcode).trim() : undefined;
    const trimmedSecondaryEmail = secondary_email ? String(secondary_email).trim().toLowerCase() : undefined;
    const trimmedSecondaryPhone = secondary_phone ? String(secondary_phone).trim() : undefined;
    const trimmedMc = mc_code ? String(mc_code).trim() : undefined;

    if (trimmedMc) {
      const existingCarrier = await Carrier.findOne({ mc_code: trimmedMc, _id: {$ne: req.params.id }, tenantId: tenantIdChk });
      if (existingCarrier) {
        return res.status(200).send({
          status: false,
          message: "MC Code must be unique. This MC Code is already in use.",
        });
      }
    }

    if (trimmedEmail) {
      const companyId = req.user?.company?._id || req.user?.company || null;
      const existingEmail = await Carrier.findOne({
        email: trimmedEmail,
        _id: { $ne: req.params.id },
        tenantId: tenantIdChk,
        ...(companyId ? { company: companyId } : {})
      });
      if (existingEmail) {
        return res.status(200).send({
          status: false,
          message: "Email must be unique. This email is already in use.",
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
    // Build update object with processed emails
    const updateData = {
        name: trimmedName,
        email: trimmedEmail,
        location: trimmedLocation,
        phone: trimmedPhone,
        country: trimmedCountry,
        state: trimmedState,
        city: trimmedCity,
        zipcode: trimmedZipcode,
        mc_code: trimmedMc,
        secondary_email: trimmedSecondaryEmail,
        secondary_phone: trimmedSecondaryPhone
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

// Google's Directions API answers NOT_FOUND / ZERO_RESULTS for the whole route without saying which
// stop it choked on. When routing fails we geocode each stop once to name the bad one, so the
// dispatcher is told which address to fix instead of a bare "NOT_FOUND". Failure path only.
async function findUnresolvableAddresses(locations) {
  const key = getGoogleApiKey();
  if (!key) return [];
  const results = await Promise.all(
    (locations || []).map(async (address) => {
      try {
        const resp = await axios.get('https://maps.googleapis.com/maps/api/geocode/json', {
          params: { address, key },
          timeout: 10000,
        });
        const ok = resp?.data?.status === 'OK' && Array.isArray(resp.data.results) && resp.data.results.length > 0;
        return ok ? null : address;
      } catch {
        return null; // a network blip is not proof the address is bad
      }
    })
  );
  return results.filter(Boolean);
}

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
      // resolveRouteDistance already geocoded every stop on its fallback path — reuse that answer
      // instead of paying for the same calls again.
      const unresolved = Array.isArray(result.unresolved) && result.unresolved.length
        ? result.unresolved
        : await findUnresolvableAddresses(locations);
      // Three different failures, three different messages. "ZERO_RESULTS" on its own tells the
      // dispatcher nothing: every stop was found, one of them just landed somewhere no truck can
      // drive to from the others — so name the pair and where each one actually landed.
      const pair = result.brokenPair;
      let msg;
      if (unresolved.length > 0) {
        msg = `Google could not find ${unresolved.length === 1 ? 'this address' : 'these addresses'}: ${unresolved.join(' | ')}`;
      } else if (pair) {
        msg = `No driving route between "${pair.from.typed}" (found as ${pair.from.resolvedTo}) and "${pair.to.typed}" (found as ${pair.to.resolvedTo}). One of these two addresses is landing in the wrong place — make it more specific.`;
      } else {
        msg = result.error === 'ZERO_RESULTS'
          ? 'Every stop was found, but Google cannot build a driving route between them. Check that each address is in the right city/country.'
          : (result.error || 'No route found between these stops.');
      }
      return res.status(200).json({
        status: false,
        msg,
        unresolved,
        brokenPair: pair || null,
        resolvedStops: result.resolvedStops || [],
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
      // Stops Google could not place from the typed text — routed from a reduced form (street+city,
      // or the postal code). Shown as a warning so the dispatcher can accept it or type the miles.
      approximatedStops: result.approximatedStops || [],
    });
  } catch (error) {
    const unresolved = await findUnresolvableAddresses(locations);
    res.status(200).json({
      status: false,
      msg: unresolved.length > 0
        ? `Google could not find ${unresolved.length === 1 ? 'this address' : 'these addresses'}: ${unresolved.join(' | ')}`
        : (error.response?.data?.error_message || error.message || "Failed to fetch route info"),
      unresolved,
    });
  }
};
