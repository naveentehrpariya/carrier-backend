
const errorHandler = (err, req, res, next) => { 
   // Handle Mongoose Validation Errors
   if (err.name === 'ValidationError') {
      const messages = Object.values(err.errors).map(val => val.message);
      return res.status(400).json({
         status: false,
         errors: messages,
         message: "Validation Error",
      });
   }

   // Handle MongoDB Duplicate Key Errors
   if (err.code === 11000) {
      const field = Object.keys(err.keyValue)[0];
      return res.status(400).json({
         status: false,
         errors: [`A record with that ${field} already exists.`],
         message: "Duplicate Error",
      });
   }

   const statusCode = err.statusCode || (res.statusCode === 200 ? 500 : res.statusCode);
   
   res.status(statusCode).json({
      status: false,
      message: err.message || "Internal Server Error",
      stack: process.env.NODE_ENV === 'production' ? null : err.stack
   });
}     
module.exports = errorHandler;
