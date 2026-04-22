const axios = require('axios');
const mongoose = require('mongoose');
require('dotenv').config({path: './.env'});
const Carrier = require('./db/Carrier');
const User = require('./db/Users');

mongoose.connect(process.env.DB_URL_OFFICE).then(async () => {
  const user = await User.findOne({ status: 'active', email: 'admin@gmail.com' }).populate('company'); 
  
  const c = await Carrier.findOne({ deletedAt: null }).lean();
  const q = c ? c.name : 'Blue';
  console.log("Searching for:", q);
  const req = {
    user: user,
    tenantId: user.tenantId,
    query: {
      q: q,
      limit: 5
    }
  };
  
  const res = {
    json: (data) => console.log("JSON Response carriers length:", data.results?.carriers?.length, "customers:", data.results?.customers?.length),
    status: (code) => ({
      json: (data) => console.log("Error Response:", code, data)
    })
  };
  
  const searchController = require('./controllers/searchController');
  await searchController.globalSearch(req, res);
  
  process.exit(0);
});