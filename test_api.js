const axios = require('axios');
require('dotenv').config({path: './.env'});
const jwt = require('jsonwebtoken');

const token = jwt.sign({ id: '6784abdeec01b5b3d11f774a', role: 'super_admin' }, process.env.SECRET_ACCESS || 'MYSECRET', { expiresIn: '1d' });

axios.get('http://localhost:8000/search/global?q=Blue', {
  headers: { Authorization: `Bearer ${token}` }
}).then(res => {
  console.log("API Response:", JSON.stringify(res.data, null, 2));
}).catch(err => {
  console.log("API Error:", err.response ? err.response.data : err.message);
});
