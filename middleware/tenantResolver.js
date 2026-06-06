const Tenant = require('../db/Tenant');
const catchAsync = require('../utils/catchAsync');

/**
 * Middleware to resolve tenant from subdomain or domain
 * Sets req.tenant, req.tenantId, and req.isLandingPage
 */
const tenantResolver = catchAsync(async (req, res, next) => {
  const hostname = req.get('Host') || req.hostname || '';
  const protocol = req.protocol;
  const originalUrl = req.originalUrl;
  
  // Log request details for debugging
  console.log(`🌐 Request: ${protocol}://${hostname}${originalUrl}`);
  
  // Parse hostname to extract subdomain
  const hostParts = hostname.split('.');
  let subdomain = null;
  let isMainDomain = false;
  let isSuperAdmin = false;
  
  // Handle different hostname formats
  if (hostname.includes('localhost') || hostname.includes('127.0.0.1')) {
    // Development mode - check for query parameter or port-based routing
    const tenantParam = req.query.tenant;
    
    if (tenantParam === 'admin') {
      isSuperAdmin = true;
      subdomain = 'admin';
    } else if (tenantParam) {
      subdomain = tenantParam;
    } else {
      // Default to main domain/landing page in dev
      isMainDomain = true;
    }
    
  } else if (hostParts.length >= 3) {
    // Production subdomain format: subdomain.domain.com
    subdomain = hostParts[0];
    
    // Check for special subdomains
    if (subdomain === 'admin') {
      isSuperAdmin = true;
    } else if (subdomain === 'www') {
      isMainDomain = true;
      subdomain = null;
    }
    
  } else if (hostParts.length === 2) {
    // Main domain: domain.com
    isMainDomain = true;
  }
  
  // Set request flags
  req.isLandingPage = isMainDomain;
  req.isSuperAdmin = isSuperAdmin;
  req.subdomain = subdomain;
  
  console.log(`🏷️  Parsed: subdomain=${subdomain}, isLanding=${isMainDomain}, isSuperAdmin=${isSuperAdmin}`);
  
  // Handle landing page requests
  if (isMainDomain) {
    req.tenant = null;
    req.tenantId = null;
    console.log('📄 Landing page request');
    return next();
  }
  
  // Handle super admin requests
  if (isSuperAdmin) {
    req.tenant = null;
    req.tenantId = null;
    console.log('👑 Super admin request');
    return next();
  }
  
  // Handle tenant requests
  if (subdomain) {
    try {
      // Find tenant by tenantId only
      const tenant = await Tenant.findOne({ 
        tenantId: subdomain,
        status: { $in: ['active'] }
      }).lean();
      
      if (!tenant) {
        console.log(`❌ Tenant not found for subdomain: ${subdomain}`);
        return res.status(404).json({
          status: false,
          error: 'tenant_not_found',
          message: 'Company not found or inactive',
          subdomain: subdomain
        });
      }
      
      // Check if tenant subscription is active and not expired
      if (
        !tenant.subscription ||
        tenant.subscription.status !== 'active'
      ) {
        console.log(`❌ Inactive subscription for tenant: ${subdomain}`);
        return res.status(403).json({
          status: false,
          error: 'subscription_inactive',
          message: 'Company subscription is inactive'
        });
      }
      
      req.tenant = tenant;
      req.tenantId = tenant.tenantId;
      
      // Update last activity
      Tenant.findByIdAndUpdate(tenant._id, { 
        'usage.lastActivity': new Date() 
      }).catch(err => console.log('Failed to update tenant activity:', err.message));
      
      console.log(`✅ Tenant resolved: ${tenant.name} (${tenant.tenantId})`);
      
    } catch (error) {
      console.error('❌ Tenant resolution error:', error.message);
      return res.status(500).json({
        status: false,
        error: 'tenant_resolution_failed',
        message: 'Failed to resolve tenant'
      });
    }
  } else {
    // No subdomain and not main domain - invalid request
    console.log('❌ Invalid request format');
    return res.status(400).json({
      status: false,
      error: 'invalid_request',
      message: 'Invalid domain format'
    });
  }
  
  next();
});

/**
 * Middleware to require tenant context
 * Use this for routes that must have a tenant
 */
const requireTenant = (req, res, next) => {
  if (!req.tenant || !req.tenantId) {
    return res.status(400).json({
      status: false,
      error: 'tenant_required',
      message: 'This endpoint requires tenant context'
    });
  }
  next();
};

/**
 * Middleware to require super admin access
 * Use this for super admin only routes
 */
const requireSuperAdmin = (req, res, next) => {
  if (!req.isSuperAdmin) {
    return res.status(403).json({
      status: false,
      error: 'super_admin_required',
      message: 'Super admin access required'
    });
  }
  next();
};

/**
 * Middleware to require landing page context
 * Use this for landing page only routes
 */
const requireLandingPage = (req, res, next) => {
  if (!req.isLandingPage) {
    return res.status(403).json({
      status: false,
      error: 'landing_page_required',
      message: 'This endpoint is only available on the landing page'
    });
  }
  next();
};

/**
 * Helper function to generate tenant URL
 */
const generateTenantUrl = (subdomain, domain = process.env.DOMAIN || 'localhost:3000') => {
  if (domain.includes('localhost')) {
    return `http://localhost:3000/home?tenant=${subdomain}`;
  }
  return `https://${subdomain}.${domain}/home`;
};

/**
 * Helper function to generate super admin URL
 */
const generateSuperAdminUrl = (domain = process.env.DOMAIN || 'localhost:3000') => {
  if (domain.includes('localhost')) {
    return `http://localhost:3000?tenant=admin`;
  }
  return `https://admin.${domain}`;
};

/**
 * Lightweight middleware to ensure tenant context is available for API routes
 * Used for routes that need tenant context but don't want full tenant resolution
 */
const ensureTenantContext = catchAsync(async (req, res, next) => {
  // Prefer tenantId from emulation or previously set context (already authenticated)
  let tParam = req.tenantId;

  // Fallback to query param only — never trust the x-tenant-id header from
  // unauthenticated callers as it allows arbitrary tenant context injection
  if (!tParam) {
    const tParamRaw = req.query?.tenant;
    tParam = (tParamRaw || '').toString().trim().toLowerCase();
  }

  if (tParam && !req.tenant) {
    const tenant = await Tenant.findOne({ 
      $or: [{ tenantId: tParam }, { subdomain: tParam }]
    });
    if (tenant) {
      req.tenantId = tenant.tenantId;
      req.tenant = tenant;
    }
  }
  next();
});

module.exports = {
  tenantResolver,
  requireTenant,
  requireSuperAdmin,
  requireLandingPage,
  generateTenantUrl,
  generateSuperAdminUrl,
  ensureTenantContext
};
