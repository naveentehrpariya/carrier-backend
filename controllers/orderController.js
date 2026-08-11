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
const DriverSalary = require("../db/DriverSalary");
const ConversionRate = require("../db/ConversionRate");
const { syncOwnerFinancialRecords, resolveOrderOwnerFields } = require("../utils/ownerSettlement");
const { checkOrderLimit } = require("../middlewares/planLimitsMiddleware");
const { logActivity } = require("../utils/activityLogger");
const { createOrderFxConverter, resolveDisplayCurrency, orderMoneyIn } = require("../utils/orderMoney");
const { kmToMiles } = require("../utils/distance");

const DISTANCE_SOURCES = ['auto_fastest', 'auto_domestic', 'auto_corridor', 'manual'];
const normalizeDistanceSource = (value) =>
   DISTANCE_SOURCES.includes(String(value || '')) ? String(value) : 'auto_fastest';

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

/**
 * Order search — one definition, used by every order listing endpoint.
 *
 * Matches customer order no, our own serial no, the order-level reference,
 * per-stop reference numbers and pickup/delivery addresses. A numeric term is
 * still matched exactly against serial_no, but no longer *exclusively*: a load
 * whose reference or postal code is all digits has to be findable too.
 *
 * Returns an $or array (or null). Callers must push it onto $and — assigning it
 * to queryObj.$or would clobber the deletedAt filter and leak deleted orders.
 */
function buildOrderSearchOr(search) {
   const value = String(search || '').trim();
   if (value.length < 2) return null;
   const safe = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
   const rx = { $regex: safe, $options: 'i' };
   const or = [
      { customer_order_no: rx },
      { company_name: rx },
      { 'shipping_details.reference': rx },
      { 'shipping_details.locations.referenceNo': rx },
      { 'shipping_details.locations.location': rx },
      { 'shipping_details.locations.address': rx },
      { 'shipping_details.locations.city': rx },
   ];
   if (!isNaN(value) && value !== '') {
      or.unshift({ serial_no: parseInt(value, 10) });
   }
   return or;
}

