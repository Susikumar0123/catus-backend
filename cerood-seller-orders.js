'use strict';

// ============================================================
// CEROOD SELLER ORDERS
//
// Renewed + Cosmetics + Fashion + Main Store
//
// GET   /api/seller/orders
// PATCH /api/seller/orders/:orderItemId/decision
// PATCH /api/seller/orders/:orderItemId/fulfilment
//
// Renewed item ID: 123
// Cosmetics item ID: cosmetics:123
// Fashion item ID: clothing:123
// Main Store item ID: shop:123
// ============================================================

module.exports = function (
    app,
    db,
    requireSellerAuth,
    sellerShipping = null
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


    // Ensure the shipping module's additive DB columns exist before
    // Main Store/order queries use them. No Ekart credential is needed for this.
    async function ensureOrderSchema() {
        if (sellerShipping && typeof sellerShipping.ensureSchema === 'function') {
            await sellerShipping.ensureSchema();
        }
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

                oi.fulfilment_location_id,

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
    // MAIN STORE ORDER HELPERS
    // ========================================================

    function parseShopItem(raw) {
        const match = /^shop:([1-9]\d*)$/.exec(String(raw || ''));
        if (!match) return null;
        const id = Number(match[1]);
        return Number.isSafeInteger(id) ? { marketplace: 'shop', id } : null;
    }

    function shopOrderConfirmed(order) {
        const payment = String(order?.payment_method || '').toLowerCase();
        const status = String(order?.status || '').toLowerCase();
        const paymentStatus = String(order?.payment_status || '').toLowerCase();
        const bad = ['cancelled','canceled','failed','refunded','expired'];
        if (bad.includes(status)) return false;
        if (payment === 'cod') return true;
        return ['paid','captured','success','payment_review'].includes(paymentStatus);
    }

    async function getShopOrders(sellerId) {
        await ensureOrderSchema();
        return query(`
            SELECT
                'shop:' || oi.id::text AS order_item_id,
                'shop' AS marketplace,
                oi.order_id,
                oi.product_id,
                oi.product_name,
                oi.unit_price,
                oi.quantity,
                oi.line_total,
                NULL::integer AS warranty_days_at_purchase,
                oi.seller_id,
                oi.fulfilment_location_id,
                COALESCE(oi.seller_order_status,'new') AS seller_order_status,
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
            FROM public.cerood_shop_order_items oi
            JOIN public.cerood_shop_orders o ON o.id=oi.order_id
            LEFT JOIN public.cerood_shop_products p ON p.id=oi.product_id
            WHERE oi.seller_id=?
              AND LOWER(o.status) NOT IN ('cancelled','canceled','failed','refunded','expired')
              AND (
                    LOWER(o.payment_method)='cod'
                    OR LOWER(COALESCE(o.payment_status,'')) IN ('paid','captured','success','payment_review')
              )
            ORDER BY o.created_at DESC,oi.id DESC
            LIMIT 100
        `,[sellerId]);
    }

    async function changeShopItem(item, sellerId, field, value) {
        await ensureOrderSchema();
        let client;
        try {
            client = await db.getClient();
            await client.query('BEGIN');
            await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`shop-order-item:${item.id}`]);

            const itemRows = await client.query(`
                SELECT oi.id,oi.order_id,oi.product_id,oi.variant_id,oi.quantity,oi.seller_id,
                       COALESCE(oi.seller_order_status,'new') AS seller_order_status,
                       o.payment_method,o.payment_status,o.status
                  FROM public.cerood_shop_order_items oi
                  JOIN public.cerood_shop_orders o ON o.id=oi.order_id
                 WHERE oi.id=$1 AND oi.seller_id=$2
                 FOR UPDATE OF oi
            `,[item.id,sellerId]);

            const current = itemRows[0];
            if (!current || !shopOrderConfirmed(current)) {
                await client.query('ROLLBACK');
                return [];
            }

            if (field === 'decision') {
                if (!['accepted','rejected'].includes(value) || current.seller_order_status !== 'new') {
                    await client.query('ROLLBACK');
                    return [];
                }

                const rows = await client.query(`
                    UPDATE public.cerood_shop_order_items
                       SET seller_order_status=$1,
                           seller_accepted_at=CASE WHEN $1='accepted' THEN NOW() ELSE seller_accepted_at END,
                           seller_rejected_at=CASE WHEN $1='rejected' THEN NOW() ELSE seller_rejected_at END
                     WHERE id=$2 AND seller_id=$3
                     RETURNING id,order_id,seller_order_status,seller_accepted_at,seller_rejected_at
                `,[value,item.id,sellerId]);

                if (value === 'rejected') {
                    const qty = Number(current.quantity || 0);
                    if (qty > 0 && current.variant_id) {
                        await client.query(`
                            UPDATE public.cerood_product_variants
                               SET stock=stock+$1,updated_at=NOW()
                             WHERE id=$2 AND product_id=$3
                        `,[qty,current.variant_id,current.product_id]);
                    } else if (qty > 0) {
                        await client.query(`
                            UPDATE public.cerood_shop_products
                               SET stock=stock+$1,updated_at=NOW()
                             WHERE id=$2
                        `,[qty,current.product_id]);
                    }
                }

                await client.query('COMMIT');
                return rows.map(row=>({...row,order_item_id:`shop:${row.id}`,marketplace:'shop'}));
            }

            if (field === 'fulfilment') {
                const previous = value === 'packed' ? 'accepted' : 'packed';
                if (!['packed','shipped'].includes(value) || current.seller_order_status !== previous) {
                    await client.query('ROLLBACK');
                    return [];
                }
                const rows = await client.query(`
                    UPDATE public.cerood_shop_order_items
                       SET seller_order_status=$1,
                           seller_packed_at=CASE WHEN $1='packed' THEN NOW() ELSE seller_packed_at END,
                           seller_shipped_at=CASE WHEN $1='shipped' THEN NOW() ELSE seller_shipped_at END
                     WHERE id=$2 AND seller_id=$3 AND COALESCE(seller_order_status,'new')=$4
                     RETURNING id,order_id,seller_order_status,seller_accepted_at,seller_packed_at,seller_shipped_at
                `,[value,item.id,sellerId,previous]);
                await client.query('COMMIT');
                return rows.map(row=>({...row,order_item_id:`shop:${row.id}`,marketplace:'shop'}));
            }

            await client.query('ROLLBACK');
            return [];
        } catch (error) {
            if (client) await client.query('ROLLBACK').catch(()=>{});
            throw error;
        } finally {
            if (client) client.release();
        }
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

                await ensureOrderSchema();

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

                            oi.seller_listing_id,

                            oi.fulfilment_location_id,

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
                    clothingOrders,
                    shopOrders
                ] = await Promise.all([

                    getMarketplaceOrders(
                        'cosmetics',
                        sellerId
                    ),

                    getMarketplaceOrders(
                        'clothing',
                        sellerId
                    ),

                    getShopOrders(
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

                    ...clothingOrders,

                    ...shopOrders

                ].sort(

                    (a, b) =>

                        new Date(b.ordered_at) -
                        new Date(a.ordered_at)

                );


                const ordersWithShipping =
                    sellerShipping && typeof sellerShipping.attachShipments === 'function'
                        ? await sellerShipping.attachShipments(allOrders, sellerId)
                        : allOrders;

                return res.json({

                    success: true,

                    orders: ordersWithShipping,

                    count: ordersWithShipping.length

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
            // MAIN STORE DECISION
            // ================================================

            const shopItem = parseShopItem(rawItemId);
            if (shopItem) {
                if (!['accepted','rejected'].includes(decision)) {
                    return res.status(400).json({success:false,message:'Invalid decision.'});
                }
                try {
                    const rows = await changeShopItem(shopItem, req.seller.id, 'decision', decision);
                    if (!rows.length) {
                        return res.status(409).json({success:false,message:'Order unavailable or already decided. Refresh orders.'});
                    }
                    return res.json({
                        success:true,
                        message:decision==='accepted'
                            ? 'Main Store order accepted.'
                            : 'Main Store item rejected and reserved stock restored. Cerood admin must resolve customer cancellation/refund separately.',
                        order:rows[0]
                    });
                } catch (error) {
                    console.error('Main Store seller decision error:',error);
                    return res.status(error.status||500).json({success:false,message:error.status?error.message:'Unable to update Main Store seller order.'});
                }
            }


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

                                : 'Order rejected. Reserved stock restored for this seller item; Cerood admin must resolve any payment/refund action.',

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

                // A reject must restore the stock that checkout already deducted.
                // This is intentionally one SQL statement:
                // - transition is allowed only from NULL/new
                // - therefore a repeated reject cannot restore stock twice
                // - latched offers restore cerood_seller_listings stock
                // - legacy seller-owned Renewed products restore renewed_products stock
                // - mixed-seller orders remain active; only this seller's item changes
                // Reject + replacement allocation are atomic. The replacement also locks
                // the fulfilment location used for this order item. Customer pincode is read
                // from the original order address and is used only as a location-priority signal.
                const sql = decision === 'rejected'
                    ? `
                        WITH transitioned AS (
                            UPDATE public.renewed_order_items AS oi
                            SET seller_order_status='rejected', seller_rejected_at=NOW()
                            FROM public.renewed_orders AS o
                            WHERE oi.order_id=o.id AND oi.id=? AND oi.seller_id=?
                              AND (oi.seller_order_status IS NULL OR oi.seller_order_status='new')
                              AND ((o.payment_method='cod' AND o.status='processing')
                                OR (o.payment_method<>'cod' AND o.status='paid'))
                            RETURNING oi.id AS order_item_id,oi.order_id,oi.product_id,
                                      oi.seller_id AS rejected_seller_id,
                                      oi.seller_listing_id AS rejected_listing_id,
                                      oi.quantity,oi.seller_order_status,
                                      regexp_replace(COALESCE(o.delivery_address->>'pincode',''), '\D', '', 'g') AS customer_pincode
                        ),
                        restored_exact AS (
                            UPDATE public.cerood_seller_listings l
                            SET stock=l.stock+t.quantity,updated_at=NOW()
                            FROM transitioned t
                            WHERE l.id=t.rejected_listing_id
                              AND l.seller_id=t.rejected_seller_id
                              AND l.product_id=t.product_id
                            RETURNING l.id
                        ),
                        restored_legacy AS (
                            UPDATE public.cerood_seller_listings l
                            SET stock=l.stock+t.quantity,updated_at=NOW()
                            FROM transitioned t
                            WHERE t.rejected_listing_id IS NULL
                              AND l.seller_id=t.rejected_seller_id
                              AND l.product_id=t.product_id
                            RETURNING l.id
                        ),
                        restored_master AS (
                            UPDATE public.renewed_products p
                            SET stock=p.stock+t.quantity,updated_at=NOW()
                            FROM transitioned t
                            WHERE t.rejected_listing_id IS NULL
                              AND p.id=t.product_id AND p.seller_id=t.rejected_seller_id
                              AND NOT EXISTS (
                                SELECT 1 FROM public.cerood_seller_listings l
                                WHERE l.seller_id=t.rejected_seller_id AND l.product_id=t.product_id
                              )
                            RETURNING p.id
                        ),
                        eligible AS (
                            SELECT l.id,l.product_id,l.seller_id,l.price,l.stock,l.warranty_days,
                                   l.dispatch_days,l.updated_at,l.fulfilment_location_id,
                                   t.order_item_id,t.order_id,t.quantity,t.customer_pincode,
                                   regexp_replace(COALESCE(sl.pincode,s.pincode,''), '\D', '', 'g') AS origin_pincode,
                                   MIN(l.price) OVER () AS min_price
                            FROM transitioned t
                            JOIN public.cerood_seller_listings l ON l.product_id=t.product_id
                            JOIN public.cerood_sellers s ON s.id=l.seller_id
                            LEFT JOIN public.cerood_seller_locations sl
                              ON sl.id=l.fulfilment_location_id
                             AND sl.seller_id=l.seller_id
                             AND sl.is_active=true
                            WHERE l.seller_id<>t.rejected_seller_id
                              AND l.approval_status='approved' AND l.is_active=true
                              AND l.stock>=t.quantity AND s.status='approved'
                              AND (l.fulfilment_location_id IS NULL OR sl.id IS NOT NULL)
                        ),
                        fair_pool AS (
                            SELECT *,
                                   CASE
                                     WHEN customer_pincode ~ '^\d{6}$' AND origin_pincode=customer_pincode THEN 0
                                     WHEN customer_pincode ~ '^\d{6}$' AND origin_pincode ~ '^\d{6}$'
                                          AND LEFT(origin_pincode,3)=LEFT(customer_pincode,3) THEN 1
                                     WHEN origin_pincode ~ '^\d{6}$' THEN 2
                                     ELSE 3
                                   END AS location_rank
                            FROM eligible
                            WHERE price<=min_price+GREATEST(50,CEIL(min_price*0.02))
                        ),
                        recent_load AS (
                            SELECT i.seller_listing_id,COALESCE(SUM(i.quantity),0)::bigint AS assigned_units_7d
                            FROM public.renewed_order_items i
                            JOIN public.renewed_orders o ON o.id=i.order_id
                            WHERE i.seller_listing_id IS NOT NULL
                              AND o.created_at>=NOW()-INTERVAL '7 days'
                              AND o.status NOT IN ('expired','cancelled')
                            GROUP BY i.seller_listing_id
                        ),
                        chosen AS (
                            SELECT f.*
                            FROM fair_pool f
                            LEFT JOIN recent_load r ON r.seller_listing_id=f.id
                            ORDER BY f.location_rank,COALESCE(r.assigned_units_7d,0),
                                     f.price,f.dispatch_days,f.updated_at,f.id
                            LIMIT 1
                        ),
                        reserved AS (
                            UPDATE public.cerood_seller_listings l
                            SET stock=l.stock-c.quantity,updated_at=NOW()
                            FROM chosen c
                            WHERE l.id=c.id AND l.stock>=c.quantity
                            RETURNING l.id AS seller_listing_id,l.seller_id,l.price,l.warranty_days,
                                      l.fulfilment_location_id,c.order_item_id,c.order_id,c.quantity
                        ),
                        reassigned AS (
                            UPDATE public.renewed_order_items oi
                            SET seller_id=r.seller_id,seller_listing_id=r.seller_listing_id,
                                fulfilment_location_id=r.fulfilment_location_id,
                                unit_price=r.price,line_total=r.price*r.quantity,
                                warranty_days_at_purchase=r.warranty_days,
                                seller_order_status='new',seller_accepted_at=NULL,
                                seller_rejected_at=NULL,seller_packed_at=NULL,seller_shipped_at=NULL,
                                seller_order_note=NULL
                            FROM reserved r
                            WHERE oi.id=r.order_item_id AND oi.order_id=r.order_id
                            RETURNING oi.id AS order_item_id,oi.order_id,oi.seller_id,
                                      oi.seller_listing_id,oi.fulfilment_location_id,oi.seller_order_status
                        )
                        SELECT t.order_item_id,t.order_id,
                               COALESCE(r.seller_order_status,t.seller_order_status) AS seller_order_status,
                               r.seller_id AS reassigned_seller_id,
                               r.seller_listing_id AS reassigned_listing_id,
                               r.fulfilment_location_id AS reassigned_fulfilment_location_id,
                               (r.order_item_id IS NOT NULL) AS reassigned
                        FROM transitioned t
                        LEFT JOIN reassigned r ON r.order_item_id=t.order_item_id
                    `
                    : `

                        UPDATE public.renewed_order_items AS oi

                        SET

                            seller_order_status = 'accepted',

                            seller_accepted_at = NOW()

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
            // MAIN STORE FULFILMENT
            // ================================================

            const shopItem = parseShopItem(rawItemId);
            if (shopItem) {
                if (!['packed','shipped'].includes(nextStatus)) {
                    return res.status(400).json({success:false,message:'Invalid fulfilment status.'});
                }
                try {
                    if (nextStatus === 'shipped' && sellerShipping && typeof sellerShipping.assertBookedForItem === 'function') {
                        await sellerShipping.assertBookedForItem(rawItemId, req.seller.id);
                    }
                    const rows = await changeShopItem(shopItem, req.seller.id, 'fulfilment', nextStatus);
                    if (!rows.length) {
                        return res.status(409).json({success:false,message:'Order unavailable or invalid status transition. Refresh orders.'});
                    }
                    return res.json({
                        success:true,
                        message:nextStatus==='packed' ? 'Main Store item marked as packed.' : 'Main Store item marked as shipped.',
                        order:rows[0]
                    });
                } catch (error) {
                    console.error('Main Store seller fulfilment error:',error);
                    return res.status(error.status||500).json({success:false,message:error.status?error.message:'Unable to update Main Store fulfilment.'});
                }
            }


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

                    if (
                        nextStatus === 'shipped' &&
                        sellerShipping &&
                        typeof sellerShipping.assertBookedForItem === 'function'
                    ) {
                        await sellerShipping.assertBookedForItem(
                            rawItemId,
                            req.seller.id
                        );
                    }

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

                    return res.status(error.status || 500).json({

                        success: false,

                        message:
                            error.status
                                ? error.message
                                : 'Unable to update order fulfilment.'

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

                if (
                    nextStatus === 'shipped' &&
                    sellerShipping &&
                    typeof sellerShipping.assertBookedForItem === 'function'
                ) {
                    await sellerShipping.assertBookedForItem(
                        rawItemId,
                        req.seller.id
                    );
                }

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

                return res.status(error.status || 500).json({

                    success: false,

                    message:
                        error.status
                            ? error.message
                            : 'Unable to update order fulfilment.'

                });

            }

        }

    );

};