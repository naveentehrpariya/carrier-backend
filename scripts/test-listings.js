require('dotenv').config({ path: '../.env' });
const connectDB = require('../db/config');
const User = require('../db/Users');
connectDB().then(async () => {
  const usersActive = await User.find({ tenantId: 'tehrpariya-web', permissions: 'driver' }).lean();
  const usersAll = await User.find({ tenantId: 'tehrpariya-web', permissions: 'driver' }, null, { includeInactive: true }).lean();
  console.log("Active drivers:", usersActive.length);
  console.log("All drivers:", usersAll.length);
  
  if (usersAll.length > usersActive.length) {
    const inactive = usersAll.filter(u => u.status === 'inactive');
    console.log("Inactive drivers:", inactive.map(u => u.email));
  }
  process.exit(0);
});
