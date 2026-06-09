const User = require("../db/Users");
const jwt = require("jsonwebtoken");
const catchAsync = require("../utils/catchAsync");
const {promisify} = require("util");
const AppError = require("../utils/AppError");
const SendEmail = require("../utils/Email");
const { logActivity } = require("../utils/activityLogger");

const crypto = require("crypto");
const JSONerror = require("../utils/jsonErrorHandler");
const logger = require("../utils/logger");
if (!process.env.SECRET_ACCESS) {
  console.error('⚠️  CRITICAL: SECRET_ACCESS env var not set — using insecure fallback. Set it in .env immediately!');
}
const SECRET_ACCESS = process.env.SECRET_ACCESS || 'MYSECRET';
const bcrypt = require('bcrypt');
const Company = require("../db/Company");
const EmployeeDoc = require("../db/EmployeeDoc");
const Tenant = require("../db/Tenant");
const SuperAdmin = require("../db/SuperAdmin");
const fileupload = require('../utils/fileupload');

const signToken = async (id) => {
  const token = jwt.sign(
    {id}, 
    SECRET_ACCESS, 
    {expiresIn:'14400m'}
  );
  return token
}

const validateToken = catchAsync ( async (req, res, next) => {
  // First check for JWT in cookies (preferred for security)
  let token = req.cookies?.jwt;
  
  // Fallback to Authorization header for backward compatibility
  if (!token) {
    let authHeader = req.headers.Authorization || req.headers.authorization;
    if (authHeader && authHeader.startsWith("Bearer")) {
      token = authHeader.split(" ")[1];
    }
  }
  
  if (!token) {
    return res.status(401).json({
      status: false,
      message: "User is not authorized or Token is missing",
    });
  }
  
  try {
    const decode = await promisify(jwt.verify)(token, SECRET_ACCESS);
    if (decode) {
      let result = await User.findById(decode.id).populate('company');
      if (!result) {
        return res.status(401).json({
          status: false,
          message: 'User not found',
        });
      }
      req.user = result;
      next();
    } else {
      res.status(401).json({
        status: false,
        message: 'Unauthorized',
      });
    }
  } catch (err) {
    res.status(401).json({
      status: false,
      message: 'Invalid or expired token',
      error: err
    });
  }
});
const editUser = catchAsync(async (req, res, next) => {
  // Authorization check: allow if is_admin === 1 OR role === 3 (Tenant Admin)
  const hasEmployeesPermission = req.user?.permissions?.includes('employees') || req.user?.permissions?.includes('subadmin');
  if (req.user && req.user.is_admin !== 1 && req.user.role !== 3 && !hasEmployeesPermission) {
    return res.json({
      status : false,
      message : "You are not authorized to access this route."
    });
  }

  // Prevent client from setting tenantId
  if ('tenantId' in req.body) {
    delete req.body.tenantId;
  }

  // Get tenant context — required, never optional
  const tenantIdFromContext = req.tenantId || req.user?.tenantId;
  if (!tenantIdFromContext) {
    return res.status(400).json({
      status: false,
      message: "Tenant context is required to edit a user."
    });
  }

  // Find user strictly within the same tenant
  const filter = { _id: req.params.id, tenantId: tenantIdFromContext };
  const existedUser = await User.findOne(filter, null, { includeInactive: true });
  
  if (!existedUser) {
    return res.json({
      status : false,
      message : "User not found or access denied."
    });
  }

  // Sub-admins (not the main tenant admin) cannot modify the main tenant admin account
  const isFullAdmin = req.user?.is_admin === 1 || Number(req.user?.role) === 3;
  const targetIsMainAdmin = existedUser.is_admin === 1 || Number(existedUser.role) === 3;
  if (!isFullAdmin && targetIsMainAdmin) {
    return res.status(403).json({
      status: false,
      message: "You are not authorized to modify the administrator account."
    });
  }

  if(req.body.email !== existedUser?.email){
    // Check if new email is already in use within tenant
    const emailExists = await User.findOne({ 
      email: req.body.email, 
      tenantId: tenantIdFromContext,
      _id: { $ne: req.params.id }
    }, null, { includeInactive: true });
    
    if (emailExists) {
      return res.json({
        status : false,
        message : "Your given email address is already used."
      });
    }
  } 
  
  // Commission validation on update
  const editNeedsCommission = req.body.permissions?.includes('regular') || req.body.permissions?.includes('outsourcing') || req.body.permissions?.includes('subadmin');
  if (editNeedsCommission && (req.body.staff_commision === undefined || req.body.staff_commision === null || req.body.staff_commision === '')) {
    return res.status(400).json({
      status: false,
      message: "Staff commission is required for regular, outsourcing, or subadmin roles."
    });
  }

  try {
    const payload = {
      name: req.body.name,
      email: req.body.email,
      staff_commision: editNeedsCommission ? req.body.staff_commision : null,
      country: req.body.country,
      phone: req.body.phone,
      position: req.body.position,
      address: req.body.address,
      permissions: req.body.permissions || [],
      modulesCustomized: false
    };
    const result = await User.findByIdAndUpdate(req.params.id, payload, { new: true, includeInactive: true });

    result.password = undefined;
    logActivity(req, {
      action: 'UPDATE',
      module: 'employee',
      description: `Updated employee "${result.name}" (${result.email})`,
      resourceId: result._id,
      resourceName: result.name,
    });
    res.send({
      status: true,
      user: result,
      message: "User has been updated.",
    });
  } catch (err) {
    JSONerror(res, err, next);
    logger(err);
  }
});

const suspandUser = catchAsync(async (req, res, next) => {
  const hasEmployeesPermission = req.user?.permissions?.includes('employees') || req.user?.permissions?.includes('subadmin');
  if(req.user && req.user.is_admin !== 1 && req.user.role !== 3 && !hasEmployeesPermission){
    return res.json({
      status : false,
      message : "You are not authorized to access this route."
    });
  }
  
  // Get tenant context for security — mandatory, never skip
  const tenantIdFromContext = req.tenantId || req.user?.tenantId;
  if (!tenantIdFromContext) {
    return res.status(400).json({ status: false, message: "Tenant context is required." });
  }

  // Build filter with tenant context
  const filter = { _id: req.params.id, tenantId: tenantIdFromContext };
  
  // Include inactive users in the search
  const existedUser = await User.findOne(filter, null, { includeInactive: true });
  
  if (!existedUser) {
    return res.json({
      status: false,
      message: "User not found or access denied."
    });
  }
  
  const newStatus = existedUser.status === 'active' ? 'inactive' : 'active';
  const actionMessage = existedUser.status === 'active' ? 'suspended' : 'reactivated';
  
  try {
    const updatedUser = await User.findByIdAndUpdate(
      req.params.id, 
      { status: newStatus },
      { new: true, includeInactive: true }
    );
    
    if (updatedUser) {
      updatedUser.password = undefined;
    }
    
    logActivity(req, {
      action: 'STATUS_CHANGE',
      module: 'employee',
      description: `Employee "${existedUser.name}" account ${actionMessage}`,
      resourceId: existedUser._id,
      resourceName: existedUser.name,
      details: { newStatus },
    });
    res.send({
      status: true,
      user: updatedUser,
      message: `User account has been ${actionMessage}.`,
    });
  } catch (err) {
    JSONerror(res, err, next);
    logger(err);
  }
});

