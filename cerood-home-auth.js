'use strict';

// ============================================================
// CEROOD HOME SERVICES — SEPARATE CUSTOMER AUTH
//
// This module intentionally keeps Home Services customer accounts
// separate from Cerood Shopping / Renewed / Fashion / Beauty accounts.
// Same mobile number may exist in both systems with different passwords.
//
// Optional (recommended) environment variable:
//   CEROOD_HOME_SERVICE_JWT_SECRET=<32+ chars>
// Falls back to the common customer secret only for deployment continuity.
// ============================================================

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

module.exports = function registerCeroodHomeServiceAuth(app, db, helpers = {}) {
    const verifyMsg91AccessToken = helpers.verifyMsg91AccessToken;
    const extractVerifiedPhoneFromMsg91 = helpers.extractVerifiedPhoneFromMsg91;

    const query = (sql, params = []) => new Promise((resolve, reject) => {
        db.query(sql, params, (error, rows) => {
            if (error) return reject(error);
            resolve(rows || []);
        });
    });

    const clean = (value, max = 500) => String(value ?? '')
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, max);

    const phone10 = value => String(value ?? '').replace(/\D/g, '').slice(-10);

    function fail(status, message, code) {
        const error = new Error(message);
        error.status = status;
        if (code) error.code = code;
        return error;
    }

    let schemaPromise;
    function ensureSchema() {
        if (!schemaPromise) {
            schemaPromise = query(`
                CREATE TABLE IF NOT EXISTS public.cerood_home_service_customers (
                    id UUID PRIMARY KEY,
                    name VARCHAR(160) NOT NULL,
                    email VARCHAR(320),
                    phone VARCHAR(10) NOT NULL UNIQUE,
                    pincode VARCHAR(6),
                    address TEXT NOT NULL DEFAULT 'No address saved',
                    password TEXT NOT NULL,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )
            `).catch(error => {
                schemaPromise = null;
                throw error;
            });
        }
        return schemaPromise;
    }

    function sessionSecret() {
        const secret = String(
            process.env.CEROOD_HOME_SERVICE_JWT_SECRET ||
            process.env.CEROOD_CUSTOMER_JWT_SECRET ||
            process.env.RENEWED_CUSTOMER_JWT_SECRET ||
            ''
        );
        if (secret.length < 32) {
            throw fail(
                503,
                'Home Services login is not configured on the server.',
                'HOME_AUTH_SECRET'
            );
        }
        return secret;
    }

    function publicCustomer(row) {
        if (!row) return null;
        return {
            id: row.id,
            name: row.name || '',
            email: row.email || '',
            phone: row.phone || '',
            pincode: row.pincode || '',
            address: row.address || 'No address saved'
        };
    }

    function createSession(row) {
        return jwt.sign(
            {
                sub: String(row.id),
                phone: String(row.phone),
                role: 'cerood_home_service_customer'
            },
            sessionSecret(),
            {
                algorithm: 'HS256',
                expiresIn: '7d',
                issuer: 'cerood-home-services'
            }
        );
    }

    async function requireHomeAuth(req, res, next) {
        try {
            await ensureSchema();
            const auth = String(req.get('Authorization') || '');
            const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
            if (!token) throw fail(401, 'Home Services login required.', 'HOME_AUTH_REQUIRED');

            let payload;
            try {
                payload = jwt.verify(token, sessionSecret(), {
                    algorithms: ['HS256'],
                    issuer: 'cerood-home-services'
                });
            } catch (_) {
                throw fail(401, 'Home Services session expired. Please login again.', 'HOME_AUTH_EXPIRED');
            }

            if (payload?.role !== 'cerood_home_service_customer' || !payload?.sub) {
                throw fail(401, 'Invalid Home Services session.', 'HOME_AUTH_INVALID');
            }

            const rows = await query(
                `SELECT id,name,email,phone,pincode,address
                   FROM public.cerood_home_service_customers
                  WHERE id=? LIMIT 1`,
                [String(payload.sub)]
            );
            if (!rows.length) throw fail(401, 'Home Services account was not found.', 'HOME_AUTH_USER');
            req.homeServiceCustomer = rows[0];
            next();
        } catch (error) {
            res.status(error.status || 500).json({
                success: false,
                code: error.code || undefined,
                message: error.message || 'Home Services authentication failed.'
            });
        }
    }

    async function verifiedPhone(accessToken, claimedPhone) {
        if (typeof verifyMsg91AccessToken !== 'function' || typeof extractVerifiedPhoneFromMsg91 !== 'function') {
            throw fail(503, 'OTP verification is not configured for Home Services.', 'HOME_OTP_CONFIG');
        }
        const verificationData = await verifyMsg91AccessToken(accessToken);
        const verified = phone10(extractVerifiedPhoneFromMsg91(verificationData, accessToken));
        if (!verified) throw fail(401, 'Unable to confirm verified mobile number from MSG91.', 'HOME_OTP_PHONE');
        if (verified !== claimedPhone) throw fail(401, 'OTP verification does not match this mobile number.', 'HOME_OTP_MISMATCH');
        return verified;
    }

    app.post('/api/home-services/auth/check-user', async (req, res) => {
        try {
            await ensureSchema();
            const phone = phone10(req.body?.phone);
            if (!/^[6-9]\d{9}$/.test(phone)) throw fail(400, 'Enter a valid 10-digit mobile number.');
            const rows = await query(
                `SELECT id FROM public.cerood_home_service_customers WHERE phone=? LIMIT 1`,
                [phone]
            );
            res.json({ success: true, exists: Boolean(rows.length), hasPassword: Boolean(rows.length) });
        } catch (error) {
            res.status(error.status || 500).json({ success: false, message: error.message || 'Unable to check Home Services account.' });
        }
    });

    app.post('/api/home-services/auth/login-password', async (req, res) => {
        try {
            await ensureSchema();
            sessionSecret();
            const phone = phone10(req.body?.phone);
            const password = String(req.body?.password || '');
            if (!/^[6-9]\d{9}$/.test(phone) || !password) throw fail(400, 'Mobile number and password are required.');

            const rows = await query(
                `SELECT * FROM public.cerood_home_service_customers WHERE phone=? LIMIT 1`,
                [phone]
            );
            if (!rows.length) throw fail(404, 'Home Services account not found. Please create an account.');
            const customer = rows[0];
            const ok = await bcrypt.compare(password, String(customer.password || ''));
            if (!ok) throw fail(401, 'Incorrect password.');

            const session = createSession(customer);
            res.json({
                success: true,
                user: publicCustomer(customer),
                home_service_session: session,
                session
            });
        } catch (error) {
            res.status(error.status || 500).json({ success: false, code: error.code || undefined, message: error.message || 'Home Services login failed.' });
        }
    });

    app.post('/api/home-services/auth/complete-registration', async (req, res) => {
        try {
            await ensureSchema();
            sessionSecret();

            const accessToken = String(req.body?.accessToken || '').trim();
            const phone = phone10(req.body?.phone);
            const name = clean(req.body?.name, 160);
            const email = clean(req.body?.email, 320);
            const pincode = String(req.body?.pincode || '').replace(/\D/g, '').slice(0, 6);
            const password = String(req.body?.password || '');

            if (!accessToken) throw fail(400, 'OTP verification token is missing.');
            if (!/^[6-9]\d{9}$/.test(phone)) throw fail(400, 'Invalid mobile number.');
            if (!name) throw fail(400, 'Name is required.');
            if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw fail(400, 'Enter a valid email address.');
            if (!/^\d{6}$/.test(pincode)) throw fail(400, 'Invalid pincode.');
            if (password.length < 4) throw fail(400, 'Password must be at least 4 characters.');

            await verifiedPhone(accessToken, phone);

            const existing = await query(
                `SELECT id FROM public.cerood_home_service_customers WHERE phone=? LIMIT 1`,
                [phone]
            );
            if (existing.length) throw fail(409, 'Mobile number already registered for Home Services. Please login.');

            const hashed = await bcrypt.hash(password, 12);
            const id = crypto.randomUUID();
            const rows = await query(
                `INSERT INTO public.cerood_home_service_customers
                    (id,name,email,phone,pincode,address,password)
                 VALUES (?,?,?,?,?,'No address saved',?)
                 RETURNING *`,
                [id, name, email || null, phone, pincode, hashed]
            );
            const customer = rows[0] || { id, name, email, phone, pincode, address: 'No address saved' };
            const session = createSession(customer);
            res.status(201).json({
                success: true,
                message: 'Home Services account created successfully!',
                user: publicCustomer(customer),
                home_service_session: session,
                session
            });
        } catch (error) {
            console.error('Home Services registration:', error.response?.data || error.message);
            res.status(error.status || 500).json({ success: false, code: error.code || undefined, message: error.message || 'Unable to create Home Services account.' });
        }
    });

    app.post('/api/home-services/auth/reset-password', async (req, res) => {
        try {
            await ensureSchema();
            sessionSecret();

            const accessToken = String(req.body?.accessToken || '').trim();
            const phone = phone10(req.body?.phone);
            const password = String(req.body?.password || '');
            if (!accessToken) throw fail(400, 'OTP verification token is missing.');
            if (!/^[6-9]\d{9}$/.test(phone)) throw fail(400, 'Invalid mobile number.');
            if (password.length < 4) throw fail(400, 'Password must be at least 4 characters.');

            await verifiedPhone(accessToken, phone);
            const hashed = await bcrypt.hash(password, 12);
            const rows = await query(
                `UPDATE public.cerood_home_service_customers
                    SET password=?,updated_at=NOW()
                  WHERE phone=? RETURNING *`,
                [hashed, phone]
            );
            if (!rows.length) throw fail(404, 'Home Services account not found.');
            const customer = rows[0];
            const session = createSession(customer);
            res.json({
                success: true,
                message: 'Home Services password updated successfully.',
                user: publicCustomer(customer),
                home_service_session: session,
                session
            });
        } catch (error) {
            console.error('Home Services reset password:', error.response?.data || error.message);
            res.status(error.status || 500).json({ success: false, code: error.code || undefined, message: error.message || 'Unable to reset Home Services password.' });
        }
    });

    app.get('/api/home-services/customer/me', requireHomeAuth, async (req, res) => {
        res.set('Cache-Control', 'private, no-store');
        res.json({ success: true, user: publicCustomer(req.homeServiceCustomer) });
    });

    app.post('/api/home-services/customer/update-address', requireHomeAuth, async (req, res) => {
        try {
            const address = clean(req.body?.address, 1200);
            const pincode = String(req.body?.pincode || '').replace(/\D/g, '').slice(0, 6);
            if (!address) throw fail(400, 'Service address is required.');
            if (!/^[1-9]\d{5}$/.test(pincode)) throw fail(400, 'Enter a valid 6-digit pincode.');
            const rows = await query(
                `UPDATE public.cerood_home_service_customers
                    SET address=?,pincode=?,updated_at=NOW()
                  WHERE id=? RETURNING *`,
                [address, pincode, req.homeServiceCustomer.id]
            );
            res.json({ success: true, user: publicCustomer(rows[0]) });
        } catch (error) {
            res.status(error.status || 500).json({ success: false, message: error.message || 'Unable to save service address.' });
        }
    });

    app.post('/api/home-services/customer/remove-address', requireHomeAuth, async (req, res) => {
        try {
            const rows = await query(
                `UPDATE public.cerood_home_service_customers
                    SET address='No address saved',updated_at=NOW()
                  WHERE id=? RETURNING *`,
                [req.homeServiceCustomer.id]
            );
            res.json({ success: true, user: publicCustomer(rows[0]) });
        } catch (error) {
            res.status(error.status || 500).json({ success: false, message: error.message || 'Unable to remove service address.' });
        }
    });

    return { ensureSchema, requireHomeAuth };
};
