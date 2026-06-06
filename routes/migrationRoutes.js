const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();
const { authenticateJWT, requireSuperAdmin } = require('../middleware/auth');

// All migration routes require super-admin authentication
router.use(authenticateJWT, requireSuperAdmin);

// Route to migrate serial_no fields from string to number
router.post('/migrate-serial-numbers', async (req, res) => {
  try {
    console.log('🔄 Starting serial number migration...');
    
    // Find all orders with string serial_no
    const ordersWithStringSerial = await mongoose.connection.db.collection('orders')
      .find({ serial_no: { $type: 'string' } })
      .toArray();
    
    console.log(`Found ${ordersWithStringSerial.length} orders with string serial_no`);
    
    if (ordersWithStringSerial.length === 0) {
      return res.json({
        success: true,
        message: 'No migration needed - all serial numbers are already numbers',
        migrated: 0
      });
    }
    
    let migratedCount = 0;
    
    // Convert each string serial_no to number
    for (const order of ordersWithStringSerial) {
      const numericSerial = parseInt(order.serial_no, 10);
      
      if (!isNaN(numericSerial)) {
        await mongoose.connection.db.collection('orders').updateOne(
          { _id: order._id },
          { $set: { serial_no: numericSerial } }
        );
        migratedCount++;
        console.log(`✅ Migrated order ${order._id}: "${order.serial_no}" → ${numericSerial}`);
      } else {
        console.log(`❌ Skipped order ${order._id}: invalid serial_no "${order.serial_no}"`);
      }
    }
    
    // Verification - check top orders by serial_no
    const topOrders = await mongoose.connection.db.collection('orders')
      .find({})
      .sort({ serial_no: -1 })
      .limit(5)
      .toArray();
    
    console.log('\n=== Verification ===');
    console.log('Top 5 orders (by serial_no descending):');
    topOrders.forEach(order => {
      console.log(`Serial No: ${order.serial_no} (${typeof order.serial_no})`);
    });
    
    res.json({
      success: true,
      message: `Successfully migrated ${migratedCount} orders`,
      migrated: migratedCount,
      total_found: ordersWithStringSerial.length,
      verification: {
        top_orders: topOrders.map(o => ({
          serial_no: o.serial_no,
          type: typeof o.serial_no
        }))
      }
    });
    
  } catch (error) {
    console.error('❌ Migration failed:', error);
    res.status(500).json({
      success: false,
      message: 'Migration failed',
      error: error.message
    });
  }
});

// Route to check current serial number status
router.get('/serial-numbers-status', async (req, res) => {
  try {
    const totalOrders = await mongoose.connection.db.collection('orders').countDocuments();
    const stringSerialCount = await mongoose.connection.db.collection('orders')
      .countDocuments({ serial_no: { $type: 'string' } });
    const numberSerialCount = await mongoose.connection.db.collection('orders')
      .countDocuments({ serial_no: { $type: 'number' } });
    
    // Get max serial number
    const maxOrder = await mongoose.connection.db.collection('orders')
      .findOne({}, { sort: { serial_no: -1 } });
    
    // Get counter status
    const counter = await mongoose.connection.db.collection('counters')
      .findOne({ _id: 'order_serial' });
    
    res.json({
      success: true,
      status: {
        total_orders: totalOrders,
        string_serial_count: stringSerialCount,
        number_serial_count: numberSerialCount,
        max_serial_no: maxOrder ? maxOrder.serial_no : null,
        max_serial_type: maxOrder ? typeof maxOrder.serial_no : null,
        counter: counter || null,
        migration_needed: stringSerialCount > 0
      }
    });
    
  } catch (error) {
    console.error('❌ Status check failed:', error);
    res.status(500).json({
      success: false,
      message: 'Status check failed',
      error: error.message
    });
  }
});

module.exports = router;