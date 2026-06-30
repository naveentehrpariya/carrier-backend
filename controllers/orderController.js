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
const Truck = require("../db/Truck");
const OwnerOperatorFinancialRecord = require("../db/OwnerOperatorFinancialRecord");
const ConversionRate = require("../db/ConversionRate");
const { checkOrderLimit } = require("../middlewares/planLimitsMiddleware");
const { logActivity } = require("../utils/activityLogger");

const SUPPORTED_CURRENCIES = new Set(['CAD', 'USD', 'INR']);
const BASE_ORDER_CURRENCY = 'USD';
const FX_FALLBACK = {
   CAD_USD: 0.74,
   USD_CAD: 1.35,
   USD_INR: 83,
   INR_USD: 0.012,
   CAD_INR: 61,
   INR_CAD: 0.0164,
};
function toMonthEndDate(refDate = new Date()) {
   const d = new Date(refDate);
   const end = new Date(d.getFullYear(), d.getMonth() + 1, 0);
   const y = end.getFullYear();
   const m = String(end.getMonth() + 1).padStart(2, '0');
   const day = String(end.getDate()).padStart(2, '0');
   return `${y}-${m}-${day}`;
}

async function fetchLiveFxRate(sourceCurrency, targetCurrency, referenceDate = new Date()) {
   const src = normalizeCurrency(sourceCurrency, BASE_ORDER_CURRENCY);
   const dst = normalizeCurrency(targetCurrency, BASE_ORDER_CURRENCY);
   if (src === dst) return 1;
   const date = toMonthEndDate(referenceDate);

   try {
      const res = await fetch(`https://api.frankfurter.app/${date}?from=${src}&to=${dst}`);
      const json = await res.json();
      const rate = Number(json?.rates?.[dst] || 0);
      if (Number.isFinite(rate) && rate > 0) return rate;
   } catch (_) {}

   try {
      const res = await fetch(`https://open.er-api.com/v6/latest/${src}`);
      const json = await res.json();
      const rate = Number(json?.rates?.[dst] || 0);
      if (Number.isFinite(rate) && rate > 0) return rate;
   } catch (_) {}

   return null;
}

function normalizeCurrency(value, fallback = BASE_ORDER_CURRENCY) {
   const code = String(value || fallback).trim().toUpperCase();
   if (!/^[A-Z]{3}$/.test(code)) return String(fallback).toUpperCase();
   if (!SUPPORTED_CURRENCIES.has(code)) return String(fallback).toUpperCase();
   return code;
}

async function resolveMonthlyRate({ tenantId, sourceCurrency, targetCurrency = BASE_ORDER_CURRENCY, referenceDate = new Date() }) {
   const src = normalizeCurrency(sourceCurrency, BASE_ORDER_CURRENCY);
   const dst = normalizeCurrency(targetCurrency, BASE_ORDER_CURRENCY);
   if (src === dst) return 1;
   const month = Number(new Date(referenceDate).getMonth()) + 1;
   const year = Number(new Date(referenceDate).getFullYear());
   const row = await ConversionRate.findOne({
      tenantId,
      month,
      year,
      sourceCurrency: src,
      targetCurrency: dst
   }).lean();
   const rate = Number(row?.rate || 0);
   if (Number.isFinite(rate) && rate > 0) return rate;

   const liveRate = await fetchLiveFxRate(src, dst, referenceDate);
   if (Number.isFinite(Number(liveRate)) && Number(liveRate) > 0) {
      await ConversionRate.findOneAndUpdate(
         {
            tenantId,
            month,
            year,
            sourceCurrency: src,
            targetCurrency: dst
         },
         {
            tenantId,
            month,
            year,
            sourceCurrency: src,
            targetCurrency: dst,
            rate: Number(liveRate)
         },
         { upsert: true, new: true }
      );
      return Number(liveRate);
   }

   return Number(FX_FALLBACK[`${src}_${dst}`] || 1);
}

async function resolveMonthlyRateToBase({ tenantId, sourceCurrency, referenceDate = new Date() }) {
   return resolveMonthlyRate({
      tenantId,
      sourceCurrency,
      targetCurrency: BASE_ORDER_CURRENCY,
      referenceDate
   });
}

function convertToBase(amount, rateToBase) {
   const val = Number(amount || 0);
   const rate = Number(rateToBase || 1);
   const converted = val * (Number.isFinite(rate) && rate > 0 ? rate : 1);
   return Number(converted.toFixed(2));
}

function normalizeRevenueItemsToBase(items = [], rateToBase = 1) {
   if (!Array.isArray(items)) return [];
   return items.map((item) => {
      const next = { ...(item || {}) };
      if (typeof next.rate !== 'undefined' && next.rate !== null && next.rate !== '') {
         const numericRate = Number(next.rate);
         if (Number.isFinite(numericRate)) next.rate = convertToBase(numericRate, rateToBase);
      }
      return next;
   });
}

function getTenantId(req) {
   return req.tenantId || req.user?.tenantId || null;
}

// Admin-level order access: sees/acts on every order in the tenant.
// Never rely on `role` alone — not set on signup users.
function isPrivilegedOrderUser(req) {
   const isEmulating = req.isEmulating || req.isSuperAdminUser;
   return req.user?.role === 3 || req.user?.is_admin === 1 || req.user?.permissions?.includes('subadmin') || isEmulating;
}

