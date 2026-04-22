const mongoose = require('mongoose');
const schema = new mongoose.Schema({
      tenantId: { 
         type: String, 
         required: true, 
         index: true,
      },
      company: { type: mongoose.Schema.Types.ObjectId, ref: 'companies' },
      order: { 
           type: mongoose.Schema.Types.ObjectId, ref: 'orders',
      },
      status: { 
           type: String,
      },
      method: { 
           type: String,
      },
      type : {
         type : String,
      },
      approval : {
         type : String,
      },
      updated_by: { 
         type: mongoose.Schema.Types.ObjectId, ref: 'users',
      },
      createdAt: {
         type: Date,
         default: Date.now()     
      },
});
const PaymentLogs = mongoose.model('paymentlogs', schema);
module.exports = PaymentLogs;

 