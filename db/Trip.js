const mongoose = require('mongoose');

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
    this.total_km = Number(this.totalDistance || miles) * 1.60934;
    // Driver pay based on miles rate
    this.total_driver_pay = miles * Number(this.rate_per_mile || 0);
    this.updatedAt = Date.now();
    next();
});

const Trip = mongoose.model('trips', tripSchema);
module.exports = Trip;
