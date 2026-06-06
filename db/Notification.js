const mongoose = require('mongoose');
const schema = new mongoose.Schema({
   tenantId: { 
      type: String, 
      required: true, 
      index: true,
   },
   company: { type: mongoose.Schema.Types.ObjectId, ref: 'companies' },
   name: { type:String },
   mime: {
        type:String,
   },
   size: { type:String },
   filename: { type:String },
   url: { type:String },
   order: { type: mongoose.Schema.Types.ObjectId, ref: 'orders' },
   createdAt: {
      type: Date,
      default: Date.now     
   },
   read_status: {
      type: Date,
      default: null   
   },
});



const Notification = mongoose.model('notifications', schema);
module.exports = Notification;

 