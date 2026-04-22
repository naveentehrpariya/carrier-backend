const nodemailer = require('nodemailer');
const sendEmail = async (options) => { 
   try {
      const transporter = nodemailer.createTransport({
         host: 'smtp.hostinger.com', // Use your Hostinger SMTP server address
         port: 587, // Usually 587 for TLS or 465 for SSL
         secure: false, // Set to true if using port 465
         auth: {
           user: process.env.EMAIL_USERNAME, // Your Hostinger email username
           pass: process.env.EMAIL_PASSWORD, // Your Hostinger email password
         },
         tls: {
           rejectUnauthorized: false,
         },
       });
      const mailOptions = { 
         from: process.env.EMAIL_FROM,
         to: options.email,
         subject: options.subject,
         html: options.message,
      };

      


      const result = await transporter.sendMail(mailOptions);
      console.log('Email sent:', result);
      return result; 
   } catch (error) {
      console.error('Error sending email:', error);
      throw error; // Rethrow error for higher-level error handling
   }
};

module.exports = sendEmail;
