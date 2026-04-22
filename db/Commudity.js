const mongoose = require('mongoose');
const schema = new mongoose.Schema({
   tenantId: { 
      type: String, 
      required: true, 
      index: true,
   },
   company: { type: mongoose.Schema.Types.ObjectId, ref: 'companies' },
   name: {
      type:String,
      required:[true, 'Commodity name can not be empty.']
    },   
    createdAt: {
      type: Date,
      default: Date.now()     
   },
});

// Compound unique index for tenant-name combination
schema.index({ tenantId: 1, name: 1 }, { unique: true, collation: { locale: 'en', strength: 2 } });
const Commudity = mongoose.model('commudity', schema);
module.exports = Commudity;

 