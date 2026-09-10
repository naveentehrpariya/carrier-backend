const { default: mongoose } = require('mongoose');
const mongo = require('mongoose'); 
const schema = new mongo.Schema({
    customer_order_no:  {
        type: String,
        trim: true,
        default: null,
        index: true
    },
    tenantId: { 
        type: String, 
        required: true, 
        index: true,
    },
    company: { type: mongoose.Schema.Types.ObjectId, ref: 'companies' },
    company_name:{ 
        type:String,
        required:true,
    },
    serial_no:  {
        type: Number,
        min: 0,
    },
    shipping_details : [],
    
    // Customer
    customer: { 
        type: mongoose.Schema.Types.ObjectId, ref: 'customers',
        required:[true, 'Please enter customer details.'],
    },
    order_type: {
        type: String,
        enum: ['outsourcing', 'regular'],
        default: 'outsourcing',
        index: true
    },
    driver: { type: mongoose.Schema.Types.ObjectId, ref: 'users' },
    drivers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'users' }],
    truck: { type: mongoose.Schema.Types.ObjectId, ref: 'trucks' },
    trailer: { type: mongoose.Schema.Types.ObjectId, ref: 'trailers' },
    ownerOperator: { type: mongoose.Schema.Types.ObjectId, ref: 'owneroperators', default: null, index: true },
    // Split across more than one settlement party (two owner operators, or an owner + a company
    // truck). Settlement is then per trip: `ownerOperator` is null and `ownerOperators` lists every
    // owner with a leg on this order.
    isMixedOwner: { type: Boolean, default: false, index: true },
    // WHO GETS PAID, read from the legs — see utils/orderParty.js.
    // `order_type` above is no longer typed in by a dispatcher; it is a stamped reading of these.
    // A mixed order (a carrier leg AND a fleet leg) is stamped `regular` and flagged here, because
    // `regular` is the branch that does not assume a single carrier owning the whole order.
    // Subset of ['company','owner','carrier'], always in that order.
    order_parties: { type: [String], default: [], index: true },
    isMixedType: { type: Boolean, default: false, index: true },
    // Every outside carrier with a leg on this order. `carrier` below stays a single id ONLY while
    // there is exactly one; with several it is null and this is the list — the same convention
    // `ownerOperator` / `ownerOperators` already uses.
    carriers: { type: [mongoose.Schema.Types.ObjectId], ref: 'carriers', default: [], index: true },
    // (There is deliberately no `isMixedCarrier` column. "More than one carrier" is
    //  `carriers.length > 1` — the same document already says it, so storing it again is one more
    //  thing that can disagree with the legs. Read it with orderParty.hasMultipleCarriers(order);
    //  query it as { 'carriers.1': { $exists: true } }.)

    // THE ORDER'S TOTAL OUTSIDE COST — what leaves the company for this load, whoever it goes to:
    // the carrier legs plus the owner-operator settlement. `carrier_amount` below is the carrier
    // share alone and `settle_amount` the owner share alone; on an order with only one kind of leg
    // this equals the one that applies, which is exactly what every existing report already reads,
    // so pointing a reader here changes nothing for legacy data and fixes it for a mixed order.
    // `cost_amount` is base currency; `input_cost_amount` is the currency it was typed in.
    cost_amount: { type: Number, default: 0 },
    input_cost_amount: { type: Number, default: 0 },
    // Share of the route (by miles) that outside carriers run, 0..1. Only meaningful on a mixed
    // order, where staff commission is earned on the brokered part of the revenue alone.
    carrier_ratio: { type: Number, default: 0 },
    ownerOperators: [{ type: mongoose.Schema.Types.ObjectId, ref: 'owneroperators' }],
    isOwnerOperatedTruck: { type: Boolean, default: false, index: true },
    settle_amount: { type: Number, default: 0 },
    owner_profit: { type: Number, default: 0 },
    driver_assignment_mode: {
        type: String,
        enum: ['company_driver', 'owner_driver'],
        default: 'company_driver'
    },
    driver_assignment_status: {
        type: String,
        default: 'company_driver_assigned'
    },
    total_amount: {
        type:Number,
        required:[true, 'Please enter total amount of this order.'],
    },
    lock : {
        type: Boolean,
        default: false
    },
    // CUSTOMER PAYEMENTS
    customer_payment_status : {
        type: String,
        default: 'pending'
    },
    customer_payment_approved_by_admin : {
        type: Number,
        default: 0 // 0 not approved, 1 approved, 2 rejected
    },
    customer_payment_date :{
        type: Date
    },
    customer_payment_method :{
        type: String,
    },
    customer_payment_updated_by :{
        type: mongoose.Schema.Types.ObjectId, ref: 'users',
    },
    // CARRIER PAYMENTS
    carrier_payment_status : {
        type: String,
        default: 'pending'
    },
    carrier_payment_approved_by_admin : {
        type: Number,
        default: 0 // 0 not approved, 1 approved, 2 rejected
    },
    carrier_payment_date :{
        type: Date
    },
    carrier_payment_method :{
        type: String
    },
    carrier_payment_updated_by :{
        type: mongoose.Schema.Types.ObjectId, ref: 'users',
    },
    // Carrier
    // An order split across TWO carriers has no single carrier: `carrier` is null and `carriers`
    // above holds the list. Requiring the single column would then reject the save outright — the
    // order is perfectly well described, just not by one id. Same convention, and the same fix, as
    // `ownerOperator` / `ownerOperators` on a mixed-owner order.
    carrier: { 
        type: mongoose.Schema.Types.ObjectId, ref: 'carriers',
        required:[function() { 
            const type = this.order_type;
            if (type !== 'outsourcing') return false;
            return !(Array.isArray(this.carriers) && this.carriers.length > 0);
        }, 'Please enter carrier details.'],
    }, 
    carrier_amount:  {
        type:Number,
        required:[function() { 
            const type = this.order_type;
            if (type !== 'outsourcing') return false;
            return !(Array.isArray(this.carriers) && this.carriers.length > 0);
        }, 'Please enter carrier amount.'],
    },
    totalDistance : { 
        type: Number,
        // required:[true, 'Please enter total distance of this order.'],
    },
    totalDistanceInKM : {
        type: Number,
        // required:[true, 'Please enter total distance of this order.'],
    },
    // Assumptions behind totalDistance. A bare number could not be audited — that is how an
    // AB -> ON order ended up storing a route through North Dakota (133 mi short) without anyone
    // noticing until the client counted the miles.
    route_crosses_border: { type: Boolean, default: false },
    route_countries: { type: [String], default: [] },      // e.g. ['CA'] or ['CA','US']
    distance_source: {
        type: String,
        enum: ['auto_fastest', 'auto_domestic', 'auto_corridor', 'auto_selected', 'manual'],
        default: 'auto_fastest',
    },
    // WHICH road the distance is for. "2,258 km" alone cannot be compared with what the client sees
    // in Google Maps — Google returns two or three routes per lane and names each one, and the whole
    // "your number disagrees with mine" class of dispute is really "we are looking at different
    // roads". Storing the name makes that answerable from the order itself.
    route_summary: { type: String, default: '' },          // e.g. 'Trans-Canada Hwy'
    route_polyline: { type: String, default: '' },         // Google encoded overview, for the map
    route_duration_sec: { type: Number, default: 0 },
    // The options that were on screen when this one was picked — what was NOT chosen is the other
    // half of the evidence.
    route_options: {
        type: [{
            _id: false,
            summary: String,
            km: Number,
            miles: Number,
            durationSeconds: Number,
            crossesBorder: Boolean,
        }],
        default: [],
    },
    revenue_items: [],
    carrier_revenue_items: [],
    revenue_currency:{
       type: String,
       default:"usd",
    },
    amount_currency: {
        type: String,
        default: "usd",
    },
    input_currency: {
        type: String,
        default: "usd",
    },
    fx_to_usd: {
        type: Number,
        default: 1,
    },
    input_total_amount: {
        type: Number,
        default: 0,
    },
    input_carrier_amount: {
        type: Number,
        default: 0,
    },
    input_settle_amount: {
        type: Number,
        default: 0,
    },
    order_status :{
        type: String,
        default:"added",
    },
    // Notes
    notes : {
        type: String,
    },
    carrier_payment_notes : { 
        type: String
    },
    customer_payment_notes : { 
        type: String
    },
    created_by: { type: mongoose.Schema.Types.ObjectId, ref: 'users' },
    createdAt: {
        type: Date,
        default: Date.now   // function reference, not invocation — evaluated per-document
    },
    deletedAt: {
        type: Date,
    },
    updatedAt: {
        type: Date,
    },
},{
    toJSON: { virtuals: true },
    toObject: { virtuals: true }
}); 

