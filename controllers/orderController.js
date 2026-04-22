const catchAsync = require("../utils/catchAsync");
const APIFeatures  = require("../utils/APIFeatures");
const Order = require("../db/Order");
const Files = require("../db/Files");
const JSONerror = require("../utils/jsonErrorHandler");
const Commudity = require("../db/Commudity");
const Equipment = require("../db/Equipment");
const Charges = require("../db/Charges");
const PaymentLogs = require("../db/PaymentLogs");
const Trip = require("../db/Trip");
const { checkOrderLimit } = require("../middlewares/planLimitsMiddleware");

function getTenantId(req) {
   return req.tenantId || req.user?.tenantId || null;
}

function normalizeCompanyId(req) {
   const raw = req.user?.company?._id || req.user?.company;
   return raw ? String(raw) : null;
}

async function CreatePaymentLog(user, order, status, method, type, approval, tenantId, company) {
   if (!tenantId) {
      throw new Error('CreatePaymentLog: tenantId is required to create a payment log.');
   }
   const payment = await PaymentLogs.create({
      tenantId,
      company: company || null,
      order: order,
      method: method,
      status: status,
      type: type,
      approval: "approved",
      updated_by: user,
   });
   return payment;
}

async function generateUniqueSerialNumber(tenantId) {
   const mongoose = require('mongoose');
   
   try {
      const counterSchema = new mongoose.Schema({
         _id: { type: String, required: true },
         sequence_value: { type: Number, default: 1000 }
      });
      
      let Counter;
      try {
         Counter = mongoose.model('counters');
      } catch (error) {
         Counter = mongoose.model('counters', counterSchema);
      }
      
      const counterKey = `serial_no:${tenantId || 'legacy_tenant_001'}`;
      let existingCounter = await Counter.findOne({ _id: counterKey });
      
      if (!existingCounter) {
         const maxOrder = await Order.findOne({ tenantId: tenantId || 'legacy_tenant_001' }, { serial_no: 1 }).sort({ serial_no: -1 }).lean();
         const maxSerialNo = maxOrder ? maxOrder.serial_no : 1000;
         
         existingCounter = await Counter.create({
            _id: counterKey,
            sequence_value: maxSerialNo
         });
      }
      
      let attempts = 0;
      const maxAttempts = 3;
      
      while (attempts < maxAttempts) {
         try {
            const counter = await Counter.findOneAndUpdate(
               { _id: counterKey },
               { $inc: { sequence_value: 1 } },
               { new: true }
            );
            
            if (!counter || !counter.sequence_value) {
               throw new Error('Failed to generate serial number: Invalid counter response');
            }
            
            return counter.sequence_value;
         } catch (error) {
            attempts++;
            if (attempts >= maxAttempts) {
               throw new Error(`Failed to generate unique serial number after ${maxAttempts} attempts: ${error.message}`);
            }
            
            await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempts) * 100));
         }
      }
   } catch (error) {
      throw new Error(`Serial number generation failed: ${error.message}`);
   }
}

exports.create_order = catchAsync(async (req, res, next) => {
   try {
      const tenantId = getTenantId(req);
      if (!tenantId) {
         return res.status(400).json({ status: false, message: "Tenant context is required." });
      }

      const { company_name,
         customer_order_no,
         shipping_details,

         // Customer
         customer,
         customer_payment_date,
         customer_payment_method,
         total_amount,

         // Carrier
         carrier,
         carrier_amount,
         carrier_payment_date,
         carrier_payment_method,

         order_type,
         drivers,
         driver,
         truck,
         trailer,
         
         // Revennue
         revenue_items,
         carrier_revenue_items,
         revenue_currency,

         totalDistance,

         order_status,
       } = req.body;
 
      const newOrderId = await generateUniqueSerialNumber(tenantId);
      const order = await Order.create({
         company_name,
         serial_no : parseInt(newOrderId),
         customer_order_no: customer_order_no ? String(customer_order_no).trim() : null,
         shipping_details,

         customer : customer,
         customer_payment_date,
         customer_payment_method,
         total_amount,

         carrier,
         carrier_amount, 
         carrier_payment_date,
         carrier_payment_method,

         order_type,
         drivers: drivers || [],
         driver,
         truck,
         trailer,

         revenue_items,
         carrier_revenue_items,
         revenue_currency,
         totalDistance,
         order_status,
         tenantId: req.tenantId,
         company:req.user && req.user.company ? req.user.company._id : null,

         created_by : req.user._id,
      });
   
      if(!order){
         res.json({
            status:false,
            message: "Failed to create order."
         });
      }
      
      // Create a default trip covering the entire route
      try {
         const locations = Array.isArray(order.shipping_details) && order.shipping_details[0]
            ? (order.shipping_details[0].locations || [])
            : [];
         if (locations.length > 0) {
            const startLoc = locations[0];
            const endLoc = locations[locations.length - 1];
            const defaultTrip = new Trip({
               tenantId: req.tenantId || req.user?.tenantId,
               order: order._id,
               trip_no: 1,
               start_stop_index: 0,
               end_stop_index: locations.length - 1,
               driver: order.order_type === 'regular' ? order.driver : null,
               drivers: order.order_type === 'regular' ? (order.drivers || []) : [],
               truck: order.order_type === 'regular' ? order.truck : null,
               trailer: order.order_type === 'regular' ? order.trailer : null,
               carrier: order.order_type === 'outsourcing' ? order.carrier : null,
               start_location: `${startLoc.location || startLoc.address || ''}${startLoc.city ? `, ${startLoc.city}` : ''}`,
               end_location: `${endLoc.location || endLoc.address || ''}${endLoc.city ? `, ${endLoc.city}` : ''}`,
               miles: Number(order.totalDistance) || 0,
               totalDistance: Number(order.totalDistance) || 0,
               distance_unit: 'mi',
               rate_per_mile: 0,
               created_by: req.user._id
            });
            await defaultTrip.save();
         }
      } catch (tripErr) {
         console.error('Default trip creation failed:', tripErr);
      }
      res.json({
         status:true,
         order,
         message: "Order has been created."
      });
   } catch (err) {
      JSONerror(res, err, next);
   }
});

