'use strict';

// ============================================================
// CEROOD SELLER ORDERS
//
// Renewed + Cosmetics + Fashion
//
// GET   /api/seller/orders
// PATCH /api/seller/orders/:orderItemId/decision
// PATCH /api/seller/orders/:orderItemId/fulfilment
//
// Renewed item ID: 123
// Cosmetics item ID: cosmetics:123
// Fashion item ID: clothing:123
// ============================================================

module.exports = function (
    app,
    db,
    requireSellerAuth
) {

    // ========================================================
    // DATABASE QUERY HELPER
    // ========================================================

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


    // ========================================================
    // MARKETPLACE TABLE CONFIGURATION
    // ========================================================

    const marketplaceTables = Object.freeze({

        cosmetics: [
            'cosmetics_order_items',
            'cosmetics_orders',
            'cosmetics_products'
        ],

        clothing: [
            'clothing_order_items',
            'clothing_orders',
            'clothing_products'
        ]

    });


    // ========================================================
    // IDENTIFY MARKETPLACE ORDER ITEM
    // ========================================================

    function parseMarketplaceItem(raw) {

        const match =
            /^(cosmetics|clothing):([1-9]\d*)$/
                .exec(String(raw || ''));

        if (!match) {
            return null;
        }

        const id = Number(match[2]);

        if (!Number.isSafeInteger(id)) {
            return null;
        }

        return {
            marketplace: match[1],
            id
        };

    }


    // ========================================================
    // CONFIRMED MARKETPLACE ORDERS ONLY
    //
    // COD:
    //   Order must not be cancelled / failed / refunded.
    //
    // ONLINE:
    //   Payment must be verified as paid / captured / success.
    // ========================================================

    const marketplaceConfirmed = `

        (

            (
                LOWER(o.payment_method) = 'cod'

                AND LOWER(o.status) NOT IN (
                    'cancelled',
                    'canceled',
                    'failed',
                    'refunded'
                )
            )

            OR

            (
                LOWER(o.payment_method) <> 'cod'

                AND LOWER(o.payment_status) IN (
                    'paid',
                    'captured',
                    'success'
                )
            )

        )

        AND LOWER(o.status) NOT IN (
            'cancelled',
            'canceled',
            'failed',
            'refunded'
        )

    `;


    // ========================================================
    // GET COSMETICS / FASHION ORDERS
    // ========================================================

    async function getMarketplaceOrders(
        marketplace,
        sellerId
    ) {

        const [
            itemTable,
            orderTable,
            productTable
        ] = marketplaceTables[marketplace];

        return query(
            `

            SELECT

                ? || ':' || oi.id::text
                    AS order_item_id,

                ? AS marketplace,

                oi.order_id,

                oi.product_id,

                oi.product_name,

                oi.unit_price,

                oi.quantity,

                oi.total_price AS line_total,

                NULL::integer
                    AS warranty_days_at_purchase,

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

                o.payment_status,

                o.status AS delivery_status,

                o.created_at AS ordered_at,

                p.image_url AS product_image

            FROM public.${itemTable} oi

            INNER JOIN public.${orderTable} o
                ON o.id = oi.order_id

            LEFT JOIN public.${productTable} p
                ON p.id::text = oi.product_id

            WHERE oi.seller_id = ?

              AND ${marketplaceConfirmed}

            ORDER BY

                o.created_at DESC,

                oi.id DESC

            LIMIT 100

            `,
            [
                marketplace,
                marketplace,
                sellerId
            ]
        );

    }


    // ========================================================
    // UPDATE COSMETICS / FASHION SELLER ITEM
    // ========================================================

    async function changeMarketplaceItem(
        item,
        sellerId,
        field,
        value
    ) {

        const [
            itemTable,
            orderTable
        ] = marketplaceTables[item.marketplace];

        const isDecision =
            field === 'decision';

        const previous =
            value === 'packed'
                ? 'accepted'
                : 'packed';


        // ====================================================
        // ACCEPT / REJECT SQL
        // ====================================================

        const decisionSql = `

            UPDATE public.${itemTable} oi

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

            FROM public.${orderTable} o

            WHERE oi.order_id = o.id

              AND oi.id = ?

              AND oi.seller_id = ?

              AND (

                    oi.seller_order_status IS NULL

                    OR oi.seller_order_status = 'new'

              )

              AND ${marketplaceConfirmed}

            RETURNING

                oi.id,

                oi.order_id,

                oi.seller_order_status,

                oi.seller_accepted_at,

                oi.seller_rejected_at

        `;


        // ====================================================
        // PACKED / SHIPPED SQL
        // ====================================================

        const fulfilmentSql = `

            UPDATE public.${itemTable} oi

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

            FROM public.${orderTable} o

            WHERE oi.order_id = o.id

              AND oi.id = ?

              AND oi.seller_id = ?

              AND oi.seller_order_status = ?

              AND ${marketplaceConfirmed}

            RETURNING

                oi.id,

                oi.order_id,

                oi.seller_order_status,

                oi.seller_accepted_at,

                oi.seller_packed_at,

                oi.seller_shipped_at

        `;


        const sql =
            isDecision
                ? decisionSql
                : fulfilmentSql;


        const params =
            isDecision

                ? [
                    value,
                    value,
                    value,
                    item.id,
                    sellerId
                ]

                : [
                    value,
                    value,
                    value,
                    item.id,
                    sellerId,
                    previous
                ];


        const rows =
            await query(
                sql,
                params
            );


        return rows.map(row => ({

            ...row,

            order_item_id:
                `${item.marketplace}:${row.id}`,

            marketplace:
                item.marketplace

        }));

    }


    // ========================================================
    // 1. GET ALL SELLER ORDERS
    // ========================================================

    app.get(

        '/api/seller/orders',

        requireSellerAuth,

        async (req, res) => {

            res.set(
                'Cache-Control',
                'no-store'
            );

            try {

                const sellerId =
                    req.seller.id;


                // ============================================
                // EXISTING RENEWED ORDERS
                // ============================================

                const renewedOrders =
                    await query(
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
                        [
                            sellerId
                        ]
                    );


                // ============================================
                // COSMETICS + FASHION ORDERS
                // ============================================

                const [
                    cosmeticsOrders,
                    clothingOrders
                ] = await Promise.all([

                    getMarketplaceOrders(
                        'cosmetics',
                        sellerId
                    ),

                    getMarketplaceOrders(
                        'clothing',
                        sellerId
                    )

                ]);


                // ============================================
                // COMBINE THREE MARKETPLACES
                // ============================================

                const allOrders = [

                    ...renewedOrders.map(
                        order => ({

                            ...order,

                            marketplace: 'renewed'

                        })
                    ),

                    ...cosmeticsOrders,

                    ...clothingOrders

                ].sort(

                    (a, b) =>

                        new Date(b.ordered_at) -
                        new Date(a.ordered_at)

                );


                return res.json({

                    success: true,

                    orders: allOrders,

                    count: allOrders.length

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


    // ========================================================
    // 2. SELLER ACCEPT / REJECT
    // ========================================================

    app.patch(

        '/api/seller/orders/:orderItemId/decision',

        requireSellerAuth,

        async (req, res) => {

            res.set(
                'Cache-Control',
                'no-store'
            );


            const rawItemId =
                req.params.orderItemId;


            const itemId =
                Number(rawItemId);


            const decision =
                String(
                    req.body?.decision || ''
                )
                    .trim()
                    .toLowerCase();


            // ================================================
            // COSMETICS / FASHION DECISION
            // ================================================

            const marketplaceItem =
                parseMarketplaceItem(
                    rawItemId
                );


            if (marketplaceItem) {

                if (
                    ![
                        'accepted',
                        'rejected'
                    ].includes(decision)
                ) {

                    return res.status(400).json({

                        success: false,

                        message:
                            'Invalid decision.'

                    });

                }


                try {

                    const rows =
                        await changeMarketplaceItem(

                            marketplaceItem,

                            req.seller.id,

                            'decision',

                            decision

                        );


                    if (!rows.length) {

                        return res.status(409).json({

                            success: false,

                            message:
                                'Order unavailable or already decided. Refresh orders.'

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
                        'Marketplace seller decision error:',
                        error
                    );

                    return res.status(500).json({

                        success: false,

                        message:
                            'Unable to update seller order.'

                    });

                }

            }


            // ================================================
            // INVALID MARKETPLACE ITEM
            // ================================================

            if (
                String(rawItemId).includes(':')
            ) {

                return res.status(400).json({

                    success: false,

                    message:
                        'Invalid marketplace order item.'

                });

            }


            // ================================================
            // RENEWED INPUT VALIDATION
            // ================================================

            if (

                !Number.isSafeInteger(itemId)

                || itemId < 1

                || ![
                    'accepted',
                    'rejected'
                ].includes(decision)

            ) {

                return res.status(400).json({

                    success: false,

                    message:
                        'Valid order item and decision required.'

                });

            }


            // ================================================
            // EXISTING RENEWED DECISION
            // ================================================

            try {

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


                const rows =
                    await query(
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


    // ========================================================
    // 3. SELLER PACKED / SHIPPED
    // ========================================================

    app.patch(

        '/api/seller/orders/:orderItemId/fulfilment',

        requireSellerAuth,

        async (req, res) => {

            res.set(
                'Cache-Control',
                'no-store'
            );


            const rawItemId =
                req.params.orderItemId;


            const itemId =
                Number(rawItemId);


            const nextStatus =
                String(
                    req.body?.status || ''
                )
                    .trim()
                    .toLowerCase();


            // ================================================
            // COSMETICS / FASHION FULFILMENT
            // ================================================

            const marketplaceItem =
                parseMarketplaceItem(
                    rawItemId
                );


            if (marketplaceItem) {

                if (
                    ![
                        'packed',
                        'shipped'
                    ].includes(nextStatus)
                ) {

                    return res.status(400).json({

                        success: false,

                        message:
                            'Invalid fulfilment status.'

                    });

                }


                try {

                    const rows =
                        await changeMarketplaceItem(

                            marketplaceItem,

                            req.seller.id,

                            'fulfilment',

                            nextStatus

                        );


                    if (!rows.length) {

                        return res.status(409).json({

                            success: false,

                            message:
                                'Order unavailable or invalid status transition. Refresh orders.'

                        });

                    }


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
                        'Marketplace seller fulfilment error:',
                        error
                    );

                    return res.status(500).json({

                        success: false,

                        message:
                            'Unable to update order fulfilment.'

                    });

                }

            }


            // ================================================
            // INVALID MARKETPLACE ITEM
            // ================================================

            if (
                String(rawItemId).includes(':')
            ) {

                return res.status(400).json({

                    success: false,

                    message:
                        'Invalid marketplace order item.'

                });

            }


            // ================================================
            // RENEWED INPUT VALIDATION
            // ================================================

            if (

                !Number.isSafeInteger(itemId)

                || itemId < 1

                || ![
                    'packed',
                    'shipped'
                ].includes(nextStatus)

            ) {

                return res.status(400).json({

                    success: false,

                    message:
                        'Valid order item and fulfilment status required.'

                });

            }


            // ================================================
            // ALLOWED STATUS FLOW
            //
            // accepted -> packed -> shipped
            // ================================================

            const previousStatus =

                nextStatus === 'packed'

                    ? 'accepted'

                    : 'packed';


            // ================================================
            // EXISTING RENEWED FULFILMENT
            // ================================================

            try {

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


                const rows =
                    await query(
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


                if (!rows.length) {

                    return res.status(409).json({

                        success: false,

                        message:
                            'Order unavailable or invalid status transition. Refresh orders.'

                    });

                }


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