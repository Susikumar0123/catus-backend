const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const Razorpay = require('razorpay');
const multer = require('multer');
const path = require('path');
const db = require('./db');
const axios = require('axios');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());
app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

// ==========================================
// SUPABASE STORAGE - IMAGE UPLOAD
// ==========================================

const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 5 * 1024 * 1024 // 5 MB
    }
});

app.post('/api/upload-image', upload.single('image'), async (req, res) => {
    try {

        if (!req.file) {
            return res.status(400).json({
                success: false,
                message: 'No image uploaded'
            });
        }

        const SUPABASE_URL = String(process.env.SUPABASE_URL || '')
            .replace(/\/rest\/v1\/?$/, '');

        const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;

        if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
            return res.status(500).json({
                success: false,
                message: 'Supabase Storage configuration missing'
            });
        }

        const extension =
            path.extname(req.file.originalname).toLowerCase() || '.jpg';

        const fileName =
            `home-icons/${Date.now()}-${Math.random()
                .toString(36)
                .substring(2, 8)}${extension}`;

        await axios.post(
            `${SUPABASE_URL}/storage/v1/object/catus-images/${fileName}`,
            req.file.buffer,
            {
                headers: {
                    Authorization: `Bearer ${SUPABASE_SECRET_KEY}`,
                    apikey: SUPABASE_SECRET_KEY,
                    'Content-Type': req.file.mimetype
                },
                maxBodyLength: Infinity
            }
        );

        const imageUrl =
            `${SUPABASE_URL}/storage/v1/object/public/catus-images/${fileName}`;

        return res.json({
            success: true,
            imageUrl: imageUrl
        });

    } catch (error) {

        console.error(
            'Supabase Image Upload Error:',
            error.response?.data || error.message
        );

        return res.status(500).json({
            success: false,
            message: 'Image upload failed',
            error: error.response?.data || error.message
        });
    }
});

// ==========================================
// TECHNICIAN PARTNER REGISTRATION
// ==========================================
app.post('/api/technicians/register', (req, res) => {

    const {
        name,
        phone,
        alt_phone,
        email,
        experience_years,
        work_type,
        specialization,
        district,
        city,
        pincode,
        service_radius_km,
        home_address,
        shop_address,
        notes
    } = req.body;

    const cleanName = String(name || '').trim();
    const cleanPhone = String(phone || '').replace(/\D/g, '');
    const cleanAltPhone = String(alt_phone || '').replace(/\D/g, '');
    const cleanPincode = String(pincode || '').replace(/\D/g, '');
    const cleanSpecialization = String(specialization || '').trim();

    if (
        !cleanName ||
        !/^\d{10}$/.test(cleanPhone) ||
        !cleanSpecialization ||
        !String(work_type || '').trim() ||
        !String(district || '').trim() ||
        !String(city || '').trim() ||
        !/^\d{6}$/.test(cleanPincode) ||
        !String(home_address || '').trim()
    ) {
        return res.status(400).json({
            success: false,
            message: 'Please enter all required technician details correctly.'
        });
    }

    if (cleanAltPhone && !/^\d{10}$/.test(cleanAltPhone)) {
        return res.status(400).json({
            success: false,
            message: 'Alternative mobile number must be 10 digits.'
        });
    }

    const technicianId =
        'TECH-' +
        Date.now().toString().slice(-8) +
        Math.floor(10 + Math.random() * 90);

    const query = `
        INSERT INTO public.technicians
        (
            technician_id,
            name,
            phone,
            alt_phone,
            email,
            experience_years,
            work_type,
            specialization,
            district,
            city,
            pincode,
            service_radius_km,
            home_address,
            shop_address,
            notes,
            status
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        RETURNING technician_id, status
    `;

    db.query(
        query,
        [
            technicianId,
            cleanName,
            cleanPhone,
            cleanAltPhone || null,
            String(email || '').trim() || null,
            Math.max(0, Number(experience_years) || 0),
            String(work_type || '').trim(),
            cleanSpecialization,
            String(district || '').trim(),
            String(city || '').trim(),
            cleanPincode,
            Math.max(1, Number(service_radius_km) || 20),
            String(home_address || '').trim(),
            String(shop_address || '').trim() || null,
            String(notes || '').trim() || null,
            'Pending'
        ],
        (err, results) => {

            if (err) {
                console.error('Technician Registration Error:', err);

                if (err.code === '23505') {
                    return res.status(400).json({
                        success: false,
                        message: 'This mobile number is already registered as a technician.'
                    });
                }

                return res.status(500).json({
                    success: false,
                    message: 'Technician registration failed.'
                });
            }

            return res.json({
                success: true,
                message: 'Technician registration submitted successfully!',
                technician_id: results[0].technician_id,
                status: results[0].status
            });
        }
    );
});

// ==========================================
// 1. REGISTER API ROUTE (Fixed)
// ==========================================
app.post('/api/register', (req, res) => {
    const { name, email, phone, pincode } = req.body;
    
    const address = "No address saved";
    const randomCustId = Math.floor(10000 + Math.random() * 90000);

    const query = 'INSERT INTO users (id, name, email, phone, pincode, address) VALUES (?, ?, ?, ?, ?, ?)';
    db.query(query, [randomCustId, name, email, phone, pincode, address], (err, result) => {
        if (err) {
            if (err.code === 'ER_DUP_ENTRY') {
                return res.status(400).json({ success: false, message: 'Mobile number already registered!' });
            }
            return res.status(500).json({ success: false, error: err.message });
        }
        res.json({ 
            success: true, 
            message: 'User registered successfully!', 
            user: { id: randomCustId, name, email, phone, pincode, address } 
        });
    });
});

// ==========================================
// 2. CHECK USER & PASSWORD LOGIN API ROUTES (Updated)
// ==========================================
app.post('/api/check-user', (req, res) => {
    const { phone } = req.body;
    const query = 'SELECT * FROM users WHERE phone = ?';
    db.query(query, [phone], (err, results) => {
        if (err) return res.status(500).json({ success: false, error: err.message });
        if (results && results.length > 0) {
            const user = results[0];
            // 🛑 நம்பர் டேட்டாபேஸில் இருந்தால், பாஸ்வேர்ட் இருக்கிறதா இல்லையா என்பதைப் பொருட்படுத்தாமல் லாகின் பக்கத்திற்கு அனுப்ப true கொடுக்கிறோம்
            res.json({ success: true, exists: true, hasPassword: true, user: user });
        } else {
            res.json({ success: true, exists: false, hasPassword: false });
        }
    });
});

// ==========================================
// LOGIN PASSWORD ROUTE (Fixed for proper matching)
// ==========================================
app.post('/api/login-password', (req, res) => {
    const { phone, password } = req.body;
    const query = 'SELECT * FROM users WHERE phone = ?';
    db.query(query, [phone], async (err, results) => {
        if (err) return res.status(500).json({ success: false, error: err.message });
        
        if (results && results.length > 0) {
            const user = results[0];
            // Passwords-ah trim panrathu space error-ai thavirkkum
            if (await bcrypt.compare(String(password), String(user.password))) {
                res.json({ success: true, user: user });
            } else {
                res.status(401).json({ success: false, message: 'Incorrect password.' });
            }
        } else {
            res.status(404).json({ success: false, message: 'User not found.' });
        }
    });
});

// ==========================================
// SECURE MEMORY OTP STORE (Temporary Storage)
// ==========================================

