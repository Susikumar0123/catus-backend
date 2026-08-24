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
        console.error('Database connection failed:', err);
    } else {
        console.log('Database connected successfully!');
        release();
    }
});

// Helper function to convert MySQL '?' style queries to PostgreSQL '$1, $2' style
const db = {
    query: (text, params, callback) => {
        let queryText = text;
        let queryParams = params;

        if (typeof params === 'function') {
            callback = params;
            queryParams = [];
        }

        // Convert ? to $1, $2, etc.
        let counter = 1;
        queryText = queryText.replace(/\?/g, () => `$${counter++}`);

        return pool.query(queryText, queryParams, (err, res) => {
            if (err) {
                return callback(err, null);
            }
            // Return results in an array format compatible with mysql callback style (results, fields)
            callback(null, res.rows);
        });
    }
};

module.exports = db;