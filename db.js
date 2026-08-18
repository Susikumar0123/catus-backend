const mysql = require('mysql2');
require('dotenv').config(); // Load environment variables from .env file

// Database Configuration using variables from .env file
const db = mysql.createConnection({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME
});

db.connect((err) => {
    if (err) {
        console.error('Database connection failed: ' + err.message);
        return;
    }
    console.log('Connected to MySQL database successfully using .env!');
});

// Exporting the db connection so it can be used in server.js
module.exports = db;