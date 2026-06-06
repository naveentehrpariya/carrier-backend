require('dotenv').config();
const connectDB = require('../db/config');
const User = require('../db/Users');
connectDB().then(async () => {
  const drivers = await User.find({ tenantId: 'tehrpariya-web' }, null, { includeInactive: true }).lean();
  for (const d of drivers) {
    if (d.role === 0 || (d.permissions && d.permissions.includes('driver'))) {
       console.log('Driver:', d.email, '| Role:', d.role, '| Perms:', d.permissions, '| Status:', d.status);
    }
  }
  process.exit(0);
});
