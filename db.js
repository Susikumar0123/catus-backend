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

const db = {

    // ==========================================
    // NORMAL DATABASE QUERY
    // ==========================================
    query: (text, params, callback) => {

        let queryText = text;
        let queryParams = params;

        if (typeof params === 'function') {
            callback = params;
            queryParams = [];
        }

        queryParams = queryParams || [];

        let counter = 1;

        // Convert MySQL-style ? placeholders
        // to PostgreSQL $1, $2, $3...
        queryText = queryText.replace(
            /\?/g,
            () => `$${counter++}`
        );

        return pool.query(
            queryText,
            queryParams,
            (err, res) => {

                if (err) {

                    if (typeof callback === 'function') {
                        return callback(err, null);
                    }

                    return;
                }

                if (typeof callback === 'function') {
                    callback(null, res.rows);
                }
            }
        );
    },


    // ==========================================
    // TRANSACTION DATABASE CONNECTION
    // ==========================================
    getClient: async () => {

        const client =
            await pool.connect();

        return {

            query: async (text, params = []) => {

                let queryText = text;

                let counter = 1;

                // BEGIN / COMMIT / ROLLBACK have no ?
                // Normal queries can still use ? placeholders
                queryText = queryText.replace(
                    /\?/g,
                    () => `$${counter++}`
                );

                const result =
                    await client.query(
                        queryText,
                        params
                    );

                return result.rows;
            },

            release: () => {
                client.release();
            }
        };
    }

};

module.exports = db;