exports.update_order = catchAsync(async (req, res, next) => {
   try {
      const tenantId = getTenantId(req);
      if (!tenantId) {
         return res.status(400).json({ status: false, message: "Tenant context is required." });
      }
      const companyId = normalizeCompanyId(req);
      const updateData = req.body;
      const criteria = { _id: req.params.id, tenantId };
      if (companyId) criteria.company = companyId;
      const order = await Order.findOneAndUpdate(criteria, updateData, {
         new: true, 
         runValidators: true,
      });
      if(!order) {
         return res.status(404).json({
            status: false,
            message: "Order not found."
         });
      }
      res.status(200).json({
         status: true,
         order,
         message: "Order updated successfully."
      });
   } catch (error) {
      res.status(400).json({
         status: false,
         message: "Failed to update order.",
         error: error.message
      });
   }
});

exports.order_listing = catchAsync(async (req, res, next) => {
   const { search, customer_id, carrier_id, driver_id, truck_id, trailer_id, created_by_id, sortby, status, paymentStatus } = req.query;
   
   const queryObj = {
      $or: [
         { deletedAt: null },
         { deletedAt: '' },
         { deletedAt: { $exists: false } }
      ]
   };

   const tenantId = getTenantId(req);
   if (!tenantId) {
      return res.status(400).json({ status: false, message: "Tenant context is required.", orders: [], page: 1, totalPages: 0 });
   }
   queryObj.tenantId = tenantId;
   const companyId = normalizeCompanyId(req);
   if (companyId) {
      queryObj.$and = queryObj.$and || [];
      queryObj.$and.push({
         $or: [
            { company: companyId },
            { company: null },
            { company: { $exists: false } }
         ]
      });
   }

   if(paymentStatus){
      queryObj.carrier_payment_status = paymentStatus;
      queryObj.customer_payment_status = paymentStatus;
   }
   
   // Sanitize and validate customer_id
   if(customer_id){
      const sanitizedCustomerId = customer_id.trim();
      if (sanitizedCustomerId) {
         const mongoose = require('mongoose');
         if (mongoose.Types.ObjectId.isValid(sanitizedCustomerId)) {
            queryObj.customer = sanitizedCustomerId;
         } else {
            // Invalid ObjectId, return empty results
            return res.json({
               status: true,
               orders: [],
               page: 1,
               totalPages: 0,
               message: "No orders found"
            });
         }
      }
   }

   // Sanitize and validate carrier_id
   if(carrier_id){
      const sanitizedCarrierId = carrier_id.trim();
      if (sanitizedCarrierId) {
         const mongoose = require('mongoose');
         if (mongoose.Types.ObjectId.isValid(sanitizedCarrierId)) {
            queryObj.carrier = sanitizedCarrierId;
         } else {
            // Invalid ObjectId, return empty results
            return res.json({
               status: true,
               orders: [],
               page: 1,
               totalPages: 0,
               message: "No orders found"
            });
         }
      }
   }

   const mongoose = require('mongoose');
   const setObjectIdFilter = (key, value) => {
      const v = String(value || '').trim();
      if (!v) return;
      if (!mongoose.Types.ObjectId.isValid(v)) {
         throw new Error('invalid_object_id');
      }
      queryObj[key] = v;
   };

   // Assigned fleet filters (Regular orders)
   try {
      if (driver_id) setObjectIdFilter('driver', driver_id);
      if (truck_id) setObjectIdFilter('truck', truck_id);
      if (trailer_id) setObjectIdFilter('trailer', trailer_id);
      if (driver_id || truck_id || trailer_id) queryObj.order_type = 'regular';
   } catch (e) {
      return res.json({ status: true, orders: [], page: 1, totalPages: 0, message: "No orders found" });
   }

   // Admin filter: orders created by a specific employee (used in employee detail)
   if (created_by_id && (req.user?.is_admin === 1 || req.user?.permissions?.includes('accounting'))) {
      try {
         setObjectIdFilter('created_by', created_by_id);
      } catch (e) {
         return res.json({ status: true, orders: [], page: 1, totalPages: 0, message: "No orders found" });
      }
   }
   
   if(status == 'added' || status == 'intransit' || status == 'completed'){
      queryObj.order_status = status;
   }

   // Apply created_by filter only for staff users (role === 1) - use strict numeric check
   if (req.user && Number(req.user.role) === 1) {
      queryObj.created_by = req.user._id;
      // Debug logging in non-production
      if (process.env.NODE_ENV !== 'production') {
         console.log('Staff user filter applied:', { userId: req.user._id, permissions: req.user.permissions, query: queryObj });
      }
   }

   if (search && search.length > 1) {
      const searchValue = search.trim();
      if (!isNaN(searchValue)) {
         // Numeric: match by serial number
         queryObj.serial_no = parseInt(searchValue);
      } else {
         // Non-numeric: search customer order number or company name
         queryObj.$or = [
            { customer_order_no: { $regex: searchValue, $options: 'i' } },
            { company_name: { $regex: searchValue, $options: 'i' } },
         ];
      }
   }

      // Set default sort to serial_no descending if not provided
      if (!req.query.sort) {
         req.query.sort = '-serial_no';
      }
      
      let Query = new APIFeatures(
         Order.find(queryObj)
            .populate(['created_by', 'customer', 'carrier', 'carrier_payment_updated_by', 'customer_payment_updated_by', 'driver', 'truck', 'trailer'])
            .populate('documents_count'),
         req.query
      ).sort();

   const { query, page, limit, totalPages } = await Query.paginate();
  let data = await query;
  // Attach trips_count for each order
  try {
     const ids = (data || []).map(o => o._id);
     if (ids.length > 0) {
        const grouped = await Trip.aggregate([
           { $match: { order: { $in: ids } } },
           { $group: { _id: "$order", c: { $sum: 1 } } }
        ]);
        const map = {};
        grouped.forEach(g => { map[String(g._id)] = g.c; });
        data = data.map(o => {
           const obj = o.toObject ? o.toObject() : o;
           obj.trips_count = map[String(o._id)] || 0;
           return obj;
        });
     }
  } catch (e) {
     // fail silently, do not break listing
  }

   res.json({
      status: true,
      orders: data,
      page : page,
      totalPages : totalPages,
      message: data.length ? undefined : "No files found"
   });
});

