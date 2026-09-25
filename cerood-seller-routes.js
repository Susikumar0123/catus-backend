
'use strict';

// CEROOD SELLER MARKETPLACE
// Phase 2: Seller registration, login and admin approval.
// Product upload and seller order APIs are not included yet.

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

module.exports = function registerSellerRoutes(
    app,
    db,
    requireAdminAuth,
    verifyMsg91AccessToken,
    extractVerifiedPhoneFromMsg91
) {

    // ==========================================
    // 1. DATABASE HELPER
    // ==========================================

    const query = (sql, args = []) =>
        new Promise((resolve, reject) => {

            db.query(sql, args, (err, rows) => {

                if (err) {
                    return reject(err);
                }

                resolve(rows || []);

            });

        });


    // ==========================================
    // 2. ERROR HELPER
    // ==========================================

    const fail = (res, err) => {

        console.error(
            'Seller API:',
            err.message
        );

        return res.status(500).json({

            success: false,

            message: 'Seller service unavailable.'

        });

    };


    // ==========================================
    // 3. SAFE SELLER FIELDS
    // ==========================================

    // Never return password_hash to frontend.

    const publicFields = `
        id,
        owner_name,
        shop_name,
        phone,
        email,
        business_type,
        gst_number,
        address,
        state,
        district,
        pincode,
        status,
        commission_percent,
        approved_at,
        created_at,
        updated_at
    `;


    // ==========================================
    // 4. VALIDATION HELPERS
    // ==========================================

    const secret = () =>
        String(
            process.env.SELLER_JWT_SECRET || ''
        );

    const phoneOf = (value) =>
        String(value || '')
            .replace(/\D/g, '')
            .replace(/^91(?=[6-9]\d{9}$)/, '');

    const cleanText = (value, max) =>
        String(value ?? '')
            .trim()
            .slice(0, max);

    const validPhone = (value) =>
        /^[6-9]\d{9}$/.test(value);

    const validUUID = (value) =>
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);


    // ==========================================
    // 5. SELLER REGISTRATION
    // ==========================================

    app.post(
        '/api/sellers/register',
        async (req, res) => {

            res.set(
                'Cache-Control',
                'no-store'
            );

            try {

                const body = req.body || {};

                const phone = phoneOf(
                    body.phone
                );

                const password = String(
                    body.password || ''
                );

                const owner_name = cleanText(
                    body.owner_name,
                    150
                );

                const shop_name = cleanText(
                    body.shop_name,
                    180
                );

                const accessToken = String(
                    body.accessToken || ''
                ).trim();

                const pincode = cleanText(
                    body.pincode,
                    6
                );

                const email = cleanText(
                    body.email,
                    180
                );


                // Validate registration data.

                if (

                    !validPhone(phone) ||

                    !owner_name ||

                    !shop_name ||

                    password.length < 8 ||

                    password.length > 128 ||

                    !accessToken ||

                    !/^\d{6}$/.test(pincode) ||

                    (
                        email &&
                        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
                    )

                ) {

                    return res.status(400).json({

                        success: false,

                        message:
                            'Valid owner, shop, mobile, OTP token, pincode and password (8+ characters) required.'

                    });

                }


                // ==================================
                // VERIFY MSG91 OTP ACCESS TOKEN
                // ==================================

                let verified;

                try {

                    verified =
                        await verifyMsg91AccessToken(
                            accessToken
                        );

                } catch (error) {

                    return res.status(401).json({

                        success: false,

                        message:
                            'Mobile OTP verification failed.'

                    });

                }


                const verifiedPhone =
                    extractVerifiedPhoneFromMsg91(
                        verified,
                        accessToken
                    );


                // OTP verified mobile must match
                // the registration mobile.

                if (

                    !validPhone(verifiedPhone) ||

                    verifiedPhone !== phone

                ) {

                    return res.status(401).json({

                        success: false,

                        message:
                            'Verified mobile number does not match.'

                    });

                }


                // ==================================
                // HASH SELLER PASSWORD
                // ==================================

                const passwordHash =
                    await bcrypt.hash(
                        password,
                        12
                    );


                // ==================================
                // INSERT SELLER INTO SUPABASE
                // ==================================

                const rows = await query(

                    `INSERT INTO public.cerood_sellers

                    (
                        owner_name,
                        shop_name,
                        phone,
                        email,
                        password_hash,
                        business_type,
                        gst_number,
                        address,
                        state,
                        district,
                        pincode,
                        status
                    )

                    VALUES

                    (
                        ?, ?, ?, ?, ?, ?,
                        ?, ?, ?, ?, ?,
                        'pending'
                    )

                    RETURNING ${publicFields}`,

                    [

                        owner_name,

                        shop_name,

                        phone,

                        email || null,

                        passwordHash,

                        cleanText(
                            body.business_type,
                            60
                        ) || null,

                        cleanText(
                            body.gst_number,
                            20
                        ) || null,

                        cleanText(
                            body.address,
                            3000
                        ) || null,

                        cleanText(
                            body.state,
                            100
                        ) || null,

                        cleanText(
                            body.district,
                            100
                        ) || null,

                        pincode

                    ]

                );


                return res.status(201).json({

                    success: true,

                    message:
                        'Seller registration submitted for Cerood approval.',

                    seller: rows[0]

                });


            } catch (error) {

                if (error.code === '23505') {

                    return res.status(409).json({

                        success: false,

                        message:
                            'Mobile number already registered as seller.'

                    });

                }

                return fail(
                    res,
                    error
                );

            }

        }
    );


    // ==========================================
    // 6. SELLER LOGIN
    // ==========================================

    app.post(
        '/api/sellers/login',
        async (req, res) => {

            res.set(
                'Cache-Control',
                'no-store'
            );

            try {

                const phone = phoneOf(
                    req.body?.phone
                );

                const password = String(
                    req.body?.password || ''
                );


                if (

                    !validPhone(phone) ||

                    !password

                ) {

                    return res.status(400).json({

                        success: false,

                        message:
                            'Enter mobile and password.'

                    });

                }


                // ==================================
                // FETCH SELLER
                // ==================================

                const rows = await query(

                    `SELECT

                        ${publicFields},

                        password_hash

                    FROM public.cerood_sellers

                    WHERE phone = ?

                    LIMIT 1`,

                    [phone]

                );


                const seller = rows[0];


                // ==================================
                // VERIFY PASSWORD
                // ==================================

                if (

                    !seller ||

                    !seller.password_hash ||

                    !(
                        await bcrypt.compare(
                            password,
                            seller.password_hash
                        )
                    )

                ) {

                    return res.status(401).json({

                        success: false,

                        message:
                            'Invalid mobile or password.'

                    });

                }


                // ==================================
                // CHECK ADMIN APPROVAL
                // ==================================

                if (
                    seller.status !== 'approved'
                ) {

                    return res.status(403).json({

                        success: false,

                        status: seller.status,

                        message:
                            seller.status === 'pending'

                                ? 'Waiting for Cerood approval.'

                                : 'Seller account is not approved.'

                    });

                }


                // ==================================
                // CHECK JWT CONFIGURATION
                // ==================================

                if (
                    secret().length < 32
                ) {

                    return res.status(503).json({

                        success: false,

                        message:
                            'Seller login is not configured.'

                    });

                }


                delete seller.password_hash;


                // ==================================
                // GENERATE SELLER JWT
                // ==================================

                const token = jwt.sign(

                    {

                        sub: seller.id,

                        role: 'seller'

                    },

                    secret(),

                    {

                        algorithm: 'HS256',

                        issuer: 'cerood-seller',

                        expiresIn: '7d'

                    }

                );


                return res.json({

                    success: true,

                    token,

                    seller

                });


            } catch (error) {

                return fail(
                    res,
                    error
                );

            }

        }
    );


    // ==========================================
    // 7. SELLER AUTH MIDDLEWARE
    // ==========================================

    async function requireSellerAuth(
        req,
        res,
        next
    ) {

        try {

            const authorization =
                String(
                    req.headers.authorization || ''
                );


            if (

                !authorization.startsWith(
                    'Bearer '
                ) ||

                secret().length < 32

            ) {

                return res.status(401).json({

                    success: false,

                    message:
                        'Seller login required.'

                });

            }


            // ==================================
            // VERIFY JWT
            // ==================================

            const decoded = jwt.verify(

                authorization.slice(7),

                secret(),

                {

                    algorithms: ['HS256'],

                    issuer: 'cerood-seller'

                }

            );


            if (

                decoded.role !== 'seller' ||

                !validUUID(decoded.sub)

            ) {

                throw new Error(
                    'Invalid seller token'
                );

            }


            // ==================================
            // FETCH CURRENT SELLER STATUS
            // ==================================

            const rows = await query(

                `SELECT

                    ${publicFields}

                FROM public.cerood_sellers

                WHERE id = ?

                LIMIT 1`,

                [decoded.sub]

            );


            // Suspended seller must lose access.

            if (

                !rows.length ||

                rows[0].status !== 'approved'

            ) {

                return res.status(403).json({

                    success: false,

                    message:
                        'Seller account is not active.'

                });

            }


            req.seller = rows[0];

            next();


        } catch (error) {

            return res.status(401).json({

                success: false,

                message:
                    'Seller session invalid or expired.'

            });

        }

    }


    // ==========================================
    // 8. GET LOGGED-IN SELLER
    // ==========================================

    app.get(

        '/api/sellers/me',

        requireSellerAuth,

        (req, res) => {

            return res.json({

                success: true,

                seller: req.seller

            });

        }

    );


    // ==========================================
    // 9. ADMIN - LIST ALL SELLERS
    // ==========================================

    app.get(

        '/api/admin/sellers',

        requireAdminAuth,

        async (req, res) => {

            res.set(
                'Cache-Control',
                'no-store'
            );

            try {

                const sellers =
                    await query(

                        `SELECT

                            ${publicFields}

                        FROM public.cerood_sellers

                        ORDER BY created_at DESC

                        LIMIT 500`

                    );


                return res.json({

                    success: true,

                    sellers

                });


            } catch (error) {

                return fail(
                    res,
                    error
                );

            }

        }

    );


    // ==========================================
    // 10. ADMIN - APPROVE / REJECT / SUSPEND
    // ==========================================

    app.patch(

        '/api/admin/sellers/:id/status',

        requireAdminAuth,

        async (req, res) => {

            res.set(
                'Cache-Control',
                'no-store'
            );

            try {

                const id = String(
                    req.params.id || ''
                );

                const status = String(
                    req.body?.status || ''
                );


                if (

                    !validUUID(id) ||

                    ![
                        'approved',
                        'rejected',
                        'suspended'
                    ].includes(status)

                ) {

                    return res.status(400).json({

                        success: false,

                        message:
                            'Invalid seller or status.'

                    });

                }


                const rows = await query(

                    `UPDATE public.cerood_sellers

                    SET

                        status = ?,

                        approved_at = CASE

                            WHEN ? = 'approved'

                            THEN NOW()

                            ELSE NULL

                        END,

                        updated_at = NOW()

                    WHERE id = ?

                    RETURNING ${publicFields}`,

                    [

                        status,

                        status,

                        id

                    ]

                );


                if (!rows.length) {

                    return res.status(404).json({

                        success: false,

                        message:
                            'Seller not found.'

                    });

                }


                return res.json({

                    success: true,

                    seller: rows[0]

                });


            } catch (error) {

                return fail(
                    res,
                    error
                );

            }

        }

    );


    // ==========================================
    // 11. EXPORT SELLER AUTH FOR NEXT PHASE
    // ==========================================

    return {

        requireSellerAuth

    };

};
