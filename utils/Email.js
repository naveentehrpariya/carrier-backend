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
         // Verify the server's certificate: this connection carries the mailbox
         // password. EMAIL_TLS_INSECURE=true restores the old behaviour for a server
         // whose certificate cannot be verified — never the default.
         tls: {
           rejectUnauthorized: process.env.EMAIL_TLS_INSECURE !== 'true',
         },
       });
      const mailOptions = { 
         from: process.env.EMAIL_FROM,
         to: options.email,
         subject: options.subject,
         html: options.message,
      };
      // Optional, and additive: every existing caller omits these, and nodemailer
      // ignores an undefined key. Attachments are what let a document (a priced fuel
      // sheet, say) be sent instead of described.
      if (options.attachments) mailOptions.attachments = options.attachments;
      if (options.replyTo) mailOptions.replyTo = options.replyTo;
      if (options.cc) mailOptions.cc = options.cc;

      


      const result = await transporter.sendMail(mailOptions);
      console.log('Email sent:', result);
      return result; 
   } catch (error) {
      console.error('Error sending email:', error);
      throw error; // Rethrow error for higher-level error handling
   }
};

module.exports = sendEmail;
