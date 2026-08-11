const mongoose = require('mongoose');
const { KM_PER_MI } = require('../utils/distance');

const tripSchema = new mongoose.Schema({
    tenantId: { 
        type: String, 
        required: true, 
        index: true
    },
    order: { type: mongoose.Schema.Types.ObjectId, ref: 'orders', required: true, index: true },
    trip_no: { type: Number, required: true },
    
    // Selection range from order.locations
    start_stop_index: { type: Number, required: true },
    end_stop_index: { type: Number, required: true },
    
    // Assets for this specific segment/trip
    driver: { type: mongoose.Schema.Types.ObjectId, ref: 'users' },
    drivers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'users' }],
    truck: { type: mongoose.Schema.Types.ObjectId, ref: 'trucks' },
    trailer: { type: mongoose.Schema.Types.ObjectId, ref: 'trailers' },
    carrier: { type: mongoose.Schema.Types.ObjectId, ref: 'carriers' },
    
    // Locations for this segment
    start_location: { type: String },
    end_location: { type: String },
    
    // Distance and Pay
    miles: { type: Number, default: 0 },
    totalDistance: { type: Number, default: 0 }, // canonical trip distance
    total_km: { type: Number, default: 0 }, // convenience in kilometers
    distance_unit: { type: String, enum: ['mi', 'km'], default: 'mi' },
    rate_per_mile: { type: Number, default: 0 }, // Decided rate for this driver at time of split
    total_driver_pay: { type: Number, default: 0 },
    // Currency of rate_per_mile / total_driver_pay — snapshotted from the driver's locked
    // DriverProfile.rateCurrency at split time. One pay currency per trip is enforced in
    // splitOrder, so a single code is enough. Legacy trips have none and read as USD.
    rate_currency: { type: String, enum: ['USD', 'CAD', 'INR'], default: 'USD', uppercase: true },

    // Owner-operator settlement for this leg, typed by the admin in the ORDER's input currency.
    // null = derive it from the order's settle amount by miles share (see utils/ownerSettlement.js).
    settle_amount: { type: Number, default: null },
    
    status: {
        type: String,
        enum: ['planned', 'started', 'en-route', 'delivered', 'cancelled'],
        default: 'planned'
    },
    
    notes: { type: String },
    instructions: { type: String },
    
    created_by: { type: mongoose.Schema.Types.ObjectId, ref: 'users' },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
    deletedAt: { type: Date, default: null }
}, {
    toJSON: { virtuals: true },
    toObject: { virtuals: true }
});

// Calculate driver pay before saving
tripSchema.pre('save', function(next) {
    const miles = Number(this.miles || 0);
    // Keep canonical totalDistance in same unit as order (miles by default)
    if (!this.totalDistance || this.totalDistance === 0) {
        this.totalDistance = miles;
    }
    // Compute kilometers
    this.total_km = Number(this.totalDistance || miles) * KM_PER_MI;
    // Driver pay based on miles rate
    this.total_driver_pay = miles * Number(this.rate_per_mile || 0);
    this.updatedAt = Date.now();
    next();
});

// `total_km` and `total_driver_pay` are derived columns, and the hook above only fires on .save().
// Every update path that goes through the query API (updateTrip's findOneAndUpdate, migrations,
// any future patch) skipped it, so a trip whose miles or rate changed kept the OLD pay — which is
// what Order View prints. Recompute here too, from the merged (update ∪ stored) values.
async function recomputeDerived(next) {
    try {
        const update = this.getUpdate();
        if (!update) return next();
        const target = update.$set ? update.$set : update;
        const touched = ['miles', 'totalDistance', 'rate_per_mile'].some((k) => k in target);
        if (!touched) return next();

        const current = await this.model.findOne(this.getQuery())
            .select('miles totalDistance rate_per_mile').lean();
        const miles = Number(target.miles ?? current?.miles ?? 0) || 0;
        const distance = Number(target.totalDistance ?? current?.totalDistance ?? 0) || miles;
        const rate = Number(target.rate_per_mile ?? current?.rate_per_mile ?? 0) || 0;

        target.total_km = distance * KM_PER_MI;
        target.total_driver_pay = miles * rate;
        this.setUpdate(update);
        next();
    } catch (err) {
        next(err);
    }
}
// Not registered for updateMany: one recomputed value cannot be correct for many different docs.
tripSchema.pre('findOneAndUpdate', recomputeDerived);
tripSchema.pre('updateOne', recomputeDerived);

const Trip = mongoose.model('trips', tripSchema);
module.exports = Trip;