exports.order_listing_account = catchAsync(async (req, res) => {
   try {
      const { search } = req.query;
      const tenantId = getTenantId(req);
      const companyId = normalizeCompanyId(req);
      const queryObj = {
         $or: [{ deletedAt: null }]
      };
      if (tenantId) queryObj.tenantId = tenantId;
      if (companyId) {
         queryObj.$and = queryObj.$and || [];
         queryObj.$and.push({
            $or: [
               { company: companyId },
               { company: null },
               { company: { $exists: false } }
            ]
         });
      }
      if (search && search.length >1) {
         const safeSearch = search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // escape regex
         queryObj.customer_order_no = { $regex: new RegExp(safeSearch, 'i') };
      } 
      
   // Set default sort to serial_no descending if not provided
   if (!req.query.sort) {
      req.query.sort = '-serial_no';
   }
   
   let Query = new APIFeatures(
      Order.find(queryObj)
         .populate(['created_by', 'customer', 'carrier', 'carrier_payment_updated_by', 'customer_payment_updated_by', 'driver', 'truck', 'trailer'])
         .populate('documents_count'),
      req.query
   ).sort();

      const { query, totalDocuments, page, limit, totalPages } = await Query.paginate();
  let data = await query;
  // Attach trips_count for each order
  try {
     const ids = (data || []).map(o => o._id);
     if (ids.length > 0) {
        const grouped = await Trip.aggregate([
           { $match: { order: { $in: ids } } },
           { $group: { _id: "$order", c: { $sum: 1 } } }
        ]);
        const map = {};
        grouped.forEach(g => { map[String(g._id)] = g.c; });
        data = data.map(o => {
           const obj = o.toObject ? o.toObject() : o;
           obj.trips_count = map[String(o._id)] || 0;
           return obj;
        });
     }
  } catch (e) {}

      res.json({
         status: true,
         orders: data,
         totalDocuments,
         page,
         limit,
         totalPages,
         message: data.length ? undefined : "No orders found",
      });
   } catch (error) {
      res.status(500).json({
         status: false,
         message: "Something went wrong",
         error: error.message,
      });
   }
});

