// ==========================================
// CEROOD SELLER ORDERS
// Seller-specific, read-only order listing
// ==========================================

module.exports = function (
    app,
    db,
    requireSellerAuth
) {

    // Convert existing callback-style db.query
    // into a Promise for async/await.
    function query(sql, params = []) {

        return new Promise((resolve, reject) => {

            db.query(
                sql,
                params,
                (error, rows) => {

                    if (error) {
                        return reject(error);
                    }

                    resolve(rows || []);

                }
            );

        });

    }


    // ==========================================
    // GET LOGGED-IN SELLER ORDERS
    // ==========================================

    app.get(
        '/api/seller/orders',
        requireSellerAuth,
        async (req, res) => {

            res.set('Cache-Control', 'no-store');

            try {

                // Never accept seller_id from browser.
                // Seller identity comes from verified JWT.
                const sellerId = req.seller.id;

                const orders = await query(
                    `
                    SELECT

                        oi.id AS order_item_id,

                        oi.order_id,

                        oi.product_id,

                        oi.product_name,

                        oi.unit_price,

                        oi.quantity,

                        oi.line_total,

                        oi.warranty_days_at_purchase,

                        oi.seller_id,

                        COALESCE(
                            oi.seller_order_status,
                            'new'
                        ) AS seller_order_status,

                        oi.seller_accepted_at,

                        oi.seller_rejected_at,

                        oi.seller_packed_at,

                        oi.seller_shipped_at,

                        oi.seller_order_note,

                        o.customer_name,

                        o.customer_phone,

                        o.delivery_address,

                        o.payment_method,

                        o.status AS payment_status,

                        o.delivery_status,

                        o.created_at AS ordered_at,

                        p.image_url AS product_image

                    FROM public.renewed_order_items oi

                    INNER JOIN public.renewed_orders o
                        ON o.id = oi.order_id

                    LEFT JOIN public.renewed_products p
                        ON p.id = oi.product_id

                    WHERE oi.seller_id = ?

                    AND (

                        (
                            o.payment_method = 'cod'
                            AND o.status = 'processing'
                        )

                        OR

                        (
                            o.status = 'paid'
                        )

                    )

                    ORDER BY
                        o.created_at DESC,
                        oi.id DESC

                    LIMIT 100
                    `,
                    [sellerId]
                );

                return res.json({

                    success: true,

                    orders,

                    count: orders.length

                });

            } catch (error) {

                console.error(
                    'Seller Orders Error:',
                    error
                );

                return res.status(500).json({

                    success: false,

                    message:
                        'Unable to load seller orders.'

                });

            }

        }
    );

};