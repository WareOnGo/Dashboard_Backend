// index.js
const express = require('express');
const cors = require('cors');
require('dotenv').config(); 

const app = express();
const PORT = process.env.PORT || 3001;

// --- Middleware ---
const coresoptions = {origin: '*'};
app.use(cors(coresoptions));
app.use(express.json());

// --- Routes ---
// UNCOMMENT THIS LINE:
app.use('/api/warehouses', require('./routes/warehouse')); // <-- This connects your routes

// --- Basic Test Route ---
app.get('/', (req, res) => {
  res.send('Warehouse API is running!');
});

// --- Start Server ---
app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});