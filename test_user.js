const mongoose = require('mongoose');
require('dotenv').config({path: './.env'});
const User = require('./db/Users');

mongoose.connect(process.env.DB_URL_OFFICE).then(async () => {
  const userLean = await User.findOne({ email: 'admin@gmail.com' }).lean();
  console.log("userLean.allowedModules:", userLean.allowedModules);
  
  const userModel = await User.findOne({ email: 'admin@gmail.com' });
  console.log("userModel.allowedModules:", userModel.allowedModules);
  console.log("userModel.toObject().allowedModules:", userModel.toObject().allowedModules);
  
  process.exit(0);
});