app.post('/api/send-otp', (req, res) => {
    const { 
    phone, 
    mode,
    resend,
    name, 
    email, 
    pincode 
} = req.body;

    const cleanPhone = String(phone || '').trim();

    if (!/^\d{10}$/.test(cleanPhone)) {
        return res.status(400).json({
            success: false,
            message: 'Invalid 10-digit mobile number.'
        });
    }

    const generatedOtp = String(
    Math.floor(1000 + Math.random() * 9000)
);
    const expiresAt = Date.now() + (5 * 60 * 1000);


    // ==========================================
// NEW USER REGISTRATION
// ==========================================
if (mode === 'register') {

    const isResend =
        resend === true || resend === 'true';

    const checkQuery = `
        SELECT *
        FROM public.users
        WHERE phone = ?
        LIMIT 1
    `;

    return db.query(
        checkQuery,
        [cleanPhone],
        (checkErr, rows) => {

            if (checkErr) {

                console.error(
                    'Registration check error:',
                    checkErr
                );

                return res.status(500).json({
                    success: false,
                    message: checkErr.message
                });
            }


            // ==========================================
            // EXISTING PHONE + RESEND OTP
            // ==========================================
            if (rows && rows.length > 0) {

                const existingUser = rows[0];

                if (isResend) {

                    const updateResendQuery = `
                        UPDATE public.users
                        SET name = ?,
                            email = ?,
                            pincode = ?,
                            otp_code = ?,
                            otp_expires_at = ?
                        WHERE phone = ?
                    `;

                    return db.query(
                        updateResendQuery,
                        [
                            name || existingUser.name || '',
                            email || existingUser.email || '',
                            pincode || existingUser.pincode || '',
                            generatedOtp,
                            expiresAt,
                            cleanPhone
                        ],
                        (updateErr) => {

                            if (updateErr) {

                                console.error(
                                    'Registration resend OTP update error:',
                                    updateErr
                                );

                                return res.status(500).json({
                                    success: false,
                                    message: updateErr.message
                                });
                            }

                            

                            return res.json({
                                success: true,
                                message: 'OTP resent successfully!'
                            });
                        }
                    );
                }


                // ==========================================
                // EXISTING USER - NORMAL REGISTRATION ATTEMPT
                // ==========================================
                return res.status(400).json({
                    success: false,
                    message:
                        'Mobile number already registered. Please login.'
                });
            }


            // ==========================================
            // BRAND NEW USER
            // ==========================================
            const randomCustId =
                Math.floor(10000 + Math.random() * 90000);

            const insertQuery = `
                INSERT INTO public.users
                (
                    id,
                    name,
                    email,
                    phone,
                    pincode,
                    address,
                    password,
                    otp_code,
                    otp_expires_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `;

            db.query(
                insertQuery,
                [
                    randomCustId,
                    name || '',
                    email || '',
                    cleanPhone,
                    pincode || '',
                    'No address saved',
                    '',
                    generatedOtp,
                    expiresAt
                ],
                (insertErr) => {

                    if (insertErr) {

                        console.error(
                            'Registration user creation error:',
                            insertErr
                        );

                        return res.status(500).json({
                            success: false,
                            message: insertErr.message
                        });
                    }

                    

                    return res.json({
                        success: true,
                        message: 'OTP sent successfully!'
                    });
                }
            );
        }
    );
}

    // ==========================================
    // FORGOT PASSWORD
    // ==========================================

    const checkQuery = `
        SELECT id
        FROM public.users
        WHERE phone = ?
        LIMIT 1
    `;

    db.query(checkQuery, [cleanPhone], (checkErr, rows) => {

        if (checkErr) {
            return res.status(500).json({
                success: false,
                message: checkErr.message
            });
        }

        // Forgot password only for existing users
        if (!rows || rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Mobile number is not registered.'
            });
        }

        const updateQuery = `
            UPDATE public.users
            SET otp_code = ?,
                otp_expires_at = ?
            WHERE phone = ?
        `;

        db.query(
            updateQuery,
            [generatedOtp, expiresAt, cleanPhone],
            (updateErr) => {

                if (updateErr) {
                    return res.status(500).json({
                        success: false,
                        message: updateErr.message
                    });
                }


                res.json({
                    success: true,
                    message: 'OTP sent successfully!'
                });
            }
        );
    });
});

// ==========================================
// VERIFY OTP ONLY - FOR FORGOT PASSWORD
// ==========================================
app.post('/api/verify-otp', (req, res) => {

    const phone =
        String(req.body.phone || '').trim();

    const otp =
        String(req.body.otp || '').trim();

    if (!phone || !otp) {
        return res.status(400).json({
            success: false,
            message: 'Phone and OTP are required.'
        });
    }

    if (!/^\d{4}$/.test(otp)) {
        return res.status(400).json({
            success: false,
            message: 'Invalid OTP format.'
        });
    }

    const query = `
        SELECT id, phone, otp_code, otp_expires_at
        FROM public.users
        WHERE phone = ?
        LIMIT 1
    `;

    db.query(query, [phone], (err, rows) => {

        if (err) {
            console.error('OTP verify error:', err);

            return res.status(500).json({
                success: false,
                message: err.message
            });
        }

        if (!rows || rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Mobile number is not registered.'
            });
        }

        const user = rows[0];

        if (!user.otp_code) {
            return res.status(400).json({
                success: false,
                message: 'OTP not found. Please request a new OTP.'
            });
        }

        if (
            !user.otp_expires_at ||
            Date.now() > Number(user.otp_expires_at)
        ) {
            return res.status(400).json({
                success: false,
                message: 'OTP has expired. Please request a new one.'
            });
        }

        if (
            String(user.otp_code).trim() !== otp
        ) {
            return res.status(400).json({
                success: false,
                message: 'Invalid or incorrect OTP.'
            });
        }

        // Do NOT clear OTP yet.
        // It must remain valid until password is updated.

        return res.json({
            success: true,
            message: 'OTP verified successfully.'
        });
    });
});
// ==========================================
// VERIFY OTP & SET PASSWORD
// ==========================================
app.post('/api/verify-otp-set-password', (req, res) => {
    const phone = String(req.body.phone || '').trim();
    const otp = String(req.body.otp || '').trim();
    const password = String(req.body.password || '').trim();

    if (!phone || !otp) {
        return res.status(400).json({
            success: false,
            message: 'Phone and OTP are required.'
        });
    }

    if (!/^\d{4}$/.test(otp)) {
        return res.status(400).json({
            success: false,
            message: 'Invalid OTP format.'
        });
    }

    if (!password || password.length < 4) {
        return res.status(400).json({
            success: false,
            message: 'Password must be at least 4 characters.'
        });
    }

    const findUserQuery = `
        SELECT *
        FROM public.users
        WHERE phone = ?
        LIMIT 1
    `;

    db.query(findUserQuery, [phone], async (err, rows) => {

        if (err) {
            console.error('Find User Error:', err);

            return res.status(500).json({
                success: false,
                message: err.message
            });
        }

        if (!rows || rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'User not found.'
            });
        }

        const user = rows[0];

        if (!user.otp_code) {
            return res.status(400).json({
                success: false,
                message: 'OTP not found. Please request a new OTP.'
            });
        }

        if (
            !user.otp_expires_at ||
            Date.now() > Number(user.otp_expires_at)
        ) {
            return res.status(400).json({
                success: false,
                message: 'OTP has expired. Please request a new one.'
            });
        }

        if (String(user.otp_code).trim() !== otp) {
            return res.status(400).json({
                success: false,
                message: 'Invalid or incorrect OTP.'
            });
        }
        const hashedPassword = await bcrypt.hash(password, 12);

        const updateQuery = `
            UPDATE public.users
            SET password = ?,
                otp_code = NULL,
                otp_expires_at = NULL
            WHERE phone = ?
            RETURNING *
        `;

        db.query(
            updateQuery,
            [hashedPassword, phone],
            (updateErr, updatedRows) => {

                if (updateErr) {
                    console.error('Password Update Error:', updateErr);

                    return res.status(500).json({
                        success: false,
                        message: updateErr.message
                    });
                }

                if (!updatedRows || updatedRows.length === 0) {
                    return res.status(500).json({
                        success: false,
                        message: 'Password update failed.'
                    });
                }

                return res.json({
                    success: true,
                    message: 'Password updated successfully!',
                    user: updatedRows[0]
                });
            }
        );
    });
});

// ==========================================
// 3. GET USER ORDERS API ROUTE
// ==========================================
app.get('/api/orders/:phone', (req, res) => {
    const phone = req.params.phone;
    
    const query = 'SELECT * FROM orders WHERE phone = ? ORDER BY id DESC'; 
    db.query(query, [phone], (err, results) => {
        if (err) return res.status(500).json({ success: false, error: err.message });
        res.json({ success: true, orders: results });
    });
});

