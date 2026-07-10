// src/routes/verifiedNumbers.js
const express = require('express');
const router = express.Router();
const container = require('../container');
const { authMiddleware } = require('../middleware/authMiddleware');

const verifiedNumberController = container.resolve('verifiedNumberController');

// Any authenticated user can read the POC list (parity with the warehouse list).
router.get('/', authMiddleware.authenticateJWT, verifiedNumberController.list);

module.exports = router;
