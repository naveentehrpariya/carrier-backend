const mongoose = require('mongoose');
require('dotenv').config({path: './.env'});
const User = require('./db/Users');

mongoose.connect(process.env.DB_URL_OFFICE).then(async () => {
  const user = await User.findOne({ email: 'admin@gmail.com' }).populate('company');
  console.log("admin@gmail.com populated company:", user.company);
  process.exit(0);
});
