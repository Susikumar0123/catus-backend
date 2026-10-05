
'use strict';

// CEROOD SELLER MARKETPLACE
// Seller registration, authentication, account management and persistent support.
// Existing product and order modules remain separately registered in server.js.

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


    // Seller account detail for Common Admin. Credentials are never selected.
    app.get('/api/admin/sellers/:id/details', requireAdminAuth, async (req, res) => {
        res.set('Cache-Control', 'no-store');
        const id = String(req.params.id || '');
        if (!validUUID(id)) return res.status(400).json({success:false,message:'Invalid seller.'});
        try {
            const sellers = await query(`SELECT ${publicFields} FROM public.cerood_sellers WHERE id=? LIMIT 1`, [id]);
            if (!sellers.length) return res.status(404).json({success:false,message:'Seller not found.'});
            const [locations, serviceability] = await Promise.all([
                query(`SELECT id,location_name,address_line1,address_line2,city,district,state,pincode,
                              is_active,is_default,created_at,updated_at
                         FROM public.cerood_seller_locations WHERE seller_id=?
                        ORDER BY is_default DESC,created_at ASC`, [id]),
                query(`SELECT svc.id,svc.fulfilment_location_id,loc.location_name,svc.destination_pincode,
                              svc.min_delivery_days,svc.max_delivery_days,svc.delivery_fee,
                              svc.cod_available,svc.prepaid_available,svc.is_active,svc.created_at,svc.updated_at
                         FROM public.cerood_seller_serviceability svc
                         JOIN public.cerood_seller_locations loc ON loc.id=svc.fulfilment_location_id
                        WHERE loc.seller_id=? ORDER BY loc.location_name,svc.destination_pincode`, [id])
            ]);
            return res.json({success:true,seller:sellers[0],locations,serviceability});
        } catch (error) { return fail(res, error); }
    });

    // Persistent seller support. Tables are additive; existing orders and payments are untouched.
    const crypto = require('crypto');
    const multer = require('multer');
    const axios = require('axios');
    const ticketStatuses = ['open','in_progress','needs_attention','closed'];
    const supportBucket = 'cerood-seller-support';
    const supportMimes = ['image/jpeg','image/png','image/webp','video/mp4','video/webm'];
    let schemaPromise, bucketPromise;
    function supportSchema() {
        if (!schemaPromise) schemaPromise = (async () => {
            const statements = [
                `CREATE TABLE IF NOT EXISTS public.cerood_seller_support_tickets (
                    id UUID PRIMARY KEY, ticket_no BIGSERIAL UNIQUE NOT NULL,
                    seller_id UUID NOT NULL REFERENCES public.cerood_sellers(id),
                    category VARCHAR(100) NOT NULL, subject VARCHAR(250) NOT NULL,
                    reference_id VARCHAR(100), description TEXT NOT NULL,
                    status VARCHAR(30) NOT NULL DEFAULT 'open'
                        CHECK(status IN ('open','in_progress','needs_attention','closed')),
                    last_sender VARCHAR(10) NOT NULL DEFAULT 'seller',
                    last_message_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    seller_seen_at TIMESTAMPTZ, admin_seen_at TIMESTAMPTZ,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
                `CREATE TABLE IF NOT EXISTS public.cerood_seller_support_messages (
                    id UUID PRIMARY KEY,
                    ticket_id UUID NOT NULL REFERENCES public.cerood_seller_support_tickets(id) ON DELETE CASCADE,
                    sender_role VARCHAR(10) NOT NULL CHECK(sender_role IN ('seller','admin')),
                    body TEXT NOT NULL DEFAULT '', attachments JSONB NOT NULL DEFAULT '[]'::jsonb,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
                `CREATE INDEX IF NOT EXISTS cerood_support_seller_updated ON public.cerood_seller_support_tickets(seller_id,updated_at DESC)`,
                `CREATE INDEX IF NOT EXISTS cerood_support_status_updated ON public.cerood_seller_support_tickets(status,updated_at DESC)`,
                `CREATE INDEX IF NOT EXISTS cerood_support_messages_ticket ON public.cerood_seller_support_messages(ticket_id,created_at)`,
                `ALTER TABLE public.cerood_seller_support_tickets ENABLE ROW LEVEL SECURITY`,
                `ALTER TABLE public.cerood_seller_support_messages ENABLE ROW LEVEL SECURITY`
            ];
            for (const sql of statements) await query(sql);
        })().catch(error => { schemaPromise = null; throw error; });
        return schemaPromise;
    }
    function storageConfig() {
        const base = String(process.env.SUPABASE_URL || process.env.PROJECT_URL || '').replace(/\/rest\/v1\/?$/, '').replace(/\/$/, '');
        const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '';
        if (!base || !key) throw Object.assign(new Error('Ticket attachment storage is not configured.'), {status:503});
        return {base,headers:{Authorization:'Bearer '+key,apikey:key},timeout:60000};
    }
    async function ensureSupportBucket() {
        if (!bucketPromise) bucketPromise = (async () => {
            const c = storageConfig();
            let bucket;
            try { bucket = (await axios.get(c.base+'/storage/v1/bucket/'+supportBucket, c)).data; }
            catch (error) {
                const status = Number(error.response?.status), code = String(error.response?.data?.statusCode || '');
                if (status !== 404 && code !== '404') throw error;
                try {
                    await axios.post(c.base+'/storage/v1/bucket', {
                        id:supportBucket,name:supportBucket,public:false,file_size_limit:25*1024*1024,allowed_mime_types:supportMimes
                    }, c);
                } catch (createError) {
                    if (![400,409].includes(Number(createError.response?.status))) throw createError;
                }
                bucket = (await axios.get(c.base+'/storage/v1/bucket/'+supportBucket, c)).data;
            }
            if (bucket?.public !== false) throw Object.assign(new Error('Ticket attachments require a private storage bucket.'), {status:503});
        })().catch(error => { bucketPromise = null; throw error; });
        return bucketPromise;
    }
    function detectedMedia(buffer) {
        if (!Buffer.isBuffer(buffer)) return '';
        if (buffer.length >= 3 && buffer[0]===255 && buffer[1]===216 && buffer[2]===255) return 'image/jpeg';
        if (buffer.length >= 8 && buffer.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
        if (buffer.length >= 12 && buffer.toString('ascii',0,4)==='RIFF' && buffer.toString('ascii',8,12)==='WEBP') return 'image/webp';
        if (buffer.length >= 12 && buffer.toString('ascii',4,8)==='ftyp') return 'video/mp4';
        if (buffer.length >= 4 && buffer.subarray(0,4).equals(Buffer.from([26,69,223,163]))) return 'video/webm';
        return '';
    }
    const ticketUpload = multer({storage:multer.memoryStorage(),limits:{fileSize:25*1024*1024,files:3,fields:8,fieldSize:20000},
        fileFilter:(req,file,cb) => cb(supportMimes.includes(file.mimetype)?null:new Error('Use JPG, PNG, WebP, MP4 or WebM attachments.'), supportMimes.includes(file.mimetype))
    }).array('files',3);
    function parseTicketUpload(req,res,next) {
        ticketUpload(req,res,error => {
            if (error) return res.status(400).json({success:false,message:error.code==='LIMIT_FILE_SIZE'?'Maximum video size is 25 MB.':error.message});
            for (const file of req.files || []) {
                if (detectedMedia(file.buffer)!==file.mimetype) return res.status(400).json({success:false,message:'An attachment has an invalid file format.'});
                if (file.mimetype.startsWith('image/') && file.size>10*1024*1024) return res.status(400).json({success:false,message:'Maximum image size is 10 MB.'});
            }
            next();
        });
    }
    async function storeEvidence(req,ticketId,uploaded) {
        const files = req.files || [];
        if (!files.length) return [];
        await ensureSupportBucket();
        const c=storageConfig(), result=[],extensions={'image/jpeg':'jpg','image/png':'png','image/webp':'webp','video/mp4':'mp4','video/webm':'webm'};
        for (const file of files) {
            const id=crypto.randomUUID(), storage_path=ticketId+'/'+id+'.'+extensions[file.mimetype];
            await axios.post(c.base+'/storage/v1/object/'+supportBucket+'/'+storage_path,file.buffer,{
                headers:{...c.headers,'Content-Type':file.mimetype},timeout:c.timeout,maxBodyLength:25*1024*1024
            });
            uploaded.push(storage_path);
            result.push({id,storage_path,file_name:String(file.originalname||'attachment').replace(/[\x00-\x1f\\/]/g,'_').slice(0,180),content_type:file.mimetype,size:file.size});
        }
        return result;
    }
    async function discardEvidence(paths) {
        if (!paths.length) return;
        try { const c=storageConfig(); await axios.delete(c.base+'/storage/v1/object/'+supportBucket,{...c,data:{prefixes:paths}}); }
        catch (error) { console.error('Ticket upload cleanup failed:', error.message); }
    }
    function publicMessage(message) {
        const attachments=typeof message.attachments==='string'?JSON.parse(message.attachments):message.attachments||[];
        return {...message,attachments:attachments.map(({id,file_name,content_type,size})=>({id,file_name,content_type,size}))};
    }
    function ticketFailure(res,error) {
        console.error('Seller support:',error.message);
        return res.status(error.status || 500).json({success:false,message:error.status?error.message:'Unable to process the support request. Please try again.'});
    }
    async function listTickets(req,res,admin) {
        res.set('Cache-Control','no-store');
        try {
            await supportSchema();
            const params=[],where=[];
            if (!admin) {params.push(req.seller.id);where.push('t.seller_id=?');}
            else if (req.query.seller_id) {
                if (!validUUID(req.query.seller_id)) return res.status(400).json({success:false,message:'Invalid seller filter.'});
                params.push(req.query.seller_id);where.push('t.seller_id=?');
            }
            const category=String(req.query.category||'').trim();
            if(category){if(category.length>100)return res.status(400).json({success:false,message:'Invalid category filter.'});where.push('t.category=?');params.push(category);}
            const q=String(req.query.q||'').trim().slice(0,150);
            if(q){where.push(`(t.subject ILIKE ? OR COALESCE(t.reference_id,'') ILIKE ? OR s.shop_name ILIKE ? OR s.owner_name ILIKE ? OR CAST(t.ticket_no AS TEXT) ILIKE ?)`);for(let i=0;i<5;i++)params.push('%'+q+'%');}
            const baseWhere=where.length?' WHERE '+where.join(' AND '):'';
            const joined=` FROM public.cerood_seller_support_tickets t JOIN public.cerood_sellers s ON s.id=t.seller_id`;
            const counts=(await query(`SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER(WHERE t.status='open')::int AS open,
                COUNT(*) FILTER(WHERE t.status='in_progress')::int AS in_progress,
                COUNT(*) FILTER(WHERE t.status='needs_attention')::int AS needs_attention,
                COUNT(*) FILTER(WHERE t.status='closed')::int AS closed ${joined}${baseWhere}`,params))[0];
            const status=String(req.query.status||'');
            if(status){if(!ticketStatuses.includes(status))return res.status(400).json({success:false,message:'Invalid ticket status.'});where.push('t.status=?');params.push(status);}
            const limit=Math.max(1,Math.min(100,Math.floor(Number(req.query.limit)||50))),offset=Math.max(0,Math.min(100000,Math.floor(Number(req.query.offset)||0)));
            const rows=await query(`SELECT t.*,s.shop_name,s.owner_name,s.phone AS seller_phone,s.email AS seller_email,
                CASE WHEN t.last_sender=? AND (t.${admin?'admin':'seller'}_seen_at IS NULL OR t.last_message_at>t.${admin?'admin':'seller'}_seen_at) THEN true ELSE false END AS unread
                ${joined}${where.length?' WHERE '+where.join(' AND '):''} ORDER BY t.updated_at DESC,t.ticket_no DESC LIMIT ? OFFSET ?`,
                [admin?'seller':'admin',...params,limit+1,offset]);
            return res.json({success:true,tickets:rows.slice(0,limit),counts,has_more:rows.length>limit,offset});
        } catch(error){return ticketFailure(res,error);}
    }
    async function ticketThread(req,res,admin) {
        res.set('Cache-Control','no-store');
        const id=String(req.params.id||'');
        if(!validUUID(id))return res.status(400).json({success:false,message:'Invalid ticket.'});
        try {
            await supportSchema();
            const args=admin?[id]:[id,req.seller.id];
            const rows=await query(`SELECT t.*,s.shop_name,s.owner_name,s.phone AS seller_phone,s.email AS seller_email
                FROM public.cerood_seller_support_tickets t JOIN public.cerood_sellers s ON s.id=t.seller_id
                WHERE t.id=?${admin?'':' AND t.seller_id=?'} LIMIT 1`,args);
            if(!rows.length)return res.status(404).json({success:false,message:'Ticket not found.'});
            const messages=await query(`SELECT id,sender_role,body,attachments,created_at FROM public.cerood_seller_support_messages WHERE ticket_id=? ORDER BY created_at,id`,[id]);
            // Do not mark a concurrent reply read: acknowledge only the message timestamp returned above.
            await query(`UPDATE public.cerood_seller_support_tickets SET ${admin?'admin':'seller'}_seen_at=? WHERE id=?`,[rows[0].last_message_at,id]);
            return res.json({success:true,ticket:rows[0],messages:messages.map(publicMessage)});
        } catch(error){return ticketFailure(res,error);}
    }
    async function createTicket(req,res) {
        res.set('Cache-Control','no-store');
        const b=req.body||{},category=String(b.category||'').trim(),subject=String(b.subject||'').trim(),description=String(b.description||'').trim(),reference=String(b.reference_id||'').trim();
        if(!category||category.length>100||!subject||subject.length>250||!description||description.length>5000||reference.length>100)
            return res.status(400).json({success:false,message:'Enter a category, subject and description (maximum 5,000 characters).'});
        const id=crypto.randomUUID(),uploaded=[];let client;
        try {
            await supportSchema();
            const attachments=await storeEvidence(req,id,uploaded);
            client=await db.getClient();await client.query('BEGIN');
            const rows=await client.query(`INSERT INTO public.cerood_seller_support_tickets(id,seller_id,category,subject,reference_id,description,seller_seen_at)
                VALUES($1,$2,$3,$4,$5,$6,NOW()) RETURNING *`,[id,req.seller.id,category,subject,reference||null,description]);
            await client.query(`INSERT INTO public.cerood_seller_support_messages(id,ticket_id,sender_role,body,attachments) VALUES($1,$2,'seller',$3,$4::jsonb)`,[crypto.randomUUID(),id,description,JSON.stringify(attachments)]);
            await client.query('COMMIT');return res.status(201).json({success:true,ticket:rows[0]});
        } catch(error){if(client)await client.query('ROLLBACK').catch(()=>{});await discardEvidence(uploaded);return ticketFailure(res,error);}
        finally{if(client)client.release();}
    }
    async function replyTicket(req,res,admin) {
        res.set('Cache-Control','no-store');
        const id=String(req.params.id||''),body=String(req.body?.body||'').trim(),status=String(req.body?.status||'');
        if(!validUUID(id)||body.length>5000||(!body&&!(req.files||[]).length)||(status&&(!admin||!ticketStatuses.includes(status))))
            return res.status(400).json({success:false,message:'Enter a reply (maximum 5,000 characters) and a valid status.'});
        const uploaded=[];let client;
        try {
            await supportSchema();
            // Check ownership before uploading evidence, then check again under the transaction lock.
            const own=await query(`SELECT id FROM public.cerood_seller_support_tickets WHERE id=?${admin?'':' AND seller_id=?'}`,admin?[id]:[id,req.seller.id]);
            if(!own.length)return res.status(404).json({success:false,message:'Ticket not found.'});
            const attachments=await storeEvidence(req,id,uploaded);
            client=await db.getClient();await client.query('BEGIN');
            const rows=await client.query(`SELECT * FROM public.cerood_seller_support_tickets WHERE id=$1${admin?'':' AND seller_id=$2'} FOR UPDATE`,admin?[id]:[id,req.seller.id]);
            if(!rows.length)throw Object.assign(new Error('Ticket not found.'),{status:404});
            const next=admin?(status||'in_progress'):(rows[0].status==='closed'?'open':rows[0].status==='needs_attention'?'in_progress':rows[0].status);
            const messages=await client.query(`INSERT INTO public.cerood_seller_support_messages(id,ticket_id,sender_role,body,attachments)
                VALUES($1,$2,$3,$4,$5::jsonb) RETURNING *`,[crypto.randomUUID(),id,admin?'admin':'seller',body,JSON.stringify(attachments)]);
            await client.query(`UPDATE public.cerood_seller_support_tickets SET status=$2,last_sender=$3,last_message_at=NOW(),updated_at=NOW(),${admin?'admin':'seller'}_seen_at=NOW() WHERE id=$1`,[id,next,admin?'admin':'seller']);
            await client.query('COMMIT');return res.status(201).json({success:true,message:publicMessage(messages[0]),status:next});
        } catch(error){if(client)await client.query('ROLLBACK').catch(()=>{});await discardEvidence(uploaded);return ticketFailure(res,error);}
        finally{if(client)client.release();}
    }
    async function downloadTicketAttachment(req,res,admin) {
        res.set('Cache-Control','private, no-store');
        const id=String(req.params.id||''),attachmentId=String(req.params.attachmentId||'');
        if(!validUUID(id)||!validUUID(attachmentId))return res.status(400).json({success:false,message:'Invalid attachment.'});
        try {
            await supportSchema();
            const rows=await query(`SELECT m.attachments FROM public.cerood_seller_support_messages m
                JOIN public.cerood_seller_support_tickets t ON t.id=m.ticket_id
                WHERE t.id=?${admin?'':' AND t.seller_id=?'}`,admin?[id]:[id,req.seller.id]);
            const file=rows.flatMap(r=>typeof r.attachments==='string'?JSON.parse(r.attachments):r.attachments||[]).find(f=>f.id===attachmentId);
            if(!file)return res.status(404).json({success:false,message:'Attachment not found.'});
            await ensureSupportBucket();const c=storageConfig();
            const result=await axios.get(c.base+'/storage/v1/object/authenticated/'+supportBucket+'/'+file.storage_path,{...c,responseType:'arraybuffer',maxContentLength:25*1024*1024});
            res.set('Content-Type',file.content_type);res.set('X-Content-Type-Options','nosniff');
            res.set('Content-Disposition',"attachment; filename*=UTF-8''"+encodeURIComponent(file.file_name));
            return res.send(Buffer.from(result.data));
        } catch(error){return ticketFailure(res,error);}
    }
    app.get('/api/sellers/support/tickets',requireSellerAuth,(req,res)=>listTickets(req,res,false));
    app.post('/api/sellers/support/tickets',requireSellerAuth,parseTicketUpload,createTicket);
    app.get('/api/sellers/support/tickets/:id',requireSellerAuth,(req,res)=>ticketThread(req,res,false));
    app.post('/api/sellers/support/tickets/:id/messages',requireSellerAuth,parseTicketUpload,(req,res)=>replyTicket(req,res,false));
    app.get('/api/sellers/support/tickets/:id/attachments/:attachmentId',requireSellerAuth,(req,res)=>downloadTicketAttachment(req,res,false));
    app.get('/api/admin/seller-support/tickets',requireAdminAuth,(req,res)=>listTickets(req,res,true));
    app.get('/api/admin/seller-support/tickets/:id',requireAdminAuth,(req,res)=>ticketThread(req,res,true));
    app.post('/api/admin/seller-support/tickets/:id/messages',requireAdminAuth,parseTicketUpload,(req,res)=>replyTicket(req,res,true));
    app.get('/api/admin/seller-support/tickets/:id/attachments/:attachmentId',requireAdminAuth,(req,res)=>downloadTicketAttachment(req,res,true));
    app.patch('/api/admin/seller-support/tickets/:id/status',requireAdminAuth,async(req,res)=>{
        res.set('Cache-Control','no-store');
        const id=String(req.params.id||''),status=String(req.body?.status||'');
        if(!validUUID(id)||!ticketStatuses.includes(status))return res.status(400).json({success:false,message:'Invalid ticket or status.'});
        let client;
        try{await supportSchema();client=await db.getClient();await client.query('BEGIN');
            const current=await client.query(`SELECT * FROM public.cerood_seller_support_tickets WHERE id=$1 FOR UPDATE`,[id]);
            if(!current.length){await client.query('ROLLBACK');return res.status(404).json({success:false,message:'Ticket not found.'});}
            let ticket=current[0];
            if(ticket.status!==status){
                await client.query(`INSERT INTO public.cerood_seller_support_messages(id,ticket_id,sender_role,body)
                    VALUES($1,$2,'admin',$3)`,[crypto.randomUUID(),id,'Ticket status changed to '+status.replace(/_/g,' ')+'.']);
                const rows=await client.query(`UPDATE public.cerood_seller_support_tickets SET status=$2,last_sender='admin',
                    updated_at=NOW(),last_message_at=NOW(),admin_seen_at=NOW() WHERE id=$1 RETURNING *`,[id,status]);ticket=rows[0];
            }
            await client.query('COMMIT');return res.json({success:true,ticket});
        }catch(error){if(client)await client.query('ROLLBACK').catch(()=>{});return ticketFailure(res,error);}
        finally{if(client)client.release();}
    });


    // ==========================================
    // 11. EXPORT SELLER AUTH FOR NEXT PHASE
    // ==========================================

    return {

        requireSellerAuth

    };

};
