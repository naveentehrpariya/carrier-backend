const express = require('express');
const router = express.Router();
const { validateToken } = require('../controllers/multiTenantAuthController');
const { resolveTenant, optionalTenant } = require('../middleware/tenant');

// Guard: all tenant-debug routes are disabled in production
router.use((req, res, next) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(404).json({ status: false, message: 'Not found' });
  }
  next();
});
const Order = require('../db/Order');
const Customer = require('../db/Customer');
const Carrier = require('../db/Carrier');
const Company = require('../db/Company');
const User = require('../db/Users');

// Debug endpoint to test tenant resolution
router.get('/test-tenant-resolution', optionalTenant, async (req, res) => {
  try {
    const debug = {
      timestamp: new Date(),
      request: {
        url: req.url,
        query: req.query,
        headers: {
          host: req.headers.host,
          'x-tenant-id': req.headers['x-tenant-id']
        }
      },
      tenant: {
        resolved: !!req.tenantId,
        tenantId: req.tenantId,
        tenant: req.tenant ? {
          name: req.tenant.name,
          subdomain: req.tenant.subdomain,
          status: req.tenant.status
        } : null
      },
      user: req.user ? {
        id: req.user._id,
        tenantId: req.user.tenantId,
        role: req.user.role
      } : null
    };

    // If tenant is resolved, get data counts
    if (req.tenantId) {
      const [orders, customers, carriers] = await Promise.all([
        Order.countDocuments({ tenantId: req.tenantId }),
        Customer.countDocuments({ tenantId: req.tenantId }),
        Carrier.countDocuments({ tenantId: req.tenantId })
      ]);
      
      debug.data = { orders, customers, carriers };
    }

    res.json({
      status: true,
      debug
    });
  } catch (error) {
    res.status(500).json({
      status: false,
      error: error.message,
      debug: {
        query: req.query,
        headers: req.headers
      }
    });
  }
});

// Test order listing with tenant
router.get('/test-orders', validateToken, resolveTenant, async (req, res) => {
  try {
    const queryObj = {
      $or: [
        { deletedAt: null },
        { deletedAt: '' },
        { deletedAt: { $exists: false } }
      ]
    };

    // Scope by tenant
    if (req.tenantId) {
      queryObj.tenantId = req.tenantId;
    }

    const orders = await Order.find(queryObj)
      .populate(['customer', 'carrier'])
      .sort({ serial_no: -1 });

    res.json({
      status: true,
      debug: {
        tenantId: req.tenantId,
        queryObj,
        ordersFound: orders.length
      },
      orders: orders.map(order => ({
        serial_no: order.serial_no,
        tenantId: order.tenantId,
        total_amount: order.total_amount,
        order_status: order.order_status,
        customer: order.customer ? order.customer.name : null,
        carrier: order.carrier ? order.carrier.name : null
      }))
    });
  } catch (error) {
    res.status(500).json({
      status: false,
      error: error.message
    });
  }
});

router.post('/backfill-orders', validateToken, async (req, res) => {
  try {
    if (!req.isSuperAdminUser) {
      return res.status(403).json({
        status: false,
        error: 'super_admin_required',
        message: 'Only super admin may backfill orders.'
      });
    }

    const { tenantId } = req.body || {};
    if (!tenantId) {
      return res.status(400).json({
        status: false,
        error: 'tenantId_required',
        message: 'Provide tenantId in request body.'
      });
    }

    // Collect companies and users for the tenant
    const [companies, users] = await Promise.all([
      Company.find({ tenantId }).select('_id').lean(),
      User.find({ tenantId }).select('_id').lean()
    ]);
    const companyIds = companies.map(c => c._id);
    const userIds = users.map(u => u._id);

    // Prepare update filters (exclude already correct tenantId)
    const byCompanyFilter = companyIds.length
      ? { company: { $in: companyIds }, tenantId: { $ne: tenantId } }
      : null;
    const byUserFilter = userIds.length
      ? { created_by: { $in: userIds }, tenantId: { $ne: tenantId } }
      : null;

    let matchedByCompany = 0, matchedByUser = 0, updatedByCompany = 0, updatedByUser = 0;

    if (byCompanyFilter) {
      matchedByCompany = await Order.countDocuments(byCompanyFilter);
      const resUpdate = await Order.updateMany(byCompanyFilter, { $set: { tenantId } });
      updatedByCompany = resUpdate.modifiedCount || resUpdate.nModified || 0;
    }

    if (byUserFilter) {
      matchedByUser = await Order.countDocuments(byUserFilter);
      const resUpdate = await Order.updateMany(byUserFilter, { $set: { tenantId } });
      updatedByUser = resUpdate.modifiedCount || resUpdate.nModified || 0;
    }

    const remainingWrong = await Order.countDocuments({ tenantId: { $ne: tenantId }, $or: [
      companyIds.length ? { company: { $in: companyIds } } : { _id: null },
      userIds.length ? { created_by: { $in: userIds } } : { _id: null }
    ]});

    res.json({
      status: true,
      tenantId,
      stats: {
        companies: companies.length,
        users: users.length,
        matchedByCompany,
        matchedByUser,
        updatedByCompany,
        updatedByUser,
        remainingWrong
      }
    });
  } catch (error) {
    res.status(500).json({
      status: false,
      error: error.message
    });
  }
});

module.exports = router;