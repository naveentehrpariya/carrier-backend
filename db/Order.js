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
    carrier: { 
        type: mongoose.Schema.Types.ObjectId, ref: 'carriers',
        required:[function() { 
            const type = this.order_type;
            return type === 'outsourcing';
        }, 'Please enter carrier details.'],
    }, 
    carrier_amount:  {
        type:Number,
        required:[function() { 
            const type = this.order_type;
            return type === 'outsourcing';
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

 