// ==========================================
// 4. CREATE ORDER API ROUTE (Checkout)
// ==========================================
app.post('/api/orders', (req, res) => {

    const {
        order_id,
        customer_id,
        customer_name,
        phone,
        whatsapp,
        address,
        district,
        pincode,
        order_date,
        status,
        payment_verification,
        items
    } = req.body;

    if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({
            success: false,
            message: 'Valid service items are required.'
        });
    }

    const cleanItems = items
        .map(item => ({
            product_id: String(item.product_id || '').trim(),
            quantity: Math.max(1, parseInt(item.quantity, 10) || 1)
        }))
        .filter(item => item.product_id);

    if (cleanItems.length === 0) {
        return res.status(400).json({
            success: false,
            message: 'Invalid service items.'
        });
    }

    const productIds = [...new Set(
        cleanItems.map(item => item.product_id)
    )];

    const placeholders = productIds.map(() => '?').join(',');

    const priceQuery = `
        SELECT service_id, service_name, price
        FROM public.services
        WHERE service_id IN (${placeholders})
    `;

    db.query(priceQuery, productIds, (priceErr, services) => {

        if (priceErr) {
            console.error('Order Price Error:', priceErr);

            return res.status(500).json({
                success: false,
                message: 'Unable to calculate order amount.'
            });
        }

        if (!services || services.length !== productIds.length) {
            return res.status(400).json({
                success: false,
                message: 'One or more services are invalid.'
            });
        }

        const serviceMap = {};

        services.forEach(service => {
            serviceMap[String(service.service_id)] = service;
        });

        let subtotal = 0;

        cleanItems.forEach(item => {
            subtotal +=
                (Number(serviceMap[item.product_id].price) || 0)
                * item.quantity;
        });

        const visitationFee = 49;
        const platformFee = 15;
        const taxes =
            Math.round((subtotal + visitationFee) * 0.05);

        const finalAmount =
            subtotal + visitationFee + platformFee + taxes;

        const combinedProductIds =
            cleanItems.map(item => item.product_id).join(', ');

        const combinedServiceName =
            cleanItems.map(item =>
                serviceMap[item.product_id].service_name
            ).join(', ');

        let safeStatus = 'Pending';

if (
    status === 'Paid' &&
    payment_verification &&
    payment_verification.razorpay_order_id &&
    payment_verification.razorpay_payment_id &&
    payment_verification.razorpay_signature
) {
    const verificationBody =
        payment_verification.razorpay_order_id +
        '|' +
        payment_verification.razorpay_payment_id;

    const expectedSignature = crypto
        .createHmac(
            'sha256',
            process.env.RAZORPAY_KEY_SECRET
        )
        .update(verificationBody)
        .digest('hex');

    if (
        expectedSignature ===
        payment_verification.razorpay_signature
    ) {
        safeStatus = 'Paid';
    } else {
        return res.status(400).json({
            success: false,
            message: 'Invalid Razorpay payment verification.'
        });
    }
}

        const query = `
            INSERT INTO orders
            (
                order_id,
                customer_id,
                product_id,
                service_name,
                customer_name,
                phone,
                whatsapp,
                address,
                district,
                pincode,
                amount,
                order_date,
                status,
                booked_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
        `;

        const values = [
            order_id,
            customer_id,
            combinedProductIds,
            combinedServiceName,
            customer_name,
            phone,
            whatsapp || '',
            address,
            district,
            pincode,
            finalAmount,
            order_date,
            safeStatus
        ];

        db.query(query, values, (err) => {

            if (err) {
                console.error(
                    'Insert Order Error:',
                    err.message
                );

                return res.status(500).json({
                    success: false,
                    error: err.message
                });
            }

            return res.json({
                success: true,
                message: 'Order placed successfully!',
                amount: finalAmount
            });
        });
    });
});

// ==========================================
// ADMIN LOGIN + AUTHENTICATION
// ==========================================

function safeCompare(valueA, valueB) {
    const a = Buffer.from(String(valueA || ''));
    const b = Buffer.from(String(valueB || ''));

    if (a.length !== b.length) {
        return false;
    }

    return crypto.timingSafeEqual(a, b);
}

function createAdminToken() {

    const payload = Buffer.from(
        JSON.stringify({
            role: 'admin',
            exp: Date.now() + (12 * 60 * 60 * 1000)
        })
    ).toString('base64url');

    const signature = crypto
        .createHmac(
            'sha256',
            process.env.ADMIN_TOKEN_SECRET
        )
        .update(payload)
        .digest('base64url');

    return `${payload}.${signature}`;
}

function verifyAdminToken(token) {

    try {

        const [payload, signature] =
            String(token || '').split('.');

        if (!payload || !signature) {
            return false;
        }

        const expectedSignature = crypto
            .createHmac(
                'sha256',
                process.env.ADMIN_TOKEN_SECRET
            )
            .update(payload)
            .digest('base64url');

        if (!safeCompare(signature, expectedSignature)) {
            return false;
        }

        const decoded = JSON.parse(
            Buffer.from(payload, 'base64url').toString('utf8')
        );

        return (
            decoded.role === 'admin' &&
            Number(decoded.exp) > Date.now()
        );

    } catch (error) {
        return false;
    }
}

app.post('/api/admin/login', (req, res) => {

    const username =
        String(req.body.username || '').trim();

    const password =
        String(req.body.password || '');

    if (
        !process.env.ADMIN_USERNAME ||
        !process.env.ADMIN_PASSWORD ||
        !process.env.ADMIN_TOKEN_SECRET
    ) {
        return res.status(500).json({
            success: false,
            message: 'Admin authentication is not configured.'
        });
    }

    const validUsername =
        safeCompare(
            username,
            process.env.ADMIN_USERNAME
        );

    const validPassword =
        safeCompare(
            password,
            process.env.ADMIN_PASSWORD
        );

    if (!validUsername || !validPassword) {

        return res.status(401).json({
            success: false,
            message: 'Invalid admin credentials.'
        });
    }

    const token = createAdminToken();

    return res.json({
        success: true,
        token
    });
});

function requireAdminAuth(req, res, next) {

    if (!process.env.ADMIN_TOKEN_SECRET) {
        return res.status(500).json({
            success: false,
            message: 'Admin authentication is not configured.'
        });
    }

    const authHeader =
        String(req.headers.authorization || '');

    const token =
        authHeader.startsWith('Bearer ')
            ? authHeader.slice(7)
            : '';

    if (!verifyAdminToken(token)) {

        return res.status(401).json({
            success: false,
            message: 'Unauthorized admin access.'
        });
    }

    next();
}

// Protect every /api/admin/* route below this line
app.use('/api/admin', requireAdminAuth);

// ==========================================
// ADMIN - GET ALL TECHNICIANS
// ==========================================
app.get('/api/admin/technicians', (req, res) => {

    const query = `
        SELECT *
        FROM public.technicians
        ORDER BY created_at DESC, id DESC
    `;

    db.query(query, [], (err, results) => {

        if (err) {
            console.error('Admin Technicians Fetch Error:', err);

            return res.status(500).json({
                success: false,
                message: 'Unable to load technicians.'
            });
        }

        return res.json({
            success: true,
            technicians: results || []
        });
    });
});

// ==========================================
// ADMIN - UPDATE TECHNICIAN STATUS
// ==========================================
app.post('/api/admin/update-technician-status', (req, res) => {

    const {
        technician_id,
        status
    } = req.body;

    const cleanTechnicianId =
        String(technician_id || '').trim();

    const cleanStatus =
        String(status || '').trim();

    const allowedStatuses = [
        'Pending',
        'Active',
        'Inactive'
    ];

    if (
        !cleanTechnicianId ||
        !allowedStatuses.includes(cleanStatus)
    ) {
        return res.status(400).json({
            success: false,
            message: 'Invalid technician status request.'
        });
    }

    const query = `
        UPDATE public.technicians
        SET status = ?,
            updated_at = NOW()
        WHERE technician_id = ?
        RETURNING technician_id, name, status
    `;

    db.query(
        query,
        [cleanStatus, cleanTechnicianId],
        (err, results) => {

            if (err) {
                console.error(
                    'Technician Status Update Error:',
                    err
                );

                return res.status(500).json({
                    success: false,
                    message: 'Unable to update technician status.'
                });
            }

            if (!results || results.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'Technician not found.'
                });
            }

            return res.json({
                success: true,
                message: 'Technician status updated successfully.',
                technician: results[0]
            });
        }
    );
});

