const mongoose = require('mongoose');
const schema = new mongoose.Schema({
   // user: { 
   //    type: mongoose.Schema.Types.ObjectId, ref: 'users'
   // },
   
   tenantId: { 
      type: String, 
      required: true, 
      unique: true,
      index: true,
   },
   company_slug: {
      type:String,
   },
   order_prefix: {
      type: String,
      trim: true,
      uppercase: true,
      maxlength: 6,
      default: null,
   },
   logo: {
      type:String,
   },
   pdf_logo: {
      type: String,
   },
   logo_base64: {
      type: String,
   },
   name: { 
      type:String,
      required:[true, 'Please enter company name.']
   },
   email: { 
      type:String,
      required:[true, 'Please enter company email address.'],
   },
   phone: { 
      type:String,
      required:[true, 'Please enter company contact number.'],
   },
   address: { 
      type:String,
      required:[true, 'Please enter company address.'],
   },
   bank_name: {
      type: String,
   },
   account_name: {
      type: String,
   },
   account_number: {
      type: String,
   },
   routing_number: {
      type: String,
   },
   remittance_primary_email: {
      type: String,
      default: null
   },
   remittance_secondary_email: {
      type: String,
      default: null
   },
   rate_confirmation_terms: {
      type: String,
      default: `Carrier is responsible to confirm the actual weight and count received from the shipper before transit.

Additional fees such as loading/unloading, pallet exchange, etc., are included in the agreed rate.

POD must be submitted within 5 days of delivery.

Freight charges include $100 for MacroPoint tracking. Non-compliance may lead to deduction.

Cross-border shipments require custom stamps or deductions may apply.`
   },
   createdAt: {
       type: Date,
       default: Date.now
   }
});

const Company = mongoose.model('companies', schema);
module.exports = Company;

 
