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
   user: { type: mongoose.Schema.Types.ObjectId, ref: 'users' },
   added_by: { type: mongoose.Schema.Types.ObjectId, ref: 'users' },
   createdAt: {
      type: Date,
      default: Date.now     
   },
   deletedAt: {
      type: Date,
      default: null   
   },
});


const EmployeeDoc = mongoose.model('employee_docs', schema);
module.exports = EmployeeDoc;