// ==========================================
// GET ALL CUSTOMERS FOR ADMIN MASTER
// ==========================================
app.get('/api/admin/customers', (req, res) => {
    const usersQuery = 'SELECT * FROM users ORDER BY id DESC';
    const ordersQuery = 'SELECT phone FROM orders';

    db.query(usersQuery, (err, users) => {
        if (err) return res.status(500).json({ success: false, error: err.message });

        db.query(ordersQuery, (err2, orders) => {
            if (err2) return res.status(500).json({ success: false, error: err2.message });

            let orderCounts = {};
            orders.forEach(o => {
                let cleanPhone = String(o.phone || '').trim();
                if (cleanPhone) {
                    orderCounts[cleanPhone] = (orderCounts[cleanPhone] || 0) + 1;
                }
            });

            let enrichedUsers = users.map(u => {
                let userPhone = String(u.phone || '').trim();
                return {
                    ...u,
                    total_orders: orderCounts[userPhone] || 0
                };
            });

            res.json({ success: true, customers: enrichedUsers });
        });
    });
});

// ==========================================
// 6. UPDATE STATUS
// ==========================================
app.post('/api/admin/update-status', (req, res) => {

    const { order_id, status } = req.body;

    const cleanStatus =
        String(status || '').trim().toLowerCase();

    let query = '';
    const allowedStatuses = [
    'pending',
    'assigned',
    'on the way',
    'in service',
    'completed',
    're-service requested',
    'trash'
];

if (!allowedStatuses.includes(cleanStatus)) {
    return res.status(400).json({
        success: false,
        message: 'Invalid order status.'
    });
}

    if (cleanStatus === 'assigned') {

        query = `
            UPDATE orders
            SET status = ?,
                assigned_at = COALESCE(assigned_at, NOW())
            WHERE order_id = ?
            RETURNING *
        `;

    } else if (cleanStatus === 'on the way') {

        query = `
            UPDATE orders
            SET status = ?,
                on_the_way_at = COALESCE(on_the_way_at, NOW())
            WHERE order_id = ?
            RETURNING *
        `;

    } else if (
        cleanStatus === 'in service' ||
        cleanStatus === 'service' ||
        cleanStatus === 'active'
    ) {

        query = `
            UPDATE orders
            SET status = ?,
                service_started_at = COALESCE(service_started_at, NOW())
            WHERE order_id = ?
            RETURNING *
        `;

    } else if (cleanStatus === 'completed') {

        query = `
            UPDATE orders
            SET status = ?,
                completed_at = COALESCE(completed_at, NOW())
            WHERE order_id = ?
            RETURNING *
        `;

    } else {

        query = `
            UPDATE orders
            SET status = ?
            WHERE order_id = ?
            RETURNING *
        `;
    }

    db.query(
        query,
        [status, order_id],
        (err, results) => {

            if (err) {

                console.error(
                    'Order Status Update Error:',
                    err
                );

                return res.status(500).json({
                    success: false,
                    error: err.message
                });
            }

            if (!results || results.length === 0) {

                return res.status(404).json({
                    success: false,
                    message: 'Order not found'
                });
            }

            return res.json({
                success: true,
                message: 'Status updated successfully',
                order: results[0]
            });
        }
    );
});

// ==========================================
// 7. PERMANENT DELETE SINGLE ORDER
// ==========================================
app.post('/api/admin/delete-order', (req, res) => {
    const { order_id } = req.body;
    const query = 'DELETE FROM orders WHERE order_id = ?';
    db.query(query, [order_id], (err, result) => {
        if (err) return res.status(500).json({ success: false, error: err.message });
        res.json({ success: true, message: 'Order permanently deleted' });
    });
});

// ==========================================
// 8. BULK DELETE ORDERS FROM TRASH
// ==========================================
app.post('/api/admin/bulk-delete', (req, res) => {
    const { order_ids } = req.body;
    if (!order_ids || order_ids.length === 0) return res.json({ success: true });

    const placeholders = order_ids.map(() => '?').join(',');
    const query = `DELETE FROM orders WHERE order_id IN (${placeholders})`;
    
    db.query(query, order_ids, (err, result) => {
        if (err) return res.status(500).json({ success: false, error: err.message });
        res.json({ success: true, message: 'Bulk delete successful' });
    });
});

// Secure Razorpay Initialization
const razorpayInstance = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET
});

// ==========================================
// 9. RAZORPAY PAYMENT ORDER CREATION API
// ==========================================
app.post('/api/create-razorpay-order', async (req, res) => {

    const { items } = req.body;

    if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({
            success: false,
            message: 'No service items provided.'
        });
    }

    const cleanItems = items
        .map(item => ({
            product_id: String(item.product_id || '').trim(),
            quantity: Math.max(1, parseInt(item.quantity, 10) || 1)
        }))
        .filter(item => item.product_id);

    if (cleanItems.length === 0) {
        return res.status(400).json({
            success: false,
            message: 'Invalid service items.'
        });
    }

    const productIds = [...new Set(
        cleanItems.map(item => item.product_id)
    )];

    const placeholders = productIds.map(() => '?').join(',');

    const priceQuery = `
        SELECT service_id, price
        FROM public.services
        WHERE service_id IN (${placeholders})
    `;

    db.query(priceQuery, productIds, async (err, services) => {

        if (err) {
            console.error('Razorpay Price Fetch Error:', err);

            return res.status(500).json({
                success: false,
                message: 'Unable to calculate payment amount.'
            });
        }

        if (!services || services.length !== productIds.length) {
            return res.status(400).json({
                success: false,
                message: 'One or more services are invalid.'
            });
        }

        const priceMap = {};

        services.forEach(service => {
            priceMap[String(service.service_id)] =
                Number(service.price) || 0;
        });

        let subtotal = 0;

        cleanItems.forEach(item => {
            subtotal +=
                priceMap[item.product_id] * item.quantity;
        });

        const visitationFee = 49;
const platformFee = 15;
const taxes = Math.round((subtotal + visitationFee) * 0.05);

const finalAmount =
    subtotal + visitationFee + platformFee + taxes;

        if (!Number.isFinite(finalAmount) || finalAmount <= 0) {
            return res.status(400).json({
                success: false,
                message: 'Invalid payment amount.'
            });
        }

        const options = {
            amount: Math.round(finalAmount * 100),
            currency: 'INR',
            receipt:
                'receipt_' +
                Math.random().toString(36).substring(7)
        };

        try {

            const order =
                await razorpayInstance.orders.create(options);

            return res.json({
                success: true,
                id: order.id,
                amount: order.amount
            });

        } catch (error) {

            console.error('Razorpay Error:', error);

            return res.status(500).json({
                success: false,
                message: 'Unable to create payment order.'
            });
        }
    });
});

app.post('/api/calculate-order-total', (req, res) => {

    const { items } = req.body;

    if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({
            success: false,
            message: 'No service items provided.'
        });
    }

    const cleanItems = items
        .map(item => ({
            product_id: String(item.product_id || '').trim(),
            quantity: Math.max(1, parseInt(item.quantity, 10) || 1)
        }))
        .filter(item => item.product_id);

    if (cleanItems.length === 0) {
        return res.status(400).json({
            success: false,
            message: 'Invalid service items.'
        });
    }

    const productIds = [...new Set(
        cleanItems.map(item => item.product_id)
    )];

    const placeholders = productIds.map(() => '?').join(',');

    const query = `
        SELECT service_id, price
        FROM public.services
        WHERE service_id IN (${placeholders})
    `;

    db.query(query, productIds, (err, services) => {

        if (err) {
            console.error('Order Total Error:', err);

            return res.status(500).json({
                success: false,
                message: 'Unable to calculate order total.'
            });
        }

        if (!services || services.length !== productIds.length) {
            return res.status(400).json({
                success: false,
                message: 'One or more services are invalid.'
            });
        }

        const priceMap = {};

        services.forEach(service => {
            priceMap[String(service.service_id)] =
                Number(service.price) || 0;
        });

        let subtotal = 0;

        cleanItems.forEach(item => {
            subtotal +=
                priceMap[item.product_id] * item.quantity;
        });

        const visitationFee = 49;
        const platformFee = 15;
        const taxes = Math.round((subtotal + visitationFee) * 0.05);

        const finalAmount =
            subtotal + visitationFee + platformFee + taxes;

        return res.json({
            success: true,
            subtotal,
            visitationFee,
            platformFee,
            taxes,
            finalAmount
        });
    });
});

