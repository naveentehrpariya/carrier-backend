require('dotenv').config({ path: __dirname + '/../.env' });
const express = require('express');
const mongoose = require('mongoose');
const Order = require('../db/Order');
const router = express.Router();

const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017/carrier";

// Test endpoint - No auth required, returns all orders
router.get('/test-orders', async (req, res) => {
  try {
    await mongoose.connect(MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true });
    
    const tenantId = req.query.tenantId || 'cross-miles-carrier-inc';
    
    const orders = await Order.find({ tenantId })
      .sort({ serial_no: -1 })
      .limit(20)
      .lean();
    
    await mongoose.disconnect();
    
    res.json({
      status: true,
      count: orders.length,
      tenantId: tenantId,
      orders: orders.map(o => ({
        serial_no: o.serial_no,
        order_status: o.order_status,
        order_type: o.order_type,
        total_amount: o.total_amount,
        settle_amount: o.settle_amount,
        isOwnerOperatedTruck: o.isOwnerOperatedTruck,
        driver_assignment_mode: o.driver_assignment_mode
      }))
    });
  } catch (error) {
    res.status(500).json({ status: false, error: error.message });
  }
});

module.exports = router;
