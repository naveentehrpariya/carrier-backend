const mongoose = require('mongoose');
require('dotenv').config({path: './.env'});
const Carrier = require('./db/Carrier');

mongoose.connect(process.env.DB_URL_OFFICE).then(async () => {
  const c = await Carrier.find({ deletedAt: null }).limit(1).lean();
  console.log("Sample carrier:", JSON.stringify(c, null, 2));
  
  if (c.length > 0) {
      const q = c[0].name; // Search by the name of the sample
      console.log("Searching for:", q);
      const tokens = q.split(/\s+/).map((t) => t.trim()).filter((t) => t.length >= 2);
      const tokenRegexes = tokens.map((t) => new RegExp(String(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
      
      const carriers = await Carrier.find({
        $and: [
          { $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }] },
          ...tokenRegexes.map((r) => ({ $or: [{ name: r }, { email: r }, { phone: r }, { mc_code: r }, { carrierID: r }] }))
        ]
      }).limit(5).lean();
      console.log("Found carriers length:", carriers.length);
  }
  process.exit(0);
});