// ==========================================
// RAZORPAY PAYMENT SIGNATURE VERIFICATION
// ==========================================
app.post('/api/verify-razorpay-payment', (req, res) => {

    const {
        razorpay_order_id,
        razorpay_payment_id,
        razorpay_signature
    } = req.body;

    if (
        !razorpay_order_id ||
        !razorpay_payment_id ||
        !razorpay_signature
    ) {
        return res.status(400).json({
            success: false,
            message: 'Payment verification details are missing.'
        });
    }

    const body =
        razorpay_order_id + '|' + razorpay_payment_id;

    const expectedSignature = crypto
        .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
        .update(body)
        .digest('hex');

    if (expectedSignature !== razorpay_signature) {
        return res.status(400).json({
            success: false,
            message: 'Payment verification failed.'
        });
    }

    return res.json({
        success: true,
        message: 'Payment verified successfully.'
    });
});

// ==========================================
// SERVICES API ROUTES
// ==========================================
// ==========================================
// SERVICE GROUPS / HOME ICONS API
// ==========================================

// Get all active home service groups/icons
app.get('/api/service-groups', (req, res) => {

    const query = `
        SELECT
            id,
            group_id,
            group_name,
            icon_url,
            display_order,
            is_active
        FROM public.service_groups
        WHERE is_active = TRUE
        ORDER BY display_order ASC, id ASC
    `;

    db.query(query, [], (err, results) => {

        if (err) {
            console.error('Service Groups Fetch Error:', err);

            return res.status(500).json({
                success: false,
                error: err.message
            });
        }

        res.json({
            success: true,
            groups: results
        });
    });
});


// Get all service groups for Admin
app.get('/api/admin/service-groups', (req, res) => {

    const query = `
        SELECT *
        FROM public.service_groups
        ORDER BY display_order ASC, id ASC
    `;

    db.query(query, [], (err, results) => {

        if (err) {
            console.error('Admin Service Groups Fetch Error:', err);

            return res.status(500).json({
                success: false,
                error: err.message
            });
        }

        res.json({
            success: true,
            groups: results
        });
    });
});

// ==========================================
// ADMIN - ADD NEW HOME ICON / SERVICE GROUP
// ==========================================

app.post('/api/admin/add-service-group', (req, res) => {

    const {
        group_id,
        group_name,
        icon_url,
        display_order,
        is_active
    } = req.body;

    const cleanGroupId = String(group_id || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');

    const cleanGroupName = String(group_name || '').trim();
    const cleanIconUrl = String(icon_url || '').trim();

    if (!cleanGroupId || !cleanGroupName) {
        return res.status(400).json({
            success: false,
            message: 'Group ID and Group Name are required.'
        });
    }

    const query = `
        INSERT INTO public.service_groups
        (
            group_id,
            group_name,
            icon_url,
            display_order,
            is_active
        )
        VALUES (?, ?, ?, ?, ?)
        RETURNING *
    `;

    db.query(
        query,
        [
            cleanGroupId,
            cleanGroupName,
            cleanIconUrl,
            Number(display_order) || 0,
            is_active === false ? false : true
        ],
        (err, results) => {

            if (err) {

                console.error(
                    'Add Service Group Error:',
                    err
                );

                // PostgreSQL unique violation
                if (err.code === '23505') {
                    return res.status(400).json({
                        success: false,
                        message: 'This Group ID already exists.'
                    });
                }

                return res.status(500).json({
                    success: false,
                    error: err.message
                });
            }

            return res.json({
                success: true,
                message: 'Home icon added successfully!',
                group: results && results[0]
                    ? results[0]
                    : null
            });
        }
    );
});


// ==========================================
// ADMIN - UPDATE HOME ICON / SERVICE GROUP
// ==========================================

app.post('/api/admin/update-service-group', (req, res) => {

    const {
        old_group_id,
        group_id,
        group_name,
        icon_url,
        display_order,
        is_active
    } = req.body;

    const cleanOldGroupId =
        String(old_group_id || '').trim();

    const cleanGroupId = String(group_id || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');

    const cleanGroupName =
        String(group_name || '').trim();

    const cleanIconUrl =
        String(icon_url || '').trim();

    if (
        !cleanOldGroupId ||
        !cleanGroupId ||
        !cleanGroupName
    ) {
        return res.status(400).json({
            success: false,
            message:
                'Old Group ID, Group ID and Group Name are required.'
        });
    }

    const query = `
        UPDATE public.service_groups
        SET
            group_id = ?,
            group_name = ?,
            icon_url = ?,
            display_order = ?,
            is_active = ?
        WHERE group_id = ?
        RETURNING *
    `;

    db.query(
        query,
        [
            cleanGroupId,
            cleanGroupName,
            cleanIconUrl,
            Number(display_order) || 0,
            is_active === false ? false : true,
            cleanOldGroupId
        ],
        (err, results) => {

            if (err) {

                console.error(
                    'Update Service Group Error:',
                    err
                );

                if (err.code === '23505') {
                    return res.status(400).json({
                        success: false,
                        message:
                            'Another Home Icon already uses this Group ID.'
                    });
                }

                return res.status(500).json({
                    success: false,
                    error: err.message
                });
            }

            if (!results || results.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'Home Icon not found.'
                });
            }

            return res.json({
                success: true,
                message: 'Home icon updated successfully!',
                group: results[0]
            });
        }
    );
});

// ==========================================
// ADMIN - TOGGLE HOME ICON ACTIVE / HIDDEN
// ==========================================

app.post('/api/admin/toggle-service-group', (req, res) => {

    const {
        group_id,
        is_active
    } = req.body;

    const cleanGroupId =
        String(group_id || '').trim();

    if (!cleanGroupId) {
        return res.status(400).json({
            success: false,
            message: 'Group ID is required.'
        });
    }

    const query = `
        UPDATE public.service_groups
        SET is_active = ?
        WHERE group_id = ?
        RETURNING *
    `;

    db.query(
        query,
        [
            is_active === true,
            cleanGroupId
        ],
        (err, results) => {

            if (err) {
                console.error(
                    'Toggle Service Group Error:',
                    err
                );

                return res.status(500).json({
                    success: false,
                    error: err.message
                });
            }

            if (!results || results.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'Home Icon not found.'
                });
            }

            return res.json({
                success: true,
                message:
                    is_active === true
                        ? 'Home icon activated successfully!'
                        : 'Home icon hidden successfully!',
                group: results[0]
            });
        }
    );
});


// ==========================================
// ADMIN - SAFE DELETE HOME ICON
// ==========================================

app.post('/api/admin/delete-service-group', (req, res) => {

    const {
        group_id
    } = req.body;

    const cleanGroupId =
        String(group_id || '').trim();

    if (!cleanGroupId) {
        return res.status(400).json({
            success: false,
            message: 'Group ID is required.'
        });
    }

    // First check whether any services are using this group
    const checkQuery = `
        SELECT COUNT(*)::int AS service_count
        FROM public.services
        WHERE group_id = ?
    `;

    db.query(
        checkQuery,
        [cleanGroupId],
        (checkErr, checkResults) => {

            if (checkErr) {
                console.error(
                    'Service Group Delete Check Error:',
                    checkErr
                );

                return res.status(500).json({
                    success: false,
                    error: checkErr.message
                });
            }

            const serviceCount =
                checkResults &&
                checkResults[0]
                    ? Number(checkResults[0].service_count)
                    : 0;

            if (serviceCount > 0) {
                return res.status(400).json({
                    success: false,
                    message:
                        `Cannot delete this Home Icon. ${serviceCount} service(s) are using this group. Reassign those services first.`
                });
            }

            const deleteQuery = `
                DELETE FROM public.service_groups
                WHERE group_id = ?
                RETURNING *
            `;

            db.query(
                deleteQuery,
                [cleanGroupId],
                (deleteErr, deleteResults) => {

                    if (deleteErr) {
                        console.error(
                            'Delete Service Group Error:',
                            deleteErr
                        );

                        return res.status(500).json({
                            success: false,
                            error: deleteErr.message
                        });
                    }

                    if (
                        !deleteResults ||
                        deleteResults.length === 0
                    ) {
                        return res.status(404).json({
                            success: false,
                            message: 'Home Icon not found.'
                        });
                    }

                    return res.json({
                        success: true,
                        message:
                            'Home icon deleted successfully!'
                    });
                }
            );
        }
    );
});