function applyOrderSearch(queryObj, search) {
   const or = buildOrderSearchOr(search);
   if (!or) return queryObj;
   queryObj.$and = queryObj.$and || [];
   queryObj.$and.push({ $or: or });
   return queryObj;
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
   // Settle amount MAY exceed order total (owner paid more than the order
   // brings in) — owner_profit simply goes negative for that order.

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

async function loadOrderTripsAndTrucks(tenantId, orderId) {
   const trips = await Trip.find({ tenantId, order: orderId, deletedAt: null })
      .select('truck miles totalDistance total_km settle_amount')
      .lean();
   const truckIds = [...new Set(trips.map((t) => String(t.truck || '')).filter(Boolean))];
   const truckRows = truckIds.length > 0
      ? await Truck.find({ tenantId, _id: { $in: truckIds } }).select('ownerOperated ownerOperator').lean()
      : [];
   return { trips, truckMap: new Map(truckRows.map((t) => [String(t._id), t])) };
}

// Owner ledger rows for an order. A mixed split settles per leg, so the trips (and the owner of each
// trip's truck) decide the rows — see utils/ownerSettlement.js.
async function syncOwnerOperatorFinancialRecords({ tenantId, companyId, userId, order }) {
   const { trips, truckMap } = order?.isMixedOwner
      ? await loadOrderTripsAndTrucks(tenantId, order._id)
      : { trips: [], truckMap: new Map() };
   await syncOwnerFinancialRecords({ tenantId, companyId, userId, order, trips, truckMap });
}

// A stop may be saved without an address on purpose: dispatch often books a load before the
// shipper confirms the exact facility. The order is allowed through; what is NOT allowed is an
// address that was typed and then silently dropped (see GetLocation) or one that cannot be
// routed (see carrierController.getDistance).

/* ── Money sanity ───────────────────────────────────────────────────────────────
   A minus sign in a rate box used to sail straight through to the database: order #1107 carries
   `total_amount: -1160` from a single `Line Haul -1160 x 1` line, and every report that sums it
   is wrong by that much. Nothing about an order is ever negative — revenue, cost, settlement and
   the line items behind them are all amounts owed, not adjustments.                            */
/* A delivery cannot happen before its pickup. Dates are stored as `YYYY-MM-DD` strings, which
   compare correctly as strings — no timezone to get wrong. Only the order's first pickup and last
   delivery are compared: multi-stop runs legitimately interleave. */
function findBackwardsDates(shippingDetails) {
   const problems = [];
   (Array.isArray(shippingDetails) ? shippingDetails : []).forEach((block) => {
      const locs = Array.isArray(block?.locations) ? block.locations : [];
      const kind = (l) => l?.type || l?.location_type;
      const firstPickup = locs.find((l) => kind(l) === 'pickup' && l?.date);
      const lastDelivery = [...locs].reverse().find((l) => kind(l) === 'delivery' && l?.date);
      if (firstPickup && lastDelivery && String(lastDelivery.date) < String(firstPickup.date)) {
         problems.push(`Delivery is dated ${lastDelivery.date}, before the pickup on ${firstPickup.date}.`);
      }
   });
   return problems;
}

/* Pull every leg back inside the order's current stop list after the stops were edited.
   One leg (the common case) is simply stretched over the whole route, exactly as create_order
   builds it. Several legs are clamped and their order preserved; a leg squeezed out entirely by
   the edit is soft-deleted rather than left pointing at nothing. */
async function resyncTripStopIndexes(tenantId, order) {
   const locs = order?.shipping_details?.[0]?.locations || [];
   const last = locs.length - 1;
   const legs = await Trip.find({ tenantId, order: order._id, deletedAt: null }).sort({ trip_no: 1 });
   if (legs.length === 0) return;

   if (last < 1) {
      // Fewer than two stops left — there is no route for a leg to describe.
      await Trip.updateMany({ tenantId, order: order._id, deletedAt: null }, { deletedAt: Date.now() });
      return;
   }

   if (legs.length === 1) {
      const leg = legs[0];
      if (leg.start_stop_index !== 0 || leg.end_stop_index !== last) {
         leg.start_stop_index = 0;
         leg.end_stop_index = last;
         await leg.save();
      }
      return;
   }

   let cursor = 0;
   for (const leg of legs) {
      const start = Math.min(Math.max(Number(leg.start_stop_index || 0), cursor), last);
      const end = Math.min(Math.max(Number(leg.end_stop_index || 0), start), last);
      if (start >= last && leg !== legs[legs.length - 1]) {
         leg.deletedAt = Date.now();
         await leg.save();
         continue;
      }
      if (start !== leg.start_stop_index || end !== leg.end_stop_index) {
         leg.start_stop_index = start;
         leg.end_stop_index = end;
         await leg.save();
      }
      cursor = end;
   }
   // The last surviving leg must always reach the final stop, or part of the route belongs to nobody.
   const surviving = await Trip.find({ tenantId, order: order._id, deletedAt: null }).sort({ trip_no: 1 });
   const tail = surviving[surviving.length - 1];
   if (tail && tail.end_stop_index !== last) {
      tail.end_stop_index = last;
      await tail.save();
   }
}

function findNegativeMoney({ revenue_items, carrier_revenue_items, total_amount, carrier_amount, settle_amount }) {
   const bad = [];
   const checkItems = (items, label) => {
      (Array.isArray(items) ? items : []).forEach((item, i) => {
         const rate = Number(item?.rate);
         const qty = Number(item?.quantity);
         const name = item?.revenue_item || item?.name || `line ${i + 1}`;
         if (Number.isFinite(rate) && rate < 0) bad.push(`${label} "${name}" has a negative rate (${rate})`);
         if (Number.isFinite(qty) && qty < 0) bad.push(`${label} "${name}" has a negative quantity (${qty})`);
      });
   };
   checkItems(revenue_items, 'Customer revenue');
   checkItems(carrier_revenue_items, 'Carrier revenue');
   [['total_amount', total_amount], ['carrier_amount', carrier_amount], ['settle_amount', settle_amount]]
      .forEach(([field, value]) => {
         const n = Number(value);
         if (Number.isFinite(n) && n < 0) bad.push(`${field.replace(/_/g, ' ')} is negative (${n})`);
      });
   return bad;
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
         // Route assumptions from /getdistance (or 'manual' when the dispatcher typed the miles).
         route_crosses_border,
         route_countries,
         distance_source,

         order_status,
       } = req.body;

      const negatives = findNegativeMoney({ revenue_items, carrier_revenue_items, total_amount, carrier_amount, settle_amount });
      if (negatives.length > 0) {
         return res.status(400).json({ status: false, code: 'negative_amount', message: negatives[0], problems: negatives });
      }

      const badDates = findBackwardsDates(shipping_details);
      if (badDates.length > 0) {
         return res.status(400).json({ status: false, code: 'dates_backwards', message: badDates[0], problems: badDates });
      }

      // The same reference on the same customer is usually a double-submit or two dispatchers
      // entering one load — prod has 28 such pairs. It is occasionally legitimate (a split
      // shipment), so this warns and lets the user confirm rather than blocking.
      const reference = String(shipping_details?.[0]?.reference || '').trim();
      if (reference && customer && !req.body?.confirm_duplicate) {
         const twins = await Order.find({
            tenantId,
            customer,
            'shipping_details.reference': reference,
            $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
         }).select('serial_no createdAt').sort({ createdAt: -1 }).limit(5).lean();
         if (twins.length > 0) {
            return res.status(409).json({
               status: false,
               code: 'duplicate_reference',
               message: `This customer already has reference "${reference}" on order #${twins.map((t) => t.serial_no).join(', #')}.`,
               duplicates: twins.map((t) => ({ serial_no: t.serial_no, createdAt: t.createdAt })),
            });
         }
      }

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
         route_crosses_border: !!route_crosses_border,
         route_countries: Array.isArray(route_countries) ? route_countries : [],
         distance_source: normalizeDistanceSource(distance_source),
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
               // order.totalDistance is KM. Storing it under `miles` (and labelling the unit 'mi')
               // put a 60%-inflated number on every single-leg order — harmless for pay, which
               // re-derives from the order, but wrong on every screen that reads the trip directly.
               miles: kmToMiles(order.totalDistance),
               totalDistance: kmToMiles(order.totalDistance),
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
         'route_crosses_border', 'route_countries', 'distance_source',
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

      // Same rule on edit as on create — see findNegativeMoney.
      const negatives = findNegativeMoney(updateData);
      if (negatives.length > 0) {
         return res.status(400).json({ status: false, code: 'negative_amount', message: negatives[0], problems: negatives });
      }

      // A stop cannot arrive before the stop it is picked up from.
      const badDates = findBackwardsDates(updateData.shipping_details);
      if (badDates.length > 0) {
         return res.status(400).json({ status: false, code: 'dates_backwards', message: badDates[0], problems: badDates });
      }

      // Changing the currency of an order that already holds typed amounts silently reinterprets
      // every one of them — CA$1,000 becomes US$1,000 with no conversion and no trace. The edit
      // form always echoes the saved currency back, so a change here is either a mistake or a
      // deliberate act that needs its own flow. Drop it and keep the order's own currency.
      if ('revenue_currency' in updateData) {
         const existing = await Order.findOne({ _id: req.params.id, tenantId })
            .select('input_currency revenue_currency input_total_amount').lean();
         const current = String(existing?.input_currency || existing?.revenue_currency || '').toLowerCase();
         const incoming = String(updateData.revenue_currency || '').toLowerCase();
         const hasTypedAmounts = Number(existing?.input_total_amount || 0) > 0;
         if (current && incoming && current !== incoming && hasTypedAmounts) {
            delete updateData.revenue_currency;
         }
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

      // Amounts in the body are the user's TYPED values, in the order's input currency. A caller that
      // echoes the whole order back (e.g. a screen that only meant to edit the stops) would send the
      // stored BASE amounts and the base `revenue_currency` instead — which this handler would then
      // re-stamp as "typed in USD" and re-convert, silently rewriting the order's money. Drop such an
      // echo: values byte-identical to what is already stored in base are not an edit.
      const storedInputCurrency = normalizeCurrency(
         existingOrder.input_currency || existingOrder.revenue_currency || BASE_ORDER_CURRENCY,
         BASE_ORDER_CURRENCY
      );
      const orderIsConverted = storedInputCurrency !== BASE_ORDER_CURRENCY;
      if (orderIsConverted) {
         const echoes = (bodyKey, baseKey) =>
            bodyKey in updateData && Number(updateData[bodyKey]) === Number(existingOrder[baseKey] || 0);
         if (
            normalizeCurrency(updateData.revenue_currency, storedInputCurrency) === BASE_ORDER_CURRENCY &&
            (echoes('total_amount', 'total_amount') || !('total_amount' in updateData))
         ) {
            delete updateData.revenue_currency;
            if (echoes('total_amount', 'total_amount')) delete updateData.total_amount;
            if (echoes('carrier_amount', 'carrier_amount')) delete updateData.carrier_amount;
            if (echoes('settle_amount', 'settle_amount')) delete updateData.settle_amount;
            delete updateData.revenue_items;
            delete updateData.carrier_revenue_items;
         }
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
      // A mixed-owner order is settled per trip, not from order.truck — recomputing the owner context
      // from the first trip's truck here would hand the whole settlement to one owner. Its owner
      // columns are re-derived from the trips after the update instead.
      if (nextOrderType === 'regular' && !existingOrder.isMixedOwner) {
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

      // A leg addresses its stops by POSITION (`start_stop_index` / `end_stop_index`). Editing the
      // order's stops used to leave those numbers untouched, so deleting a stop silently pointed a
      // leg at a different stop — or past the end, where `extractLocMeta` returns nothing and the
      // route reads blank. Prod carried two such legs (#1424, #1053).
      if ('shipping_details' in updateData) {
         await resyncTripStopIndexes(tenantId, order);
      }

      if (order.isMixedOwner) {
         // Revenue/settle may have changed — re-derive each owner leg's share from the trips.
         const { trips, truckMap } = await loadOrderTripsAndTrucks(tenantId, order._id);
         const fields = resolveOrderOwnerFields({ order: order.toObject(), trips, truckMap });
         order.isOwnerOperatedTruck = fields.isOwnerOperatedTruck;
         order.ownerOperator = fields.ownerOperator;
         order.ownerOperators = fields.ownerOperators;
         order.isMixedOwner = fields.isMixedOwner;
         order.settle_amount = fields.settle_amount;
         order.input_settle_amount = fields.input_settle_amount;
         order.owner_profit = fields.owner_profit;
         order.carrier_amount = fields.carrier_amount;
         await order.save();
      }
      if (order.isOwnerOperatedTruck) {
         await syncOwnerOperatorFinancialRecords({
            tenantId,
            companyId: req.user?.company?._id || req.user?.company || null,
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

/* ── Convert an order between regular and outsourcing ───────────────────────────
   A load booked on our own truck sometimes has to go to an outside carrier (or the reverse).
   `order_type` is deliberately NOT in ALLOWED_UPDATE_FIELDS — flipping it on its own would leave
   the old type's money and assignments behind: a carrier cost with no carrier, an owner settlement
   for a load we no longer run, driver pay for a trip that never happened.

   So conversion is its own endpoint with three parts:
     1. refuse when the order has already produced money or work that cannot be un-done,
     2. demand the new type's required fields up front,
     3. clear the old type's fields in the same write.                                        */

// Everything that makes an order un-convertible, checked together so the user gets the full list
// rather than one blocker at a time.
async function conversionBlockers(order, tenantId) {
   const blockers = [];
   if (order.lock) blockers.push('The order is locked. Unlock it first.');

   if (String(order.customer_payment_status || 'pending') !== 'pending') {
      blockers.push(`The customer payment is already "${order.customer_payment_status}".`);
   }
   if (order.order_type === 'outsourcing' && String(order.carrier_payment_status || 'pending') !== 'pending') {
      blockers.push(`The carrier payment is already "${order.carrier_payment_status}".`);
   }

   const [tripCount, settledRows, salaryRows] = await Promise.all([
      Trip.countDocuments({ tenantId, order: order._id, deletedAt: null }),
      OwnerOperatorFinancialRecord.countDocuments({
         tenantId, order: order._id, paymentStatus: { $ne: 'pending' },
      }),
      DriverSalary.countDocuments({ tenantId, 'orderBreakdown.order': order._id }),
   ]);
   // Every order is born with ONE default leg covering the whole route (see create_order), so a
   // single leg is not planning work — it is rewritten to the new type below. More than one means
   // a dispatcher built a real split, and converting would silently throw that away.
   if (tripCount > 1) {
      blockers.push(`This order is split into ${tripCount} legs. Merge them back to one in Trip Planning first.`);
   }
   if (settledRows > 0) {
      blockers.push('An owner operator has already been paid for this order.');
   }
   if (salaryRows > 0) {
      blockers.push('This order is already on a generated driver payslip.');
   }
   return blockers;
}

// Preflight: the modal asks this the moment it opens, so a dispatcher sees "this order cannot be
// converted, here is why" before filling anything in — not after pressing the button.
exports.convert_order_check = catchAsync(async (req, res) => {
   const tenantId = getTenantId(req);
   if (!tenantId) {
      return res.status(400).json({ status: false, message: 'Tenant context is required.' });
   }
   const criteria = { _id: req.params.id, tenantId };
   applyOrderOwnershipScope(req, criteria);
   const order = await Order.findOne(criteria).select(
      'order_type lock customer_payment_status carrier_payment_status serial_no'
   );
   if (!order) {
      return res.status(404).json({ status: false, message: 'Order not found.' });
   }

   const target = order.order_type === 'regular' ? 'outsourcing' : 'regular';
   const blockers = await conversionBlockers(order, tenantId);

   const allowed = Array.isArray(req.allowedOrderTypes) ? req.allowedOrderTypes : null;
   if (allowed && allowed.length > 0 && !allowed.includes(target)) {
      blockers.push(`Your plan or permissions do not include ${target} orders.`);
   }

   res.json({ status: true, from: order.order_type, target, canConvert: blockers.length === 0, blockers });
});

exports.convert_order_type = catchAsync(async (req, res) => {
   const tenantId = getTenantId(req);
   if (!tenantId) {
      return res.status(400).json({ status: false, message: 'Tenant context is required.' });
   }

   const target = String(req.body?.target || '').toLowerCase();
   if (!['regular', 'outsourcing'].includes(target)) {
      return res.status(400).json({ status: false, message: 'Choose either regular or outsourcing.' });
   }

   const criteria = { _id: req.params.id, tenantId };
   applyOrderOwnershipScope(req, criteria);
   const order = await Order.findOne(criteria);
   if (!order) {
      return res.status(404).json({ status: false, message: 'Order not found.' });
   }
   if (order.order_type === target) {
      return res.status(400).json({ status: false, message: `This order is already ${target}.` });
   }

   // The module the order is moving INTO has to be one this tenant and this user may use —
   // otherwise conversion becomes a way around the plan and the permission checks on create.
   const allowed = Array.isArray(req.allowedOrderTypes) ? req.allowedOrderTypes : null;
   if (allowed && allowed.length > 0 && !allowed.includes(target)) {
      return res.status(403).json({
         status: false,
         message: `Your plan or permissions do not include ${target} orders.`,
      });
   }

   const blockers = await conversionBlockers(order, tenantId);
   if (blockers.length > 0) {
      return res.status(400).json({ status: false, code: 'conversion_blocked', message: blockers[0], blockers });
   }

   // Amounts are typed in the order's own currency; store both the typed value and the base one,
   // exactly like create/update do. Never re-stamp the currency here.
   const fxToBase = Number(order.fx_to_usd || 1);
   const missing = [];
   const update = { order_type: target };

   if (target === 'outsourcing') {
      const carrier = req.body?.carrier;
      const items = Array.isArray(req.body?.carrier_revenue_items) ? req.body.carrier_revenue_items : [];
      // The carrier cost is the sum of its line items, exactly as on the add-order form; a bare
      // `carrier_amount` is accepted for callers that have no line items to give.
      const itemsTotal = items.reduce((sum, i) => sum + (Number(i?.rate) || 0) * (Number(i?.quantity) || 0), 0);
      const carrierAmount = itemsTotal > 0 ? itemsTotal : Number(req.body?.carrier_amount);

      // `carrier` and `carrier_amount` are required by the Order schema for an outsourcing order,
      // so these two stay mandatory here — everything else mirrors what add-order lets you skip.
      if (!carrier) missing.push('carrier');
      if (!Number.isFinite(carrierAmount) || carrierAmount <= 0) missing.push('carrier_amount');
      if (missing.length > 0) {
         return res.status(400).json({
            status: false, code: 'fields_required', missing,
            message: 'An outsourcing order needs a carrier and what the carrier is paid.',
         });
      }
      update.carrier = carrier;
      update.input_carrier_amount = carrierAmount;
      update.carrier_amount = convertToBase(carrierAmount, fxToBase);
      // Line item rates are stored in base currency, the same as revenue_items on create/update.
      update.carrier_revenue_items = normalizeRevenueItemsToBase(items, fxToBase);

      // Drop everything that only means something on our own truck.
      Object.assign(update, {
         truck: null, trailer: null, driver: null, drivers: [],
         isOwnerOperatedTruck: false, ownerOperator: null, ownerOperators: [], isMixedOwner: false,
         settle_amount: 0, input_settle_amount: 0, owner_profit: 0,
         driver_assignment_mode: 'company_driver',
      });
   } else {
      // Nothing here is mandatory — the add-order form lets a fleet order be saved with no truck,
      // no driver and no settle amount, and conversion must not be stricter than creation. The
      // "needs attention" panel is what surfaces an order still missing them.
      const truckId = req.body?.truck || null;
      const driverList = Array.isArray(req.body?.drivers) ? req.body.drivers.filter(Boolean) : [];
      const primaryDriver = req.body?.driver || driverList[0] || null;

      const truck = truckId
         ? await Truck.findOne({ _id: truckId, tenantId }).select('ownerOperated ownerOperator').lean()
         : null;
      if (truckId && !truck) {
         return res.status(400).json({ status: false, message: 'That truck was not found for this tenant.' });
      }

      const ownerOperated = !!(truck?.ownerOperated && truck?.ownerOperator);
      const settleAmount = Number(req.body?.settle_amount);

      const drivers = driverList.length > 0 ? driverList : (primaryDriver ? [primaryDriver] : []);
      update.truck = truckId;
      update.trailer = req.body?.trailer || null;
      update.driver = primaryDriver;
      update.drivers = drivers;
      update.isOwnerOperatedTruck = ownerOperated;
      update.ownerOperator = ownerOperated ? truck.ownerOperator : null;
      update.ownerOperators = ownerOperated ? [truck.ownerOperator] : [];
      update.isMixedOwner = false;
      // A settle amount only means anything on an owner's truck, and may be left blank for now.
      const settle = ownerOperated && Number.isFinite(settleAmount) && settleAmount > 0 ? settleAmount : 0;
      update.input_settle_amount = settle;
      update.settle_amount = convertToBase(settle, fxToBase);
      update.owner_profit = ownerOperated
         ? Number(order.total_amount || 0) - Number(update.settle_amount || 0)
         : 0;
      update.driver_assignment_mode = ownerOperated && !primaryDriver ? 'owner_driver' : 'company_driver';

      // Drop everything that only means something when an outside carrier runs the load.
      Object.assign(update, {
         carrier: null, carrier_amount: 0, input_carrier_amount: 0, carrier_revenue_items: [],
         carrier_payment_status: 'pending', carrier_payment_date: null, carrier_payment_method: null,
      });
   }

   const saved = await Order.findOneAndUpdate(criteria, update, { new: true, runValidators: true });

   // The order's single default leg still describes the old type — point it at the new one, the
   // same way create_order would have built it. (A real multi-leg split was blocked above.)
   await Trip.updateMany(
      { tenantId, order: order._id, deletedAt: null },
      target === 'outsourcing'
         ? { carrier: update.carrier, truck: null, trailer: null, driver: null, drivers: [], rate_per_mile: 0, total_driver_pay: 0, settle_amount: null }
         : { carrier: null, truck: update.truck, trailer: update.trailer, driver: update.driver, drivers: update.drivers }
   );

   // Settlement ledger rows belong to the type we just left.
   await OwnerOperatorFinancialRecord.deleteMany({ tenantId, order: order._id });

   logActivity(req, {
      action: 'UPDATE',
      module: 'order',
      description: `Converted order #${order.serial_no} from ${order.order_type} to ${target}`,
      resourceId: order._id,
      resourceName: `#${order.serial_no}`,
      details: { from: order.order_type, to: target },
   });

   res.json({ status: true, order: saved, message: `Order is now ${target}.` });
});

/* ── Orders that need attention ─────────────────────────────────────────────────
   One place that answers "which orders are not finished, and what is wrong with them".
   Every rule below is something a human has to fix — nothing here is derivable, and nothing
   here is a style preference. Levels: 'error' = the order's money is wrong or missing,
   'warn' = it is incomplete, 'info' = it has been sitting too long.

   Deliberately NOT flagged: an owner-operated leg with no driver of ours (the owner's own
   driver runs it — see the Trip Planning notes), and a stop that is a relay marker.        */
const ATTENTION_RULES = [
   // Route — these feed distance, which feeds driver pay → owner settlement → truck gross
   { code: 'blank_stop', group: 'data', level: 'error', label: 'Stop has no address',
     test: (o) => (o.shipping_details || []).some((b) => (b.locations || []).some((l) =>
        (l?.type || l?.location_type) !== 'relay' && !String(l?.location || l?.address || '').trim())) },
   { code: 'no_distance', group: 'data', level: 'error', label: 'No distance',
     test: (o) => Number(o.totalDistance || 0) <= 0 },

   // Money
   { code: 'no_revenue', group: 'data', level: 'error', label: 'No customer amount',
     test: (o) => Number(o.total_amount || 0) <= 0 && Number(o.input_total_amount || 0) <= 0 },
   { code: 'owner_no_settle', group: 'data', level: 'error', label: 'Owner truck, nothing to settle',
     test: (o) => o.order_type === 'regular' && o.isOwnerOperatedTruck
        && Number(o.settle_amount || 0) <= 0 && Number(o.input_settle_amount || 0) <= 0 },
   { code: 'carrier_no_cost', group: 'data', level: 'warn', label: 'No carrier cost',
     test: (o) => o.order_type === 'outsourcing' && Number(o.carrier_amount || 0) <= 0 },
   { code: 'loss_making', group: 'data', level: 'warn', label: 'Cost above revenue',
     test: (o) => o.order_type === 'outsourcing'
        && Number(o.carrier_amount || 0) > 0 && Number(o.total_amount || 0) > 0
        && Number(o.carrier_amount) > Number(o.total_amount) },

   // Assignment
   { code: 'no_carrier', group: 'data', level: 'error', label: 'No carrier',
     test: (o) => o.order_type === 'outsourcing' && !o.carrier },
   { code: 'no_truck', group: 'data', level: 'warn', label: 'No truck',
     test: (o) => o.order_type === 'regular' && !o.truck },
   { code: 'no_driver', group: 'data', level: 'warn', label: 'No driver',
     test: (o) => o.order_type === 'regular' && !o.isOwnerOperatedTruck
        && !o.driver && !(Array.isArray(o.drivers) && o.drivers.length > 0) },

   // Paperwork and ageing — `_docCount` and `_ageDays` are stamped on the row before testing
   { code: 'no_documents', group: 'followup', level: 'warn', label: 'No documents',
     test: (o) => Number(o._docCount || 0) === 0 },
   { code: 'customer_unpaid', group: 'followup', level: 'warn', label: 'Customer not paid',
     test: (o) => o._ageDays > 30 && String(o.customer_payment_status || 'pending') === 'pending' },
   { code: 'carrier_unpaid', group: 'followup', level: 'warn', label: 'Carrier not paid',
     test: (o) => o.order_type === 'outsourcing' && o._ageDays > 30
        && String(o.carrier_payment_status || 'pending') === 'pending' },
   { code: 'stale_status', group: 'followup', level: 'info', label: 'Still "added"',
     test: (o) => o._ageDays > 30 && String(o.order_status || 'added') === 'added' },
];

exports.orders_needing_attention = catchAsync(async (req, res) => {
   const tenantId = getTenantId(req);
   if (!tenantId) {
      return res.status(400).json({ status: false, message: 'Tenant context is required.' });
   }

   const criteria = {
      tenantId,
      $or: [{ deletedAt: null }, { deletedAt: '' }, { deletedAt: { $exists: false } }],
   };
   if (Array.isArray(req.allowedOrderTypes) && req.allowedOrderTypes.length > 0) {
      criteria.order_type = { $in: req.allowedOrderTypes };
   }
   applyOrderOwnershipScope(req, criteria);
   const companyId = normalizeCompanyId(req);
   if (companyId) {
      criteria.$and = (criteria.$and || []).concat([{
         $or: [{ company: companyId }, { company: null }, { company: { $exists: false } }],
      }]);
   }

   const orders = await Order.find(criteria)
      .select('serial_no order_type customer carrier createdAt totalDistance total_amount input_total_amount '
         + 'settle_amount input_settle_amount carrier_amount input_currency revenue_currency isOwnerOperatedTruck '
         + 'driver drivers truck order_status customer_payment_status carrier_payment_status shipping_details created_by')
      .populate('customer', 'name')
      .populate('created_by', 'name')
      .sort({ createdAt: -1 })
      .lean();

   // One grouped query for the file counts — never a lookup per order.
   const ids = orders.map((o) => o._id);
   const docCounts = new Map();
   if (ids.length > 0) {
      const grouped = await Files.aggregate([
         { $match: { order: { $in: ids } } },
         { $group: { _id: '$order', n: { $sum: 1 } } },
      ]);
      grouped.forEach((g) => docCounts.set(String(g._id), g.n));
   }

   const now = Date.now();
   const counts = {};
   const flagged = [];
   orders.forEach((o) => {
      o._docCount = docCounts.get(String(o._id)) || 0;
      o._ageDays = Math.floor((now - new Date(o.createdAt || now).getTime()) / 86400000);
      const issues = ATTENTION_RULES.filter((r) => {
         try { return r.test(o); } catch { return false; }
      }).map(({ code, group, level, label }) => ({ code, group, level, label }));
      if (issues.length === 0) return;
      issues.forEach((i) => { counts[i.code] = (counts[i.code] || 0) + 1; });
      flagged.push({
         _id: o._id,
         serial_no: o.serial_no,
         order_type: o.order_type,
         customer: o.customer?.name || '',
         created_by: o.created_by?.name || '',
         createdAt: o.createdAt,
         ageDays: o._ageDays,
         totalDistance: Number(o.totalDistance || 0),
         amount: Number(o.input_total_amount || 0) || Number(o.total_amount || 0),
         currency: String(o.input_currency || o.revenue_currency || 'usd').toUpperCase(),
         issues,
      });
   });

   // Worst first: blockers, then how many things are wrong, then oldest.
   const rank = (row) => (row.issues.some((i) => i.level === 'error') ? 0 : row.issues.some((i) => i.level === 'warn') ? 1 : 2);
   flagged.sort((a, b) => rank(a) - rank(b) || b.issues.length - a.issues.length || new Date(a.createdAt) - new Date(b.createdAt));

   // `data` issues are wrong or missing information — someone must go and fix them.
   // `followup` issues (no documents, unpaid, still "added") are ordinary business state on most
   // orders; counting them in the headline made 691 of 691 orders "need attention", which is the
   // same as flagging none. They ship in the payload but the banner only counts the data group.
   const needsFixing = flagged.filter((f) => f.issues.some((i) => i.group === 'data'));

   res.json({
      status: true,
      total: needsFixing.length,
      followupTotal: flagged.length - needsFixing.length,
      scanned: orders.length,
      errors: needsFixing.filter((f) => f.issues.some((i) => i.level === 'error')).length,
      counts,
      orders: flagged,
   });
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

   applyOrderSearch(queryObj, search);

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
            const companyDoc = await Company.findOne({ _id: companyId, tenantId: req.tenantId || req.user?.tenantId }).select('logo_base64 pdf_logo logo').lean();
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
                  await Company.findOneAndUpdate({ _id: companyId, tenantId: req.tenantId || req.user?.tenantId }, { logo_base64: base64Logo });
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
            tr, thead, tbody, .no-break, .avoid-break {
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
      applyOrderSearch(queryObj, search);

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

   // Calculate total profit and revenue.
   // Money is summed in the display currency, converted ONCE from each order's exact typed
   // amount — never from the USD base column, which would round-trip and drift off the order card.
   const displayCurrency = resolveDisplayCurrency(req, BASE_ORDER_CURRENCY);
   const fx = createOrderFxConverter(overviewTenantId, displayCurrency);

   const moneyFields = 'total_amount carrier_amount settle_amount order_type isOwnerOperatedTruck created_by createdAt input_currency revenue_currency input_total_amount input_carrier_amount input_settle_amount';
   const allOrdersForProfit = await Order.find(queryFilter)
         .select(moneyFields)
         .populate({ path: 'created_by', select: 'staff_commision' })
         .lean();

   await fx.prime(allOrdersForProfit.map((o) => o.createdAt));

   let totalProfit = 0;
   let totalRevenue = 0;
   allOrdersForProfit.forEach(o => {
      const money = orderMoneyIn(o, fx);
      totalProfit += money.profit;
      totalRevenue += money.revenue;
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
         .select(moneyFields)
         .populate({ path: 'created_by', select: 'staff_commision' })
         .lean();

      await fx.prime(monthlyOrders.map((o) => o.createdAt));

      let monthlyRevenue = 0;
      let monthlyProfit = 0;
      monthlyOrders.forEach(o => {
         const money = orderMoneyIn(o, fx);
         monthlyRevenue += money.revenue;
         monthlyProfit += money.profit;
      });

      const monthName = startOfMonth.toLocaleString('default', { month: 'short' });
      chartData.push({
         name: monthName,
         loads: monthlyOrders.length,
         revenue: monthlyRevenue,
         profit: monthlyProfit
      });
   }

   // Amounts are already in this currency — the frontend renders them as-is (rate 1).
   const baseCurrency = displayCurrency;

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
   const tenantIdCtx = req.tenantId || req.user?.tenantId;
   if (!tenantIdCtx) {
      return res.status(400).json({ status: false, orders: null, message: 'Tenant context missing.' });
   }
   const criteria = {
      _id: id,
      tenantId: tenantIdCtx,
      $or: [
         { deletedAt: null },
         { deletedAt: '' },
         { deletedAt: { $exists: false } }
      ]
   };
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
   const deletedAt = Date.now();
   order.deletedAt = deletedAt;
   await order.save();

   // A deleted order's legs used to stay alive: they still carried a driver, miles and a rate, so
   // driver logs, trip aggregates and driver pay kept counting a load that was cancelled. Prod had
   // 15 such legs holding 2,216 miles. The files go with them — nothing should hang off a deleted
   // order. (Soft delete, like everything else here, so a mistaken delete stays recoverable.)
   const [legs, files] = await Promise.all([
      Trip.updateMany({ tenantId, order: order._id, deletedAt: null }, { deletedAt }),
      Files.updateMany({ order: order._id, deletedAt: null }, { deletedAt }),
   ]);

   logActivity(req, {
      action: 'DELETE',
      module: 'order',
      details: { legsRemoved: legs.modifiedCount, filesRemoved: files.modifiedCount },
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
   applyOrderSearch(queryObj, search);

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

   applyOrderSearch(queryObj, search);

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



 



 
