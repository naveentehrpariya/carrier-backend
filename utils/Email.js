const nodemailer = require('nodemailer');
// SMTP_* (e.g. Gmail with an app password) wins when set; otherwise the original
// Hostinger mailbox via EMAIL_*. Gmail refuses a From that is not the account.
function transportOptions() {
   if (process.env.SMTP_HOST && process.env.SMTP_USER) {
      const port = Number(process.env.SMTP_PORT) || 587;
      return {
         host: process.env.SMTP_HOST,
         port,
         secure: port === 465,
         auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
         tls: { rejectUnauthorized: process.env.EMAIL_TLS_INSECURE !== 'true' },
      };
   }
   return {
      host: 'smtp.hostinger.com',
      port: 587,
      secure: false,
      auth: { user: process.env.EMAIL_USERNAME, pass: process.env.EMAIL_PASSWORD },
      // Verify the server's certificate: this connection carries the mailbox
      // password. EMAIL_TLS_INSECURE=true restores the old unverified behaviour.
      tls: { rejectUnauthorized: process.env.EMAIL_TLS_INSECURE !== 'true' },
   };
}

const isEmailConfigured = () => Boolean((process.env.SMTP_HOST && process.env.SMTP_USER) || (process.env.EMAIL_USERNAME && process.env.EMAIL_PASSWORD));

const sendEmail = async (options) => { 
   try {
      const transporter = nodemailer.createTransport(transportOptions());
      const mailOptions = { 
         from: process.env.EMAIL_FROM || process.env.SMTP_FROM || process.env.SMTP_USER,
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
module.exports.isEmailConfigured = isEmailConfigured;