app.get('/api/services', (req, res) => {
    const query = 'SELECT * FROM services';
    db.query(query, (err, results) => {
        if (err) return res.status(500).json({ success: false, error: err.message });
        res.json({ success: true, services: results });
    });
});

app.get('/api/home-services', (req, res) => {
    const query = `
        SELECT * FROM (
            SELECT *, 
            ROW_NUMBER() OVER(PARTITION BY category ORDER BY id DESC) as rn 
            FROM services
        ) t WHERE t.rn <= 4
    `;
    
    db.query(query, (err, results) => {
        if (err) {
            const fallbackQuery = 'SELECT * FROM services';
            return db.query(fallbackQuery, (err2, results2) => {
                if (err2) return res.status(500).json({ success: false, error: err2.message });
                res.json({ success: true, services: results2 });
            });
        }
        res.json({ success: true, services: results});
    });
});

app.post('/api/admin/update-service', (req, res) => {

    const { 
        old_service_id,
        service_id,
        service_name,
        category,
        group_id,
        price,
        mrp,
        is_hot_deal,
        select_options,
        why_choose_us,
        discount_text,
        image_url,
        image_url_2,
        image_url_3,
        image_url_4,
        enable_select_options,
        product_note 
    } = req.body;

    const query = `
        UPDATE services
        SET
            service_id = ?,
            service_name = ?,
            category = ?,
            group_id = ?,
            price = ?,
            mrp = ?,
            is_hot_deal = ?,
            select_options = ?,
            why_choose_us = ?,
            discount_text = ?,
            image_url = ?,
            image_url_2 = ?,
            image_url_3 = ?,
            image_url_4 = ?,
            enable_select_options = ?,
            product_note = ?
        WHERE service_id = ?
    `;

    db.query(query, [
        service_id,
        service_name,
        category,
        group_id || null,
        price,
        mrp,
        is_hot_deal,
        select_options,
        why_choose_us,
        discount_text || '3% off',
        image_url,
        image_url_2 || '',
        image_url_3 || '',
        image_url_4 || '',
        enable_select_options ?? 1,
        product_note || '',
        old_service_id
    ], (err, result) => {

        if (err) {
            console.error('Update Service Error:', err.message);

            return res.status(500).json({
                success: false,
                error: err.message
            });
        }

        res.json({
            success: true,
            message: 'Service updated successfully!'
        });
    });
});

app.get('/api/admin/orders', (req, res) => {
    const query = 'SELECT * FROM orders ORDER BY id DESC';
    db.query(query, (err, results) => {
        if (err) return res.status(500).json({ success: false, error: err.message });
        res.json({ success: true, orders: results });
    });
});

app.post('/api/admin/assign-technician-manual', (req, res) => {
    const { order_id, technician_name, technician_phone, eta } = req.body;
    const query = `
    UPDATE orders
    SET technician_name = ?,
        technician_phone = ?,
        eta = ?,
        status = ?,
        assigned_at = COALESCE(assigned_at, NOW())
    WHERE order_id = ?
`;
    db.query(query, [technician_name, technician_phone, eta, 'Assigned', order_id], (err, result) => {
        if (err) return res.status(500).json({ success: false, error: err.message });
        res.json({ success: true, message: 'Technician assigned successfully!' });
    });
});

// ==========================================
// HERO BANNERS API ROUTES
// ==========================================
app.get('/api/hero-banners', (req, res) => {
    const query = 'SELECT * FROM hero_banners ORDER BY id DESC';
    db.query(query, (err, results) => {
        if (err) return res.status(500).json({ success: false, error: err.message });
        res.json({ success: true, banners: results });
    });
});

app.post('/api/admin/add-banner', (req, res) => {
    const { title, subtitle, image_url, product_id, bg_color, text_color, button_text } = req.body;
    const query = 'INSERT INTO hero_banners (title, subtitle, image_url, product_id, bg_color, text_color, button_text) VALUES (?, ?, ?, ?, ?, ?, ?)';
    
    db.query(query, [title, subtitle, image_url, product_id, bg_color || '#f4f3f1', text_color || '#111', button_text || 'Book now'], (err, result) => {
        if (err) return res.status(500).json({ success: false, error: err.message });
        res.json({ success: true, message: 'New banner added successfully!' });
    });
});

app.post('/api/admin/delete-banner', (req, res) => {
    const { id } = req.body;
    const query = 'DELETE FROM hero_banners WHERE id = ?';
    db.query(query, [id], (err, result) => {
        if (err) return res.status(500).json({ success: false, error: err.message });
        res.json({ success: true, message: 'Banner deleted successfully!' });
    });
});

app.post('/api/admin/edit-banner', (req, res) => {
    const { id, title, subtitle, image_url, product_id, bg_color, text_color, button_text } = req.body;
    const query = 'UPDATE hero_banners SET title = ?, subtitle = ?, image_url = ?, product_id = ?, bg_color = ?, text_color = ?, button_text = ? WHERE id = ?';
    
    db.query(query, [title, subtitle, image_url, product_id, bg_color, text_color, button_text, id], (err, result) => {
        if (err) return res.status(500).json({ success: false, error: err.message });
        res.json({ success: true, message: 'Banner updated successfully!' });
    });
});

// ==========================================
// REVIEWS API ROUTES
// ==========================================
app.get('/api/reviews/:service_id', (req, res) => {

    const serviceId = req.params.service_id;

    const query =
        'SELECT * FROM product_reviews WHERE service_id = ? ORDER BY id DESC';

    db.query(query, [serviceId], (err, results) => {

        if (err) {
            return res.status(500).json({
                success: false,
                error: err.message
            });
        }

        const validReviews = (results || []).filter(r => {

            const rating = Number(r.rating);

            return (
                Number.isFinite(rating) &&
                rating >= 1 &&
                rating <= 5
            );
        });

        const reviewCount = validReviews.length;

        const totalRating = validReviews.reduce(
            (sum, r) => sum + Number(r.rating),
            0
        );

        const averageRating =
            reviewCount > 0
                ? totalRating / reviewCount
                : 0;

        res.json({
            success: true,
            average_rating: Number(averageRating.toFixed(1)),
            review_count: reviewCount,
            reviews: validReviews
        });
    });
});

app.post('/api/reviews', (req, res) => {

    const {
        service_id,
        order_id,
        phone,
        rating,
        review_text
    } = req.body;

    const cleanServiceId = String(service_id || '').trim();
    const cleanOrderId = String(order_id || '').trim();
    const cleanPhone = String(phone || '').trim();
    const cleanReview = String(review_text || '').trim();
    const ratingValue = Number(rating);

    if (
        !cleanServiceId ||
        !cleanOrderId ||
        !cleanPhone ||
        !Number.isInteger(ratingValue) ||
        ratingValue < 1 ||
        ratingValue > 5
    ) {
        return res.status(400).json({
            success: false,
            message: 'Invalid review details.'
        });
    }

    const orderQuery = `
        SELECT
            order_id,
            product_id,
            customer_name,
            phone,
            status
        FROM orders
        WHERE order_id = ?
          AND phone = ?
        LIMIT 1
    `;

    db.query(
        orderQuery,
        [cleanOrderId, cleanPhone],
        (orderErr, orders) => {

            if (orderErr) {
                console.error('Review Order Check Error:', orderErr);

                return res.status(500).json({
                    success: false,
                    message: orderErr.message
                });
            }

            if (!orders || orders.length === 0) {
                return res.status(403).json({
                    success: false,
                    message: 'This booking does not belong to this customer.'
                });
            }

            const order = orders[0];

            if (
                String(order.status || '').trim().toLowerCase()
                !== 'completed'
            ) {
                return res.status(400).json({
                    success: false,
                    message: 'Review is allowed only after service completion.'
                });
            }

            if (
                String(order.product_id || '').trim()
                !== cleanServiceId
            ) {
                return res.status(400).json({
                    success: false,
                    message: 'Service does not match this booking.'
                });
            }

            const insertQuery = `
                INSERT INTO product_reviews
                (
                    service_id,
                    order_id,
                    customer_name,
                    rating,
                    review_text
                )
                VALUES (?, ?, ?, ?, ?)
            `;

            db.query(
                insertQuery,
                [
                    cleanServiceId,
                    cleanOrderId,
                    order.customer_name || 'CATUS Customer',
                    ratingValue,
                    cleanReview
                ],
                (insertErr) => {

                    if (insertErr) {

                        if (
                            insertErr.code === '23505' ||
                            String(insertErr.message || '')
                                .toLowerCase()
                                .includes('unique')
                        ) {
                            return res.status(409).json({
                                success: false,
                                message: 'You have already reviewed this booking.'
                            });
                        }

                        console.error(
                            'Review Insert Error:',
                            insertErr
                        );

                        return res.status(500).json({
                            success: false,
                            message: insertErr.message
                        });
                    }

                    return res.json({
                        success: true,
                        message: 'Verified review added successfully!'
                    });
                }
            );
        }
    );
});

