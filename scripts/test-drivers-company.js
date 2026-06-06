require('dotenv').config({ path: './.env' });
const connectDB = require('./db/config');
const User = require('./db/Users');
connectDB().then(async () => {
  const naveen = await User.findOne({ email: 'naveen@gmail.com' }).lean();
  console.log('Naveen company:', naveen.company);

  const drivers = await User.find({ permissions: 'driver', tenantId: 'tehrpariya-web' }, null, { includeInactive: true }).lean();
  console.log('Total drivers for tenant:', drivers.length);
  for (const d of drivers) {
    console.log('Driver:', d.email, '| Company:', d.company, '| Status:', d.status, '| Permissions:', d.permissions);
  }
  process.exit(0);
});