exports.updateOrderPaymentStatus = catchAsync(async (req, res) => {
   try { 
      const { status, method, notes, approve } = req.body;
      const tenantId = getTenantId(req);
      if (!tenantId) {
         return res.status(400).json({ status: false, message: "Tenant context is required." });
      }
      const companyId = normalizeCompanyId(req);
      let order;
      const criteria = { _id: req.params.id, tenantId };
      if (companyId) criteria.company = companyId;
      if(req.params.type === 'customer'){ 
            const update = {
               customer_payment_status : status,
               customer_payment_date  : Date.now(),
               customer_payment_method : method,
               customer_payment_notes : notes,
               customer_payment_updated_by : req?.user?._id,
            };
            if (approve && req?.user?.is_admin == 1) {
               update.customer_payment_approved_by_admin = 1;
            }
            order = await Order.findOneAndUpdate(criteria, update, {
              new: true, 
              runValidators: true,
            });
         await CreatePaymentLog(req.user?._id, req.params.id, status, method, 'customer', req?.user?.is_admin == 1 ? 'admin' : null, tenantId, companyId);
      } else { 
         const update = {
            carrier_payment_status :status,
            carrier_payment_date : Date.now(),
            carrier_payment_method : method,
            carrier_payment_notes : notes,
            carrier_payment_updated_by : req?.user?._id,
         };
         if (approve && req?.user?.is_admin == 1) {
            update.carrier_payment_approved_by_admin = 1;
         }
         order = await Order.findOneAndUpdate(criteria, update, {
           new: true, 
           runValidators: true,
         });
         await CreatePaymentLog(req.user?._id, req.params.id, status, method, "carrier", req?.user?.is_admin == 1 ? 'admin' : null, tenantId, companyId);
      }
      if(!order){
        return res.send({
          status: false,
          message: "failed to update order information.",
        });
      }
      res.send({
         status: true,
         order: order,
         message: "Payment status has been updated.",
      });
   } catch (error) {
      res.send({
        status: false,
        message: "Failed to update order information.",
      });
    }
});

exports.updateOrderStatus = catchAsync(async (req, res) => {
   try { 
      const { status } = req.body;
      const tenantId = getTenantId(req);
      if (!tenantId) {
         return res.status(400).json({ status: false, message: "Tenant context is required." });
      }
      const companyId = normalizeCompanyId(req);
      const criteria = { _id: req.params.id, tenantId };
      if (companyId) criteria.company = companyId;
      const order  = await Order.findOneAndUpdate(criteria, {
         order_status : status,
         updatedAt : Date.now(),
      }, {
         new: true, 
         runValidators: true,
      });
      if(!order){
        return res.send({
          status: false,
          message: "failed to update order information.",
        });
      }
      res.send({
        status: true,
        order: order,
        message: "Order status has been updated.",
      });
    } catch (error) {
      res.send({
        status: false,
        message: "Failed to update order information.",
      });
    }
});

exports.addnote = catchAsync(async (req, res) => {
   try { 
      const { notes } = req.body;
      const tenantId = getTenantId(req);
      if (!tenantId) {
         return res.status(400).json({ status: false, message: "Tenant context is required." });
      }
      const companyId = normalizeCompanyId(req);
      const criteria = { _id: req.params.id, tenantId };
      if (companyId) criteria.company = companyId;
      const order  = await Order.findOneAndUpdate(criteria, {
         notes : notes,
         updatedAt : Date.now(),
      }, {
         new: true,
         runValidators: true,
      });
      if(!order){
        return res.send({
          status: false,
          message: "failed to add note on this order.",
        });
      }
      res.send({
        status: true,
        order: order,
        message: "Note has been added.",
      });
    } catch (error) {
      res.send({
        status: false,
        error :error,
        message: "Failed to update order information.",
      });
    }
});