const signup = catchAsync(async (req, res, next) => {
  // Extract fields and explicitly exclude privileged fields from body
  const { permissions, name, email, avatar, password, generateAutoPassword, staff_commision, position, country, phone, address } = req.body;

  // Prevent client from injecting privileged fields
  if ('tenantId' in req.body) delete req.body.tenantId;
  if ('is_admin' in req.body) delete req.body.is_admin;
  if ('role' in req.body) delete req.body.role;
  
  // Authorization check: allow if is_admin === 1 or role === 3 or has permission
  const hasEmployeesPermission = req.user?.permissions?.includes('employees') || req.user?.permissions?.includes('subadmin');
  if (req.user && req.user.is_admin !== 1 && req.user.role !== 3 && !hasEmployeesPermission) {
    return res.json({
      status : false,
      message : "You are not authorized to create user."
    });
  }

  // Get tenant context from authenticated user
  const creator = req.user;
  const tenantIdFromContext = req.tenantId || (creator && creator.tenantId);

  // Require tenant context
  if (!tenantIdFromContext) {
    return res.status(400).json({
      status: false,
      message: "Tenant context is required to create an employee"
    });
  }

  // Commission is required when user has a commission-eligible permission
  const needsCommission = permissions?.includes('regular') || permissions?.includes('outsourcing') || permissions?.includes('subadmin');
  if (needsCommission && (staff_commision === undefined || staff_commision === null || staff_commision === '')) {
    return res.status(400).json({
      status: false,
      message: "Staff commission is required for regular, outsourcing, or subadmin roles."
    });
  }

  // Resolve company — inherit from creator, or look up by tenantId
  let companyId = creator?.company?._id || creator?.company || null;
  if (!companyId) {
    const Company = require('../db/Company');
    const foundCompany = await Company.findOne({ tenantId: tenantIdFromContext });
    if (!foundCompany) {
      return res.status(400).json({
        status: false,
        message: "Company not found for this tenant. Cannot create employee."
      });
    }
    companyId = foundCompany._id;
  }

  // Check if email is already used within the same tenant
  const isEmailUsed = await User.findOne({ email: email, tenantId: tenantIdFromContext }, null, { includeInactive: true });
  let generatedPassword = password || '';
  if(generateAutoPassword === 1){
    generatedPassword = crypto.randomBytes(10).toString('hex');
  }

  if(isEmailUsed){
    return res.json({
      status : false,
      message : "Your given email address is already used."
    });
  }

  // Generate unique corporate ID
  let corporateID;
  let isUnique = false;
  while (!isUnique) {
    corporateID = `CCID${crypto.randomInt(100000, 1000000)}`;
    const existingUser = await User.findOne({ corporateID }, null, { includeInactive: true });
    if (!existingUser) {
      isUnique = true;
    }
  }

  try {
    const result = await User.create({
      name: name,
      email: email, 
      staff_commision : (permissions?.includes('regular') || permissions?.includes('outsourcing') || permissions?.includes('subadmin')) ? staff_commision : null,
      avatar: avatar || '',
      corporateID: corporateID,
      created_by: creator && creator._id,
      password: generatedPassword,
      country: country,
      phone: phone,
      address: address,
      company: companyId,
      position: position,
      confirmPassword: generatedPassword,
      tenantId: tenantIdFromContext,
      permissions: permissions || [],
      modulesCustomized: false
    });
    
    result.password = undefined;
    logActivity(req, {
      action: 'CREATE',
      module: 'employee',
      description: `Created employee "${name}" (${email})`,
      resourceId: result._id,
      resourceName: name,
    });
    res.send({
      status: true,
      generatedUser : {
        name: name,
        generatedPassword: generatedPassword,
        email: email,
        corporateID: corporateID
      },
      user: result,
      message: "User has been created.",
    });
  } catch (err) {
    JSONerror(res, err, next);
    logger(err);
  }
});
 
const login = catchAsync ( async (req, res, next) => { 
   const { email, password, tenantId } = req.body;
   const normalizedEmail = (email || '').trim().toLowerCase();
   const normalizedTenantId = (tenantId || '').trim().toLowerCase();
   if(!email || !password){
      return next(new AppError("Email and password is required !!", 401))
   }
   if(!tenantId){
      return next(new AppError("Tenant ID is required !!", 401))
   }
    const user = await User.findOne({ email: normalizedEmail, tenantId: normalizedTenantId }).select('+password').lean();
    
    if (!user) {
        return res.status(200).json({ status: false, message: "Invalid Details" });
    } 

    if (user.status === 'inactive') {
        return res.status(200).json({ status: false, message: "Your account is suspended!" });
    }
    const pp= await bcrypt.compare(password, user.password)
    console.log("await bcrypt.compare(password", pp);

   if(!user || !(await bcrypt.compare(password, user.password))){
    return res.status(200).json({
      status : false, 
      message:"Details are invalid.",
     });   
   }
   
   const token = await signToken(user._id);
  //  res.cookie('jwt', token, {
  //   expires:new Date(Date.now() + 30*24*60*60*1000),
  //   httpOnly:true,
  //  });
   res.cookie('jwt', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production', // Use true in production (HTTPS)
    sameSite: 'Strict', // or 'Lax' for less strict
    maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
  });

  user.password = undefined;
  user.confirmPassword = undefined;

  // Ensure permissions array exists
  user.permissions = user.permissions || [];
  user.isTenantAdmin = user.is_admin === 1;

   logActivity(req, {
     action: 'LOGIN',
     module: 'auth',
     description: `User "${user.name}" logged in`,
     resourceId: user._id,
     resourceName: user.name,
   });
   res.status(200).json({
    status :true,
    message:"Login Successfully !!",
    user : user,
    token
   });
});

