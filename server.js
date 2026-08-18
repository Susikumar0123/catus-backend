const express = require('express');
const cors = require('cors');
const Razorpay = require('razorpay');
const db = require('./db');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ==========================================
// 1. REGISTER API ROUTE
// ==========================================
app.post('/api/register', (req, res) => {
    const { name, email, phone, pincode } = req.body;
    
    const address = "No address saved";
    const randomCustId = Math.floor(10000 + Math.random() * 90000);
    const defaultWallet = 0; // <--- Wallet balance-ai 0 nu set panrom

    const query = 'INSERT INTO users (id, name, email, phone, pincode, address, wallet) VALUES (?, ?, ?, ?, ?, ?, ?)';
    db.query(query, [randomCustId, name, email, phone, pincode, address, defaultWallet], (err, result) => {
        if (err) {
            if (err.code === 'ER_DUP_ENTRY') {
                return res.status(400).json({ success: false, message: 'Mobile number already registered!' });
            }
            return res.status(500).json({ success: false, error: err.message });
        }
        res.json({ 
            success: true, 
            message: 'User registered successfully!', 
            user: { id: randomCustId, name, email, phone, pincode, address, wallet: defaultWallet } 
        });
    });
});

// ==========================================
// 2. LOGIN API ROUTE
// ==========================================
app.post('/api/login', (req, res) => {
    const { phone } = req.body;
    
    const query = 'SELECT * FROM users WHERE phone = ?';
    db.query(query, [phone], (err, results) => {
        if (err) return res.status(500).json({ success: false, error: err.message });

        if (results.length > 0) {
            res.json({ success: true, exists: true, user: results[0] });
        } else {
            res.json({ success: true, exists: false, message: 'User not found. Please register.' });
        }
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
            console.error('Insert Error Detail:', err.sqlMessage || err.message); // <--- SQL error clear-ah console-la theriyum
            return res.status(500).json({ success: false, error: err.message });
        }
        res.json({ success: true, message: 'Order placed and saved to database successfully!' });
    });
}); // <--- Ithu munnadi miss aana closing bracket!

// ==========================================
// GET ALL CUSTOMERS FOR ADMIN MASTER WITH LIVE ORDER COUNT (FIXED)
// ==========================================
app.get('/api/admin/customers', (req, res) => {
    const usersQuery = 'SELECT * FROM users ORDER BY id DESC';
    const ordersQuery = 'SELECT phone FROM orders';

    db.query(usersQuery, (err, users) => {
        if (err) return res.status(500).json({ success: false, error: err.message });

        db.query(ordersQuery, (err2, orders) => {
            if (err2) return res.status(500).json({ success: false, error: err2.message });

            // Ovvoru user-oda phone number-kum evlo orders irukku nu map/count panrom
            let orderCounts = {};
            orders.forEach(o => {
                let cleanPhone = String(o.phone || '').trim();
                if (cleanPhone) {
                    orderCounts[cleanPhone] = (orderCounts[cleanPhone] || 0) + 1;
                }
            });

            // Users list-oda total_orders-ai attach panrom
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

const razorpayInstance = new Razorpay({
    key_id: "rzp_test_TQiJV43IJEq24x",
    key_secret: "hsRVUhrE58cWxOB1GKjSVRV6"
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
// SERVICES API ROUTES FOR FRONTEND & ADMIN
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
        product_note // <--- 1. Inga destructure la add pannunga
    } = req.body;
    
    // 2. Query-la product_note column-ai include panrom
    const query = `UPDATE services SET service_id = ?, service_name = ?, category = ?, price = ?, mrp = ?, is_hot_deal = ?, select_options = ?, why_choose_us = ?, discount_text = ?, artificial_reviews_count = ?, artificial_reviews_data = ?, image_url = ?, image_url_2 = ?, image_url_3 = ?, image_url_4 = ?, enable_select_options = ?, product_note = ? WHERE service_id = ?`;
    
    db.query(query, [
        service_id, service_name, category, price, mrp, is_hot_deal, select_options, why_choose_us, 
        discount_text || '3% off', artificial_reviews_count || 500, artificial_reviews_data || '', 
        image_url, image_url_2 || '', image_url_3 || '', image_url_4 || '', 
        enable_select_options ?? 1, 
        product_note || '', // <--- 3. Value-ai pass panrom
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
        product_note // <--- 1. Destructure la irukku
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
        product_note || '' // <--- 2. Inga values array-la pass panrom! (Ithu thaan miss aachu)
    ], (err, result) => {
        if (err) {
            console.error('Add Service Error:', err.message);
            return res.status(500).json({ success: false, error: err.message });
        }
        res.json({ success: true, message: 'New service added successfully!' });
    });
});

// 1. Save Transaction Route
app.post('/api/transactions', (req, res) => {
    const { transaction_id, customer_id, customer_name, mobile, email, product_name, amount, payment_mode, status, date_time } = req.body;
    const query = `INSERT INTO transactions (transaction_id, customer_id, customer_name, mobile, email, product_name, amount, payment_mode, status, date_time) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    
    db.query(query, [transaction_id, customer_id, customer_name, mobile, email, product_name, amount, payment_mode, status, date_time], (err, result) => {
        if (err) return res.status(500).json({ success: false, error: err.message });
        res.json({ success: true, message: 'Transaction saved successfully!' });
    });
});

// 2. Fetch Transactions for Admin Panel
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
            (SELECT COALESCE(SUM(amount), 0) FROM orders WHERE status != 'Trash' AND status != 'Cancelled' AND status != 'Rejected' AND DATE(order_date) = CURDATE()) as todays_collection
    `;
    
    db.query(query, (err, results) => {
        if (err) return res.status(500).json({ success: false, error: err.message });
        res.json({ success: true, stats: results[0] });
    });
});
// ==========================================
// UPDATE ORDER ADDRESS API ROUTE
// ==========================================
app.post('/api/admin/update-order-address', (req, res) => {
    const { order_id, address, district, pincode } = req.body;
    const query = 'UPDATE orders SET address = ?, district = ?, pincode = ? WHERE order_id = ?';
    db.query(query, [address, district, pincode, order_id], (err, result) => {
        if (err) return res.status(500).json({ success: false, error: err.message });
        res.json({ success: true, message: 'Order address updated successfully!' });
    });
});
app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});