exports.overview = catchAsync(async (req, res) => {
   let customercompletedPayments, customerpendingPayments, totalLoads, intransitLoads, completedLoads, pendingLoads, carriercompletedPayments, carrierpendingPayments;
   
   // Base filter to exclude deleted orders
   const baseDeletedFilter = {
      $or: [
         { deletedAt: null },
         { deletedAt: '' },
         { deletedAt: { $exists: false } }
      ]
   };
   
   let queryFilter;
   
   // Check if this is a super admin emulating a tenant
   const isEmulating = req.isEmulating || req.isSuperAdminUser;
   
   // A user is regular (staff) if they are NOT an admin (role 3) and NOT is_admin=1
   const isRegularUser = req.user.role !== 3 && req.user.is_admin !== 1 && !isEmulating;
   
   if(isRegularUser){
      // For regular users (non-admin, non-emulating), include created_by filter
      // Or if they are a driver (role 0), filter by driver assignment
      if (req.user.role === 0) {
         queryFilter = {
            driver: req.user._id,
            ...baseDeletedFilter
         };
      } else {
         queryFilter = {
            created_by: req.user._id,
            ...baseDeletedFilter
         };
      }
   } else {
      // For admin users or super admins emulating, only apply deleted filter
      queryFilter = baseDeletedFilter;
   }

   // Scope dashboard counts by tenant when available
   if (req.tenantId) {
      queryFilter.tenantId = req.tenantId;
   } else if (process.env.NODE_ENV !== 'production') {
      console.warn('⚠️ Overview: No tenantId provided - this might show all data!');
   }

   const companyId = normalizeCompanyId(req);
   if (companyId) {
      queryFilter.$and = queryFilter.$and || [];
      queryFilter.$and.push({
         $or: [
            { company: companyId },
            { company: null },
            { company: { $exists: false } }
         ]
      });
   }
   
   
   // Count documents with proper filter
   totalLoads = await Order.countDocuments(queryFilter);
   intransitLoads = await Order.countDocuments({ order_status: 'intransit', ...queryFilter });
   completedLoads = await Order.countDocuments({ order_status: 'completed', ...queryFilter });
   pendingLoads = await Order.countDocuments({ order_status: 'added', ...queryFilter });

   // carrier payments
   carrierpendingPayments = await Order.countDocuments({ carrier_payment_status: { $ne: 'paid' }, ...queryFilter });
   carriercompletedPayments = await Order.countDocuments({ carrier_payment_status: 'paid', ...queryFilter });
   
   // customer payments
   customercompletedPayments = await Order.countDocuments({ customer_payment_status: 'paid', ...queryFilter });
   customerpendingPayments = await Order.countDocuments({ customer_payment_status: { $ne: 'paid' }, ...queryFilter });

   // Generate chart data for the last 6 months (Revenue & Loads)
   const chartData = [];
   const today = new Date();
   for (let i = 5; i >= 0; i--) {
      const startOfMonth = new Date(today.getFullYear(), today.getMonth() - i, 1);
      const endOfMonth = new Date(today.getFullYear(), today.getMonth() - i + 1, 0, 23, 59, 59);
      const monthFilter = { ...queryFilter, createdAt: { $gte: startOfMonth, $lte: endOfMonth } };
      
      const monthlyOrders = await Order.find(monthFilter)
         .select('total_amount carrier_amount order_type created_by')
         .populate({ path: 'created_by', select: 'staff_commision' });
      
      let monthlyRevenue = 0;
      let monthlyProfit = 0;
      monthlyOrders.forEach(o => {
         monthlyRevenue += Number(o.total_amount) || 0;
         monthlyProfit += Number(o.profit) || 0;
      });

      const monthName = startOfMonth.toLocaleString('default', { month: 'short' });
      chartData.push({
         name: monthName,
         loads: monthlyOrders.length,
         revenue: monthlyRevenue,
         profit: monthlyProfit
      });
   }

   res.json({
      status: true,
      message: 'Dashboard data retrieved successfully.',
      chartData: chartData,
      lists: [
         { icon:"van",bg:'bg-green-700', title : 'Total Loads', data: totalLoads, link: '/orders' },
         { icon:"van",bg:'bg-green-700', title : 'Intransit Loads', data: intransitLoads, link:"/orders?status=intransit" },
         { icon:"van",bg:'bg-green-700', title : 'Completed Loads', data: completedLoads, link:"/orders?status=completed" },
         { icon:"van",bg:'bg-green-700', title : 'Pending Loads', data: pendingLoads, link:"/orders?status=added" },

         { icon:"card",bg:'bg-green-700', title : 'Carrier Pending Payments', data: carrierpendingPayments, link:"/payments?title=Carrier Pending Payments&type=carrier&status=pending" },
         { icon:"card",bg:'bg-green-700', title : 'Carrier Done Payments', data: carriercompletedPayments, link:"/payments?title=Carrier Completed Payments&type=carrier&status=paid" },

         { icon:"card",bg:'bg-green-700', title : 'Customer Pending Payments', data: customerpendingPayments, link:"/payments?title=Customer Pending Payments&type=customer&status=pending" },
         { icon:"card",bg:'bg-green-700', title : 'Customer Done Payments', data: customercompletedPayments, link:"/payments?title=Customer Completed Payments&type=customer&status=paid" },
      ] 
   });
});