// Mutates a Mongoose criteria object so non-admin users only match their own
// records (created orders, or assigned orders for drivers). Returns criteria.
function applyOrderOwnershipScope(req, criteria) {
   if (!req.user || isPrivilegedOrderUser(req)) return criteria;
   if (Number(req.user.role) === 0 || req.user?.permissions?.includes('driver')) {
      criteria.$and = (criteria.$and || []).concat([{ $or: [{ driver: req.user._id }, { drivers: req.user._id }] }]);
   } else {
      criteria.created_by = req.user._id;
   }
   return criteria;
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
         // Start from 1000 base. The very first generated number via $inc will be 1001.
         const maxSerialNo = maxOrder && typeof maxOrder.serial_no === 'number' && maxOrder.serial_no > 1000 ? maxOrder.serial_no : 1000;
         
         existingCounter = await Counter.create({
            _id: counterKey,
            sequence_value: maxSerialNo
         });
      } else {
         // Sync counter if it's lagging behind the actual max serial_no
         const maxOrder = await Order.findOne({ tenantId: tenantId || 'legacy_tenant_001' }, { serial_no: 1 }).sort({ serial_no: -1 }).lean();
         // But only if there is a max order and it's higher. If there are NO orders, do NOT update the counter to 1000 if it's already higher (e.g. 1008 from a previous bug)
         if (maxOrder && typeof maxOrder.serial_no === 'number' && existingCounter.sequence_value < maxOrder.serial_no) {
            existingCounter = await Counter.findOneAndUpdate(
               { _id: counterKey },
               { $set: { sequence_value: maxOrder.serial_no } },
               { new: true }
            );
         } else if (!maxOrder && existingCounter.sequence_value > 1000) {
            // FIX: If there are NO orders but the counter got inflated to something like 1008, reset it down to 1000
            existingCounter = await Counter.findOneAndUpdate(
               { _id: counterKey },
               { $set: { sequence_value: 1000 } },
               { new: true }
            );
         }
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

async function resolveRegularOrderOwnerContext({ tenantId, truckId, totalAmount, settleAmount, driverAssignmentMode, allowMissingTruck = false }) {
   const ctx = {
      isOwnerOperatedTruck: false,
      ownerOperator: null,
      settle_amount: 0,
      owner_profit: 0,
      carrier_amount: 0,
      driver_assignment_mode: 'company_driver',
      driver_assignment_status: 'company_driver_assigned'
   };
   if (!truckId) return ctx;

   const truck = await Truck.findOne({
      _id: truckId,
      tenantId,
      $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }]
   }).populate('ownerOperator', 'status fullName');
   if (!truck) {
      // On edit, a stored truck ref may be stale (truck deleted/cross-tenant). Don't block
      // the whole order update — treat it as no truck so the order can still be saved.
      if (allowMissingTruck) {
         ctx.truckCleared = true;
         return ctx;
      }
      throw new Error('Selected truck not found');
   }

   if (!truck.ownerOperated) return ctx;
   if (!truck.ownerOperator || truck.ownerOperator.status !== 'active') {
      throw new Error('Owner operated truck must be linked with an active owner operator');
   }

   const settle = Number(settleAmount || 0);
   const orderTotal = Number(totalAmount || 0);
   if (settle <= 0) {
      throw new Error('Settle amount is required for owner operated truck');
   }
   if (settle > orderTotal) {
      throw new Error('Settle amount can not be greater than order total');
   }

   const mode = driverAssignmentMode === 'owner_driver' ? 'owner_driver' : 'company_driver';
   return {
      isOwnerOperatedTruck: true,
      ownerOperator: truck.ownerOperator._id,
      settle_amount: settle,
      owner_profit: orderTotal - settle,
      carrier_amount: settle,
      driver_assignment_mode: mode,
      driver_assignment_status: mode === 'owner_driver' ? 'owner_operator_driver' : 'company_driver_assigned'
   };
}