const profile = catchAsync ( async (req, res) => {
  if (!req.user) {
    return res.status(200).json({
      status: false,
      message: "Unauthorized",
    });
  }

  const isSuperAdmin = req.isSuperAdminUser || req.superAdmin;
  const isEmulating = req.isEmulating && req.tenantId;
  
  const validModules = ['outsourcing', 'regular'];
  const sanitizeModules = (value) => Array.isArray(value)
    ? value.map((m) => String(m).toLowerCase().trim()).filter((m) => validModules.includes(m))
    : [];

  let userProfile = {
    _id: req.user._id,
    id: req.user._id,
    name: req.user.name,
    email: req.user.email,
    status: req.user.status || 'active',
    permissions: req.user.permissions || [],
    corporateID: req.user.corporateID,
    is_admin: req.user.is_admin,
    isTenantAdmin: req.user.is_admin === 1,
    tenantId: req.user.tenantId,
    position: req.user.position,
    phone: req.user.phone,
    country: req.user.country,
    address: req.user.address,
    avatar: req.user.avatar,
    createdAt: req.user.createdAt
  };

  // If emulating or regular user, we should intersect with plan modules
  const tenantIdForPlan = req.tenantId || req.user.tenantId;
  if (tenantIdForPlan) {
    try {
      const tenant = await Tenant.findOne({ tenantId: tenantIdForPlan });
      if (tenant && tenant.subscription) {
        let planModules = sanitizeModules(tenant.subscription.allowedModules);
        
        // Fallback to plan record if cached is default and plan exists
        if (tenant.subscription.plan) {
          try {
            const SubscriptionPlan = require('../db/SubscriptionPlan');
            const rawPlanRef = tenant.subscription.plan;
            let planRecord = null;
            const planRefStr = String(rawPlanRef || '');
            if (require('mongoose').Types.ObjectId.isValid(planRefStr)) {
              planRecord = await SubscriptionPlan.findById(planRefStr);
            } else if (typeof rawPlanRef === 'string' && rawPlanRef.trim()) {
              planRecord = await SubscriptionPlan.findOne({ slug: rawPlanRef.trim(), isActive: true });
            } else if (tenant.subscription.planSlug) {
              planRecord = await SubscriptionPlan.findOne({ slug: tenant.subscription.planSlug, isActive: true });
            }
            if (planRecord && Array.isArray(planRecord.allowedModules) && planRecord.allowedModules.length > 0) {
              planModules = sanitizeModules(planRecord.allowedModules);
            }
          } catch (planErr) {
            console.error('Plan fetch error in profile:', planErr);
          }
        }
        if (!planModules.length) planModules = ['outsourcing'];

        // Remove regular/outsourcing permissions from userProfile if they aren't in the plan
        userProfile.permissions = userProfile.permissions.filter(p => {
          if (p === 'regular' || p === 'outsourcing') {
            return planModules.includes(p);
          }
          return true;
        });

        // Super admin emulating gets all plan modules
        if (isSuperAdmin && isEmulating) {
           if (planModules.includes('regular') && !userProfile.permissions.includes('regular')) userProfile.permissions.push('regular');
           if (planModules.includes('outsourcing') && !userProfile.permissions.includes('outsourcing')) userProfile.permissions.push('outsourcing');
        }
      }
    } catch (err) {
      console.error('Plan modules fetch error:', err);
    }
  }

  // Handle superadmin emulation
  if (isSuperAdmin && isEmulating) {
    // Show superadmin's actual details with emulation context
    userProfile.name = `${req.user.name} (Emulating)`;
    userProfile.userType = 'super_admin_emulating';
    userProfile.status = 'active'; // Superadmin is always active during emulation
    userProfile.isEmulating = true;
    userProfile.emulatedTenantId = req.tenantId;
    
    // Add tenant context if available
    if (req.tenant) {
      userProfile.emulatingTenant = {
        tenantId: req.tenant.tenantId,
        name: req.tenant.name
      };
    }
  } else if (isSuperAdmin) {
    userProfile.userType = 'super_admin';
  } else {
    userProfile.userType = 'tenant_user';
    userProfile.tenantId = req.user.tenantId;
    if (req.isEmulatingEmployee) {
      userProfile.isEmulatingEmployee = true;
    }
  }

  // Find company for the current tenant context
  const filter = {};
  if (req.tenantId) {
    filter.tenantId = req.tenantId;
  } else if (req.user.tenantId) {
    filter.tenantId = req.user.tenantId;
  }
  
  const company = await Company.findOne(filter);
  
  res.status(200).json({
    status: true,
    user: userProfile,
    company: company,
  });
});