exports.order_detail = catchAsync(async (req, res) => {
   const id = req.params.id;
   const criteria = {
      _id: id,
      $or: [
         { deletedAt: null },
         { deletedAt: '' },
         { deletedAt: { $exists: false } }
      ]
   };
   if (req.tenantId) {
      criteria.tenantId = req.tenantId;
   }
   const order = await Order.findOne(criteria)
      .populate(['created_by', 'customer', 'carrier'])
      .populate('documents_count');
   
    if(!order){ 
      res.json({
         status: false,
         orders: null, 
         message: "Order not found."
       });
    }
   res.json({
      status: true,
      order: order
   });
});

exports.order_docs = catchAsync(async (req, res) => {
   const id = req.params.id;
   const tenantId = getTenantId(req);
   if (!tenantId) {
      return res.status(400).json({ status: false, message: "Tenant context is required.", files: [], paymentLogs: [] });
   }
   const companyId = normalizeCompanyId(req);
   const orderCriteria = { _id: id, tenantId };
   if (companyId) orderCriteria.company = companyId;
   const order = await Order.findOne(orderCriteria).select('_id').lean();
   if (!order) {
      return res.status(404).json({ status: false, message: "Order not found.", files: [], paymentLogs: [] });
   }
   const notDeleted = { $or: [{ deletedAt: null }, { deletedAt: '' }, { deletedAt: { $exists: false } }] };
   const files = await Files.find({
      tenantId,
      order: id,
      ...notDeleted
   }).populate('added_by');
    let paymentLogs = await PaymentLogs.find({ tenantId, order: id }).populate('updated_by');
    paymentLogs = paymentLogs ? paymentLogs.reverse() : [];
    if(!files){ 
      res.json({
         status: false,
         files: null,
         paymentLogs: paymentLogs ?? [],
         message: "files not found."
       });
    }
   res.json({
      status: true,
      paymentLogs: paymentLogs ?? [],
      files: files,
   });
});

exports.lockOrder = catchAsync(async (req, res) => {

   if(req.user && req.user.is_admin !== 1){
      return res.json({
         status : false,
         message : "You are not authorized to lock order."
      });
   }
   const id = req.params.id;
   const tenantId = getTenantId(req);
   if (!tenantId) {
      return res.status(400).json({ status: false, message: "Tenant context is required." });
   }
   const companyId = normalizeCompanyId(req);
   const criteria = { _id: id, tenantId };
   if (companyId) criteria.company = companyId;
   const order = await Order.findOne(criteria);
   if(!order){
      return res.json({
         status: false,
         message: "Order not found."
       });
   }
   if(order.lock){
      order.lock = null;
   } else {
      order.lock = true
   }
   await order.save();
   res.json({
      status: true,
      'Message': "Order locked status updated.",
   });
});


exports.deleteOrder = catchAsync(async (req, res) => {
   if(req.user && req.user.is_admin !== 1){
      return res.json({
         status : false,
         message : "You are not authorized to delete this order."
      });
   }

   const id = req.params.id;
   const tenantId = getTenantId(req);
   if (!tenantId) {
      return res.status(400).json({ status: false, message: "Tenant context is required." });
   }
   const companyId = normalizeCompanyId(req);
   const criteria = { _id: id, tenantId };
   if (companyId) criteria.company = companyId;
   const order = await Order.findOne(criteria);
   if(!order){ 
      res.json({
         status: false,
         message: "Order not found."
       });
   }
   order.deletedAt = Date.now();
   await order.save();
   res.json({
      status: true,
      message: "Order deleted successfully."
   });
});

exports.addCummodity = catchAsync(async (req, res, next) => {
   const { value } = req.body;
   const tenantId = req.tenantId || (req.dbFilter && req.dbFilter.tenantId);
   
   if (!tenantId) {
      return res.status(400).json({
         status: false,
         message: "Tenant ID is required."
      });
   }
   
   if (!value || !value.trim()) {
      return res.status(400).json({
         status: false,
         message: "Commodity name is required."
      });
   }
   
   // Check if commodity already exists for this tenant
   const existing = await Commudity.findOne({ tenantId, name: value.trim() });
   if (existing) {
      return res.status(409).json({
         status: false,
         message: "Commodity already exists for this tenant."
      });
   }
   
   Commudity.create({
      name: value.trim(),
      tenantId,
      company: req.user && req.user.company ? req.user.company._id : null,
   }).then(result => {
      res.send({
         status: true,
         message: "Commudity has been added.",
         data: result
      });
   }).catch(err => {
      JSONerror(res, err, next);
      logger(err);
   });
});

exports.removeCummodity = catchAsync(async (req, res, next) => {
   const { id } = req.body;
   const tenantId = req.tenantId || (req.dbFilter && req.dbFilter.tenantId);
   
   if (!tenantId) {
      return res.status(400).json({
         status: false,
         message: "Tenant ID is required."
      });
   }
   
   Commudity.deleteOne({ _id: id, tenantId })
     .then((result) => {
       if (result.deletedCount === 0) {
         return res.status(404).json({
           status: false,
           message: "Commodity not found for this tenant."
         });
       }
       res.send({
         status: true,
         message: "Commudity has been permanently removed.",
       });
     })
     .catch(err => {
       JSONerror(res, err, next);
       logger(err);
     });
});

