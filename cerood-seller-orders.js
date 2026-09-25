'use strict';

// ==========================================
// CEROOD SELLER ORDERS
//
// 1. View seller's confirmed orders
// 2. Accept / Reject own order items
// 3. Mark accepted orders as Packed
// 4. Mark packed orders as Shipped
// ==========================================

module.exports = function (
    app,
    db,
    requireSellerAuth
) {

    // ==========================================
    // DATABASE QUERY HELPER
    // ==========================================

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
    // 1. GET SELLER ORDERS
    // ==========================================

    app.get(
        '/api/seller/orders',
        requireSellerAuth,
        async (req, res) => {

            res.set('Cache-Control', 'no-store');

            try {

                // Seller ID comes from authenticated session.
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
                            o.payment_method <> 'cod'
                            AND o.status = 'paid'
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


    // ==========================================
    // 2. SELLER ACCEPT / REJECT ORDER
    // ==========================================

    app.patch(
        '/api/seller/orders/:orderItemId/decision',
        requireSellerAuth,
        async (req, res) => {

            res.set('Cache-Control', 'no-store');

            const itemId = Number(
                req.params.orderItemId
            );

            const decision = String(
                req.body?.decision || ''
            )
                .trim()
                .toLowerCase();


            // ==================================
            // VALIDATE INPUT
            // ==================================

            if (
                !Number.isSafeInteger(itemId) ||
                itemId < 1 ||
                !['accepted', 'rejected'].includes(
                    decision
                )
            ) {

                return res.status(400).json({

                    success: false,

                    message:
                        'Valid order item and decision required.'

                });

            }


            try {

                // ==================================
                // UPDATE ONLY LOGGED-IN
                // SELLER'S OWN ORDER ITEM
                // ==================================

                const sql = `
                    UPDATE public.renewed_order_items AS oi

                    SET

                        seller_order_status = ?,

                        seller_accepted_at =
                            CASE
                                WHEN ? = 'accepted'
                                THEN NOW()
                                ELSE seller_accepted_at
                            END,

                        seller_rejected_at =
                            CASE
                                WHEN ? = 'rejected'
                                THEN NOW()
                                ELSE seller_rejected_at
                            END

                    FROM public.renewed_orders AS o

                    WHERE oi.order_id = o.id

                      AND oi.id = ?

                      AND oi.seller_id = ?

                      AND (
                          oi.seller_order_status IS NULL
                          OR oi.seller_order_status = 'new'
                      )

                      AND (

                          (
                              o.payment_method = 'cod'
                              AND o.status = 'processing'
                          )

                          OR

                          (
                              o.payment_method <> 'cod'
                              AND o.status = 'paid'
                          )

                      )

                    RETURNING

                        oi.id AS order_item_id,

                        oi.order_id,

                        oi.seller_order_status,

                        oi.seller_accepted_at,

                        oi.seller_rejected_at
                `;


                const rows = await query(
                    sql,
                    [
                        decision,
                        decision,
                        decision,
                        itemId,
                        req.seller.id
                    ]
                );


                if (!rows.length) {

                    return res.status(409).json({

                        success: false,

                        message:
                            'Order unavailable, not yours, not confirmed, or already decided. Refresh orders.'

                    });

                }


                return res.json({

                    success: true,

                    message:
                        decision === 'accepted'
                            ? 'Order accepted.'
                            : 'Order rejected. Cerood admin must resolve fulfilment/refund.',

                    order: rows[0]

                });


            } catch (error) {

                console.error(
                    'Seller order decision error:',
                    error
                );

                return res.status(500).json({

                    success: false,

                    message:
                        'Unable to update seller order.'

                });

            }

        }
    );


    // ==========================================
    // 3. SELLER PACKED / SHIPPED ORDER
    // ==========================================

    app.patch(
        '/api/seller/orders/:orderItemId/fulfilment',
        requireSellerAuth,
        async (req, res) => {

            res.set('Cache-Control', 'no-store');

            const itemId = Number(
                req.params.orderItemId
            );

            const nextStatus = String(
                req.body?.status || ''
            )
                .trim()
                .toLowerCase();


            // ==================================
            // VALIDATE INPUT
            // ==================================

            if (
                !Number.isSafeInteger(itemId) ||
                itemId < 1 ||
                !['packed', 'shipped'].includes(
                    nextStatus
                )
            ) {

                return res.status(400).json({

                    success: false,

                    message:
                        'Valid order item and fulfilment status required.'

                });

            }


            // ==================================
            // ALLOWED STATUS FLOW
            //
            // accepted -> packed -> shipped
            //
            // Seller cannot skip or reverse stages.
            // ==================================

            const previousStatus =
                nextStatus === 'packed'
                    ? 'accepted'
                    : 'packed';


            try {

                // ==================================
                // UPDATE ONLY THIS SELLER'S ITEM
                // ==================================

                const sql = `
                    UPDATE public.renewed_order_items AS oi

                    SET

                        seller_order_status = ?,

                        seller_packed_at =
                            CASE
                                WHEN ? = 'packed'
                                THEN NOW()
                                ELSE seller_packed_at
                            END,

                        seller_shipped_at =
                            CASE
                                WHEN ? = 'shipped'
                                THEN NOW()
                                ELSE seller_shipped_at
                            END

                    FROM public.renewed_orders AS o

                    WHERE oi.order_id = o.id

                      AND oi.id = ?

                      AND oi.seller_id = ?

                      AND oi.seller_order_status = ?

                      AND (

                          (
                              o.payment_method = 'cod'
                              AND o.status = 'processing'
                          )

                          OR

                          (
                              o.payment_method <> 'cod'
                              AND o.status = 'paid'
                          )

                      )

                    RETURNING

                        oi.id AS order_item_id,

                        oi.order_id,

                        oi.seller_order_status,

                        oi.seller_accepted_at,

                        oi.seller_packed_at,

                        oi.seller_shipped_at
                `;


                const rows = await query(
                    sql,
                    [
                        nextStatus,
                        nextStatus,
                        nextStatus,
                        itemId,
                        req.seller.id,
                        previousStatus
                    ]
                );


                // ==================================
                // INVALID ORDER / STATUS TRANSITION
                // ==================================

                if (!rows.length) {

                    return res.status(409).json({

                        success: false,

                        message:
                            'Order unavailable or invalid status transition. Refresh orders.'

                    });

                }


                // ==================================
                // SUCCESS RESPONSE
                // ==================================

                return res.json({

                    success: true,

                    message:
                        nextStatus === 'packed'
                            ? 'Order marked as packed.'
                            : 'Order marked as shipped.',

                    order: rows[0]

                });


            } catch (error) {

                console.error(
                    'Seller fulfilment error:',
                    error
                );

                return res.status(500).json({

                    success: false,

                    message:
                        'Unable to update order fulfilment.'

                });

            }

        }
    );

};