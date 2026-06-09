const jwt = require('jsonwebtoken');
const { promisify } = require('util');
const User = require('../db/Users');
const SuperAdmin = require('../db/SuperAdmin');
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/AppError');

if (!process.env.SECRET_ACCESS) {
  console.error('⚠️  CRITICAL: SECRET_ACCESS env var not set — using insecure fallback. Set it in .env immediately!');
}
const SECRET_ACCESS = process.env.SECRET_ACCESS || 'MYSECRET';

/**
 * JWT Authentication middleware
 * Validates JWT token and attaches user to request
 */
const authenticateJWT = catchAsync(async (req, res, next) => {
  console.log('🔐 authenticateJWT called for:', req.method, req.url);
  console.log('📝 Headers:', JSON.stringify(req.headers, null, 2));
  console.log('🍪 Cookies:', req.cookies);
  
  // Prefer Authorization header if present (fix emulation overriding stale cookies)
  let token = null;
  let authHeader = req.headers.Authorization || req.headers.authorization;
  console.log('🔍 Auth header:', authHeader);
  
  if (authHeader && authHeader.startsWith('Bearer')) {
    token = authHeader.split(' ')[1];
    console.log('✅ Token from Authorization header');
  }
  
  // Fallback to JWT cookie
  if (!token) {
    token = req.cookies?.jwt;
    if (token) {
      console.log('✅ Token from JWT cookie');
    }
  }
  
  console.log('🎩 Final token:', token ? 'EXISTS' : 'NULL');
  
  if (!token) {
    console.log('❌ No token found, returning 401');
    return next(new AppError('Authentication required. Please log in.', 401));
  }
  
  try {
    // Verify the token
    const decoded = await promisify(jwt.verify)(token, SECRET_ACCESS);
    
    // Handle emulation tokens differently
    if (decoded.isEmulating || decoded.isSuperAdmin) {
      // Verify super admin record exists and is active
      const superAdmin = await SuperAdmin.findOne({ userId: decoded.id, status: 'active' });
      if (!superAdmin) {
        return next(new AppError('Super admin account not found or inactive', 401));
      }

      // Get the linked user record (best-effort; some endpoints need req.user fields)
      const actualUser = await User.findById(decoded.id);
      req.user = actualUser || { _id: decoded.id, name: superAdmin.name, email: superAdmin.email };
      req.superAdmin = superAdmin;
      req.isSuperAdminUser = true;

      // Set emulation context if token is for emulation
      if (decoded.isEmulating) {
        req.isEmulating = true;
        req.tenantId = decoded.emulatedTenantId;
      }

      return next();
    }
    
    // Regular token - check if user still exists
    const currentUser = await User.findById(decoded.id).populate('company');
    if (!currentUser) {
      return next(new AppError('The user belonging to this token no longer exists.', 401));
    }
    
    // Check if user account is active
    if (currentUser.status === 'inactive') {
      return next(new AppError('Your account has been suspended. Please contact support.', 401));
    }
    
    // Check if user changed password after the token was issued
    if (currentUser.changedPasswordAt) {
      const changedTimestamp = parseInt(
        currentUser.changedPasswordAt.getTime() / 1000,
        10
      );
      if (decoded.iat < changedTimestamp) {
        return next(new AppError('User recently changed password. Please log in again.', 401));
      }
    }
    
    // Grant access to protected route
    req.user = currentUser;
    next();
  } catch (error) {
    return next(new AppError('Invalid or expired token. Please log in again.', 401));
  }
});

/**
 * Super Admin Authorization middleware
 * Requires user to be a super admin or an emulating user
 */