exports.cummodityLists = catchAsync(async (req, res, next) => {
   const filter = req.dbFilter || { tenantId: req.tenantId };
   
   if (!filter || !filter.tenantId) {
      return res.status(400).json({
         status: false,
         message: "Tenant ID is required."
      });
   }
   
   const list = await Commudity.find(filter).sort({ name: 1 });
   const arr = [];
   list.map((item) => {
      arr.push({
         value: item.name,
         label: item.name,
         _id: item._id,
      });
   })
   res.send({
      status: true,
      list: arr,
   });
});

exports.addEquipment = catchAsync(async (req, res, next) => {
   const { value } = req.body;
   const tenantId = (req.user && req.user.tenantId) || req.tenantId || (req.dbFilter && req.dbFilter.tenantId);
   
   if (!tenantId) {
      return res.status(400).json({
         status: false,
         message: "Tenant ID is required."
      });
   }
   
   if (!value || !value.trim()) {
      return res.status(400).json({
         status: false,
         message: "Equipment name is required."
      });
   }
   
   // Check if equipment already exists for this tenant
   const existing = await Equipment.findOne({ tenantId, name: value.trim() });
   if (existing) {
      return res.status(409).json({
         status: false,
         message: "Equipment already exists for this tenant."
      });
   }
   
   Equipment.create({
      name: value.trim(),
      tenantId,
      company: req.user && req.user.company ? req.user.company._id : null,
   }).then(result => {
      res.send({
         status: true,
         message: "Equipment has been added.",
         data: result
      });
   }).catch(err => {
      JSONerror(res, err, next);
      logger(err);
   });
});

exports.removeEquipment = catchAsync(async (req, res, next) => {
   const { id } = req.body;
   const tenantId = (req.user && req.user.tenantId) || req.tenantId || (req.dbFilter && req.dbFilter.tenantId);
   
   if (!tenantId) {
      return res.status(400).json({
         status: false,
         message: "Tenant ID is required."
      });
   }
   
   Equipment.deleteOne({ _id: id, tenantId })
     .then((result) => {
       if (result.deletedCount === 0) {
         return res.status(404).json({
           status: false,
           message: "Equipment not found for this tenant."
         });
       }
       res.send({
         status: true,
         message: "Equipment has been permanently removed.",
       });
     })
     .catch(err => {
       JSONerror(res, err, next);
       logger(err);
     });
});

exports.equipmentLists = catchAsync(async (req, res, next) => {
   const filter = req.dbFilter || { tenantId: (req.user && req.user.tenantId) || req.tenantId };
   
   if (!filter || !filter.tenantId) {
      return res.status(400).json({
         status: false,
         message: "Tenant ID is required."
      });
   }
   
   const list = await Equipment.find(filter).sort({ name: 1 });
   const arr = [];
   list.map((item) => {
      arr.push({
         value: item.name,
         label: item.name,
         _id: item._id,
      });
   })
   res.send({
      status: true,
      list: arr,
   });
});

exports.addCharges = catchAsync(async (req, res, next) => {
   const { value } = req.body;
   const tenantId = (req.user && req.user.tenantId) || req.tenantId || (req.dbFilter && req.dbFilter.tenantId);
   
   if (!tenantId) {
      return res.status(400).json({
         status: false,
         message: "Tenant ID is required."
      });
   }
   if (!value || !value.trim()) {
      return res.status(400).json({
         status: false,
         message: "Charge item name is required."
      });
   }
   
   try {
      const existing = await Charges.findOne({ tenantId, name: value.trim() });
      if (existing) {
         return res.status(409).json({
            status: false,
            message: "Charge item already exists for this tenant."
         });
      }
      await Charges.create({
         tenantId,
         name: value.trim(),
         company: req.user && req.user.company ? req.user.company._id : null,
      });
      res.send({
         status: true,
         message: "Charge item has been added.",
      });
   } catch (err) {
      JSONerror(res, err, next);
      logger(err);
   }
});

exports.removeCharge = catchAsync(async (req, res, next) => {
   const { id } = req.body;
   const tenantId = (req.user && req.user.tenantId) || req.tenantId || (req.dbFilter && req.dbFilter.tenantId);
   
   if (!tenantId) {
      return res.status(400).json({
         status: false,
         message: "Tenant ID is required."
      });
   }
   
   Charges.deleteOne({ _id: id, tenantId })
     .then((result) => {
       if (result.deletedCount === 0) {
         return res.status(404).json({
           status: false,
           message: "Charge not found for this tenant."
         });
       }
       res.send({
         status: true,
         message: "Charge has been permanently removed.",
       });
     })
     .catch(err => {
       JSONerror(res, err, next);
       logger(err);
     });
});

