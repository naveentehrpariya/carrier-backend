const User = require("../db/Users");
const APIFeatures = require("../utils/APIFeatures");
const AppError = require("../utils/AppError");
const catchAsync = require("../utils/catchAsync");
const { logActivity } = require("../utils/activityLogger");

const filterObj = async (obj, ...allowed) => { 
   let newObj = {};
   Object.keys(obj).forEach(el=>{ 
      if(allowed.includes(el)) newObj[el]= obj[el];
   });
   return newObj;
}


exports.updateCurrentUserData = catchAsync( async (req, res, next) => { 
   if(req.body.password || req.body.confirmPassword){
      return res.json({
         status:false,
         message:"'Password can not changed via this request.'"
      });
   }
   const allowedFields = await filterObj(req.body, 'name', 'email', 'username', 'avatar');
   const user = await User.findByIdAndUpdate(req.user.id, allowedFields, {
      new : true, 
      runValidators : true
   });

   // Only reset email verification if the email actually changed
   if(req.body.email && req.body.email !== '' && req.body.email !== req.user.email){
     user.mailVerifiedAt = null;
     await user.save();
   }

   logActivity(req, {
      action: 'UPDATE',
      module: 'employee',
      description: `User "${user.name}" updated their profile`,
      resourceId: user._id,
      resourceName: user.name,
   });
   return res.status(200).json({
      status:true,
      user: user,
      message:"User updated !!"
   });
});


exports.deleteCurrentUser = catchAsync( async (req, res, next) => {
   const user = await User.findByIdAndUpdate(req.user.id, { status:"inactive"});
   logActivity(req, {
      action: 'STATUS_CHANGE',
      module: 'employee',
      description: `User "${req.user.name}" deactivated their account`,
      resourceId: req.user._id,
      resourceName: req.user.name,
   });
   return res.status(200).json({
      status:true,
      user:user,
      message:"User account is disabled !!"
   });
});

exports.staffListing = catchAsync(async (req, res) => {
    const tenantId = req.tenantId || req.user?.tenantId;
    if (!tenantId) {
      return res.status(400).json({ status: false, message: "Tenant context is required.", users: [], totalDocuments: 0 });
    }
    const baseFilter = { ...User.activeFilter(tenantId), role: 1 };
    const companyId = req.user?.company?._id || req.user?.company || null;
    if (companyId) baseFilter.company = companyId;
    let Query = new APIFeatures(User.find(baseFilter), req.query).sort();
    const { query, totalDocuments, page, limit, totalPages } = await Query.paginate();
    const data = await query;
    res.json({
      status: true,
      users: data,
      totalDocuments : totalDocuments,
      page : page,
      per_page : limit,
      totalPages : totalPages,
      message: data.length ? undefined : "No files found"
    });
});
