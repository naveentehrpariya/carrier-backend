const mongoose = require('mongoose');
const schema = new mongoose.Schema({
   tenantId: { 
      type: String, 
      required: true, 
      index: true,
   },
   name: { type:String },
   mime: {
      type:String,
   },
   size: { type:String },
   filename: { type:String },
   url: { type:String },
   // Typed document metadata — a doc can exist with no file at all (manual entry).
   docType: { type: String, enum: ['license', 'rc', 'insurance', 'permit', 'fitness', 'puc', 'pan', 'aadhaar', 'voter_id', 'passport', 'w9', 'authority', 'coi', 'agreement', 'noa', 'credit_app', 'tax_exempt', 'other', null], default: null },
   docTypeLabel: { type: String, default: null },
   docNumber: { type: String, default: null },
   // See FleetDoc.docFields — same contract, whitelisted by docController.
   docFields: { type: mongoose.Schema.Types.Mixed, default: null },
   issueDate: { type: Date, default: null },
   expiryDate: { type: Date, default: null },
   user: { type: mongoose.Schema.Types.ObjectId, ref: 'users' },
   added_by: { type: mongoose.Schema.Types.ObjectId, ref: 'users' },
   updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'users', default: null },
   updatedAt: { type: Date, default: null },
   createdAt: {
      type: Date,
      default: Date.now     
   },
   deletedAt: {
      type: Date,
      default: null   
   },
});


schema.index({ tenantId: 1, expiryDate: 1 });
schema.index({ tenantId: 1, user: 1, createdAt: -1 });

const EmployeeDoc = mongoose.model('employee_docs', schema);
module.exports = EmployeeDoc;
