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
    query: (text, params, callback) => {

        // MySQL-style ? placeholders
        // PostgreSQL-style $1, $2, $3...
        let index = 0;

        const pgQuery = text.replace(/\?/g, () => {
            index++;
            return `$${index}`;
        });

        pool.query(pgQuery, params || [], (err, result) => {

            if (err) {
                return callback(err, null);
            }

            // Make PostgreSQL behave like the old MySQL-style code
            callback(null, result.rows, result);
        });
    }
};