const employeesLisiting = catchAsync ( async (req, res) => {
  // Get tenant ID from request context (prefer req.tenantId from tenant resolver)
  const tenantId = req.tenantId || req.user?.tenantId;
  const validModules = ['outsourcing', 'regular'];
  const sanitizeModules = (value) => Array.isArray(value)
    ? value.map((m) => String(m).toLowerCase().trim()).filter((m) => validModules.includes(m))
    : [];
  
  if (!tenantId) {
    return res.status(400).json({
      status: false,
      message: "Tenant context is required",
      lists: [],
      totalDocuments: 0
    });
  }
  
  // Build filter using tenant context and exclude admins and drivers
  const baseFilter = { 
    tenantId: tenantId,
    is_admin: { $ne: 1 }, // Exclude admin users from employee listing
    permissions: { $ne: 'driver' }, // Exclude drivers
    role: { $ne: 0 } // Exclude legacy drivers
  };
  
  // If dbFilter from tenantDataFilter middleware exists, merge it
  if (req.dbFilter) {
    Object.assign(baseFilter, req.dbFilter);
  }

  let planModules = ['outsourcing', 'regular'];
  try {
    const tenant = await Tenant.findOne({ tenantId }).select('subscription.allowedModules').lean();
    const fromTenant = sanitizeModules(tenant?.subscription?.allowedModules);
    if (fromTenant.length) planModules = fromTenant;
  } catch (e) {}

  let companyEffectiveModules = planModules;
  const isTenantAdmin = req.user?.is_admin === 1 || req.user?.is_admin === 1 || req.user?.isTenantAdmin === true;
  if (isTenantAdmin) {
    const adminModules = sanitizeModules(req.user?.allowedModules);
    const legacyRestricted = adminModules.length > 0 && planModules.length > 0 && adminModules.length < planModules.length;
    const useAdminModules = (req.user?.modulesCustomized === true || legacyRestricted) && adminModules.length > 0;
    if (useAdminModules) {
      const clipped = adminModules.filter((m) => planModules.includes(m));
      if (clipped.length) companyEffectiveModules = clipped;
    }
  }
  
  // Debug logging for development
  if (process.env.NODE_ENV !== 'production') {
    console.log('🔍 employeesListing context:', {
      userId: req.user?._id?.toString(),
      userEmail: req.user?.email,
      reqTenantId: req.tenantId,
      userTenantId: req.user?.tenantId,
      finalTenantId: tenantId,
      filter: JSON.stringify(baseFilter)
    });
  }
  
  try {
    // Use Mongoose query with proper filtering - include inactive users so we don't lose historical data
    const employees = await User.find(baseFilter, null, { includeInactive: true })
      .select('name email status tenantId createdAt position phone country address corporateID created_by permissions staff_commision modulesCustomized')
      .sort({ createdAt: -1 })
      .lean();
    
    // Filter out drivers and admins manually if the DB query didn't catch them
    const employeesWithEffective = employees
      .filter(emp => {
        // Double check they aren't drivers or legacy drivers
        if (emp.role === 0 || (Array.isArray(emp.permissions) && emp.permissions.includes('driver'))) {
          return false;
        }
        return true;
      })
      .map((emp) => {
      // Ensure permissions array exists
      emp.permissions = Array.isArray(emp.permissions) ? emp.permissions : [];
      
      // Filter regular/outsourcing permissions based on company's plan modules
      emp.permissions = emp.permissions.filter(p => {
        if (p === 'regular' || p === 'outsourcing') {
          return companyEffectiveModules.includes(p);
        }
        return true;
      });
      
      return emp;
    });
    
    const totalDocuments = employeesWithEffective.length;
    
    // Debug logging for development
    if (process.env.NODE_ENV !== 'production') {
      console.log(`✅ Found ${totalDocuments} employees for tenant "${tenantId}"`);
      if (employeesWithEffective.length > 0) {
        console.log('First few employees:', employeesWithEffective.slice(0, 3).map(emp => ({ 
          name: emp.name, 
          email: emp.email, 
          tenantId: emp.tenantId 
        })));
      }
    }
    
    res.status(200).json({
      status: true,
      lists: employeesWithEffective,
      totalDocuments: totalDocuments
    });
  } catch (error) {
    console.error('Error in employeesListing:', error);
    res.status(500).json({
      status: false,
      message: "Failed to fetch employees",
      lists: [],
      totalDocuments: 0
    });
  }
});

const employeeDetail = catchAsync ( async (req, res) => {
  const employeeId = req.params.id;
  const tenantId = req.tenantId || req.user?.tenantId;
  if (!tenantId) {
    return res.status(400).json({ status: false, message: "Tenant context is required.", employee: null });
  }
  const companyId = req.user?.company?._id || req.user?.company || null;
  
  // Validate employee ID
  if (!employeeId || employeeId === 'undefined' || employeeId === 'null') {
    return res.status(400).json({
      status: false,
      message: "Valid employee ID is required.",
      employee: null
    });
  }
  // Check if employeeId is a valid ObjectId
  if (!employeeId.match(/^[0-9a-fA-F]{24}$/)) {
    return res.status(400).json({
      status: false,
      message: "Invalid employee ID format.",
      employee: null
    });
  }
  const criteria = { _id: employeeId, tenantId };
  if (companyId) criteria.company = companyId;
  const employee = await User.findOne(criteria, null, { includeInactive: true }).populate('company').lean();
  
  if (!employee) {
    return res.status(404).json({
      status: false,
      message: "Employee not found.",
      employee: null
    });
  }
  
  // Calculate effective permissions for employee detail view based on tenant plan
  let planModules = ['outsourcing', 'regular'];
  try {
    const tenant = await Tenant.findOne({ tenantId }).select('subscription.allowedModules').lean();
    if (tenant?.subscription?.allowedModules) {
      planModules = tenant.subscription.allowedModules.map(m => String(m).toLowerCase().trim()).filter(m => ['outsourcing', 'regular'].includes(m));
    }
  } catch (e) {}

  employee.permissions = Array.isArray(employee.permissions) ? employee.permissions : [];
  employee.permissions = employee.permissions.filter(p => {
    if (p === 'regular' || p === 'outsourcing') {
      return planModules.includes(p);
    }
    return true;
  });
  
  // Remove sensitive information
  employee.password = undefined;
  employee.confirmPassword = undefined;
  
  res.status(200).json({
    status: true,
    employee: employee,
  });
});

const employeesDocs = catchAsync ( async (req, res) => {
  const employeeId = req.params.id;
  const tenantId = req.tenantId || req.user?.tenantId;
  if (!tenantId) {
    return res.status(400).json({ status: false, message: "Tenant context is required.", documents: [] });
  }
  const companyId = req.user?.company?._id || req.user?.company || null;
  
  // Validate employee ID
  if (!employeeId || employeeId === 'undefined' || employeeId === 'null') {
    return res.status(400).json({
      status: false,
      message: "Valid employee ID is required.",
      documents: []
    });
  }
  
  // Check if employeeId is a valid ObjectId
  if (!employeeId.match(/^[0-9a-fA-F]{24}$/)) {
    return res.status(400).json({
      status: false,
      message: "Invalid employee ID format.",
      documents: []
    });
  }
  
  const employeeCriteria = { _id: employeeId, tenantId };
  if (companyId) employeeCriteria.company = companyId;
  const employee = await User.findOne(employeeCriteria).select('_id').lean();
  if (!employee) {
    return res.status(404).json({ status: false, message: "Employee not found.", documents: [] });
  }
  const documents = await EmployeeDoc.find({ tenantId, user: employeeId }).populate('added_by').sort({ createdAt: -1 });
  console.log("documents", documents);
  
  res.status(200).json({
    status: true,
    documents: documents || [],
  });
});