exports.chargesLists = catchAsync(async (req, res, next) => {
   const filter = req.dbFilter || { tenantId: (req.user && req.user.tenantId) || req.tenantId };
   
   if (!filter || !filter.tenantId) {
      return res.status(400).json({
         status: false,
         message: "Tenant ID is required."
      });
   }
   const list = await Charges.find(filter).sort({ name: 1 });
   const arr = [];
   list.map((item) => {
      arr.push({
         value: item.name,
         label: item.name,
         _id: item._id,
      });
   })
   res.send({
      status: true,
      list: arr ,
   });
});

exports.orderPayments = catchAsync(async (req, res, next) => {
   const { search, customer_id, carrier_id, sortby } = req.query;
   const queryObj = {
      $or: [{ deletedAt: null }]
   };

   // Scope by tenant when available (including emulation)
   if (req.tenantId) {
      queryObj.tenantId = req.tenantId;
   }

   // Sanitize and validate customer_id
   if(customer_id){
      const sanitizedCustomerId = customer_id.trim();
      if (sanitizedCustomerId) {
         const mongoose = require('mongoose');
         if (mongoose.Types.ObjectId.isValid(sanitizedCustomerId)) {
            queryObj.customer = sanitizedCustomerId;
         } else {
            // Invalid ObjectId, return empty results
            return res.json({
               status: true,
               orders: [],
               page: 1,
               totalPages: 0,
               message: "No orders found"
            });
         }
      }
   }

   // Sanitize and validate carrier_id
   if(carrier_id){
      const sanitizedCarrierId = carrier_id.trim();
      if (sanitizedCarrierId) {
         const mongoose = require('mongoose');
         if (mongoose.Types.ObjectId.isValid(sanitizedCarrierId)) {
            queryObj.carrier = sanitizedCarrierId;
         } else {
            // Invalid ObjectId, return empty results
            return res.json({
               status: true,
               orders: [],
               page: 1,
               totalPages: 0,
               message: "No orders found"
            });
         }
      }
   }

   // Apply created_by filter only for staff users (role === 1) - use strict numeric check
   if (req.user && Number(req.user.role) === 1) {
      queryObj.created_by = req.user._id;
      // Debug logging in non-production
      if (process.env.NODE_ENV !== 'production') {
         console.log('Staff user payments filter applied:', { userId: req.user._id, permissions: req.user.permissions, query: queryObj });
      }
   }

   // Sanitize search parameter
   if (search && search.length > 1) {
      const searchValue = search.trim();
      // Check if search is a number for serial_no search
      if (!isNaN(searchValue)) {
         queryObj.serial_no = parseInt(searchValue);
      } else {
         // For non-numeric searches, you might want to search in other fields
         // Currently keeping empty to only search serial numbers
         queryObj.serial_no = -1; // This will not match any valid serial_no
      }
   }

   // Set default sort to serial_no descending if not provided
   if (!req.query.sort) {
      req.query.sort = '-serial_no';
   }
   
   let Query = new APIFeatures(
      Order.find(queryObj)
         .populate(['created_by', 'customer', 'carrier'])
         .populate('documents_count'),
      req.query
   ).sort();

   const { query, page, limit, totalPages } = await Query.paginate();
   let data = await query;

   res.json({
      status: true,
      orders: data,
      page : page,
      totalPages : totalPages,
      message: data.length ? undefined : "No files found"
   });
});

exports.all_payments_status = catchAsync(async (req, res, next) => {
   const { search, type, status } = req.query;
   const queryObj = {
      $or: [{ deletedAt: null }]
   };
   if (req.tenantId) {
      queryObj.tenantId = req.tenantId;
   }
   if(type == 'carrier'){
      if(status == 'pending'){
         queryObj.carrier_payment_status = { $ne: 'paid' };
      } else{
         queryObj.carrier_payment_status = status;
      }
   }
   if(type == 'customer'){
      if(status == 'pending'){
         queryObj.customer_payment_status = { $ne: 'paid' };
      } else{
         queryObj.customer_payment_status = status;
      }
   }
    
   // Set default sort to serial_no descending if not provided
   if (!req.query.sort) {
      req.query.sort = '-serial_no';
   }
   
   let Query = new APIFeatures(
      Order.find(queryObj)
         .populate(['created_by', 'customer', 'carrier'])
         .populate('documents_count'),
      req.query
   ).sort();

   const { query, page, limit, totalPages } = await Query.paginate();
   let data = await query;

   res.json({
      status: true,
      lists: data,
      page : page,
      totalPages : totalPages,
      message: data.length ? undefined : "No files found"
   });
});



 



 
