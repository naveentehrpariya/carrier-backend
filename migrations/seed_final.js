require('dotenv').config({ path: __dirname + '/../.env' });
const mongoose = require('mongoose');
const Order = require('../db/Order');
const Trip = require('../db/Trip');
const Truck = require('../db/Truck');
const OwnerOperator = require('../db/OwnerOperator');
const DriverProfile = require('../db/DriverProfile');
const Company = require('../db/Company');
const Customer = require('../db/Customer');
const OwnerOperatorFinancialRecord = require('../db/OwnerOperatorFinancialRecord');

const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017/carrier";

async function seed() {
  await mongoose.connect(MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true });
  console.log('Connected to MongoDB');

  const company = await Company.findOne().lean();
  if (!company) throw new Error('No company found');
  const tenantId = company.tenantId || company._id.toString();

  // Create a Customer if none exist
  let customer = await Customer.findOne({require('dotenv').config({ path: __dirname + '/soconst mongoose = require('mongoose');
const Order = requir= const Order = require('../db/Order')Idconst Trip = require('../db/Trip');
  const Truck = reqst Customer Corp",
const OwnerOperator = require('../db_nconst DriverProfile = require('../db/DriverProfile')",const Company = require('../db/Company');
const Custddconst Customer = require('../db/CustomoObjconst OwnerOperatorFinancialRecord = requiif
const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017/carrier!ow
async function seed() {
  await mongoose.connect(MONGODB_URI, { useNewUrlParser:  aw  await mongoose.connete  console.log('Connected to MongoDB');

  const company = await Company.findOne().lean();
il: "dummy@owner.com", 
      phone: "+91   if (!company) throw new Error('No company foun    const tenantId = company.tenantId || company._id. c
  // Create a Customer if none exist
  let customer = awtoObjec  let customer = await Customer.finneconst Order = requir= const Order = require('../db/Order')Idconst Trip = require('../db/Trip');
  const Truck = reqst Customerre  const Truck = reqst Customer Corp",
const OwnerOperator = require('../db_nconst DriverProfilpaconst OwnerOperator = require('../db"Tconst Custddconst Customer = require('../db/CustomoObjconst OwnerOperatorFinancialRecord = requiif
const MONGODB_URI = process.env.M  const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017/carrier!ow
async functiwaasync function seed() {
  await mongoose.connect(MONGODB_URI, { useNewUrlParser:  aan  await mongoose.connr_o
  const company = await Company.findOne().lean();
il: "dummy@owner.com", 
      phone: "+91   if (!company) throw new Er ciil: "dummy@owner.com", 
      phone: "+91   if ( {      phone: "+91   ifio  // Create a Customer if none exist
  let customer = awtoObjec  let customer = await Customer.finneconst Order = requir:   let customer = awtoObjec  let cuy:   const Truck = reqst Customerre  const Truck = reqst Customer Corp",
const OwnerOperator = require('../db_nconst DriverProfilpaconst OwnerOperator = require }const OwnerOperator = require('../db_nconst DriverProfilpaconst OwneLuconst MONGODB_URI = process.env.M  const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017/carrier!ow
async functiwaasync function seed() {
  await mongoose.connect(MONGODB_UR];async functiwaasync function seed() {
  await mongoose.connect(MONGODB_URI, { useNewUrlParser:  aan  await mongoose.coia  await mongoose.connect(MONGODB_URe =  const company = await Company.findOne().lean();
il: "dummy@owner.com", 
      phon iil: "dummy@owner.com", 
      phone: "+91   onst r      phone: "+91   ifks      phone: "+91   if ( {      phone: "+91   ifio  // Create a Customeow  let customer = awtoObjec  let customer = await Customer.finneconst Order = requir: neconst OwnerOperator = require('../db_nconst DriverProfilpaconst OwnerOperator = require }const OwnerOperator = require('../db_nconst DriverProfilpaconst OwneLuconst MONGODB_URI = process.env0)async functiwaasync function seed() {
  await mongoose.connect(MONGODB_UR];async functiwaasync function seed() {
  await mongoose.connect(MONGODB_URI, { useNewUrlParser:  aan  await mongoose.coia  await mongoose.connect(MONGODB_URe =  const company = await Company.findOne().leci  await mongoose.connect(MONGODB_UR]);  await mongoose.connect(MONGODB_URI, { useNewUrlParser:  aan  await mon   il: "dummy@owner.com", 
      phon iil: "dummy@owner.com", 
      phone: "+91   onst r      phone: "+91   ifks      phone: "+91   if ( {      phone: "+91   ifio  // Creta      phon iil: "dummy.n      phone: "+91   onst r      pdDa  await mongoose.connect(MONGODB_UR];async functiwaasync function seed() {
  await mongoose.connect(MONGODB_URI, { useNewUrlParser:  aan  await mongoose.coia  await mongoose.connect(MONGODB_URe =  const company = await Company.findOne().leci  await mongoose.connect(MONGODB_UR]);  await mongoose.connect(MONGODB_URI, { useNewUrlParser:  aan  await mon   il: "dummy@owner.com", 
      phon iil: "dummy@owner.com", 
      phone: "+91   onstdr  await mongoose.connect(MONGODB_URI, { useNewUrlParser:  aan  await mong==      phon iil: "dummy@owner.com", 
      phone: "+91   onst r      phone: "+91   ifks      phone: "+91   if ( {      phone: "+91   ifio  // Creta      phon iil: "dummy.n      phone: "+91   onst r      pdDa  await mongoose.connect(MONGODB_UR];async functiwaasync function seed() {
  await mongoose.conle      phone: "+91   onst r      phou  await mongoose.connect(MONGODB_URI, { useNewUrlParser:  aan  await mongoose.coia  await mongoose.connect(MONGODB_URe =  const company = await Company.findOne().leci  await mongoose.connect(MONGODB_UR]);  await mongoose.connect(MONGODB_URI, {at      phon iil: "dummy@owner.com", 
      phone: "+91   onstdr  await mongoose.connect(MONGODB_URI, { useNewUrlParser:  aan  await mong==      phon iil: "dummy@owner.com", 
      phone: "+91   onst r      phone: "+91   ifks      phone: "+91   if ( {      phone: "+91   ifio  // Creta      phon iil: "dwa      phone: "+91   onstdr  await         phone: "+91   onst r      phone: "+91   ifks      phone: "+91   if ( {      phone: "+91   ifio  // Creta      phon iil: "dummy.n er  await mongoose.conle      phone: "+91   onst r      phou  await mongoose.connect(MONGODB_URI, { useNewUrlParser:  aan  await mongoose.coia  await mongoose.connect(MONGODB_URe =  const company = await Company.findOne().leci  await mongoose.co s      phone: "+91   onstdr  await mongoose.connect(MONGODB_URI, { useNewUrlParser:  aan  await mong==      phon iil: "dummy@owner.com", 
      phone: "+91   onst r      phone: "+91   ifks      phone: "+91   if ( {      phone: "+91   ifio  // Creta      phon iil: "dwa      phone: "+91   onstdr  await         phone: "+91   onst r      pha.      phone: "+91   onst r      phone: "+91   ifks      phone: "+91   if ( {      phone: "+91   ifio  // Creta      phon iil: "dwa     to      phone: "+91   onst r      phone: "+91   ifks      phone: "+91   if ( {      phone: "+91   ifio  // Creta      phon iil: "dwa      phone: "+91   onstdr  await         phone: "+91   onst r      pha.      phone: "+91   onst r      phone: "+91   ifks      phone: "+91   if ( {      phone: "+91   ifio  // Creta      phon iil: "dwa     to      phone: "+91   onst r      phone: "+91   ifks      phone: "+91   if ( {      phone: "+91   ifio  // Creta      phon iil: "dwa      phone: "+91   onstdr  await         phone: "+91   onst r      pha.      phone: "+91   onst r      phone: "+91   ifks      phone: "+91   if ( {      phone: "+91   ifio  // Creta      phon iil: "dwa     to     erialBase + ' Profit', createdAt: startDate,
    });
  }

  console.log("Seeding complete! 50 orders created successfully.");
  process.exit(0);
}

seed().catch(err => {
  console.error(err);
  process.exit(1);
});
