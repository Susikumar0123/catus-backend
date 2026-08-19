const { Pool } = require('pg');
require('dotenv').config();

const db = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

db.connect()
    .then(() => console.log('Connected to Supabase PostgreSQL database successfully!'))
    .catch(err => console.error('Database connection failed:', err.stack));

module.exports = db;