const requireSuperAdmin = catchAsync(async (req, res, next) => {
  console.log('🔐 requireSuperAdmin middleware called');
  console.log('🔍 req.user exists:', !!req.user);
  
  if (!req.user) {
    console.log('❌ No user in request');
    return next(new AppError('Authentication required', 401));
  }
  
  // Check for emulation token - decode the JWT directly to check flags
  let token = null;
  let authHeader = req.headers.Authorization || req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer')) {
    token = authHeader.split(' ')[1];
  }
  if (!token) {
    token = req.cookies?.jwt;
  }
  
  if (token) {
    console.log('🎩 Found token, verifying...');
    try {
      // Use jwt.verify (not jwt.decode) so signature and expiry are checked
      const decoded = await promisify(jwt.verify)(token, SECRET_ACCESS);
      console.log('🔍 Verified token claims:', JSON.stringify({ isSuperAdmin: decoded.isSuperAdmin, isEmulating: decoded.isEmulating }, null, 2));
      // If token indicates super admin privileges or emulation, allow access
      if (decoded.isSuperAdmin || decoded.isEmulating || decoded.originalUserId) {
        console.log('✅ Token has super admin/emulation privileges');
        req.isSuperAdminUser = true;

        // Set emulation context if token indicates emulation
        if (decoded.isEmulating) {
          req.isEmulating = true;
          if (decoded.emulatedTenantId) {
            req.tenantId = decoded.emulatedTenantId;
          }
        }

        return next();
      } else {
        console.log('⚠️ Token does not have required privileges');
      }
    } catch (error) {
      console.log('❌ Token verify error:', error.message);
      // Continue with regular super admin check
    }
  } else {
    console.log('❌ No token found');
  }
  
  // Check if user is a super admin
  const superAdmin = await SuperAdmin.findOne({ userId: req.user._id });
  if (!superAdmin || superAdmin.status !== 'active') {
    return next(new AppError('Super admin access required', 403));
  }
  
  req.superAdmin = superAdmin;
  req.isSuperAdminUser = true;
  next();
});

/**
 * Tenant Admin Authorization middleware
 * Requires user to be a tenant admin for their tenant
 */
const requireTenantAdmin = catchAsync(async (req, res, next) => {
  if (!req.user) {
    return next(new AppError('Authentication required', 401));
  }
  
  // Check if user is a tenant admin or has admin role (role 3)
  if (!req.user.isTenantAdmin && req.user.role !== 3) {
    return next(new AppError('Tenant administrator access required', 403));
  }
  
  next();
});

/**
 * Role-based authorization middleware factory
 * @param {Array} roles - Array of allowed role numbers
 */
const restrictTo = (...roles) => {
  return (req, res, next) => {
    if (!req.user) {
      return next(new AppError('Authentication required', 401));
    }
    
    if (!roles.includes(req.user.role)) {
      return next(new AppError('You do not have permission to perform this action', 403));
    }
    
    next();
  };
};

/**
 * Multi-tenant authorization middleware
 * Ensures user can only access resources within their tenant
 */
const requireTenantAccess = catchAsync(async (req, res, next) => {
  if (!req.user) {
    return next(new AppError('Authentication required', 401));
  }
  
  if (!req.tenantId) {
    return next(new AppError('Tenant context required', 400));
  }
  
  // Super admins can access any tenant
  const superAdmin = await SuperAdmin.findOne({ 
    userId: req.user._id, 
    status: 'active' 
  });
  if (superAdmin) {
    return next();
  }
  
  // Regular users can only access their own tenant
  if (req.user.tenantId !== req.tenantId) {
    return next(new AppError('Access denied. Invalid tenant context.', 403));
  }
  
  next();
});

/**
 * Optional authentication middleware
 * Attaches user to request if token is valid, but doesn't require authentication
 */
const optionalAuth = catchAsync(async (req, res, next) => {
  let token = null;
  let authHeader = req.headers.Authorization || req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer')) {
    token = authHeader.split(' ')[1];
  }
  
  if (!token) {
    token = req.cookies?.jwt;
  }
  
  if (!token) {
    return next(); // Continue without authentication
  }
  
  try {
    const decoded = await promisify(jwt.verify)(token, SECRET_ACCESS);
    const currentUser = await User.findById(decoded.id).populate('company');
    
    if (currentUser && currentUser.status === 'active') {
      req.user = currentUser;
    }
  } catch (error) {
    // Ignore token errors in optional auth
  }
  
  next();
});

module.exports = {
  authenticateJWT,
  requireSuperAdmin,
  requireTenantAdmin,
  restrictTo,
  requireTenantAccess,
  optionalAuth
};