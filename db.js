const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

pool.connect((err, client, release) => {
    if (err) {
        return console.error('Database connection failed:', err);
    }
    console.log('Database connected successfully!');
    release();
});

module.exports = {
    query: (text, params, callback) => pool.query(text, params, callback),
};