// schema.pre(/^find/, function (next) {
//     this.find({ deletedAt: { $exists: false } });
//     next();
// });

schema.query.notDeleted = function () {
  return this.where({ deletedAt: { $exists: false } });
};


// schema.virtual('gross_amount').get(function () {
//     const items = this.revenue_items || [];
//     let grossAmount = 0;
//     items.forEach(item => {
//         grossAmount += Number(item.value);
//     });
//     return grossAmount;
// });

schema.virtual('commission').get(function () {
    const totalAmount = this.total_amount || 0;
    // MIXED ORDER — part brokered to a carrier, part run on our own equipment.
    // Commission is earned on brokered work only: it is the margin between what the customer pays
    // and what an outside carrier is paid. A leg we ran ourselves has no broker margin, so only the
    // revenue attributable to the carrier legs counts. `carrier_ratio` is those legs' share of the
    // route, which is the same basis the owner side uses to attribute revenue to a leg.
    // Deliberately placed BEFORE the branches below so that every existing (non-mixed) order keeps
    // taking exactly the path it always took, to the cent.
    if (this.isMixedType) {
        const staffRate = this.created_by?.staff_commision || 0;
        if (staffRate <= 0) return 0;
        const ratio = Math.min(Math.max(Number(this.carrier_ratio || 0), 0), 1);
        if (ratio <= 0) return 0;
        const brokeredRevenue = totalAmount * ratio;
        const netBrokered = brokeredRevenue - (this.carrier_amount || 0);
        return netBrokered * (staffRate / 100);
    }
    if (this.order_type !== 'outsourcing') return 0;
    const staffCommissionRate = this.created_by?.staff_commision || 0;
    // Commission is calculated on net profit (customer rate - carrier cost), not the total.
    const carrierAmount = this.carrier_amount || 0;
    const netProfit = totalAmount - carrierAmount;
    return netProfit * (staffCommissionRate / 100);
});

