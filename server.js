const express = require('express');
const cors = require('cors');
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
    db.query(query, [phone], (err, results) => {
        if (err) return res.status(500).json({ success: false, error: err.message });
        
        if (results && results.length > 0) {
            const user = results[0];
            // Passwords-ah trim panrathu space error-ai thavirkkum
            if (String(user.password).trim() === String(password).trim()) {
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

    const generatedOtp = '1234';
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

                            console.log(
                                `[REG OTP RESEND] ${cleanPhone} => ${generatedOtp}`
                            );

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

                    console.log(
                        `[REG OTP] ${cleanPhone} => ${generatedOtp}`
                    );

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

                console.log(
                    `[RESET OTP] ${cleanPhone} => ${generatedOtp}`
                );

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

    db.query(findUserQuery, [phone], (err, rows) => {

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
            [password, phone],
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
        status 
    } = req.body;
    
    const query = `
        INSERT INTO orders 
        (order_id, customer_id, product_id, service_name, customer_name, phone, whatsapp, address, district, pincode, amount, order_date, status) 
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;
    
    const values = [
        order_id, 
        customer_id, 
        product_id || 'tv-repair', 
        service_name, 
        customer_name, 
        phone, 
        whatsapp || '', 
        address, 
        district, 
        pincode, 
        amount, 
        order_date, 
        status || 'Active' 
    ];

    db.query(query, values, (err, result) => {
        if (err) {
            console.error('Insert Error Detail:', err.sqlMessage || err.message);
            return res.status(500).json({ success: false, error: err.message });
        }
        res.json({ success: true, message: 'Order placed and saved to database successfully!' });
    });
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
    const query = 'UPDATE orders SET status = ? WHERE order_id = ?';
    db.query(query, [status, order_id], (err, result) => {
        if (err) return res.status(500).json({ success: false, error: err.message });
        res.json({ success: true, message: 'Status updated successfully' });
    });
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
    const { amount } = req.body;
    
    const options = {
        amount: amount, 
        currency: "INR",
        receipt: "receipt_" + Math.random().toString(36).substring(7)
    };

    try {
        const order = await razorpayInstance.orders.create(options);
        res.json({
            success: true,
            id: order.id,
            amount: order.amount
        });
    } catch (error) {
        console.error('Razorpay Error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==========================================
// SERVICES API ROUTES
// ==========================================
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
        old_service_id, service_id, service_name, category, price, mrp, 
        is_hot_deal, select_options, why_choose_us, discount_text,
        artificial_reviews_count, artificial_reviews_data,
        image_url, image_url_2, image_url_3, image_url_4,
        enable_select_options,
        product_note 
    } = req.body;
    
    const query = `UPDATE services SET service_id = ?, service_name = ?, category = ?, price = ?, mrp = ?, is_hot_deal = ?, select_options = ?, why_choose_us = ?, discount_text = ?, artificial_reviews_count = ?, artificial_reviews_data = ?, image_url = ?, image_url_2 = ?, image_url_3 = ?, image_url_4 = ?, enable_select_options = ?, product_note = ? WHERE service_id = ?`;
    
    db.query(query, [
        service_id, service_name, category, price, mrp, is_hot_deal, select_options, why_choose_us, 
        discount_text || '3% off', artificial_reviews_count || 500, artificial_reviews_data || '', 
        image_url, image_url_2 || '', image_url_3 || '', image_url_4 || '', 
        enable_select_options ?? 1, 
        product_note || '', 
        old_service_id
    ], (err, result) => {
        if (err) return res.status(500).json({ success: false, error: err.message });
        res.json({ success: true, message: 'Service updated successfully!' });
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
    const query = 'UPDATE orders SET technician_name = ?, technician_phone = ?, eta = ?, status = ? WHERE order_id = ?';
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
    const query = 'SELECT * FROM product_reviews WHERE service_id = ? ORDER BY id DESC';
    db.query(query, [serviceId], (err, results) => {
        if (err) return res.status(500).json({ success: false, error: err.message });
        res.json({ success: true, reviews: results });
    });
});

app.post('/api/reviews', (req, res) => {
    const { service_id, customer_name, rating, review_text } = req.body;
    const query = 'INSERT INTO product_reviews (service_id, customer_name, rating, review_text) VALUES (?, ?, ?, ?)';
    db.query(query, [service_id, customer_name, rating, review_text], (err, result) => {
        if (err) return res.status(500).json({ success: false, error: err.message });
        res.json({ success: true, message: 'Review added successfully!' });
    });
});

// Root URL check
app.get('/', (req, res) => {
    res.send('Catus Backend Server is running successfully!');
});

app.post('/api/admin/add-service', (req, res) => {
    const { 
        service_id, service_name, category, price, mrp, 
        is_hot_deal, select_options, why_choose_us, discount_text,
        artificial_reviews_count, artificial_reviews_data,
        image_url, image_url_2, image_url_3, image_url_4,
        enable_select_options,
        product_note 
    } = req.body;
    
    const query = `INSERT INTO services (service_id, service_name, category, price, mrp, is_hot_deal, select_options, why_choose_us, discount_text, artificial_reviews_count, artificial_reviews_data, image_url, image_url_2, image_url_3, image_url_4, enable_select_options, product_note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    
    db.query(query, [
        service_id, 
        service_name, 
        category || 'General', 
        price || 0, 
        mrp || 0, 
        is_hot_deal ?? 1, 
        select_options || 'Standard Service', 
        why_choose_us || 'Verified Professionals: Background-verified expert technicians.|30-Day Warranty: Post-service warranty on all repairs.', 
        discount_text || '3% off',
        artificial_reviews_count || 500,
        artificial_reviews_data || '',
        image_url, 
        image_url_2 || '', 
        image_url_3 || '', 
        image_url_4 || '',
        enable_select_options ?? 1,
        product_note || '' 
    ], (err, result) => {
        if (err) {
            console.error('Add Service Error:', err.message);
            return res.status(500).json({ success: false, error: err.message });
        }
        res.json({ success: true, message: 'New service added successfully!' });
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
// LOCATION + SERVICE SEO LANDING PAGE API
// ==========================================

app.get('/api/location-page/:location/:service', (req, res) => {

    const locationSlug = String(req.params.location || '')
        .trim()
        .toLowerCase();

    const serviceSlug = String(req.params.service || '')
        .trim()
        .toLowerCase();

    if (!locationSlug || !serviceSlug) {
        return res.status(400).json({
            success: false,
            message: 'Location and service are required.'
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
            LOWER(l.slug) = ?
            AND LOWER(s.service_id) = ?
            AND l.is_active = TRUE
            AND ls.is_available = TRUE

        LIMIT 1
    `;

    db.query(
        query,
        [locationSlug, serviceSlug],
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
                    message: 'This service is not available in this location.'
                });
            }

            const page = results[0];

            return res.json({
                success: true,
                page: page
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
// IMAGE UPLOAD CONFIGURATION (Multer)
// ==========================================
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, 'public/uploads/'); // உங்கள் ப்ராஜெக்ட் ஃபோல்டரில் public/uploads இருக்க வேண்டும்
    },
    filename: (req, file, cb) => {
        cb(null, Date.now() + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

// இமேஜ் அப்லோட் API Route
app.post('/api/upload-image', upload.single('image'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ success: false, message: 'No file uploaded' });
    }
    const imageUrl = `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`;
    res.json({ success: true, imageUrl: imageUrl });
});


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