const forgotPassword = catchAsync ( async (req, res, next) => {
  const user = await User.findOne({email:req.body.email}, null, { includeInactive: true });
  if(!user){
    return res.json({
      status:false,
      message:"No user found associated with this email.",
    });
  }
  const resetToken = await user.createPasswordResetToken();
  await user.save({validateBeforeSave:false});
  const resetTokenUrl = `${process.env.DOMAIN_URL}/user/resetpassword/${resetToken}`;
  const message = `<html xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta http-equiv="content-type" content="text/html; charset=utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0;">
  <meta name="format-detection" content="telephone=no" />

  <style>
    body{margin:0;padding:0;min-width:100%;width:100% !important;height:100% !important;}
body,table,td,div,p,a{-webkit-font-smoothing:antialiased;text-size-adjust:100%;-ms-text-size-adjust:100%;-webkit-text-size-adjust:100%;line-height:100%;}
table,td{mso-table-lspace:0pt;mso-table-rspace:0pt;border-collapse:collapse !important;border-spacing:0;}
img{border:0;line-height:100%;outline:none;text-decoration:none;-ms-interpolation-mode:bicubic;}
#outlook a{padding:0;}
.ReadMsgBody{width:100%;}
.ExternalClass{width:100%;}
.ExternalClass,.ExternalClass p,.ExternalClass span,.ExternalClass font,.ExternalClass td,.ExternalClass div{line-height:100%;}
@media all and (min-width:560px){body{margin-top:30px;}
}
/* Rounded corners */
 @media all and (min-width:560px){.container{border-radius:8px;-webkit-border-radius:8px;-moz-border-radius:8px;-khtml-border-radius:8px;}
}
/* Links */
 a,a:hover{color:#127DB3;}
.footer a,.footer a:hover{color:#999999;}

  </style>
  <title>🔒 Reset Your Password</title>
</head>

<!-- BODY -->
<body topmargin="0" rightmargin="0" bottommargin="0" leftmargin="0" marginwidth="0" marginheight="0" width="100%" style="border-collapse: collapse; border-spacing: 0;  padding: 0; width: 100%; height: 100%; -webkit-font-smoothing: antialiased; text-size-adjust: 100%; -ms-text-size-adjust: 100%; -webkit-text-size-adjust: 100%; line-height: 100%;
	background-color: #ffffff;
	color: #000000;" bgcolor="#ffffff" text="#000000">
  <table width="100%" align="center" border="0" cellpadding="0" cellspacing="0" style="border-collapse: collapse; border-spacing: 0; margin: 0; padding: 0; width: 100%;" class="background">
    <tr>
      <td align="center" valign="top" style="border-collapse: collapse; border-spacing: 0; margin: 0; padding: 0;" bgcolor="#ffffff">
        <table border="0" cellpadding="0" cellspacing="0" align="center" bgcolor="#FFFFFF" width="560" style="border-collapse: collapse; border-spacing: 0; padding: 0; width: inherit;
	max-width: 560px;" class="container">
          <tr>
            <td align="center" valign="top" style="border-collapse: collapse; border-spacing: 0; margin: 0; padding: 0; padding-left: 6.25%; padding-right: 6.25%; width: 87.5%; font-size: 24px; font-weight: bold; line-height: 130%;padding-top: 25px;color: #000000;font-family: sans-serif;" class="header">
              <img border="0" vspace="0" hspace="0" src="https://runstream.co/logo-white.png" style="max-width: 250px;" alt="The Idea" title="Runstream" />
            </td>
          </tr>
          <tr>
            <td align="center" valign="top" style="border-collapse: collapse; border-spacing: 0; margin: 0; padding: 0; padding-left: 6.25%; padding-right: 6.25%; width: 87.5%;
			padding-top: 25px;" class="line">
            </td>
          </tr>
          <tr>
            <td align="center" valign="top" style="border-collapse: collapse; border-spacing: 0; margin: 0; padding: 0; padding-left: 6.25%; padding-right: 6.25%; width: 87.5%; font-size: 17px; font-weight: 400; line-height: 160%;
			padding-top: 25px; 
			color: #000000;
			font-family: sans-serif;" class="paragraph">
              Hi ${user.name || ""},<br> We received a request to reset your password for your runstream account. No worries, it happens to the best of us!
              <br>
              To reset your password, please click the button below:
              <br>
            </td>
          </tr>
          <tr>
            <td align="center" valign="top" style="border-collapse: collapse; border-spacing: 0; margin: 0; padding: 0; padding-left: 6.25%; padding-right: 6.25%; width: 87.5%; padding-top: 25px;padding-bottom: 5px;" class="button">
                <table border="0" cellpadding="0" cellspacing="0" align="center" style=" min-width: 120px; border-collapse: collapse; border-spacing: 0; padding: 0;">
                  <tr>
                    <td align="center" valign="middle" style="border-collapse: collapse;"  >
                      <a target="_blank" style="padding: 12px 24px; margin: 0; border-collapse: collapse; text-decoration: none; border-spacing: 0; border-radius: 10px; -webkit-border-radius: 10px; -moz-border-radius: 10px; -khtml-border-radius: 10px; background: #df3939; text-decoration: none; max-width: 240px;
                        color: #FFFFFF; font-family: sans-serif; font-size: 17px; font-weight: 400; line-height: 120%;"  href=${resetTokenUrl}>
                          Reset Password
                      </a>
                    </td>
                  </tr>
                </table>
            </td>
          </tr>
          <tr>
            <td align="center" valign="top" style="border-collapse: collapse; border-spacing: 0; margin: 0; padding: 0; padding-left: 6.25%; padding-right: 6.25%; width: 87.5%;
			padding-top: 25px;" class="line">
            </td>
          </tr>
          <tr>
            <td align="center" valign="top" style="border-collapse: collapse; border-spacing: 0; margin: 0; padding: 0; padding-left: 6.25%; padding-right: 6.25%; width: 87.5%; font-size: 17px; font-weight: 400; line-height: 160%;
			padding-top: 20px;
			padding-bottom: 25px;
			color: #000000;
			font-family: sans-serif;" class="paragraph">
              If you have any questions or need assistance, feel free to reach out to our support team at <a href="mailto:Support@runstream.co" target="_blank" style=" color: #4b57ff; ">support@runstream.co</a>. We’re here to help!. 
            </td>
          </tr>
        </table>
        <table border="0" cellpadding="0" cellspacing="0" align="center" width="560" style="border-collapse: collapse; border-spacing: 0; padding: 0; width: inherit;
	max-width: 560px;" class="wrapper">
          <tr>
            <td align="center" valign="top" style="border-collapse: collapse; border-spacing: 0; margin: 0; padding: 0; padding-left: 6.25%; padding-right: 6.25%; width: 87.5%; font-size: 13px; font-weight: 400; line-height: 150%;
			padding-top: 20px;
			padding-bottom: 20px;
			color: #999999;
			font-family: sans-serif;" class="footer">
              For more information <a href="https://runstream.co/contact" target="_blank" style=" color: #999999; ">contact us</a>. Our support
              team is available to help you 24 hours a day, seven days a week.
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
  try {
    const send = await SendEmail({
      email:user.email,
      subject:"🔒 Reset Your Password",
      message
    });
    console.log('send', send);
    res.status(200).json({
      status:true,
      message:"Password Reset link sent your email address."
    })
  } catch (err){
    console.log("err",err)
    user.passwordResetToken = undefined;
    user.resetTokenExpire = undefined;
    await user.save({ validateBeforeSave:false });
    next(
      res.status(200).json({
        status:false,
        message:"Failed to reset your password. Please try again later."
      })
    )
  }
});

const resetpassword = catchAsync ( async (req, res, next) => {
  if(req.body.password !== req.body.confirmPassword){
    return res.json({
      status:false,
      message:"Confirm password is incorrect. Please try again later.",
    });
  }
  const hashToken = crypto.createHash('sha256').update(req.params.token).digest('hex');
  const user = await User.findOne({
    passwordResetToken:hashToken,
    resetTokenExpire : { $gt: Date.now()}
  });
  if(!user){
    return res.json({
      status:false,
      message:"Link expired or invalid token.",
    });
  }
  user.password = req.body.password;
  user.confirmPassword = req.body.confirmPassword;
  user.passwordResetToken = undefined;
  user.resetTokenExpire = undefined;
  await user.save({validateBeforeSave:false});
  res.json({
    status:true,
    message:"Password changed successfully.",
  }); 
});

const addCompanyInfo = catchAsync ( async (req, res, next) => {
  const tenantIdForCompany = req.tenantId || req.user?.tenantId;
  if (!tenantIdForCompany) {
    return res.status(400).json({ status: false, message: "Tenant context is required." });
  }
  const {name, email, phone, address, companyID, bank_name, account_name, account_number, routing_number, remittance_primary_email, remittance_secondary_email, rate_confirmation_terms} = req.body;
  if(companyID){
    // Find company by ID and ensure it belongs to the current tenant
    const filter = { _id: companyID, tenantId: tenantIdForCompany };
    const existing = await Company.findOne(filter);
    if(existing){
      existing.name = name !== '' && name !== undefined ? name : existing.name;
      existing.email = email !== '' && email !== undefined ? email : existing.email;
      existing.address = address  !== '' && address !== undefined ? address : existing.address;
      existing.phone = phone !== '' && phone !== undefined ? phone : existing.phone;
      existing.bank_name = bank_name !== '' && bank_name !== undefined ? bank_name : existing.bank_name;
      existing.account_name = account_name !== '' && account_name !== undefined ? account_name : existing.account_name;
      existing.account_number = account_number !== '' && account_number !== undefined ? account_number : existing.account_number;
      existing.routing_number = routing_number !== '' && routing_number !== undefined ? routing_number : existing.routing_number;
      existing.remittance_primary_email = remittance_primary_email !== '' && remittance_primary_email !== undefined ? remittance_primary_email : existing.remittance_primary_email;
      existing.remittance_secondary_email = remittance_secondary_email !== '' && remittance_secondary_email !== undefined ? remittance_secondary_email : existing.remittance_secondary_email;
      existing.rate_confirmation_terms = rate_confirmation_terms !== '' && rate_confirmation_terms !== undefined ? rate_confirmation_terms : existing.rate_confirmation_terms;
      await existing.save();
      logActivity(req, {
        action: 'UPDATE',
        module: 'company',
        description: `Updated company details "${existing.name}"`,
        resourceId: existing._id,
        resourceName: existing.name,
      });
      return res.send({
        status: true,
        company :existing,
        message: "Details has been updated.",
      });
    }
  }
  Company.create({
    name: name,
    email: email,
    address: address,
    phone: phone,
    bank_name: bank_name,
    account_name: account_name,
    account_number: account_number,
    routing_number: routing_number,
    remittance_primary_email: remittance_primary_email,
    remittance_secondary_email: remittance_secondary_email,
    rate_confirmation_terms: rate_confirmation_terms,
    tenantId: tenantIdForCompany,
  }).then(result => {
    logActivity(req, {
      action: 'CREATE',
      module: 'company',
      description: `Created company "${result.name}"`,
      resourceId: result._id,
      resourceName: result.name,
    });
    res.send({
      status: true,
      company :result,
      message: "Details has been updated.",
    });
  }).catch(err => {
    JSONerror(res, err, next);
    logger(err);
  });
});

const uploadCompanyLogo = catchAsync(async (req, res) => {
  const tenantId = req.tenantId || req.user?.tenantId;
  if (!tenantId) {
    return res.status(400).json({
      status: false,
      message: "Tenant context is required",
    });
  }

  const attachment = req.files?.attachment?.[0] || req.file;
  if (!attachment) {
    return res.status(400).json({
      status: false,
      message: "No file uploaded",
    });
  }

  const variant = 'pdf';

  const companyId = req.user?.company?._id || req.user?.company || null;
  const filter = { tenantId };
  if (companyId) filter._id = companyId;

  const company = await Company.findOne(filter);
  if (!company) {
    return res.status(404).json({
      status: false,
      message: "Company not found",
    });
  }

  const uploadResponse = await fileupload(attachment);
  if (!uploadResponse || !uploadResponse.url) {
    return res.status(500).json({
      status: false,
      message: "File upload failed",
      error: uploadResponse,
    });
  }

  company.pdf_logo = uploadResponse.url;
  company.logo = uploadResponse.url;

  await company.save();
  logActivity(req, {
    action: 'UPDATE',
    module: 'company',
    description: `Updated company logo "${company.name}"`,
    resourceId: company._id,
    resourceName: company.name,
  });

  return res.status(200).json({
    status: true,
    message: "Logo updated successfully.",
    company,
    variant,
    url: uploadResponse.url,
  });
});

const changePassword = async (req, res) => {
    try {
        const { id, password, currentPassword } = req.body;

        const tenantId = req.tenantId || req.user?.tenantId || null;
        if (!tenantId) {
          return res.status(400).json({
            status: false,
            message: 'Tenant context required.'
          });
        }

        const targetId = id || req.user?._id || req.user?.id;
        if (!targetId) {
          return res.status(400).json({
            status: false,
            message: 'User id is required.'
          });
        }

        const requesterId = req.user?._id || req.user?.id;
        const isSelf = requesterId && String(targetId) === String(requesterId);
        const isTenantAdmin = req.user?.is_admin === 1 || req.user?.is_admin === 1 || req.user?.isTenantAdmin;

        if (!isSelf && !isTenantAdmin) {
          return res.status(403).json({
            status: false,
            message: 'Not allowed to change password for this user.'
          });
        }

        if (!password || typeof password !== 'string' || password.length < 8) {
          return res.status(400).json({
            status: false,
            message: 'Password must be at least 8 characters long.'
          });
        }

        // 1. Find the user with password field included
        const criteria = { _id: targetId, tenantId };
        const companyId = req.user?.company?._id || req.user?.company || null;
        if (companyId) criteria.company = companyId;

        const user = await User.findOne(criteria).select('+password');
        if (!user) return res.status(200).json({ 
          status: false,
          message: 'User not found.' 
        });

        if (isSelf) {
          if (!currentPassword || typeof currentPassword !== 'string') {
            return res.status(400).json({
              status: false,
              message: 'Current password is required.'
            });
          }
          const isMatch = await user.checkPassword(currentPassword, user.password);
          if (!isMatch) {
            return res.status(401).json({
              status: false,
              message: 'Current password is incorrect.'
            });
          }
        }

        user.password = password;
        user.changedPasswordAt = Date.now();
        await user.save();

        logActivity(req, {
          action: 'UPDATE',
          module: 'auth',
          description: `Password changed for "${user.name}" (${user.email})`,
          resourceId: user._id,
          resourceName: user.name,
        });

        res.status(200).json({
          status:true,
          message: 'Password updated successfully.'
         });

    } catch (err) {
        console.error(err);
        res.status(500).json({ 
          status:false,
          message: 'Server error.'
         });
    }
};

const logout = catchAsync(async (req, res) => {
  if (req.user) {
    logActivity(req, {
      action: 'LOGOUT',
      module: 'auth',
      description: `User "${req.user.name}" logged out`,
      resourceId: req.user._id,
      resourceName: req.user.name,
    });
  }
  // Clear the JWT cookie
  res.cookie('jwt', '', {
    expires: new Date(Date.now() + 10 * 1000), // Expire in 10 seconds
    httpOnly: true,
  });

  res.status(200).json({
    status: true,
    message: 'Logged out successfully !!!'
  });
});


/**
 * Test debug endpoint
 */
const debugTest = (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(404).json({ status: false, message: 'Not found' });
  }
  console.log('🚨 DEBUG TEST ENDPOINT CALLED');
  res.json({ debug: 'working', timestamp: new Date() });
};

/**
 * Test Super Admin Login
 */
const testSuperAdminLogin = catchAsync(async (req, res, next) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(404).json({ status: false, message: 'Not found' });
  }
  const { email, password } = req.body;
  
  console.log('🗺 TEST SUPER ADMIN LOGIN CALLED');
  console.log('- email:', email);
  console.log('- password length:', password?.length);
  
  try {
    const superAdmin = await SuperAdmin.findOne({ email }).select('+password');
    console.log('👤 SuperAdmin found:', !!superAdmin);
    
    if (!superAdmin) {
      return res.json({ status: false, message: 'SuperAdmin not found', debug: true });
    }
    
    const passwordMatch = await bcrypt.compare(password, superAdmin.password);
    console.log('🔑 Password match:', passwordMatch);
    
    if (!passwordMatch) {
      return res.json({ status: false, message: 'Password does not match', debug: true });
    }
    
    if (superAdmin.status !== 'active') {
      return res.json({ status: false, message: 'SuperAdmin not active', debug: true });
    }
    
    const token = await signToken(superAdmin.userId);
    const user = await User.findById(superAdmin.userId).populate('company');
    
    res.json({
      status: true,
      message: 'Test super admin login successful!',
      debug: true,
      superAdmin: {
        name: superAdmin.name,
        email: superAdmin.email,
        status: superAdmin.status
      },
      user: user ? {
        name: user.name,
        email: user.email,
        role: user.role
      } : null,
      hasToken: !!token
    });
    
  } catch (error) {
    console.error('❌ Test login error:', error);
    res.json({ status: false, message: 'Error occurred', error: error.message, debug: true });
  }
});

/**
 * Multi-tenant login - handles both regular users and super admins
 */
const multiTenantLogin = catchAsync(async (req, res, next) => {
  const { email, password, tenantId, isSuperAdmin } = req.body;
  const normalizedEmail = (email || '').trim().toLowerCase();
  const normalizedTenantIdInput = (tenantId || '').trim().toLowerCase();
  const requestedSuperAdmin = isSuperAdmin === true || String(isSuperAdmin).toLowerCase() === 'true';
  
  if (!email || !password) {
    console.log('❌ Missing email or password');
    return next(new AppError("Email and password are required!", 400));
  }
  
  try {
    // Prefer tenant login when same email exists in tenant users.
    // This avoids accidental super-admin login caused by stale SuperAdmin records from old migrations.
    const userWithEmail = await User.findOne({ email: normalizedEmail }).select('+password').populate('company');

    // Only attempt super-admin login when explicitly requested OR when email doesn't exist as tenant user.
    if (requestedSuperAdmin || !userWithEmail) {
      const superAdmin = await SuperAdmin.findOne({ email: normalizedEmail }).select('+password');
      
      if (superAdmin) {
        console.log('🔍 Found super admin with email:', email);
        
        const isPasswordValid = await superAdmin.checkPassword(password, superAdmin.password);
        if (!isPasswordValid) {
          console.log('❌ Super admin password invalid');
          return res.status(200).json({
            status: false,
            message: "Invalid credentials"
          });
        }
        
        if (superAdmin.status !== 'active') {
          console.log('❌ Super admin account inactive');
          return res.status(200).json({
            status: false,
            message: "Account is inactive"
          });
        }
        
      // Create an explicit super-admin token so downstream validation does not
      // accidentally infer super-admin access from stale/misaligned user links.
      const token = jwt.sign(
        {
          id: superAdmin.userId,
          role: 'super_admin',
          isSuperAdmin: true
        },
        SECRET_ACCESS,
        { expiresIn: '14400m' }
      );
        
        res.cookie('jwt', token, {
          httpOnly: true,
          secure: process.env.NODE_ENV === 'production',
          sameSite: 'Strict',
          maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
        });
        
        // Get the actual user record
        const user = await User.findById(superAdmin.userId).populate('company');
        user.password = undefined;
        
        // Update super admin's last login
        superAdmin.lastLogin = new Date();
        await superAdmin.save({ validateBeforeSave: false });
        
        return res.status(200).json({
          status: true,
          message: "Login successful!",
          user,
          isSuperAdmin: true,
          token,
          redirectTo: "/super-admin"
        });
      }
    }
    
    // If not super admin, try to find tenant user
    console.log('🔍 Not super admin, searching for tenant user with email:', normalizedEmail);
    
    // If tenantId is provided (backward compatibility), use it
    if (tenantId) {
      console.log('🔍 Using provided tenantId:', tenantId);
    } else {
      // Auto-detect tenant from user email - use pre-fetched user
      console.log('🔍 Auto-detecting tenant from user email...');
      
      if (!userWithEmail) {
        console.log('❌ No user found with email:', email);
        return res.status(200).json({
          status: false,
          message: "Invalid credentials"
        });
      }
      
      console.log('✅ Found tenant user, using tenantId:', userWithEmail.tenantId);
      // Use the user's tenantId for tenant validation
      req.body.tenantId = (userWithEmail.tenantId || '').toLowerCase();
    }
    
    const finalTenantId = normalizedTenantIdInput || req.body.tenantId;
    
    console.log('🔍 Looking up tenant with tenantId:', finalTenantId);
    
    // Check if we can find the tenant without status filter first
    let tenantAny = await Tenant.findOne({ tenantId: finalTenantId });

    // If not found by tenantId, try by subdomain (for backward compatibility)
    if (!tenantAny) {
      tenantAny = await Tenant.findOne({ subdomain: finalTenantId });
    }

    const actualTenantId = tenantAny ? tenantAny.tenantId : finalTenantId;
    console.log('🔍 Using actualTenantId for status lookup:', actualTenantId);
    
    const tenant = await Tenant.findOne({ 
      tenantId: actualTenantId, 
      status: { $in: ['active'] } 
    });
    
    console.log('🔍 Tenant lookup result:', tenant ? 'FOUND' : 'NOT FOUND');
    if (tenant) {
      console.log('✅ Tenant found:', {
        tenantId: tenant.tenantId,
        name: tenant.name,
        status: tenant.status,
        subdomain: tenant.subdomain
      });
    }
    
    if (!tenant) {
      return res.status(200).json({
        status: false,
        message: "Company not found or inactive"
      });
    }
    
    // Find user within the tenant
    const user = await User.findOne({
      email: normalizedEmail,
      tenantId: actualTenantId
    }).select('+password').populate('company');
    
    if (!user) {
      console.log('❌ User not found - returning invalid credentials');
      return res.status(200).json({
        status: false,
        message: "Invalid credentials"
      });
    }
    
    if (user.status === 'inactive') {
      console.log('❌ User account is inactive');
      return res.status(200).json({
        status: false,
        message: "Your account is suspended!"
      });
    }
    
    console.log('🔓 Checking password for user');
    const passwordMatch = await bcrypt.compare(password, user.password);
    console.log('🔓 Password match result:', passwordMatch);
    
    if (!passwordMatch) {
      console.log('❌ Password does not match - returning invalid credentials');
      return res.status(200).json({
        status: false,
        message: "Invalid credentials"
      });
    }
    
    console.log('🎉 All validations passed - generating token');
    const token = await signToken(user._id);
    console.log('📝 Token generated successfully');
    
    // Set cookie with proper configuration for cross-origin requests
    res.cookie('jwt', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production', // Only secure in production
      sameSite: process.env.NODE_ENV === 'production' ? 'None' : 'Lax', // Allow cross-origin in production
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
      domain: process.env.NODE_ENV === 'production' ? '.logistikore.com' : undefined // Allow subdomain sharing
    });
    
    console.log('🍪 Cookie set with config:', {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: process.env.NODE_ENV === 'production' ? 'None' : 'Lax',
      maxAge: '7 days',
      domain: process.env.NODE_ENV === 'production' ? '.logistikore.com' : 'none'
    });
    
    try {
      const valid = ['outsourcing', 'regular'];
      const sanitize = (arr) => Array.isArray(arr)
        ? arr.map((m) => String(m).toLowerCase().trim()).filter((m) => valid.includes(m))
        : [];

      let planModules = sanitize(tenant?.subscription?.allowedModules);
      if (!planModules.length) planModules = ['outsourcing', 'regular'];
      if (tenant?.subscription?.plan) {
        const SubscriptionPlan = require('../db/SubscriptionPlan');
        const rawPlanRef = tenant.subscription.plan;
        const planRefStr = String(rawPlanRef || '');
        let planRecord = null;
        if (require('mongoose').Types.ObjectId.isValid(planRefStr)) {
          planRecord = await SubscriptionPlan.findById(planRefStr);
        } else if (typeof rawPlanRef === 'string' && rawPlanRef.trim()) {
          planRecord = await SubscriptionPlan.findOne({ slug: rawPlanRef.trim(), isActive: true });
        } else if (tenant.subscription.planSlug) {
          planRecord = await SubscriptionPlan.findOne({ slug: tenant.subscription.planSlug, isActive: true });
        }
        if (planRecord && Array.isArray(planRecord.allowedModules) && planRecord.allowedModules.length > 0) {
          planModules = sanitize(planRecord.allowedModules);
        }
      }
      const userModules = sanitize(user.allowedModules);
      if (user.role === 3 || user.is_admin === 1) {
        const legacyRestricted = userModules.length > 0 && planModules.length > 0 && userModules.length < planModules.length;
        const useAdminModules = (user.modulesCustomized === true || legacyRestricted) && userModules.length > 0;
        user.allowedModules = useAdminModules ? userModules.filter((m) => planModules.includes(m)) : planModules;
      } else {
        const legacyRestricted = userModules.length > 0 && planModules.length > 0 && userModules.length < planModules.length;
        const useUserModules = (user.modulesCustomized === true || legacyRestricted) && userModules.length > 0;
        user.allowedModules = useUserModules ? userModules.filter((m) => planModules.includes(m)) : planModules;
      }
    } catch (e) {}

    user.password = undefined;

    logActivity(req, {
      action: 'LOGIN',
      module: 'auth',
      description: `User "${user.name}" logged in`,
      resourceId: user._id,
      resourceName: user.name,
    });

    console.log('✅ MULTITENANT LOGIN SUCCESS - Returning success response');
    console.log('🔐 MULTITENANT LOGIN DEBUGGING END');

    res.status(200).json({
      status: true,
      message: "Login successful!",
      user,
      tenant: {
        tenantId: tenant.tenantId,
        name: tenant.name,
        subdomain: tenant.subdomain
      },
      token,
      redirectTo: "/home"
    });
    
  } catch (error) {
    console.error('❌ MULTITENANT LOGIN ERROR:', error);
    console.error('❌ Stack trace:', error.stack);
    console.log('🔐 MULTITENANT LOGIN DEBUGGING END (ERROR)');
    return res.status(500).json({
      status: false,
      message: "Login failed. Please try again."
    });
  }
});

module.exports = { changePassword, addCompanyInfo, uploadCompanyLogo, suspandUser, editUser, employeesLisiting, signup, login, multiTenantLogin, validateToken, profile, forgotPassword, resetpassword, employeesDocs, employeeDetail, logout, debugTest, testSuperAdminLogin };
