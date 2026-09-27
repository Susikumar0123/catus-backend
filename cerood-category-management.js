
'use strict';

// ==========================================
// CEROOD DYNAMIC CATEGORY MANAGEMENT
// Admin-only writes.
// Separate from Home Services.
// ==========================================

module.exports = function registerCeroodCategories(
    app,
    db,
    requireAdminAuth
) {

    const query = (sql, params = []) =>
        new Promise((resolve, reject) => {

            db.query(sql, params, (err, rows) => {

                if (err) {
                    return reject(err);
                }

                resolve(rows || []);

            });

        });


    // ==========================================
    // SUPPORTED SHOPPING MARKETPLACES
    // ==========================================

    const markets = new Set([
        'renewed',
        'cosmetics',
        'clothing',
        'general'
    ]);


    const uuid = s =>
        /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i
            .test(String(s || ''));


    const slug = s =>
        String(s || '')
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, '');


    // ==========================================
    // ERROR HANDLING
    // ==========================================

    const fail = (res, err) => {

        console.error(
            'Cerood category management:',
            err
        );

        return res
            .status(err.status || 503)
            .json({

                success: false,

                message: err.status
                    ? err.message
                    : 'Category service unavailable; check SQL migration and Render logs.'

            });

    };


    const bad = message =>
        Object.assign(
            new Error(message),
            { status: 400 }
        );


    const missing = message =>
        Object.assign(
            new Error(message),
            { status: 404 }
        );


    // ==========================================
    // PUBLIC API: GET ACTIVE CATEGORIES
    // ==========================================

    app.get(
        '/api/shop/categories',
        async (req, res) => {

            try {

                const marketplace = String(
                    req.query.marketplace || ''
                );

                if (!markets.has(marketplace)) {

                    throw bad(
                        'Valid marketplace required.'
                    );

                }

                const categories = await query(

                    `
                    SELECT
                        id,
                        marketplace,
                        parent_id,
                        name,
                        slug,
                        attribute_schema,
                        sort_order

                    FROM public.cerood_shop_categories

                    WHERE marketplace = $1
                      AND is_active = true

                    ORDER BY
                        sort_order,
                        name
                    `,

                    [marketplace]

                );

                return res.json({

                    success: true,
                    categories

                });

            } catch (e) {

                return fail(res, e);

            }

        }
    );


    // ==========================================
    // ADMIN API: GET ALL CATEGORIES
    // ==========================================

    app.get(
        '/api/admin/shop/categories',
        requireAdminAuth,
        async (req, res) => {

            try {

                const market = String(
                    req.query.marketplace || ''
                );

                if (
                    market &&
                    !markets.has(market)
                ) {

                    throw bad(
                        'Invalid marketplace.'
                    );

                }

                const categories = await query(

                    `
                    SELECT *

                    FROM public.cerood_shop_categories

                    WHERE (
                        $1::text = ''
                        OR marketplace = $1
                    )

                    ORDER BY
                        marketplace,
                        sort_order,
                        name
                    `,

                    [market]

                );

                return res.json({

                    success: true,
                    categories

                });

            } catch (e) {

                return fail(res, e);

            }

        }
    );


    // ==========================================
    // ADMIN API: CREATE CATEGORY
    // ==========================================

    app.post(
        '/api/admin/shop/categories',
        requireAdminAuth,
        async (req, res) => {

            try {

                const b = req.body || {};

                const marketplace = String(
                    b.marketplace || ''
                );

                const name = String(
                    b.name || ''
                ).trim();

                const code = slug(
                    b.slug || name
                );


                // VALIDATE MARKETPLACE

                if (!markets.has(marketplace)) {

                    throw bad(
                        'Invalid marketplace.'
                    );

                }


                // VALIDATE CATEGORY NAME

                if (
                    name.length < 2 ||
                    name.length > 100 ||
                    !code
                ) {

                    throw bad(
                        'Valid category name and slug required.'
                    );

                }


                // VALIDATE PARENT CATEGORY

                if (
                    b.parent_id &&
                    !uuid(b.parent_id)
                ) {

                    throw bad(
                        'Invalid parent ID.'
                    );

                }


                // VALIDATE ATTRIBUTES

                const attrs =
                    b.attribute_schema ?? [];

                if (
                    !Array.isArray(attrs) ||
                    attrs.length > 100
                ) {

                    throw bad(
                        'attribute_schema must be an array of up to 100 fields.'
                    );

                }


                // INSERT CATEGORY

                const rows = await query(

                    `
                    INSERT INTO public.cerood_shop_categories
                    (
                        marketplace,
                        parent_id,
                        name,
                        slug,
                        attribute_schema,
                        sort_order
                    )

                    VALUES
                    (
                        $1,
                        $2,
                        $3,
                        $4,
                        $5::jsonb,
                        $6
                    )

                    RETURNING *
                    `,

                    [
                        marketplace,

                        b.parent_id || null,

                        name,

                        code,

                        JSON.stringify(attrs),

                        Number.isInteger(b.sort_order)
                            ? b.sort_order
                            : 0
                    ]

                );


                return res
                    .status(201)
                    .json({

                        success: true,

                        category: rows[0]

                    });

            } catch (e) {

                if (e.code === '23505') {

                    e = bad(
                        'Category slug already exists in this marketplace.'
                    );

                }

                if (
                    e.code === '23503' ||
                    e.code === 'P0001'
                ) {

                    e = bad(
                        'Invalid parent category.'
                    );

                }

                return fail(res, e);

            }

        }
    );


    // ==========================================
    // ADMIN API: UPDATE CATEGORY
    // ==========================================

    app.patch(
        '/api/admin/shop/categories/:id',
        requireAdminAuth,
        async (req, res) => {

            try {

                if (!uuid(req.params.id)) {

                    throw bad(
                        'Invalid category ID.'
                    );

                }


                const allowed = [

                    'name',

                    'slug',

                    'attribute_schema',

                    'sort_order',

                    'is_active'

                ];


                const b = req.body || {};


                const keys = allowed.filter(

                    k => Object.hasOwn(b, k)

                );


                if (!keys.length) {

                    throw bad(
                        'No valid fields supplied.'
                    );

                }


                // VALIDATE NAME

                if (
                    keys.includes('name') &&
                    (
                        typeof b.name !== 'string' ||
                        b.name.trim().length < 2 ||
                        b.name.trim().length > 100
                    )
                ) {

                    throw bad(
                        'Invalid name.'
                    );

                }


                // VALIDATE SLUG

                if (keys.includes('slug')) {

                    b.slug = slug(b.slug);

                    if (!b.slug) {

                        throw bad(
                            'Invalid slug.'
                        );

                    }

                }


                // VALIDATE ATTRIBUTES

                if (
                    keys.includes('attribute_schema') &&
                    (
                        !Array.isArray(
                            b.attribute_schema
                        ) ||
                        b.attribute_schema.length > 100
                    )
                ) {

                    throw bad(
                        'Invalid attribute schema.'
                    );

                }


                // VALIDATE SORT ORDER

                if (
                    keys.includes('sort_order') &&
                    !Number.isInteger(
                        b.sort_order
                    )
                ) {

                    throw bad(
                        'Invalid sort order.'
                    );

                }


                // VALIDATE ACTIVE STATUS

                if (
                    keys.includes('is_active') &&
                    typeof b.is_active !== 'boolean'
                ) {

                    throw bad(
                        'Invalid active status.'
                    );

                }


                // PREPARE VALUES

                const vals = keys.map(

                    k =>

                        k === 'attribute_schema'

                            ? JSON.stringify(b[k])

                            : k === 'name'

                                ? b[k].trim()

                                : b[k]

                );


                // PREPARE SQL UPDATE FIELDS

                const sets = keys.map(

                    (k, i) =>

                        `"${k}"=$${i + 1}${
                            k === 'attribute_schema'
                                ? '::jsonb'
                                : ''
                        }`

                ).join(', ');


                // UPDATE CATEGORY

                const rows = await query(

                    `
                    UPDATE public.cerood_shop_categories

                    SET
                        ${sets},
                        updated_at = now()

                    WHERE id = $${keys.length + 1}

                    RETURNING *
                    `,

                    [
                        ...vals,
                        req.params.id
                    ]

                );


                if (!rows.length) {

                    throw missing(
                        'Category not found.'
                    );

                }


                return res.json({

                    success: true,

                    category: rows[0]

                });

            } catch (e) {

                if (e.code === '23505') {

                    e = bad(
                        'Category slug already exists in this marketplace.'
                    );

                }

                return fail(res, e);

            }

        }
    );

};