schema.virtual('customer_final_payment_status').get(function () {
    return this.customer_payment_status
});

schema.virtual('carrier_final_payment_status').get(function () {
    return this.carrier_payment_status
});

schema.virtual('profit').get(function () {
    const totalAmount = this.total_amount || 0;
    // MIXED ORDER — the cost is no longer whichever single column the type points at. It is what
    // every leg's party is owed: the carrier legs plus the owner settlement, which is exactly what
    // `cost_amount` holds (utils/orderCost.js). As above, this branch is first so no existing order
    // changes its arithmetic.
    if (this.isMixedType) {
        return totalAmount - Number(this.cost_amount || 0) - Number(this.commission || 0);
    }
    const isOutsourcing = this.order_type === 'outsourcing';
    const isOwnerOperated = this.order_type === 'regular' && this.isOwnerOperatedTruck;
    if (isOwnerOperated) {
        const settleAmount = Number(this.settle_amount || 0);
        return totalAmount - settleAmount;
    }
    const carrierAmount = isOutsourcing ? (this.carrier_amount || 0) : 0;
    const staffCommissionRate = isOutsourcing ? (this.created_by?.staff_commision || 0) : 0;
    // Net profit = customer rate - carrier cost. Commission comes out of that net profit.
    const netProfit = totalAmount - carrierAmount;
    const commission = netProfit * (staffCommissionRate / 100);
    const profit = netProfit - commission;
    return profit;
});

// Count of documents/files attached to this order
// Uses Mongoose virtual populate count for efficient aggregation
schema.virtual('documents_count', {
    ref: 'files',
    localField: '_id',
    foreignField: 'order',
    count: true
});

// Compound indexes for multi-tenant performance
schema.index({ tenantId: 1, serial_no: 1 }, { unique: true });
schema.index({ tenantId: 1, createdAt: -1 });
schema.index({ tenantId: 1, customer: 1 });
schema.index({ tenantId: 1, carrier: 1 });
schema.index({ tenantId: 1, order_status: 1 });
schema.index({ tenantId: 1, customer_payment_status: 1 });
schema.index({ tenantId: 1, carrier_payment_status: 1 });
schema.index({ tenantId: 1, ownerOperator: 1, createdAt: -1 });
schema.index({ tenantId: 1, ownerOperators: 1, createdAt: -1 });
schema.index({ tenantId: 1, isOwnerOperatedTruck: 1, createdAt: -1 });


module.exports = mongo.model('orders', schema);

 