// ==========================================
// SEO - DYNAMIC SITEMAP
// ==========================================

app.get('/api/sitemap.xml', (req, res) => {

    const query = `
        SELECT
            l.slug AS location_slug,
            l.district,
            l.state,
            s.service_id,
            s.slug AS service_slug
        FROM public.locations l
        INNER JOIN public.location_services ls
            ON ls.location_id = l.id
        INNER JOIN public.services s
            ON s.service_id = ls.service_id
        WHERE l.is_active = TRUE
          AND ls.is_available = TRUE
        ORDER BY l.state, l.district, l.slug, s.service_id
    `;

    db.query(query, [], (err, results) => {

        if (err) {
            console.error('Sitemap generation error:', err);

            return res.status(500)
                .type('text/plain')
                .send('Sitemap generation failed');
        }

        const frontendBase =
            'https://catus-frontend-nu.vercel.app';

        const slugify = (value) =>
            String(value || '')
                .trim()
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, '-')
                .replace(/^-+|-+$/g, '');

        const escapeXml = (value) =>
            String(value || '')
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&apos;');

        const urls = [
            `${frontendBase}/`
        ];

        (results || []).forEach(row => {

            const stateSlug =
                slugify(row.state);

            const districtSlug =
                slugify(row.district);

            const locationSlug =
                slugify(row.location_slug);

            const serviceSlug =
                slugify(row.service_slug);

            if (
                stateSlug &&
                districtSlug &&
                locationSlug &&
                serviceSlug
            ) {
                urls.push(
                    `${frontendBase}/${stateSlug}/${districtSlug}/${locationSlug}/${serviceSlug}`
                );
            }
        });

        const uniqueUrls =
            [...new Set(urls)];

        const xml =
`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${uniqueUrls.map(url => `  <url>
    <loc>${escapeXml(url)}</loc>
  </url>`).join('\n')}
</urlset>`;

        res
            .status(200)
            .set('Content-Type', 'application/xml; charset=utf-8')
            .send(xml);
    });
});

// Root URL check
app.get('/', (req, res) => {
    res.send('Catus Backend Server is running successfully!');
});

app.post('/api/admin/add-service', (req, res) => {

    const { 
        service_id,
        service_name,
        category,
        group_id,
        price,
        mrp,
        is_hot_deal,
        select_options,
        why_choose_us,
        discount_text,
        image_url,
        image_url_2,
        image_url_3,
        image_url_4,
        enable_select_options,
        product_note 
    } = req.body;

    const query = `
        INSERT INTO services
        (
            service_id,
            service_name,
            category,
            group_id,
            price,
            mrp,
            is_hot_deal,
            select_options,
            why_choose_us,
            discount_text,
            image_url,
            image_url_2,
            image_url_3,
            image_url_4,
            enable_select_options,
            product_note
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    db.query(query, [
        service_id,
        service_name,
        category || 'General',
        group_id || null,
        price || 0,
        mrp || 0,
        is_hot_deal ?? 1,
        select_options || 'Standard Service',
        why_choose_us ||
            'Verified Professionals: Background-verified expert technicians.|30-Day Warranty: Post-service warranty on all repairs.',
        discount_text || '3% off',
        image_url,
        image_url_2 || '',
        image_url_3 || '',
        image_url_4 || '',
        enable_select_options ?? 1,
        product_note || ''
    ], (err, result) => {

        if (err) {
            console.error('Add Service Error:', err.message);

            return res.status(500).json({
                success: false,
                error: err.message
            });
        }

        res.json({
            success: true,
            message: 'New service added successfully!'
        });
    });
});

// Transactions Routes
app.post('/api/transactions', (req, res) => {
    const { transaction_id, customer_id, customer_name, mobile, email, product_name, amount, payment_mode, status, date_time } = req.body;
    const query = `INSERT INTO transactions (transaction_id, customer_id, customer_name, mobile, email, product_name, amount, payment_mode, status, date_time) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    
    db.query(query, [transaction_id, customer_id, customer_name, mobile, email, product_name, amount, payment_mode, status, date_time], (err, result) => {
        if (err) return res.status(500).json({ success: false, error: err.message });
        res.json({ success: true, message: 'Transaction saved successfully!' });
    });
});

app.get('/api/admin/transactions', (req, res) => {
    const query = 'SELECT * FROM transactions ORDER BY id DESC';
    db.query(query, (err, results) => {
        if (err) return res.status(500).json({ success: false, error: err.message });
        res.json({ success: true, transactions: results });
    });
});

app.get('/api/admin/dashboard-stats', (req, res) => {
    const query = `
        SELECT 
            (SELECT COALESCE(SUM(amount), 0) FROM orders WHERE status != 'Trash' AND status != 'Cancelled' AND status != 'Rejected') as total_revenue,
            0 as total_liability,
            (SELECT COALESCE(SUM(amount), 0) FROM orders WHERE status != 'Trash' AND status != 'Cancelled' AND status != 'Rejected' AND DATE(order_date) = CURRENT_DATE) as todays_collection
    `;
    
    db.query(query, (err, results) => {
        if (err) return res.status(500).json({ success: false, error: err.message });
        res.json({ success: true, stats: results[0] });
    });
});

app.post('/api/admin/update-order-address', (req, res) => {
    const { order_id, address, district, pincode } = req.body;
    const query = 'UPDATE orders SET address = ?, district = ?, pincode = ? WHERE order_id = ?';
    db.query(query, [address, district, pincode, order_id], (err, result) => {
        if (err) return res.status(500).json({ success: false, error: err.message });
        res.json({ success: true, message: 'Order address updated successfully!' });
    });
});
// ==========================================
// DATABASE LOCATION TABLE TEST
// ==========================================

app.get('/api/test-location-table', (req, res) => {

    const query = `
        SELECT table_schema, table_name
        FROM information_schema.tables
        WHERE table_name IN ('locations', 'location_services')
        ORDER BY table_name
    `;

    db.query(query, [], (err, results) => {

        if (err) {
            console.error('Table test error:', err);

            return res.status(500).json({
                success: false,
                error: err.message
            });
        }

        return res.json({
            success: true,
            tables: results
        });
    });
});
// ==========================================
// TEMPORARY DATABASE TABLE TEST
// ==========================================

app.get('/api/test-public-tables', (req, res) => {

    const query = `
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
        ORDER BY table_name
    `;

    db.query(query, [], (err, results) => {

        if (err) {
            console.error('Public tables test error:', err);

            return res.status(500).json({
                success: false,
                error: err.message
            });
        }

        return res.json({
            success: true,
            tables: results
        });
    });
});

// ==========================================
// CATUS LOCATION SEARCH API
// ==========================================
app.get('/api/search-locations', (req, res) => {

    const search = String(req.query.q || '').trim();

    if (search.length < 2) {
        return res.json({
            success: true,
            locations: []
        });
    }

    const query = `
        SELECT
            id,
            name,
            slug,
            district,
            state,
            pincode
        FROM public.locations
        WHERE is_active = TRUE
          AND (
              name ILIKE ?
              OR slug ILIKE ?
              OR district ILIKE ?
              OR pincode ILIKE ?
          )
        ORDER BY
            CASE
                WHEN LOWER(name) = LOWER(?) THEN 0
                WHEN LOWER(name) LIKE LOWER(?) THEN 1
                ELSE 2
            END,
            name ASC
        LIMIT 30
    `;

    const contains = `%${search}%`;
    const startsWith = `${search}%`;

    db.query(
        query,
        [
            contains,
            contains,
            contains,
            contains,
            search,
            startsWith
        ],
        (err, results) => {

            if (err) {
                console.error(
                    'Location search error:',
                    err
                );

                return res.status(500).json({
                    success: false,
                    error: err.message
                });
            }

            return res.json({
                success: true,
                locations: results || []
            });
        }
    );
});

