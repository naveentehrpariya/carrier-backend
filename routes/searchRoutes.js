const express = require('express');
const router = express.Router();
const { validateToken } = require('../controllers/multiTenantAuthController');
const { optionalTenant } = require('../middleware/tenant');
const searchController = require('../controllers/searchController');

router.route('/search/global').get(validateToken, optionalTenant, searchController.globalSearch);

module.exports = router;