async function syncOwnerOperatorFinancialRecords({ tenantId, companyId, userId, order }) {
   if (!order?.isOwnerOperatedTruck || !order?.ownerOperator) return;
   const base = {
      tenantId,
      company: companyId || null,
      ownerOperator: order.ownerOperator,
      order: order._id,
      month: new Date(order.createdAt || Date.now()).getMonth() + 1,
      year: new Date(order.createdAt || Date.now()).getFullYear(),
      currency: order.revenue_currency || 'cad',
      createdBy: userId || null
   };

   await OwnerOperatorFinancialRecord.deleteMany({
      tenantId,
      order: order._id,
      type: { $in: ['SETTLEMENT', 'OWNER_PROFIT', 'DRIVER_DEDUCTION'] }
   });

   await OwnerOperatorFinancialRecord.insertMany([
      {
         ...base,
         type: 'SETTLEMENT',
         amount: Number(order.settle_amount || 0),
         paymentStatus: 'pending',
         notes: `Settlement for order #${order.serial_no || ''}`.trim()
      },
      {
         ...base,
         type: 'OWNER_PROFIT',
         amount: Number(order.owner_profit || 0),
         paymentStatus: 'pending',
         notes: `Owner profit for order #${order.serial_no || ''}`.trim()
      }
   ]);
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
         settle_amount,
         driver_assignment_mode,
         
         // Revennue
         revenue_items,
         carrier_revenue_items,
         revenue_currency,

         totalDistance,

         order_status,
       } = req.body;

      const inputCurrency = normalizeCurrency(revenue_currency, BASE_ORDER_CURRENCY);
      const fxToBase = await resolveMonthlyRateToBase({
         tenantId,
         sourceCurrency: inputCurrency,
         referenceDate: new Date(),
      });
      const totalAmountBase = convertToBase(total_amount, fxToBase);
      const carrierAmountBase = convertToBase(carrier_amount, fxToBase);
      const settleAmountBase = convertToBase(settle_amount, fxToBase);
      const revenueItemsBase = normalizeRevenueItemsToBase(revenue_items, fxToBase);
      const carrierRevenueItemsBase = normalizeRevenueItemsToBase(carrier_revenue_items, fxToBase);
 
      const newOrderId = await generateUniqueSerialNumber(tenantId);
      
      // Ensure we have a truly unique serial number by checking and incrementing if necessary
      let finalSerialNo = parseInt(newOrderId);
      
      // Safety absolute max check first to avoid long loop when gap is huge
      const absoluteMaxOrder = await Order.findOne({ tenantId: tenantId }).sort({ serial_no: -1 }).lean();
      
      if (absoluteMaxOrder && absoluteMaxOrder.serial_no) {
         const absoluteMax = parseInt(absoluteMaxOrder.serial_no);
         if (finalSerialNo <= absoluteMax) {
            finalSerialNo = absoluteMax + 1;
         }
      } else {
         // For a new company with no orders, it MUST start at 1001 (1000 base + 1)
         // Even if the counter returned something weird like 1009, force it back to 1001.
         finalSerialNo = 1001;
      }
      
      let isUnique = false;
      let checkAttempts = 0;
      const maxCheckAttempts = 100; // Increased to 100 to handle large gaps
      
      while (!isUnique && checkAttempts < maxCheckAttempts) {
         // Some legacy data might have string serial_nos, check both numeric and string
         const existing = await Order.findOne({ 
            tenantId: tenantId, 
            $or: [
               { serial_no: finalSerialNo },
               { serial_no: String(finalSerialNo) }
            ]
         }).lean();
         
         if (existing) {
            finalSerialNo++;
            checkAttempts++;
         } else {
            isUnique = true;
            // Sync the counter forward to match our jump if we made any jumps
            if (checkAttempts > 0) {
               const counterKey = `serial_no:${tenantId || 'legacy_tenant_001'}`;
               const mongoose = require('mongoose');
               const Counter = mongoose.model('counters');
               await Counter.findOneAndUpdate(
                  { _id: counterKey },
                  { $set: { sequence_value: finalSerialNo } },
                  { upsert: true }
               );
            }
         }
      }
      
      if (!isUnique) {
         // Fallback: manually fetch absolute max from database and add 1
         const maxOrder = await Order.findOne({ tenantId: tenantId }).sort({ serial_no: -1 }).lean();
         const absoluteMax = maxOrder && maxOrder.serial_no ? parseInt(maxOrder.serial_no) : 1000;
         finalSerialNo = absoluteMax + 1;
         
         const counterKey = `serial_no:${tenantId || 'legacy_tenant_001'}`;
         const mongoose = require('mongoose');
         const Counter = mongoose.model('counters');
         await Counter.findOneAndUpdate(
            { _id: counterKey },
            { $set: { sequence_value: finalSerialNo } },
            { upsert: true }
         );
      }

      const isRegular = order_type === 'regular';
      const ownerContext = isRegular
         ? await resolveRegularOrderOwnerContext({
              tenantId,
              truckId: truck,
              totalAmount: totalAmountBase,
              settleAmount: settleAmountBase,
              driverAssignmentMode: driver_assignment_mode
           })
         : {
              isOwnerOperatedTruck: false,
              ownerOperator: null,
              settle_amount: 0,
              owner_profit: 0,
              carrier_amount
           };

      const normalizedDrivers = isRegular
         ? ownerContext.driver_assignment_mode === 'owner_driver'
            ? []
            : (drivers || [])
         : [];
      const normalizedDriver = normalizedDrivers.length > 0 ? normalizedDrivers[0] : null;

      const order = await Order.create({
         company_name,
         serial_no : finalSerialNo,
         customer_order_no: customer_order_no ? String(customer_order_no).trim() : null,
         shipping_details,

         customer : customer,
         customer_payment_date,
         customer_payment_method,
         total_amount: totalAmountBase,

         carrier,
         carrier_amount: isRegular ? Number(ownerContext.carrier_amount || 0) : carrierAmountBase,
         carrier_payment_date,
         carrier_payment_method,

         order_type,
         drivers: normalizedDrivers,
         driver: normalizedDriver,
         truck,
         trailer,
         ownerOperator: ownerContext.ownerOperator,
         isOwnerOperatedTruck: ownerContext.isOwnerOperatedTruck,
         settle_amount: Number(ownerContext.settle_amount || 0),
         owner_profit: Number(ownerContext.owner_profit || 0),
         driver_assignment_mode: ownerContext.driver_assignment_mode || 'company_driver',
         driver_assignment_status:
            (ownerContext.driver_assignment_mode || 'company_driver') === 'owner_driver'
               ? 'owner_operator_driver'
               : (normalizedDrivers.length > 0 ? 'company_driver_assigned' : 'company_driver_unassigned'),

         revenue_items: revenueItemsBase,
         carrier_revenue_items: carrierRevenueItemsBase,
         revenue_currency: BASE_ORDER_CURRENCY.toLowerCase(),
         amount_currency: BASE_ORDER_CURRENCY.toLowerCase(),
         input_currency: inputCurrency.toLowerCase(),
         fx_to_usd: Number(fxToBase || 1),
         input_total_amount: Number(total_amount || 0),
         input_carrier_amount: Number(carrier_amount || 0),
         input_settle_amount: Number(settle_amount || 0),
         totalDistance,
         order_status,
         tenantId: tenantId,
         company:req.user && req.user.company ? req.user.company._id : null,

         created_by : req.user._id,
      });
   
      if(!order){
         return res.json({
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
               tenantId: tenantId,
               order: order._id,
               trip_no: 1,
               start_stop_index: 0,
               end_stop_index: locations.length - 1,
               driver: order.order_type === 'regular' && order.driver_assignment_mode !== 'owner_driver' ? order.driver : null,
               drivers: order.order_type === 'regular' && order.driver_assignment_mode !== 'owner_driver' ? (order.drivers || []) : [],
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
      logActivity(req, {
         action: 'CREATE',
         module: 'order',
         description: `Created order #${order.serial_no}`,
         resourceId: order._id,
         resourceName: `Order #${order.serial_no}`,
      });
      if (order.isOwnerOperatedTruck && order.ownerOperator) {
         await syncOwnerOperatorFinancialRecords({
            tenantId,
            companyId: req.user?.company?._id || req.user?.company || null,
            userId: req.user?._id,
            order
         });
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
      const ALLOWED_UPDATE_FIELDS = [
         'customer', 'carrier', 'driver', 'truck', 'trailer', 'drivers',
         'customer_order_no', 'company_name', 'reference_no',
         'total_amount', 'carrier_amount', 'profit',
         'shipping_details', 'totalDistance', 'notes',
         'order_status', 'pickup_date', 'delivery_date',
         'commodity', 'equipment', 'charges', 'extra_charges',
         'documents', 'invoice_number', 'po_number',
         'billing_address', 'billing_city', 'billing_state', 'billing_zip',
         'settle_amount', 'driver_assignment_mode',
         'revenue_items', 'carrier_revenue_items', 'revenue_currency',
      ];
      const updateData = {};
      for (const key of ALLOWED_UPDATE_FIELDS) {
         if (key in req.body) updateData[key] = req.body[key];
      }

      const criteria = { _id: req.params.id, tenantId };

      if (Array.isArray(req.allowedOrderTypes) && req.allowedOrderTypes.length > 0) {
         criteria.order_type = { $in: req.allowedOrderTypes };
      }
      applyOrderOwnershipScope(req, criteria);
      const existingOrder = await Order.findOne(criteria);
      if(!existingOrder) {
         return res.status(404).json({
            status: false,
            message: "Order not found."
         });
      }

      const hasAmountRelatedUpdate =
         ('total_amount' in updateData) ||
         ('carrier_amount' in updateData) ||
         ('settle_amount' in updateData) ||
         ('revenue_items' in updateData) ||
         ('carrier_revenue_items' in updateData) ||
         ('revenue_currency' in updateData);

      if (hasAmountRelatedUpdate) {
         const inputCurrency = normalizeCurrency(
            updateData.revenue_currency || existingOrder.input_currency || existingOrder.revenue_currency || BASE_ORDER_CURRENCY,
            BASE_ORDER_CURRENCY
         );
         const fxToBase = await resolveMonthlyRateToBase({
            tenantId,
            sourceCurrency: inputCurrency,
            referenceDate: existingOrder.createdAt || new Date(),
         });

         if ('total_amount' in updateData) {
            updateData.input_total_amount = Number(updateData.total_amount || 0);
            updateData.total_amount = convertToBase(updateData.total_amount, fxToBase);
         }
         if ('carrier_amount' in updateData) {
            updateData.input_carrier_amount = Number(updateData.carrier_amount || 0);
            updateData.carrier_amount = convertToBase(updateData.carrier_amount, fxToBase);
         }
         if ('settle_amount' in updateData) {
            updateData.input_settle_amount = Number(updateData.settle_amount || 0);
            updateData.settle_amount = convertToBase(updateData.settle_amount, fxToBase);
         }
         if ('revenue_items' in updateData) {
            updateData.revenue_items = normalizeRevenueItemsToBase(updateData.revenue_items, fxToBase);
         }
         if ('carrier_revenue_items' in updateData) {
            updateData.carrier_revenue_items = normalizeRevenueItemsToBase(updateData.carrier_revenue_items, fxToBase);
         }

         updateData.revenue_currency = BASE_ORDER_CURRENCY.toLowerCase();
         updateData.amount_currency = BASE_ORDER_CURRENCY.toLowerCase();
         updateData.input_currency = inputCurrency.toLowerCase();
         updateData.fx_to_usd = Number(fxToBase || 1);
      }

      const nextOrderType = existingOrder.order_type;
      if (nextOrderType === 'regular') {
         // Respect explicit truck from the request (including an intentional clear to null).
         // Only fall back to the stored value when the client didn't send the field at all.
         const nextTruck = ('truck' in updateData) ? updateData.truck : existingOrder.truck;
         const nextTotalAmount = ('total_amount' in updateData) ? updateData.total_amount : existingOrder.total_amount;
         const nextSettle = ('settle_amount' in updateData) ? updateData.settle_amount : existingOrder.settle_amount;
         const nextDriverMode = updateData.driver_assignment_mode || existingOrder.driver_assignment_mode;
         const ownerContext = await resolveRegularOrderOwnerContext({
            tenantId,
            truckId: nextTruck,
            totalAmount: nextTotalAmount,
            settleAmount: nextSettle,
            driverAssignmentMode: nextDriverMode,
            allowMissingTruck: true
         });
         if (ownerContext.truckCleared) {
            updateData.truck = null;
         }
         updateData.isOwnerOperatedTruck = ownerContext.isOwnerOperatedTruck;
         updateData.ownerOperator = ownerContext.ownerOperator;
         updateData.settle_amount = Number(ownerContext.settle_amount || 0);
         updateData.owner_profit = Number(ownerContext.owner_profit || 0);
         updateData.carrier_amount = Number(ownerContext.carrier_amount || 0);
         updateData.driver_assignment_mode = ownerContext.driver_assignment_mode || 'company_driver';
         const incomingDrivers = Array.isArray(updateData.drivers) ? updateData.drivers : (existingOrder.drivers || []);
         updateData.driver_assignment_status =
            (ownerContext.driver_assignment_mode || 'company_driver') === 'owner_driver'
               ? 'owner_operator_driver'
               : (incomingDrivers.length > 0 ? 'company_driver_assigned' : 'company_driver_unassigned');
         if (ownerContext.driver_assignment_mode === 'owner_driver') {
            updateData.drivers = [];
            updateData.driver = null;
         } else if ('drivers' in updateData && Array.isArray(updateData.drivers)) {
            updateData.driver = updateData.drivers[0] || null;
         }
      }
      const order = await Order.findOneAndUpdate(criteria, updateData, {
         new: true,
         runValidators: true,
      });
      if (order.isOwnerOperatedTruck && order.ownerOperator) {
         await syncOwnerOperatorFinancialRecords({
            tenantId,
            companyId,
            userId: req.user?._id,
            order
         });
      } else {
         await OwnerOperatorFinancialRecord.deleteMany({
            tenantId,
            order: order._id,
            type: { $in: ['SETTLEMENT', 'OWNER_PROFIT', 'DRIVER_DEDUCTION'] }
         });
      }
      logActivity(req, {
         action: 'UPDATE',
         module: 'order',
         description: `Updated order #${order.serial_no}`,
         resourceId: order._id,
         resourceName: `Order #${order.serial_no}`,
      });
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
   
   console.log('[order_listing] Request received');
   console.log('[order_listing] User company:', req.user?.company?._id || req.user?.company);
   console.log('[order_listing] User tenantId:', req.user?.tenantId);
   
   const queryObj = {
      $or: [
         { deletedAt: null },
         { deletedAt: '' },
         { deletedAt: { $exists: false } }
      ]
   };

   const tenantId = getTenantId(req);
   console.log('[order_listing] Resolved tenantId:', tenantId);
   if (!tenantId) {
      return res.status(400).json({ status: false, message: "Tenant context is required.", orders: [], page: 1, totalPages: 0 });
   }
   queryObj.tenantId = tenantId;
   const companyId = normalizeCompanyId(req);
   console.log('[order_listing] Normalized companyId:', companyId);
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
      queryObj.$and = queryObj.$and || [];
      queryObj.$and.push({
         $or: [
            { carrier_payment_status: paymentStatus },
            { customer_payment_status: paymentStatus }
         ]
      });
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
      if (key === 'driver') {
         queryObj['drivers'] = v;
      } else {
         queryObj[key] = v;
      }
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

   // Scope listings for non-admin users to their own records/assignments
   const isEmulating = req.isEmulating || req.isSuperAdminUser;
   const isAdminUser = req.user?.role === 3 || req.user?.is_admin === 1 || req.user?.permissions?.includes('subadmin') || isEmulating;
   if (req.user && !isAdminUser) {
      if (Number(req.user.role) === 0 || req.user?.permissions?.includes('driver')) {
         queryObj.$and = queryObj.$and || [];
         queryObj.$and.push({ $or: [{ driver: req.user._id }, { drivers: req.user._id }] });
      } else {
         queryObj.created_by = req.user._id;
      }
   }

   if (search && search.length > 1) {
      const searchValue = search.trim();
      if (!isNaN(searchValue)) {
         // Numeric: match by serial number
         queryObj.serial_no = parseInt(searchValue);
      } else {
         // Non-numeric: search customer order number or company name
         const safeSearch = searchValue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
         queryObj.$or = [
            { customer_order_no: { $regex: safeSearch, $options: 'i' } },
            { company_name: { $regex: safeSearch, $options: 'i' } },
         ];
      }
   }

   // Restrict listing to order types the user is allowed to access
   if (Array.isArray(req.allowedOrderTypes) && req.allowedOrderTypes.length > 0) {
      queryObj.order_type = { $in: req.allowedOrderTypes };
   }

      // Set default sort to serial_no descending if not provided
      if (!req.query.sort) {
         req.query.sort = '-serial_no';
      }
      
      let Query = new APIFeatures(
         Order.find(queryObj)
            .populate(['created_by', 'customer', 'carrier', 'carrier_payment_updated_by', 'customer_payment_updated_by', 'driver', 'drivers', 'truck', 'trailer', 'ownerOperator'])
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

exports.generatePdfFromHtml = catchAsync(async (req, res, next) => {
   const puppeteer = require('puppeteer');
   const fs = require('fs');
   const path = require('path');
   const axios = require('axios');
   const Company = require('../db/Company');

   let browser = null;
   try {
      let { html, filename, logoBase64: clientLogoBase64, docType } = req.body;
      if (!html) {
         return res.status(400).json({ status: false, message: 'HTML content is required' });
      }

      // Invoice downloads are gated by the `invoices` permission. Admin/sub-admin/accounting
      // are always allowed. Frontend hiding is not enough — enforce here too.
      if (docType === 'invoice') {
         const u = req.user || {};
         const perms = Array.isArray(u.permissions) ? u.permissions : [];
         const canDownloadInvoice =
            u.is_admin === 1 ||
            Number(u.role) === 3 ||
            perms.includes('invoices') ||
            perms.includes('subadmin') ||
            perms.includes('accounting');
         if (!canDownloadInvoice) {
            return res.status(403).json({ status: false, message: 'You do not have permission to download invoices' });
         }
      }

      // 1. Use client-provided base64 logo if available (most reliable — already loaded in browser)
      let base64Logo = clientLogoBase64 || '';

      // 2. If not provided by client, read logo_base64 cached in DB (no HTTP request needed)
      if (!base64Logo) {
         const companyId = req.user?.company?._id || req.user?.company;
         if (companyId) {
            const companyDoc = await Company.findById(companyId).select('logo_base64 pdf_logo logo').lean();
            if (companyDoc?.logo_base64) {
               base64Logo = companyDoc.logo_base64;
            } else if (companyDoc?.pdf_logo || companyDoc?.logo) {
               // Fallback: fetch from CDN (works when server has outbound internet)
               const logoUrl = companyDoc.pdf_logo || companyDoc.logo;
               try {
                  const response = await axios.get(logoUrl, {
                     responseType: 'arraybuffer',
                     timeout: 8000,
                  });
                  const buffer = Buffer.from(response.data);
                  const contentType = response.headers['content-type'] || 'image/png';
                  base64Logo = `data:${contentType};base64,${buffer.toString('base64')}`;
                  // Cache it for next time
                  await Company.findByIdAndUpdate(companyId, { logo_base64: base64Logo });
               } catch (e) {
                  console.error('Failed to fetch remote logo for PDF:', e.message);
               }
            }
         }
      }

      // 3. Local fallback — backend/assets/logo.png (works on AWS and local both)
      if (!base64Logo) {
         try {
            const candidates = [
               path.join(__dirname, '../assets/logo.png'),
               path.join(__dirname, '../../frontend/public/logo.png'),
            ];
            for (const p of candidates) {
               if (fs.existsSync(p)) {
                  base64Logo = `data:image/png;base64,${fs.readFileSync(p).toString('base64')}`;
                  break;
               }
            }
         } catch (e) {
            console.error('Failed to read local logo:', e.message);
         }
      }

      // 4. Replace all logo <img> src with the base64 string
      if (base64Logo) {
         html = html.replace(/(<img[^>]*alt=['"](?:logo|Logo)['"][^>]*>)/gi, (match) => {
            return match.replace(/src=['"][^'"]*['"]/i, `src="${base64Logo}"`);
         });
      }

      const fullHtml = `
      <!DOCTYPE html>
      <html>
      <head>
         <meta charset="utf-8" />
         <link rel="preconnect" href="https://fonts.googleapis.com" />
         <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
         <link href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@400;500;600;700;800&family=IBM+Plex+Sans:wght@300;400;500;600;700&display=swap" rel="stylesheet" />
         <script src="https://cdn.tailwindcss.com"></script>
         <style>
            @page { margin: 0; }
            html, body {
               background: white;
               -webkit-print-color-adjust: exact;
               print-color-adjust: exact;
               font-family: 'IBM Plex Sans', Arial, Helvetica, sans-serif;
               margin: 0; padding: 0;
            }
            /* Strong page-break rules — keep every block together */
            * {
               box-sizing: border-box;
            }
            div, table, tr, thead, tbody, section, article {
               page-break-inside: avoid !important;
               break-inside: avoid !important;
               orphans: 4;
               widows: 4;
            }
            img { max-width: 100%; height: auto; display: block; }

            /* Ensure layout behaves consistently in PDF */
            .flex { display: flex !important; }
            .grid { display: grid !important; }
            .justify-between { justify-content: space-between !important; }
            .items-center { align-items: center !important; }
            .items-start { align-items: flex-start !important; }
            .text-right { text-align: right !important; }
            .border-b { border-bottom: 1px solid #e5e7eb !important; }
            .pb-4 { padding-bottom: 1rem !important; }
            .mb-4 { margin-bottom: 1rem !important; }
         </style>
      </head>
      <body>
         ${base64Logo ? `<div style="position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);width:320px;pointer-events:none;z-index:9999"><img src="${base64Logo}" style="width:100%;height:auto;opacity:0.06;object-fit:contain;display:block" /></div>` : ''}
         ${html}
      </body>
      </html>
      `;

      browser = await puppeteer.launch({
         headless: true,
         args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-web-security', '--disable-features=IsolateOrigins,site-per-process'],
      });
      const page = await browser.newPage();
      
      // 1× scale keeps file size small; quality is still crisp at A4 print resolution
      await page.setViewport({ width: 794, height: 1123, deviceScaleFactor: 1 });
      await page.setContent(fullHtml, { waitUntil: 'load', timeout: 20000 }).catch(() => {});
      
      // Small delay to ensure any dynamic images (like logos) are fully rendered
      await new Promise(resolve => setTimeout(resolve, 500));
      
      const pdfBuffer = await page.pdf({
         format: 'A4',
         printBackground: true,
         margin: { top: '10mm', bottom: '12mm', left: '0', right: '0' },
      });

      const safeFilename = filename ? filename.replace(/[^a-z0-9-_.]+/gi, '_') : 'document.pdf';
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}"`);
      return res.status(200).send(Buffer.from(pdfBuffer));
   } catch (err) {
      JSONerror(res, err, next);
   } finally {
      if (browser) {
         try { await browser.close(); } catch (e) {}
      }
   }
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

      // Restrict to allowed order types
      if (Array.isArray(req.allowedOrderTypes) && req.allowedOrderTypes.length > 0) {
         queryObj.order_type = { $in: req.allowedOrderTypes };
      }

      // Non-admin users only see their own orders (mirror order_listing)
      applyOrderOwnershipScope(req, queryObj);

   // Set default sort to serial_no descending if not provided
   if (!req.query.sort) {
      req.query.sort = '-serial_no';
   }

   let Query = new APIFeatures(
      Order.find(queryObj)
         .populate(['created_by', 'customer', 'carrier', 'carrier_payment_updated_by', 'customer_payment_updated_by', 'driver', 'drivers', 'truck', 'trailer', 'ownerOperator'])
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
      let order;
      const criteria = { _id: req.params.id, tenantId };

      if (Array.isArray(req.allowedOrderTypes) && req.allowedOrderTypes.length > 0) {
         criteria.order_type = { $in: req.allowedOrderTypes };
      }
      applyOrderOwnershipScope(req, criteria);
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
      logActivity(req, {
         action: 'PAYMENT',
         module: 'order',
         description: `Updated ${req.params.type} payment status to "${status}" on order #${order.serial_no}`,
         resourceId: order._id,
         resourceName: `Order #${order.serial_no}`,
         details: { paymentType: req.params.type, status, method },
      });
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
      const criteria = { _id: req.params.id, tenantId };

      if (Array.isArray(req.allowedOrderTypes) && req.allowedOrderTypes.length > 0) {
         criteria.order_type = { $in: req.allowedOrderTypes };
      }
      applyOrderOwnershipScope(req, criteria);
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
      logActivity(req, {
         action: 'STATUS_CHANGE',
         module: 'order',
         description: `Changed order #${order.serial_no} status to "${status}"`,
         resourceId: order._id,
         resourceName: `Order #${order.serial_no}`,
         details: { newStatus: status },
      });
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
      const criteria = { _id: req.params.id, tenantId };

      if (Array.isArray(req.allowedOrderTypes) && req.allowedOrderTypes.length > 0) {
         criteria.order_type = { $in: req.allowedOrderTypes };
      }
      applyOrderOwnershipScope(req, criteria);
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
      if (req.user.role === 0 || req.user?.permissions?.includes('driver')) {
         queryFilter = {
            $or: [{ driver: req.user._id }, { drivers: req.user._id }],
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

   // Scope dashboard counts by tenant — mandatory
   const overviewTenantId = getTenantId(req);
   if (!overviewTenantId) {
      return res.status(400).json({ status: false, message: "Tenant context is required." });
   }
   queryFilter.tenantId = overviewTenantId;

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

   // Restrict counts to the modules the user is allowed to see
   const requestedType = String(req.query.type || '').toLowerCase();
   if (requestedType && ['outsourcing', 'regular'].includes(requestedType)) {
      if (!Array.isArray(req.allowedOrderTypes) || req.allowedOrderTypes.length === 0 || req.allowedOrderTypes.includes(requestedType)) {
         queryFilter.order_type = requestedType;
      } else {
         queryFilter.order_type = { $in: req.allowedOrderTypes };
      }
   } else if (Array.isArray(req.allowedOrderTypes) && req.allowedOrderTypes.length > 0) {
      queryFilter.order_type = { $in: req.allowedOrderTypes };
   }

   // Count documents with proper filter
   totalLoads = await Order.countDocuments(queryFilter);
   intransitLoads = await Order.countDocuments({ order_status: 'intransit', ...queryFilter });
   completedLoads = await Order.countDocuments({ order_status: 'completed', ...queryFilter });
   pendingLoads = await Order.countDocuments({ order_status: 'added', ...queryFilter });

   // Calculate total profit and revenue
   const allOrdersForProfit = await Order.find(queryFilter)
         .select('total_amount carrier_amount order_type created_by')
         .populate({ path: 'created_by', select: 'staff_commision' });
   
   let totalProfit = 0;
   let totalRevenue = 0;
   allOrdersForProfit.forEach(o => {
      totalProfit += Number(o.profit) || 0;
      totalRevenue += Number(o.total_amount) || 0;
   });

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

   const baseCurrency = BASE_ORDER_CURRENCY;

   res.json({
      status: true,
      message: 'Dashboard data retrieved successfully.',
      baseCurrency,
      chartData: chartData,
      lists: [
         {
            icon:"van",
            bg:'bg-green-700',
            title : 'Total Revenue',
            data: Number(totalRevenue || 0).toFixed(2),
            rawValue: Number(totalRevenue || 0),
            kind: 'currency',
            baseCurrency,
            link: '/orders'
         },
         {
            icon:"van",
            bg:'bg-green-700',
            title : 'Total Profit',
            data: Number(totalProfit || 0).toFixed(2),
            rawValue: Number(totalProfit || 0),
            kind: 'currency',
            baseCurrency,
            link: '/orders'
         },
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

exports.getFxRate = catchAsync(async (req, res) => {
   const tenantId = getTenantId(req);
   if (!tenantId) {
      return res.status(400).json({ status: false, message: "Tenant context is required." });
   }
   const source = normalizeCurrency(req.query?.source || BASE_ORDER_CURRENCY, BASE_ORDER_CURRENCY);
   const target = normalizeCurrency(req.query?.target || BASE_ORDER_CURRENCY, BASE_ORDER_CURRENCY);
   const month = Number(req.query?.month || 0);
   const year = Number(req.query?.year || 0);
   const referenceDate =
      Number.isFinite(month) && month >= 1 && month <= 12 && Number.isFinite(year) && year > 2000
         ? new Date(year, month - 1, 1)
         : new Date();

   const rate = await resolveMonthlyRate({
      tenantId,
      sourceCurrency: source,
      targetCurrency: target,
      referenceDate
   });

   return res.json({
      status: true,
      sourceCurrency: source,
      targetCurrency: target,
      month: referenceDate.getMonth() + 1,
      year: referenceDate.getFullYear(),
      rate: Number(rate || 1),
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
   if (Array.isArray(req.allowedOrderTypes) && req.allowedOrderTypes.length > 0) {
      criteria.order_type = { $in: req.allowedOrderTypes };
   }

   const order = await Order.findOne(criteria)
      .populate({ path: 'created_by', options: { includeInactive: true } })
      .populate(['customer', 'carrier', 'driver', 'drivers', 'truck', 'trailer', 'ownerOperator'])
      .populate('documents_count');

    if(!order){
      return res.json({
         status: false,
         orders: null,
         message: "Order not found."
       });
    }

   // Authorize: non-admin users may only view their own records (mirror order_listing).
   // Never rely on `role` alone — not set on signup users.
   const isEmulating = req.isEmulating || req.isSuperAdminUser;
   const isAdminUser = req.user?.role === 3 || req.user?.is_admin === 1 || req.user?.permissions?.includes('subadmin') || isEmulating;
   if (req.user && !isAdminUser) {
      const uid = String(req.user._id);
      const isDriverUser = Number(req.user.role) === 0 || req.user?.permissions?.includes('driver');
      let allowed;
      if (isDriverUser) {
         const driverIds = [order.driver, ...(Array.isArray(order.drivers) ? order.drivers : [])]
            .filter(Boolean).map(d => String(d._id || d));
         allowed = driverIds.includes(uid);
      } else {
         allowed = String(order.created_by?._id || order.created_by) === uid;
      }
      if (!allowed) {
         return res.status(403).json({
            status: false,
            forbidden: true,
            order: null,
            message: "You don't have permission to view this order."
         });
      }
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
      const orderCriteria = applyOrderOwnershipScope(req, { _id: id, tenantId });

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
   res.json({
      status: true,
      paymentLogs: paymentLogs ?? [],
      files: files,
   });
});

exports.lockOrder = catchAsync(async (req, res) => {

   if(req.user && req.user.is_admin !== 1 && Number(req.user.role) !== 3){
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
   const criteria = { _id: id, tenantId };

   const order = await Order.findOne(criteria);
   if(!order){
      return res.json({
         status: false,
         message: "Order not found."
       });
   }
   const newLockState = !order.lock;
   order.lock = newLockState || null;
   await order.save();
   logActivity(req, {
      action: 'STATUS_CHANGE',
      module: 'order',
      description: `${newLockState ? 'Locked' : 'Unlocked'} order #${order.serial_no}`,
      resourceId: order._id,
      resourceName: `Order #${order.serial_no}`,
      details: { locked: !!newLockState },
   });
   res.json({
      status: true,
      'Message': "Order locked status updated.",
   });
});


exports.deleteOrder = catchAsync(async (req, res) => {
   // Only admin and sub-admin can delete orders
   const canDelete = req.user?.is_admin === 1 || Number(req.user?.role) === 3 || req.user?.permissions?.includes('subadmin');
   if(req.user && !canDelete){
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
   const criteria = { _id: id, tenantId };

   const order = await Order.findOne(criteria);
   if(!order){
      return res.json({
         status: false,
         message: "Order not found."
       });
   }
   order.deletedAt = Date.now();
   await order.save();
   logActivity(req, {
      action: 'DELETE',
      module: 'order',
      description: `Deleted order #${order.serial_no}`,
      resourceId: order._id,
      resourceName: `Order #${order.serial_no}`,
   });
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
      logActivity(req, {
         action: 'CREATE',
         module: 'settings',
         description: `Added commodity "${result.name}"`,
         resourceId: result._id,
         resourceName: result.name,
      });
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
       logActivity(req, {
         action: 'DELETE',
         module: 'settings',
         description: `Removed commodity (ID: ${id})`,
         resourceId: id,
       });
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
      logActivity(req, {
         action: 'CREATE',
         module: 'settings',
         description: `Added equipment type "${result.name}"`,
         resourceId: result._id,
         resourceName: result.name,
      });
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
       logActivity(req, {
         action: 'DELETE',
         module: 'settings',
         description: `Removed equipment type (ID: ${id})`,
         resourceId: id,
       });
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
      const charge = await Charges.create({
         tenantId,
         name: value.trim(),
         company: req.user && req.user.company ? req.user.company._id : null,
      });
      logActivity(req, {
         action: 'CREATE',
         module: 'settings',
         description: `Added charge item "${charge.name}"`,
         resourceId: charge._id,
         resourceName: charge.name,
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
       logActivity(req, {
         action: 'DELETE',
         module: 'settings',
         description: `Removed charge item (ID: ${id})`,
         resourceId: id,
       });
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
   const tenantId = getTenantId(req);
   if (!tenantId) {
      return res.status(400).json({ status: false, message: "Tenant context is required.", orders: [], page: 1, totalPages: 0 });
   }
   const queryObj = {
      tenantId,
      $or: [{ deletedAt: null }]
   };

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

   // Scope payments to own records for non-admin users.
   // Mirror order_listing: never rely on `role` alone (not set on signup users).
   const isEmulating = req.isEmulating || req.isSuperAdminUser;
   const isAdminUser = req.user?.role === 3 || req.user?.is_admin === 1 || req.user?.permissions?.includes('subadmin') || isEmulating;
   if (req.user && !isAdminUser) {
      queryObj.created_by = req.user._id;
   }

   // Sanitize search parameter
   if (search && search.length > 1) {
      const searchValue = search.trim();
      const safeSearch = searchValue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (!isNaN(searchValue)) {
         queryObj.serial_no = parseInt(searchValue);
      } else {
         queryObj.$and = queryObj.$and || [];
         queryObj.$and.push({
            $or: [
               { customer_order_no: { $regex: safeSearch, $options: 'i' } },
               { company_name: { $regex: safeSearch, $options: 'i' } }
            ]
         });
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
   const tenantId = getTenantId(req);
   if (!tenantId) {
      return res.status(400).json({ status: false, message: "Tenant context is required.", lists: [], page: 1, totalPages: 0 });
   }
   const queryObj = {
      tenantId,
      $or: [{ deletedAt: null }]
   };
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



 



 