// ==========================================
// CATUS LOCATION VALIDATION API
// ==========================================
app.get('/api/match-location', (req, res) => {
    const name = String(req.query.name || '').trim();
    const district = String(req.query.district || '').trim();
    const state = String(req.query.state || '').trim();
    const pincode = String(req.query.pincode || '').trim();

    if (!name || !district || !state) {
        return res.status(400).json({
            success: false,
            message: 'Name, district, and state are required fields.'
        });
    }

    const query = `
        SELECT id, name, slug, district, state, pincode
        FROM public.locations
        WHERE is_active = TRUE
          AND REGEXP_REPLACE(LOWER(TRIM(name)), '[^a-z0-9]', '', 'g') = REGEXP_REPLACE(LOWER(TRIM(?)), '[^a-z0-9]', '', 'g')
          AND REGEXP_REPLACE(LOWER(TRIM(district)), '[^a-z0-9]', '', 'g') = REGEXP_REPLACE(LOWER(TRIM(?)), '[^a-z0-9]', '', 'g')
          AND REGEXP_REPLACE(LOWER(TRIM(state)), '[^a-z0-9]', '', 'g') = REGEXP_REPLACE(LOWER(TRIM(?)), '[^a-z0-9]', '', 'g')
    `;

    db.query(query, [name, district, state], (err, results) => {
        if (err) {
            console.error('Match location error:', err);
            return res.status(500).json({ success: false, error: err.message });
        }

        if (!results || results.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Location not found in Catus service database.'
            });
        }

        if (results.length === 1) {
            return res.json({
                success: true,
                location: results[0]
            });
        }

        if (pincode) {
            const pincodeMatches = results.filter(row => String(row.pincode || '').trim() === pincode);
            if (pincodeMatches.length === 1) {
                return res.json({
                    success: true,
                    location: pincodeMatches[0]
                });
            }
        }

        return res.status(409).json({
            success: false,
            ambiguous: true,
            message: 'Multiple Catus locations matched.',
            locations: results
        });
    });
});

// ==========================================
// LOCATION + SERVICE SEO LANDING PAGE API
// ==========================================

app.get('/api/location-page/:state/:district/:location/:service', (req, res) => {

    const stateSlug = String(req.params.state || '')
        .trim()
        .toLowerCase();

    const districtSlug = String(req.params.district || '')
        .trim()
        .toLowerCase();

    const locationSlug = String(req.params.location || '')
        .trim()
        .toLowerCase();

    const serviceSlug = String(req.params.service || '')
        .trim()
        .toLowerCase();

    if (!stateSlug || !districtSlug || !locationSlug || !serviceSlug) {
        return res.status(400).json({
            success: false,
            message: 'State, district, location and service are required.'
        });
    }

    const query = `
        SELECT
            l.id AS location_id,
            l.name AS location_name,
            l.slug AS location_slug,
            l.district,
            l.state,
            l.pincode,

            s.service_id,
            s.service_name,
            s.category,
            s.price AS service_price,
            s.mrp,
            s.image_url,
            s.image_url_2,
            s.image_url_3,
            s.image_url_4,
            s.why_choose_us,
            s.discount_text,
            s.product_note,

            ls.price AS location_price,
            ls.is_available,
            ls.seo_title,
            ls.seo_description,
            ls.content

        FROM locations l

        INNER JOIN location_services ls
            ON ls.location_id = l.id

        INNER JOIN services s
            ON s.service_id = ls.service_id

        WHERE
            LOWER(
                REGEXP_REPLACE(
                    TRIM(l.state),
                    '[^a-zA-Z0-9]+',
                    '-',
                    'g'
                )
            ) = ?

            AND LOWER(
                REGEXP_REPLACE(
                    TRIM(l.district),
                    '[^a-zA-Z0-9]+',
                    '-',
                    'g'
                )
            ) = ?

            AND LOWER(l.slug) = ?

            AND LOWER(s.slug) = ?

            AND l.is_active = TRUE
            AND ls.is_available = TRUE

        LIMIT 1
    `;

    db.query(
        query,
        [
            stateSlug,
            districtSlug,
            locationSlug,
            serviceSlug
        ],
        (err, results) => {

            if (err) {
                console.error(
                    'Location SEO API Error:',
                    err
                );

                return res.status(500).json({
                    success: false,
                    message: 'Database error',
                    error: err.message
                });
            }

            if (!results || results.length === 0) {
                return res.status(404).json({
                    success: false,
                    message:
                        'This service is not available in this location.'
                });
            }

            return res.json({
                success: true,
                page: results[0]
            });
        }
    );
});

app.get('/api/test-database', (req, res) => {

    const query = `
        SELECT
            current_database() AS database_name,
            current_schema() AS schema_name,
            current_user AS database_user,
            inet_server_addr() AS server_address
    `;

    db.query(query, [], (err, results) => {

        if (err) {
            console.error('Database identity error:', err);

            return res.status(500).json({
                success: false,
                error: err.message
            });
        }

        res.json({
            success: true,
            database: results[0]
        });
    });
});
app.get('/api/test-location-db', (req, res) => {

    const query = `
        SELECT
            current_database() AS database_name,
            current_schema() AS schema_name,
            current_user AS database_user,
            inet_server_addr() AS server_address,
            inet_server_port() AS server_port
    `;

    db.query(query, [], (err, results) => {

        if (err) {
            return res.status(500).json({
                success: false,
                error: err.message
            });
        }

        res.json({
            success: true,
            database: results[0]
        });
    });
});

app.get('/api/check-location-tables', (req, res) => {

    const query = `
        SELECT
            table_schema,
            table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
        AND table_name IN (
            'locations',
            'location_services',
            'services'
        )
        ORDER BY table_name
    `;

    db.query(query, [], (err, results) => {

        if (err) {
            console.error('Location table check error:', err);

            return res.status(500).json({
                success: false,
                error: err.message
            });
        }

        res.json({
            success: true,
            tables: results
        });
    });
});
app.get('/api/test-location-direct', (req, res) => {
    const query = `
        SELECT
            current_database() AS database_name,
            current_schema() AS schema_name,
            current_user AS database_user,
            inet_server_addr() AS server_address,
            inet_server_port() AS server_port,
            to_regclass('public.locations') AS locations_table,
            to_regclass('public.location_services') AS location_services_table,
            to_regclass('public.services') AS services_table
    `;

    db.query(query, [], (err, results) => {
        if (err) {
            console.error('Location direct test error:', err);

            return res.status(500).json({
                success: false,
                error: err.message
            });
        }

        res.json({
            success: true,
            database: results[0]
        });
    });
});
// Explicitly bind to '0.0.0.0' to prevent Render port scan timeout
// ==========================================



app.use('/uploads', express.static(path.join(__dirname, 'public/uploads')));

// ==========================================
// DATABASE STARTUP MIGRATION
// ==========================================
const initDatabase = () => { 
    const query = ` 
        ALTER TABLE public.users 
        ADD COLUMN IF NOT EXISTS name VARCHAR(150), 
        ADD COLUMN IF NOT EXISTS email VARCHAR(255), 
        ADD COLUMN IF NOT EXISTS pincode VARCHAR(10), 
        ADD COLUMN IF NOT EXISTS address TEXT, 
        ADD COLUMN IF NOT EXISTS password VARCHAR(255), 
        ADD COLUMN IF NOT EXISTS otp_code VARCHAR(10), 
        ADD COLUMN IF NOT EXISTS otp_expires_at BIGINT 
    `; 
 
    db.query(query, [], (err) => { 
        if (err) { 
            console.error('❌ Database migration failed:', err.message); 
            process.exit(1); 
        } 
 
        console.log('✅ Users table columns verified.'); 
 
        app.listen(PORT, '0.0.0.0', () => { 
            console.log(`✅ Server is running on port ${PORT}`); 
        }); 
    }); 
}; 
 
initDatabase();