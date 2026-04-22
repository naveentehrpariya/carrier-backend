const mongoose = require('mongoose');
require('dotenv').config({path: './.env'});
const Carrier = require('./db/Carrier');

mongoose.connect(process.env.DB_URL_OFFICE).then(async () => {
  const c = await Carrier.findOne({ deletedAt: null }).lean();
  console.log("Carrier company:", c.company, typeof c.company);
  
  const carriersWithCompany = await Carrier.find({ company: String(c.company) }).lean();
  console.log("Found by string company:", carriersWithCompany.length);
  
  const carriersWithObjectId = await Carrier.find({ company: c.company }).lean();
  console.log("Found by ObjectId company:", carriersWithObjectId.length);
  
  process.exit(0);
});
