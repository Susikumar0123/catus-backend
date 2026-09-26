const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const Razorpay = require('razorpay');
const multer = require('multer');
const path = require('path');
const sharp = require('sharp');
const db = require('./db');
const axios = require('axios');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 10000;

const allowedOrigins = [
    'https://cerood.com',
    'https://www.cerood.com',
    'https://catus-frontend-nu.vercel.app',
    'http://localhost:3000',
    'http://127.0.0.1:5500'
];

app.use(cors({
    origin: function (origin, callback) {

        // Postman / server-to-server / same-origin requests
        if (!origin) {
            return callback(null, true);
        }

        if (allowedOrigins.includes(origin)) {
            return callback(null, true);
        }

        return callback(
            new Error('Not allowed by CORS')
        );
    },
    credentials: true
}));

// Razorpay webhook signatures require ORIGINAL bytes; both routes MUST precede express.json().
app.use('/api/renewed/razorpay-webhook', express.raw({type:'application/json',limit:'256kb'}));
app.use('/api/cosmetics/razorpay-webhook', express.raw({type:'application/json',limit:'256kb'}));
app.use('/api/clothing/razorpay-webhook', express.raw({type:'application/json',limit:'256kb'}));
app.use(express.json());
app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

// ==========================================
// MSG91 VERIFY ACCESS TOKEN
// ==========================================
app.post('/api/msg91/verify-access-token', async (req, res) => {

    try {

        const accessToken = String(
            req.body.accessToken ||
            req.body['access-token'] ||
            ''
        ).trim();

        const authKey = String(
            process.env.MSG91_AUTH_KEY || ''
        ).trim();

        if (!authKey) {
            return res.status(500).json({
                success: false,
                message: 'MSG91 authentication is not configured.'
            });
        }

        if (!accessToken) {
            return res.status(400).json({
                success: false,
                message: 'MSG91 access token is required.'
            });
        }

        const msg91Response = await axios.post(
            'https://control.msg91.com/api/v5/widget/verifyAccessToken',
            {
                authkey: authKey,
                'access-token': accessToken
            },
            {
                headers: {
                    'Content-Type': 'application/json'
                },
                timeout: 10000
            }
        );

        return res.json({
            success: true,
            verified: true,
            data: msg91Response.data
        });

    } catch (error) {

        console.error(
            'MSG91 Access Token Verification Error:',
            error.response?.data || error.message
        );

        const status =
            error.response?.status >= 400 &&
            error.response?.status < 500
                ? 401
                : 502;

        return res.status(status).json({
            success: false,
            verified: false,
            message: 'MSG91 OTP verification failed.',
            error: error.response?.data || error.message
        });
    }
});
// ==========================================
// MSG91 SECURE OTP HELPERS
// ==========================================

async function verifyMsg91AccessToken(accessToken) {

    const cleanAccessToken =
        String(accessToken || '').trim();

    const authKey =
        String(
            process.env.MSG91_AUTH_KEY || ''
        ).trim();

    if (!authKey) {
        throw new Error(
            'MSG91 authentication is not configured.'
        );
    }

    if (!cleanAccessToken) {
        throw new Error(
            'MSG91 access token is required.'
        );
    }

    const response = await axios.post(
        'https://control.msg91.com/api/v5/widget/verifyAccessToken',
        {
            authkey: authKey,
            'access-token': cleanAccessToken
        },
        {
            headers: {
                'Content-Type': 'application/json'
            },
            timeout: 10000
        }
    );

    return response.data;
}


// ==========================================
// EXTRACT VERIFIED MOBILE NUMBER
// ==========================================

function extractVerifiedPhoneFromMsg91(data, accessToken) {

    function normalizePhone(value) {

        if (
            value === undefined ||
            value === null
        ) {
            return '';
        }

        const digits =
            String(value)
                .replace(/\D/g, '');

        if (/^[6-9]\d{9}$/.test(digits)) {
            return digits;
        }

        if (/^91[6-9]\d{9}$/.test(digits)) {
            return digits.slice(-10);
        }

        return '';
    }
    
    // MSG91 Verify Access Token API
// verified mobile number-ai message field-la return pannudhu
if (
    data &&
    String(data.type || '').toLowerCase() === 'success'
) {

    const phoneFromMessage =
        normalizePhone(data.message);

    if (phoneFromMessage) {

        console.log(
            'MSG91 verified phone from message:',
            phoneFromMessage
        );

        return phoneFromMessage;
    }
}

    function deepSearch(obj, depth = 0) {

        if (
            !obj ||
            typeof obj !== 'object' ||
            depth > 8
        ) {
            return '';
        }

        for (const [key, value] of Object.entries(obj)) {

            const normalizedKey =
                String(key)
                    .replace(/[-_\s]/g, '')
                    .toLowerCase();

            const phoneKeys = [
                'mobile',
                'mobilenumber',
                'phone',
                'phonenumber',
                'identifier',
                'msisdn',
                'useridentifier'
            ];

            if (phoneKeys.includes(normalizedKey)) {

                const phone =
                    normalizePhone(value);

                if (phone) {
                    return phone;
                }
            }

            if (
                value &&
                typeof value === 'object'
            ) {

                const found =
                    deepSearch(
                        value,
                        depth + 1
                    );

                if (found) {
                    return found;
                }
            }
        }

        return '';
    }


    // 1. First try MSG91 verified response
    const phoneFromResponse =
        deepSearch(data);

    if (phoneFromResponse) {
        return phoneFromResponse;
    }


    // 2. MSG91 already verified this token.
    // Decode verified JWT payload and search identifier/mobile.
    try {

        const cleanToken =
            String(accessToken || '').trim();

        const parts =
            cleanToken.split('.');

        if (parts.length !== 3) {
            return '';
        }

        let payloadPart =
            parts[1]
                .replace(/-/g, '+')
                .replace(/_/g, '/');

        while (payloadPart.length % 4) {
            payloadPart += '=';
        }

        const payloadText =
            Buffer
                .from(
                    payloadPart,
                    'base64'
                )
                .toString('utf8');

        const payload =
            JSON.parse(payloadText);

        console.log(
            'MSG91 verified JWT payload:',
            payload
        );

        return deepSearch(payload);

    } catch (error) {

        console.error(
            'MSG91 JWT payload decode error:',
            error.message
        );

        return '';
    }
}

// ==========================================
// MSG91 COMPLETE REGISTRATION
// ==========================================

app.post(
    '/api/msg91/complete-registration',
    async (req, res) => {

        try {

            const accessToken =
                String(
                    req.body.accessToken || ''
                ).trim();

            const phone =
                String(
                    req.body.phone || ''
                )
                    .replace(/\D/g, '')
                    .slice(-10);

            const name =
                String(
                    req.body.name || ''
                ).trim();

            const email =
                String(
                    req.body.email || ''
                ).trim();

            const pincode =
                String(
                    req.body.pincode || ''
                )
                    .replace(/\D/g, '');

            const password =
                String(
                    req.body.password || ''
                );


            // ==========================================
            // BASIC VALIDATION
            // ==========================================

            if (!accessToken) {

                return res.status(400).json({
                    success: false,
                    message:
                        'OTP verification token is missing.'
                });
            }

            if (!/^\d{10}$/.test(phone)) {

                return res.status(400).json({
                    success: false,
                    message:
                        'Invalid mobile number.'
                });
            }

            if (!name) {

                return res.status(400).json({
                    success: false,
                    message:
                        'Name is required.'
                });
            }

            if (!/^\d{6}$/.test(pincode)) {

                return res.status(400).json({
                    success: false,
                    message:
                        'Invalid pincode.'
                });
            }

            if (
                !password ||
                password.length < 4
            ) {

                return res.status(400).json({
                    success: false,
                    message:
                        'Password must be at least 4 characters.'
                });
            }


            // ==========================================
            // VERIFY MSG91 TOKEN
            // ==========================================

            const verificationData =
                await verifyMsg91AccessToken(
                    accessToken
                );

            console.log(
                'MSG91 verified registration data:',
                verificationData
            );
            


            const verifiedPhone =
    extractVerifiedPhoneFromMsg91(
        verificationData,
        accessToken
    );


            // ==========================================
            // PHONE MATCH SECURITY CHECK
            // ==========================================

            if (!verifiedPhone) {

                return res.status(401).json({
                    success: false,
                    message:
                        'Unable to confirm verified mobile number from MSG91.'
                });
            }

            if (verifiedPhone !== phone) {

                return res.status(401).json({
                    success: false,
                    message:
                        'OTP verification does not match this mobile number.'
                });
            }


            // ==========================================
            // CHECK EXISTING USER
            // ==========================================

            const checkQuery = `
                SELECT id
                FROM public.users
                WHERE phone = ?
                LIMIT 1
            `;

            db.query(
                checkQuery,
                [phone],
                async (checkErr, rows) => {

                    if (checkErr) {

                        console.error(
                            'Registration check error:',
                            checkErr
                        );

                        return res
                            .status(500)
                            .json({
                                success: false,
                                message:
                                    'Unable to check user.'
                            });
                    }


                    if (
                        rows &&
                        rows.length > 0
                    ) {

                        return res
                            .status(400)
                            .json({
                                success: false,
                                message:
                                    'Mobile number already registered. Please login.'
                            });
                    }


                    // ==========================================
                    // HASH PASSWORD
                    // ==========================================

                    const hashedPassword =
                        await bcrypt.hash(
                            password,
                            12
                        );


                    const randomCustId =
                        Math.floor(
                            10000 +
                            Math.random() *
                            90000
                        );


                    // ==========================================
                    // CREATE USER
                    // ==========================================

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
                        VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)
                        RETURNING *
                    `;


                    db.query(
                        insertQuery,
                        [
                            randomCustId,
                            name,
                            email,
                            phone,
                            pincode,
                            'No address saved',
                            hashedPassword
                        ],
                        (
                            insertErr,
                            insertedRows
                        ) => {

                            if (insertErr) {

                                console.error(
                                    'MSG91 registration insert error:',
                                    insertErr
                                );

                                if (
                                    insertErr.code ===
                                    '23505'
                                ) {

                                    return res
                                        .status(400)
                                        .json({
                                            success: false,
                                            message:
                                                'Mobile number already registered.'
                                        });
                                }

                                return res
                                    .status(500)
                                    .json({
                                        success: false,
                                        message:
                                            'Account creation failed.'
                                    });
                            }


                            const createdUser =
                                insertedRows &&
                                insertedRows[0]
                                    ? insertedRows[0]
                                    : {
                                        id:
                                            randomCustId,
                                        name:
                                            name,
                                        email:
                                            email,
                                        phone:
                                            phone,
                                        pincode:
                                            pincode,
                                        address:
                                            'No address saved'
                                    };


                            return res.json({
                                success: true,
                                message:
                                    'Account created successfully!',
                                user:
                                    createdUser
                            });
                        }
                    );
                }
            );

        } catch (error) {

            console.error(
                'MSG91 complete registration error:',
                error.response?.data ||
                error.message
            );

            return res
                .status(401)
                .json({
                    success: false,
                    message:
                        'OTP verification failed. Please verify OTP again.'
                });
        }
    }
);


// ==========================================
// MSG91 RESET PASSWORD
// ==========================================

app.post(
    '/api/msg91/reset-password',
    async (req, res) => {

        try {

            const accessToken =
                String(
                    req.body.accessToken || ''
                ).trim();

            const phone =
                String(
                    req.body.phone || ''
                )
                    .replace(/\D/g, '')
                    .slice(-10);

            const password =
                String(
                    req.body.password || ''
                );


            // ==========================================
            // BASIC VALIDATION
            // ==========================================

            if (!accessToken) {

                return res.status(400).json({
                    success: false,
                    message:
                        'OTP verification token is missing.'
                });
            }

            if (!/^\d{10}$/.test(phone)) {

                return res.status(400).json({
                    success: false,
                    message:
                        'Invalid mobile number.'
                });
            }

            if (
                !password ||
                password.length < 4
            ) {

                return res.status(400).json({
                    success: false,
                    message:
                        'Password must be at least 4 characters.'
                });
            }


            // ==========================================
            // VERIFY MSG91 TOKEN
            // ==========================================

            const verificationData =
                await verifyMsg91AccessToken(
                    accessToken
                );

            console.log(
                'MSG91 verified reset data:',
                verificationData
            );
            


            const verifiedPhone =
    extractVerifiedPhoneFromMsg91(
        verificationData,
        accessToken
    );


            // ==========================================
            // PHONE MATCH SECURITY CHECK
            // ==========================================

            if (!verifiedPhone) {

                return res.status(401).json({
                    success: false,
                    message:
                        'Unable to confirm verified mobile number from MSG91.'
                });
            }

            if (verifiedPhone !== phone) {

                return res.status(401).json({
                    success: false,
                    message:
                        'OTP verification does not match this mobile number.'
                });
            }


            // ==========================================
            // HASH NEW PASSWORD
            // ==========================================

            const hashedPassword =
                await bcrypt.hash(
                    password,
                    12
                );


            // ==========================================
            // UPDATE PASSWORD
            // ==========================================

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
                [
                    hashedPassword,
                    phone
                ],
                (
                    updateErr,
                    updatedRows
                ) => {

                    if (updateErr) {

                        console.error(
                            'MSG91 password update error:',
                            updateErr
                        );

                        return res
                            .status(500)
                            .json({
                                success: false,
                                message:
                                    'Unable to update password.'
                            });
                    }


                    if (
                        !updatedRows ||
                        updatedRows.length === 0
                    ) {

                        return res
                            .status(404)
                            .json({
                                success: false,
                                message:
                                    'Mobile number is not registered.'
                            });
                    }


                    return res.json({
                        success: true,
                        message:
                            'Password updated successfully!',
                        user:
                            updatedRows[0]
                    });
                }
            );

        } catch (error) {

            console.error(
                'MSG91 reset password error:',
                error.response?.data ||
                error.message
            );

            return res
                .status(401)
                .json({
                    success: false,
                    message:
                        'OTP verification failed. Please verify OTP again.'
                });
        }
    }
);
// ==========================================
// SUPABASE STORAGE - IMAGE UPLOAD
// ==========================================

const upload = multer({
    storage: multer.memoryStorage(),

    limits: {
        fileSize: 25 * 1024 * 1024 // 25 MB
    },

    fileFilter: (req, file, cb) => {

        const allowedMimeTypes = [
            'image/jpeg',
            'image/png',
            'image/webp',
            'image/gif',
            'video/mp4',
            'video/webm'
        ];

        if (!allowedMimeTypes.includes(file.mimetype)) {

            return cb(
                new Error(
                    'Only JPG, PNG, WebP, GIF, MP4 and WebM files are allowed.'
                )
            );
        }

        cb(null, true);
    }
});

// ==========================================
// TECHNICIAN WORK PROOF MEDIA UPLOAD
// ==========================================
const technicianMediaUpload = multer({
    storage: multer.memoryStorage(),

    limits: {
        fileSize: 30 * 1024 * 1024 // 30 MB max per file
    },

    fileFilter: (req, file, cb) => {

        const allowedMimeTypes = [
            'image/jpeg',
            'image/png',
            'image/webp',
            'video/mp4',
            'video/webm'
        ];

        if (!allowedMimeTypes.includes(file.mimetype)) {

            return cb(
                new Error(
                    'Only JPG, PNG, WebP, MP4 and WebM files are allowed.'
                )
            );
        }

        cb(null, true);
    }
});

app.post('/api/upload-image', upload.single('image'), async (req, res) => {
    try {

        if (!req.file) {
            return res.status(400).json({
                success: false,
                message: 'No media file uploaded'
            });
        }

        const SUPABASE_URL = String(
    process.env.SUPABASE_URL ||
    process.env.PROJECT_URL ||
    ''
).replace(/\/rest\/v1\/?$/, '');

const SUPABASE_SECRET_KEY =
    process.env.SUPABASE_SECRET_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SERVICE_KEY ||
    '';

        

        if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
            return res.status(500).json({
                success: false,
                message: 'Supabase Storage configuration missing'
            });
        }

        const extension =
    path.extname(req.file.originalname).toLowerCase() || '.jpg';

const requestedFolder =
    String(req.body.folder || 'home-icons')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9-_]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');

const safeFolder =
    requestedFolder || 'home-icons';

const generateResponsive =
    String(req.body.generateResponsive || '').toLowerCase() === 'true';

const originalBaseName =
    path.basename(
        req.file.originalname,
        path.extname(req.file.originalname)
    )
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'image';

const uploadToSupabase = async (
    storagePath,
    buffer,
    contentType
) => {

    await axios.post(
        `${SUPABASE_URL}/storage/v1/object/catus-images/${storagePath}`,
        buffer,
        {
            headers: {
                Authorization: `Bearer ${SUPABASE_SECRET_KEY}`,
                apikey: SUPABASE_SECRET_KEY,
                'Content-Type': contentType
            },
            maxBodyLength: Infinity
        }
    );

    return `${SUPABASE_URL}/storage/v1/object/public/catus-images/${storagePath}`;
};


const uniqueName =
    `${Date.now()}-${originalBaseName}`;


// ==========================================
// NORMAL IMAGE UPLOAD
// ==========================================

if (!generateResponsive) {

    const fileName =
        `${safeFolder}/${uniqueName}${extension}`;

    const imageUrl =
        await uploadToSupabase(
            fileName,
            req.file.buffer,
            req.file.mimetype
        );

    return res.json({
        success: true,
        imageUrl
    });
}


// ==========================================
// PRODUCT RESPONSIVE IMAGE UPLOAD
// 240 / 480 / 800 WEBP
// ==========================================

const sizes = [240, 480, 800];

const responsiveUrls = {};

for (const size of sizes) {

    const optimizedBuffer =
        await sharp(req.file.buffer)
            .rotate()
            .resize(size, size, {
                fit: 'cover',
                position: 'centre'
            })
            .webp({
                quality: 88,
                effort: 5
            })
            .toBuffer();

    const responsiveFileName =
        `${safeFolder}/${uniqueName}-${size}.webp`;

    responsiveUrls[size] =
        await uploadToSupabase(
            responsiveFileName,
            optimizedBuffer,
            'image/webp'
        );
}


return res.json({
    success: true,

    // Existing admin code-ku compatible
    imageUrl: responsiveUrls[800],

    imageUrl240: responsiveUrls[240],
    imageUrl480: responsiveUrls[480],
    imageUrl800: responsiveUrls[800]
});

    } catch (error) {

        console.error(
            'Supabase Image Upload Error:',
            error.response?.data || error.message
        );

        return res.status(500).json({
            success: false,
            message: 'Media upload failed',
            error: error.response?.data || error.message
        });
    }
});

async function deleteSupabaseImage(imageUrl) {
    try {
        if (!imageUrl) return;

        const SUPABASE_URL = String(
            process.env.SUPABASE_URL ||
            process.env.PROJECT_URL ||
            ''
        ).replace(/\/rest\/v1\/?$/, '');

        const SUPABASE_SECRET_KEY =
            process.env.SUPABASE_SECRET_KEY ||
            process.env.SUPABASE_SERVICE_ROLE_KEY ||
            process.env.SUPABASE_SERVICE_KEY ||
            '';

        if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
            return;
        }

        const publicPrefix =
            `${SUPABASE_URL}/storage/v1/object/public/catus-images/`;

        if (!imageUrl.startsWith(publicPrefix)) {
            return;
        }

        const filePath =
            imageUrl.substring(publicPrefix.length);

        let filesToDelete = [filePath];

        // Responsive product image:
        // DB stores -800.webp
        // Delete 240 / 480 / 800 together
        if (/-800\.webp$/i.test(filePath)) {

            const basePath =
                filePath.replace(/-800\.webp$/i, '');

            filesToDelete = [
                `${basePath}-240.webp`,
                `${basePath}-480.webp`,
                `${basePath}-800.webp`
            ];
        }

        for (const pathToDelete of filesToDelete) {

            try {

                await axios.delete(
                    `${SUPABASE_URL}/storage/v1/object/catus-images/${pathToDelete}`,
                    {
                        headers: {
                            Authorization:
                                `Bearer ${SUPABASE_SECRET_KEY}`,
                            apikey:
                                SUPABASE_SECRET_KEY
                        }
                    }
                );

                console.log(
                    'Old Supabase image deleted:',
                    pathToDelete
                );

            } catch (deleteError) {

                console.error(
                    'Supabase image variant delete failed:',
                    pathToDelete,
                    deleteError.response?.data ||
                    deleteError.message
                );
            }
        }

    } catch (error) {

        console.error(
            'Old Supabase image delete failed:',
            error.response?.data ||
            error.message
        );
    }
}

// ==========================================
// TECHNICIAN SET / RESET PASSWORD WITH OTP
// ==========================================
app.post('/api/technicians/set-password', async (req, res) => {

    try {

        const accessToken =
            String(req.body.accessToken || '').trim();

        const phone =
            String(req.body.phone || '')
                .replace(/\D/g, '')
                .slice(-10);

        const password =
            String(req.body.password || '');

        if (!accessToken) {
            return res.status(400).json({
                success: false,
                message: 'OTP verification token is missing.'
            });
        }

        if (!/^[6-9]\d{9}$/.test(phone)) {
            return res.status(400).json({
                success: false,
                message: 'Enter a valid mobile number.'
            });
        }

        if (password.length < 6) {
            return res.status(400).json({
                success: false,
                message: 'Password must be at least 6 characters.'
            });
        }

        // ==========================================
        // VERIFY MSG91 OTP ACCESS TOKEN
        // ==========================================

        const verificationData =
            await verifyMsg91AccessToken(accessToken);

        const verifiedPhone =
            extractVerifiedPhoneFromMsg91(
                verificationData,
                accessToken
            );

        if (!verifiedPhone) {
            return res.status(401).json({
                success: false,
                message: 'Unable to verify mobile number.'
            });
        }

        if (verifiedPhone !== phone) {
            return res.status(401).json({
                success: false,
                message:
                    'OTP verification does not match this mobile number.'
            });
        }

        // ==========================================
        // CHECK TECHNICIAN
        // ==========================================

        const checkQuery = `
            SELECT
                technician_id,
                name,
                phone,
                status
            FROM public.technicians
            WHERE phone = ?
            LIMIT 1
        `;

        db.query(
            checkQuery,
            [phone],
            async (checkErr, rows) => {

                if (checkErr) {

                    console.error(
                        'Technician Password Check Error:',
                        checkErr
                    );

                    return res.status(500).json({
                        success: false,
                        message:
                            'Unable to verify technician account.'
                    });
                }

                if (!rows || rows.length === 0) {
                    return res.status(404).json({
                        success: false,
                        message:
                            'Technician account not found.'
                    });
                }

                const technician = rows[0];

                if (technician.status !== 'Active') {

                    return res.status(403).json({
                        success: false,
                        message:
                            technician.status === 'Pending'
                                ? 'Your technician account is waiting for Cerood approval.'
                                : 'Your technician account is not active.'
                    });
                }

                try {

                    const hashedPassword =
                        await bcrypt.hash(
                            password,
                            12
                        );

                    const updateQuery = `
                        UPDATE public.technicians
                        SET
                            password = ?,
                            updated_at = CURRENT_TIMESTAMP
                        WHERE technician_id = ?
                        RETURNING
                            technician_id,
                            name,
                            phone,
                            status
                    `;

                    db.query(
                        updateQuery,
                        [
                            hashedPassword,
                            technician.technician_id
                        ],
                        (updateErr, updatedRows) => {

                            if (updateErr) {

                                console.error(
                                    'Technician Password Update Error:',
                                    updateErr
                                );

                                return res.status(500).json({
                                    success: false,
                                    message:
                                        'Unable to save technician password.'
                                });
                            }

                            return res.json({
                                success: true,
                                message:
                                    'Technician password created successfully.',
                                technician:
                                    updatedRows && updatedRows[0]
                                        ? updatedRows[0]
                                        : {
                                            technician_id:
                                                technician.technician_id,
                                            name:
                                                technician.name,
                                            phone,
                                            status:
                                                technician.status
                                        }
                            });
                        }
                    );

                } catch (hashError) {

                    console.error(
                        'Technician Password Hash Error:',
                        hashError
                    );

                    return res.status(500).json({
                        success: false,
                        message:
                            'Unable to create technician password.'
                    });
                }
            }
        );

    } catch (error) {

        console.error(
            'Technician Set Password Error:',
            error.response?.data ||
            error.message
        );

        return res.status(401).json({
            success: false,
            message:
                'OTP verification failed. Please verify OTP again.'
        });
    }
});

// ==========================================
// TECHNICIAN JWT AUTH MIDDLEWARE
// ==========================================
function authenticateTechnician(req, res, next) {

    const authHeader =
        String(req.headers.authorization || '').trim();

    if (
        !authHeader ||
        !authHeader.startsWith('Bearer ')
    ) {
        return res.status(401).json({
            success: false,
            message: 'Technician login required.'
        });
    }

    const token =
        authHeader.substring(7).trim();

    if (!token) {
        return res.status(401).json({
            success: false,
            message: 'Technician authentication token is missing.'
        });
    }

    const technicianJwtSecret =
        String(
            process.env.TECHNICIAN_JWT_SECRET || ''
        ).trim();

    if (!technicianJwtSecret) {
        console.error(
            'TECHNICIAN_JWT_SECRET is not configured.'
        );

        return res.status(500).json({
            success: false,
            message: 'Technician authentication is not configured.'
        });
    }

    try {

        const decoded =
            jwt.verify(
                token,
                technicianJwtSecret
            );

        if (
            !decoded ||
            decoded.role !== 'technician' ||
            !decoded.technician_id
        ) {
            return res.status(401).json({
                success: false,
                message: 'Invalid technician authentication token.'
            });
        }

        req.technician = {
            technician_id:
                String(decoded.technician_id),
            phone:
                String(decoded.phone || ''),
            role:
                decoded.role
        };

        next();

    } catch (error) {

        return res.status(401).json({
            success: false,
            message:
                error.name === 'TokenExpiredError'
                    ? 'Technician session expired. Please login again.'
                    : 'Invalid technician authentication token.'
        });
    }
}

// ==========================================
// TECHNICIAN PARTNER LOGIN
// ==========================================
app.post('/api/technicians/login', (req, res) => {

    const phone = String(req.body.phone || '')
        .replace(/\D/g, '')
        .slice(-10);

    const password = String(req.body.password || '');

    if (!/^[6-9]\d{9}$/.test(phone) || !password) {
        return res.status(400).json({
            success: false,
            message: 'Enter a valid mobile number and password.'
        });
    }

    const query = `
        SELECT
            technician_id,
            name,
            phone,
            password,
            status,
            specialization,
            district,
            city,
            profile_photo_url
        FROM public.technicians
        WHERE phone = ?
        LIMIT 1
    `;

    db.query(query, [phone], async (err, rows) => {

        if (err) {
            console.error('Technician Login Error:', err);

            return res.status(500).json({
                success: false,
                message: 'Unable to login right now.'
            });
        }

        if (!rows || rows.length === 0) {
            return res.status(401).json({
                success: false,
                message: 'Invalid mobile number or password.'
            });
        }

        const technician = rows[0];

        if (technician.status !== 'Active') {
            return res.status(403).json({
                success: false,
                message:
                    technician.status === 'Pending'
                        ? 'Your technician account is waiting for Cerood approval.'
                        : 'Your technician account is not active.'
            });
        }

        if (!technician.password) {
            return res.status(403).json({
                success: false,
                code: 'PASSWORD_NOT_SET',
                message: 'Create your technician password before login.'
            });
        }

        try {

            const passwordMatch =
                await bcrypt.compare(
                    password,
                    technician.password
                );

            if (!passwordMatch) {
                return res.status(401).json({
                    success: false,
                    message: 'Invalid mobile number or password.'
                });
            }

            db.query(
                `
                    UPDATE public.technicians
                    SET last_login_at = CURRENT_TIMESTAMP
                    WHERE technician_id = ?
                `,
                [technician.technician_id],
                (updateErr) => {
                    if (updateErr) {
                        console.error(
                            'Technician Last Login Update Error:',
                            updateErr
                        );
                    }
                }
            );

            delete technician.password;

const technicianJwtSecret =
    String(
        process.env.TECHNICIAN_JWT_SECRET || ''
    ).trim();

if (!technicianJwtSecret) {
    console.error(
        'TECHNICIAN_JWT_SECRET is not configured.'
    );

    return res.status(500).json({
        success: false,
        message: 'Technician authentication is not configured.'
    });
}

const token = jwt.sign(
    {
        technician_id: technician.technician_id,
        phone: technician.phone,
        role: 'technician'
    },
    technicianJwtSecret,
    {
        expiresIn: '7d'
    }
);

return res.json({
    success: true,
    message: 'Login successful.',
    token,
    technician
});

        } catch (error) {

            console.error(
                'Technician Password Compare Error:',
                error
            );

            return res.status(500).json({
                success: false,
                message: 'Unable to login right now.'
            });
        }
    });
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

// RENEWED-ONLY: create a separate Renewed session after a real Cerood login.
// Never mint this token from a browser-supplied user object or phone alone.
function createRenewedSessionForAuthenticatedUser(user) {
    const secret = String(process.env.RENEWED_CUSTOMER_JWT_SECRET || '');
    const phone = String(user?.phone || '').trim();
    if (secret.length < 32 || !/^[6-9]\d{9}$/.test(phone) || user?.id == null) return null;
    return jwt.sign(
        { sub: String(user.id), phone, role: 'renewed_customer' },
        secret,
        { algorithm: 'HS256', expiresIn: '7d', issuer: 'cerood-renewed' }
    );
}

app.post('/api/login-password', (req, res) => {
    const { phone, password } = req.body;
    const query = 'SELECT * FROM users WHERE phone = ?';
    db.query(query, [phone], async (err, results) => {
        if (err) return res.status(500).json({ success: false, error: err.message });
        
        if (results && results.length > 0) {
            const user = results[0];
            // Passwords-ah trim panrathu space error-ai thavirkkum
            if (await bcrypt.compare(String(password), String(user.password))) {
                res.json({ success: true, user: user, renewed_session: createRenewedSessionForAuthenticatedUser(user) });
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
                    user: updatedRows[0],
                    renewed_session: createRenewedSessionForAuthenticatedUser(updatedRows[0])
                });
            }
        );
    });
});

// ==========================================
// CUSTOMER - SAVE / UPDATE SERVICE ADDRESS
// ==========================================
app.post('/api/users/update-address', (req, res) => {

    const phone = String(req.body.phone || '')
        .replace(/\D/g, '')
        .slice(-10);

    const address = String(req.body.address || '').trim();

    const pincode = String(req.body.pincode || '')
        .replace(/\D/g, '')
        .slice(-6);

    if (!/^[6-9]\d{9}$/.test(phone)) {
        return res.status(400).json({
            success: false,
            message: 'Valid mobile number is required.'
        });
    }

    if (!address) {
        return res.status(400).json({
            success: false,
            message: 'Service address is required.'
        });
    }

    if (!/^[1-9]\d{5}$/.test(pincode)) {
        return res.status(400).json({
            success: false,
            message: 'Valid pincode is required.'
        });
    }

    const query = `
        UPDATE public.users
        SET
            address = ?,
            pincode = ?
        WHERE phone = ?
        RETURNING
            id,
            name,
            email,
            phone,
            pincode,
            address
    `;

    db.query(
        query,
        [address, pincode, phone],
        (err, rows) => {

            if (err) {
                console.error(
                    'Customer Address Update Error:',
                    err
                );

                return res.status(500).json({
                    success: false,
                    message: 'Unable to save service address.'
                });
            }

            if (!rows || rows.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'Customer account not found.'
                });
            }

            return res.json({
                success: true,
                message: 'Service address saved successfully.',
                user: rows[0]
            });
        }
    );
});


// ==========================================
// CUSTOMER - REMOVE SAVED SERVICE ADDRESS
// ==========================================
app.post('/api/users/remove-address', (req, res) => {

    const phone = String(req.body.phone || '')
        .replace(/\D/g, '')
        .slice(-10);

    if (!/^[6-9]\d{9}$/.test(phone)) {
        return res.status(400).json({
            success: false,
            message: 'Valid mobile number is required.'
        });
    }

    const query = `
        UPDATE public.users
        SET address = 'No address saved'
        WHERE phone = ?
        RETURNING
            id,
            name,
            email,
            phone,
            pincode,
            address
    `;

    db.query(
        query,
        [phone],
        (err, rows) => {

            if (err) {
                console.error(
                    'Customer Address Remove Error:',
                    err
                );

                return res.status(500).json({
                    success: false,
                    message: 'Unable to remove service address.'
                });
            }

            if (!rows || rows.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'Customer account not found.'
                });
            }

            return res.json({
                success: true,
                message: 'Service address removed successfully.',
                user: rows[0]
            });
        }
    );
});

// ==========================================
// 3. GET USER ORDERS API ROUTE
// ==========================================
app.get('/api/orders/:phone', (req, res) => {

    const phone = req.params.phone;

    const query = `
        SELECT *
        FROM orders
        WHERE phone = ?
        ORDER BY id DESC
    `;

    db.query(
        query,
        [phone],
        (err, results) => {

            if (err) {
                return res.status(500).json({
                    success: false,
                    error: err.message
                });
            }


            // ==========================================
            // CUSTOMER SECURITY
            // NEVER EXPOSE TECHNICIAN PERSONAL MOBILE
            // ==========================================

            const safeOrders =
                (results || []).map(order => {

                    const safeOrder = {
                        ...order
                    };

                    delete safeOrder.technician_phone;

                    return safeOrder;
                });


            return res.json({
                success: true,
                orders: safeOrders
            });
        }
    );
});

// ==========================================
// BULK CREATE SEPARATE SERVICE ORDERS
// ONE CHECKOUT -> MULTIPLE INDEPENDENT ORDERS
// ==========================================
app.post('/api/orders/bulk', (req, res) => {

    const {
        customer_id,
        customer_name,
        phone,
        whatsapp,
        address,
        district,
        pincode,
        service_date,
        service_time,
        service_address,
        service_district,
        service_pincode,
        order_date,
        status,
        payment_verification,
        items
    } = req.body;

    // ------------------------------------------
    // 1. VALIDATE ITEMS
    // ------------------------------------------
    if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({
            success: false,
            message: 'Valid service items are required.'
        });
    }

    const cleanItems = items
        .map(item => ({
            product_id: String(item.product_id || '').trim(),
            quantity: Math.max(
                1,
                parseInt(item.quantity, 10) || 1
            )
        }))
        .filter(item => item.product_id);

    if (cleanItems.length === 0) {
        return res.status(400).json({
            success: false,
            message: 'Invalid service items.'
        });
    }

    // ------------------------------------------
    // 2. FETCH REAL SERVICE PRICES
    // ------------------------------------------
    const productIds = [
        ...new Set(
            cleanItems.map(item => item.product_id)
        )
    ];

    const placeholders =
        productIds.map(() => '?').join(',');

    const priceQuery = `
        SELECT service_id, service_name, price
        FROM public.services
        WHERE service_id IN (${placeholders})
    `;

    db.query(
        priceQuery,
        productIds,
        async (priceErr, services) => {

            if (priceErr) {
                console.error(
                    'Bulk Order Price Error:',
                    priceErr
                );

                return res.status(500).json({
                    success: false,
                    message:
                        'Unable to calculate order amount.'
                });
            }

            if (
                !services ||
                services.length !== productIds.length
            ) {
                return res.status(400).json({
                    success: false,
                    message:
                        'One or more services are invalid.'
                });
            }

            const serviceMap = {};

            services.forEach(service => {
                serviceMap[
                    String(service.service_id)
                ] = service;
            });

            // ------------------------------------------
            // 3. CALCULATE CHECKOUT TOTAL ONCE
            // ------------------------------------------
            let subtotal = 0;

            const preparedItems =
                cleanItems.map(item => {

                    const service =
                        serviceMap[item.product_id];

                    const serviceSubtotal =
                        (Number(service.price) || 0) *
                        item.quantity;

                    subtotal += serviceSubtotal;

                    return {
                        product_id: item.product_id,
                        quantity: item.quantity,
                        service_name:
                            service.service_name,
                        service_subtotal:
                            serviceSubtotal
                    };
                });

            let checkoutSettings;

try {
    checkoutSettings = await getCheckoutSettings();
} catch (settingsErr) {

    console.error(
        'Bulk Order Checkout Settings Error:',
        settingsErr
    );

    return res.status(500).json({
        success: false,
        message: 'Unable to load checkout settings.'
    });
}

const convenienceFee =
    checkoutSettings.convenienceFee;

const gstPercent =
    checkoutSettings.gstPercent;

const taxes =
    Math.round(
        (subtotal + convenienceFee) *
        (gstPercent / 100)
    );

const finalAmount =
    subtotal +
    convenienceFee +
    taxes;

            // ------------------------------------------
            // 4. VERIFY RAZORPAY ONCE
            // ------------------------------------------
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

    const expectedSignature =
        crypto
            .createHmac(
                'sha256',
                process.env.RAZORPAY_KEY_SECRET
            )
            .update(verificationBody)
            .digest('hex');

    if (
        expectedSignature !==
        payment_verification.razorpay_signature
    ) {
        return res.status(400).json({
            success: false,
            message:
                'Invalid Razorpay payment verification.'
        });
    }

    try {

        const razorpayPayment =
            await razorpayInstance.payments.fetch(
                payment_verification.razorpay_payment_id
            );

        if (!razorpayPayment) {
            return res.status(400).json({
                success: false,
                message:
                    'Unable to confirm Razorpay payment.'
            });
        }

        if (
            razorpayPayment.order_id !==
            payment_verification.razorpay_order_id
        ) {
            return res.status(400).json({
                success: false,
                message:
                    'Razorpay payment does not match this payment order.'
            });
        }

        const paidAmount =
            Number(razorpayPayment.amount) || 0;

        const expectedAmount =
            Math.round(finalAmount * 100);

        if (paidAmount !== expectedAmount) {
            return res.status(400).json({
                success: false,
                message:
                    'Paid amount does not match the booking amount.'
            });
        }

        if (
            razorpayPayment.status !== 'captured' &&
            razorpayPayment.status !== 'authorized'
        ) {
            return res.status(400).json({
                success: false,
                message:
                    'Razorpay payment is not confirmed.'
            });
        }

        safeStatus = 'Paid';

    } catch (paymentError) {

        console.error(
            'Razorpay payment fetch error:',
            paymentError
        );

        return res.status(500).json({
            success: false,
            message:
                'Unable to verify payment with Razorpay.'
        });
    }
}



            // ------------------------------------------
            // 5. SPLIT SHARED FEES ACROSS ORDERS
            // ------------------------------------------
            let allocatedSoFar = 0;

            const orderRows =
                preparedItems.map(
                    (item, index) => {

                        let orderAmount;

                        if (
                            index ===
                            preparedItems.length - 1
                        ) {
                            orderAmount =
                                finalAmount -
                                allocatedSoFar;
                        } else {

                            const ratio =
                                subtotal > 0
                                    ? item.service_subtotal /
                                      subtotal
                                    : 1 /
                                      preparedItems.length;

                            orderAmount =
                                Math.round(
                                    finalAmount *
                                    ratio
                                );

                            allocatedSoFar +=
                                orderAmount;
                        }

                        const orderId =
                            Math.floor(
                                100000000 +
                                Math.random() *
                                900000000
                            );

                        return {
                            order_id: orderId,
                            product_id:
                                item.product_id,
                            service_name:
                                item.service_name,
                            quantity:
                                item.quantity,
                            amount:
                                orderAmount
                        };
                    }
                );

            // ------------------------------------------
            // 6. INSERT EACH SERVICE AS SEPARATE ORDER
            // ------------------------------------------
            const insertQuery = `
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

service_date,
service_time,
service_address,
service_district,
service_pincode,

amount,
order_date,
status,
payment_status,
payment_method,
booked_at
    )
    VALUES (
    ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
    ?, ?, ?, ?, ?,
    ?, ?, ?, ?, ?,
    CURRENT_TIMESTAMP
)
`;

                        let insertedOrders = [];

            let client;

            try {

                client = await db.getClient();

                await client.query('BEGIN');

                // ==========================================
                // RECORD ONLINE PAYMENT INSIDE TRANSACTION
                // ==========================================
                if (safeStatus === 'Paid') {

                    const paymentTransactionQuery = `
                        INSERT INTO public.payment_transactions
                        (
                            razorpay_payment_id,
                            razorpay_order_id,
                            customer_id,
                            customer_phone,
                            amount_paise,
                            payment_status
                        )
                        VALUES (?, ?, ?, ?, ?, ?)
                        RETURNING id
                    `;

                    await client.query(
                        paymentTransactionQuery,
                        [
                            payment_verification.razorpay_payment_id,
                            payment_verification.razorpay_order_id,
                            String(customer_id || ''),
                            String(phone || ''),
                            Math.round(finalAmount * 100),
                            'Paid'
                        ]
                    );
                }

                // ==========================================
                // INSERT ALL SERVICE ORDERS
                // ==========================================
                for (const order of orderRows) {

                    const values = [
                        order.order_id,
                        customer_id,
                        order.product_id,
                        order.service_name,
                        customer_name,
                        phone,
                        whatsapp || '',
                        address,
                        district,
                        pincode,

                        service_date || null,
                        service_time || null,
                        service_address || address,
                        service_district || district,
                        service_pincode || pincode,

                        order.amount,
                        order_date,
                        'Pending',
                        safeStatus === 'Paid'
                            ? 'Paid'
                            : 'Pending',
                        safeStatus === 'Paid'
                            ? 'Online'
                            : 'Pay Later'
                    ];

                    await client.query(
                        insertQuery,
                        values
                    );

                    insertedOrders.push(order);
                }

                await client.query('COMMIT');

                return res.json({
                    success: true,
                    message:
                        'Separate service orders created successfully!',
                    total_amount:
                        finalAmount,
                    orders:
                        insertedOrders
                });

            } catch (transactionError) {

                if (client) {

                    try {
                        await client.query('ROLLBACK');
                    } catch (rollbackError) {
                        console.error(
                            'Bulk Order Rollback Error:',
                            rollbackError
                        );
                    }
                }

                console.error(
                    'Bulk Order Transaction Error:',
                    transactionError
                );

                if (
                    transactionError.code === '23505'
                ) {
                    return res.status(409).json({
                        success: false,
                        code:
                            'PAYMENT_ALREADY_USED',
                        message:
                            'This Razorpay payment has already been used for a booking.'
                    });
                }

                return res.status(500).json({
                    success: false,
                    message:
                        'Unable to create all service orders securely.'
                });

            } finally {

                if (client) {
                    client.release();
                }
            }
        }
    );
});

// ==========================================
// 4. CREATE ORDER API ROUTE (Checkout)
// ==========================================
app.post('/api/orders', async (req, res) => {

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

    db.query(priceQuery, productIds, async (priceErr, services) => {

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

        let checkoutSettings;

try {
    checkoutSettings = await getCheckoutSettings();
} catch (settingsErr) {

    console.error(
        'Order Checkout Settings Error:',
        settingsErr
    );

    return res.status(500).json({
        success: false,
        message: 'Unable to load checkout settings.'
    });
}

const convenienceFee =
    checkoutSettings.convenienceFee;

const gstPercent =
    checkoutSettings.gstPercent;

const taxes =
    Math.round(
        (subtotal + convenienceFee) *
        (gstPercent / 100)
    );

const finalAmount =
    subtotal +
    convenienceFee +
    taxes;

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
        payment_status,
        payment_method,
        booked_at
    )
    VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        CURRENT_TIMESTAMP
    )
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

service_date || null,
service_time || null,
service_address || address,
service_district || district,
service_pincode || pincode,

order.amount,
order_date,
'Pending',
safeStatus === 'Paid' ? 'Paid' : 'Pending',
safeStatus === 'Paid' ? 'Online' : 'Pay Later'
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


// CEROOD SELLER MARKETPLACE — PHASE 2

const { requireSellerAuth } = require('./cerood-seller-routes')(
    app,
    db,
    requireAdminAuth,
    verifyMsg91AccessToken,
    extractVerifiedPhoneFromMsg91
);


// CEROOD SELLER PRODUCT MANAGEMENT

require('./cerood-seller-products')(
    app,
    db,
    requireSellerAuth,
    requireAdminAuth
);

// ==========================================
// CEROOD COSMETICS + FASHION SELLER CATALOG
// ==========================================

require('./cerood-marketplace-catalog')(
    app,
    db,
    requireSellerAuth,
    requireAdminAuth
);

// ==========================================
// CEROOD SELLER ORDERS
// ==========================================

require('./cerood-seller-orders')(
    app,
    db,
    requireSellerAuth
);


// ==========================================
// CEROOD SELLER MEDIA UPLOAD
// ==========================================

require('./cerood-seller-media')(
    app,
    requireSellerAuth
);



// Cerood Notify Stage 1 — existing admin auth, no changes to order/payment handlers.
require('./notify-routes')(app, db, requireAdminAuth);

// CEROOD PARTNERSHIP LEADS — public intake; admin access protected by existing middleware.
const partnerTypes = ['apartment', 'hotel', 'pg-hostel', 'other'];
const partnerStatuses = ['New', 'Contacted', 'Follow-up', 'Partnered', 'Closed'];
app.post('/api/partnership-leads', async (req, res) => {
    try {
        const body = req.body || {};
        const clean = (key, max = 500) => String(body[key] ?? '').trim().slice(0, max);
        const partner_type = clean('partner_type', 30);
        const business_name = clean('business_name', 160);
        const contact_name = clean('contact_name', 120);
        const phone = clean('phone', 24).replace(/\D/g, '').replace(/^91(?=[6-9]\d{9}$)/, '');
        const location = clean('location', 250);
        const email = clean('email', 160);
        const property_size = clean('property_size', 100);
        const services = clean('services', 1200);
        const message = clean('message', 2500);
        const website = clean('website', 200); // honeypot
        if (website) return res.status(400).json({success:false,message:'Invalid submission.'});
        if (!partnerTypes.includes(partner_type) || !business_name || !contact_name || !location || !/^[6-9]\d{9}$/.test(phone)) {
            return res.status(400).json({success:false,message:'Enter business type, business name, contact person, valid 10-digit mobile and location.'});
        }
        if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({success:false,message:'Invalid email.'});
        const rows = await new Promise((resolve, reject) => db.query(
            `INSERT INTO public.partnership_leads (partner_type,business_name,contact_name,phone,location,email,property_size,services,message)
             VALUES (?,?,?,?,?,?,?,?,?) RETURNING id, created_at`,
            [partner_type,business_name,contact_name,phone,location,email,property_size,services,message],
            (err, result) => err ? reject(err) : resolve(result)
        ));
        return res.status(201).json({success:true,message:'Enquiry submitted successfully. Our team will contact you.',id:rows[0].id});
    } catch (error) {
        console.error('Partnership lead submit:', error.message);
        return res.status(500).json({success:false,message:'Unable to submit enquiry. Please try again.'});
    }
});

// Protect every /api/admin/* route below this line
app.use('/api/admin', requireAdminAuth);

// ==========================================

// CEROOD PARTNERSHIP LEADS — these routes inherit requireAdminAuth.
app.get('/api/admin/partnership-leads', (req, res) => {
    db.query(`SELECT id,partner_type,business_name,contact_name,phone,location,email,property_size,services,message,status,admin_notes,created_at,updated_at
              FROM public.partnership_leads ORDER BY created_at DESC LIMIT 500`, [], (err, rows) => {
        if (err) { console.error('Partner leads list:',err.message); return res.status(500).json({success:false,message:'Unable to load partnership leads.'}); }
        res.json({success:true,leads:rows});
    });
});
app.patch('/api/admin/partnership-leads/:id', (req, res) => {
    const id = Number(req.params.id);
    const status = String(req.body?.status || '').trim();
    const admin_notes = String(req.body?.admin_notes || '').trim().slice(0, 4000);
    if (!Number.isSafeInteger(id) || id < 1 || !partnerStatuses.includes(status)) return res.status(400).json({success:false,message:'Invalid lead or status.'});
    db.query(`UPDATE public.partnership_leads SET status=?,admin_notes=?,updated_at=NOW() WHERE id=? RETURNING id,status,admin_notes`,
        [status,admin_notes,id],(err,rows)=>{
            if(err){console.error('Partner lead update:',err.message);return res.status(500).json({success:false,message:'Unable to update lead.'});}
            if(!rows.length)return res.status(404).json({success:false,message:'Lead not found.'});
            res.json({success:true,lead:rows[0]});
        });
});

// ADMIN - CHECKOUT SETTINGS
// ==========================================

// GET CHECKOUT SETTINGS
app.get('/api/admin/checkout-settings', (req, res) => {

    const query = `
        SELECT
            convenience_fee,
            convenience_fee_enabled,
            gst_percent,
            gst_enabled
        FROM public.checkout_settings
        WHERE id = 1
        LIMIT 1
    `;

    db.query(query, (err, rows) => {

        if (err) {
            console.error('Admin Checkout Settings GET Error:', err);

            return res.status(500).json({
                success: false,
                message: 'Unable to load checkout settings.'
            });
        }

        const settings = rows && rows[0] ? rows[0] : {};

        return res.json({
            success: true,
            settings: {
                convenience_fee:
                    Number(settings.convenience_fee) || 0,

                convenience_fee_enabled:
                    settings.convenience_fee_enabled === true,

                gst_percent:
                    Number(settings.gst_percent) || 0,

                gst_enabled:
                    settings.gst_enabled === true
            }
        });
    });
});


// UPDATE CHECKOUT SETTINGS
app.put('/api/admin/checkout-settings', (req, res) => {

    const convenienceFee =
        Math.max(
            0,
            Number(req.body.convenience_fee) || 0
        );

    const gstPercent =
    Math.min(
        100,
        Math.max(
            0,
            Number(req.body.gst_percent) || 0
        )
    );

    const convenienceFeeEnabled =
        req.body.convenience_fee_enabled === true;

    const gstEnabled =
        req.body.gst_enabled === true;


    const query = `
        UPDATE public.checkout_settings
        SET
            convenience_fee = ?,
            convenience_fee_enabled = ?,
            gst_percent = ?,
            gst_enabled = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = 1
        RETURNING *
    `;

    db.query(
        query,
        [
            convenienceFee,
            convenienceFeeEnabled,
            gstPercent,
            gstEnabled
        ],
        (err, rows) => {

            if (err) {
                console.error(
                    'Admin Checkout Settings UPDATE Error:',
                    err
                );

                return res.status(500).json({
                    success: false,
                    message:
                        'Unable to save checkout settings.'
                });
            }

            return res.json({
                success: true,
                message:
                    'Checkout settings saved successfully!',
                settings:
                    rows && rows[0] ? rows[0] : null
            });
        }
    );
});

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
                assigned_at = COALESCE(
    assigned_at,
    CURRENT_TIMESTAMP
)
            WHERE order_id = ?
            RETURNING *
        `;

    } else if (cleanStatus === 'on the way') {

        query = `
            UPDATE orders
            SET status = ?,
                on_the_way_at = COALESCE(
    on_the_way_at,
    CURRENT_TIMESTAMP
)
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
                service_started_at = COALESCE(
    service_started_at,
    CURRENT_TIMESTAMP
)
            WHERE order_id = ?
            RETURNING *
        `;

    } else if (cleanStatus === 'completed') {

        query = `
            UPDATE orders
            SET status = ?,
                completed_at = COALESCE(
    completed_at,
    CURRENT_TIMESTAMP
)
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
// CHECKOUT FEE SETTINGS
// ==========================================
async function getCheckoutSettings() {

    return new Promise((resolve, reject) => {

        const query = `
            SELECT
                convenience_fee,
                convenience_fee_enabled,
                gst_percent,
                gst_enabled
            FROM public.checkout_settings
            WHERE id = 1
            LIMIT 1
        `;

        db.query(query, (err, rows) => {

            if (err) {
                console.error(
                    'Checkout Settings Error:',
                    err
                );

                return reject(err);
            }

            const settings =
                rows && rows[0]
                    ? rows[0]
                    : {};

            const convenienceFee =
                settings.convenience_fee_enabled === true
                    ? Number(settings.convenience_fee) || 0
                    : 0;

            const gstPercent =
                settings.gst_enabled === true
                    ? Number(settings.gst_percent) || 0
                    : 0;

            resolve({
                convenienceFee,
                gstPercent,
                convenienceFeeEnabled:
                    settings.convenience_fee_enabled === true,
                gstEnabled:
                    settings.gst_enabled === true
            });
        });
    });
}

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

        let checkoutSettings;

try {
    checkoutSettings = await getCheckoutSettings();
} catch (settingsErr) {

    console.error(
        'Razorpay Checkout Settings Error:',
        settingsErr
    );

    return res.status(500).json({
        success: false,
        message: 'Unable to load checkout settings.'
    });
}

const convenienceFee =
    checkoutSettings.convenienceFee;

const gstPercent =
    checkoutSettings.gstPercent;

const taxes =
    Math.round(
        (subtotal + convenienceFee) *
        (gstPercent / 100)
    );

const finalAmount =
    subtotal +
    convenienceFee +
    taxes;

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
    amount: order.amount,
    key_id: process.env.RAZORPAY_KEY_ID
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

app.post('/api/calculate-order-total', async (req, res) => {

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

    db.query(query, productIds, async (err, services) => {

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

        let checkoutSettings;

try {
    checkoutSettings = await getCheckoutSettings();
} catch (settingsErr) {

    console.error(
        'Calculate Total Checkout Settings Error:',
        settingsErr
    );

    return res.status(500).json({
        success: false,
        message: 'Unable to load checkout settings.'
    });
}

const convenienceFee =
    checkoutSettings.convenienceFee;

const gstPercent =
    checkoutSettings.gstPercent;

const taxes =
    Math.round(
        (subtotal + convenienceFee) *
        (gstPercent / 100)
    );

const paymentMode = req.body.paymentMode;

const servicePayFee =
    paymentMode === 'later' ? 50 : 0;

const finalAmount =
    subtotal +
    convenienceFee +
    taxes +
    servicePayFee;

        
        return res.json({
    success: true,
    subtotal,
    convenienceFee,
    convenienceFeeEnabled:
        checkoutSettings.convenienceFeeEnabled,
    gstPercent,
    gstEnabled:
        checkoutSettings.gstEnabled,
    taxes,
    servicePayFee,
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

    const oldIconQuery = `
    SELECT icon_url
    FROM public.service_groups
    WHERE group_id = ?
    LIMIT 1
`;

db.query(oldIconQuery, [cleanOldGroupId], (findErr, oldRows) => {

    if (findErr) {
        console.error('Old Home Icon Fetch Error:', findErr.message);

        return res.status(500).json({
            success: false,
            error: findErr.message
        });
    }

    const oldIconUrl =
        oldRows && oldRows[0]
            ? oldRows[0].icon_url
            : '';

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
        async (err, results) => {

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

            if (oldIconUrl && oldIconUrl !== cleanIconUrl) {
    await deleteSupabaseImage(oldIconUrl);
}

            return res.json({
                success: true,
                message: 'Home icon updated successfully!',
                group: results[0]
            });
        }
    );
});
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
        SELECT *
        FROM services
        ORDER BY category ASC, id DESC
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

       const oldImageQuery = `
        SELECT image_url, image_url_2, image_url_3, image_url_4
        FROM public.services
        WHERE service_id = ?
        LIMIT 1
    `;

    db.query(oldImageQuery, [old_service_id], (findErr, oldRows) => {

        if (findErr) {
            console.error('Old Service Images Fetch Error:', findErr.message);

            return res.status(500).json({
                success: false,
                error: findErr.message
            });
        }

        const oldService = oldRows && oldRows[0]
            ? oldRows[0]
            : {};

        

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
        ], async (err, result) => {

            if (err) {
                console.error('Update Service Error:', err.message);

                return res.status(500).json({
                    success: false,
                    error: err.message
                });
            }

            const imageChanges = [
                [oldService.image_url, image_url],
                [oldService.image_url_2, image_url_2],
                [oldService.image_url_3, image_url_3],
                [oldService.image_url_4, image_url_4]
            ];

            for (const [oldUrl, newUrl] of imageChanges) {
                if (oldUrl && oldUrl !== newUrl) {
                    await deleteSupabaseImage(oldUrl);
                }
            }

            res.json({
                success: true,
                message: 'Service updated successfully!'
            });
        });
    });
});

// ==========================================
// TECHNICIAN - MY ASSIGNED ORDERS
// JWT PROTECTED
// ==========================================
app.get(
    '/api/technicians/orders',
    authenticateTechnician,
    (req, res) => {

        const technicianId =
            String(
                req.technician.technician_id || ''
            ).trim();

        // Verify technician still exists + Active
        const technicianQuery = `
            SELECT
                technician_id,
                name,
                phone,
                status
            FROM public.technicians
            WHERE technician_id = ?
            LIMIT 1
        `;

        db.query(
            technicianQuery,
            [technicianId],
            (techErr, technicians) => {

                if (techErr) {
                    console.error(
                        'Technician Orders - Technician Check Error:',
                        techErr
                    );

                    return res.status(500).json({
                        success: false,
                        message: 'Unable to verify technician.'
                    });
                }

                if (
                    !technicians ||
                    technicians.length === 0
                ) {
                    return res.status(404).json({
                        success: false,
                        message: 'Technician account not found.'
                    });
                }

                const technician = technicians[0];

                if (technician.status !== 'Active') {
                    return res.status(403).json({
                        success: false,
                        message:
                            'Technician account is not active.'
                    });
                }

                const ordersQuery = `
    SELECT *
    FROM public.orders
    WHERE technician_id = ?
      AND COALESCE(status, '') NOT IN (
          'Completed',
          'Cancelled',
          'Trash'
      )
    ORDER BY id DESC
`;

                db.query(
                    ordersQuery,
                    [technicianId],
                    (ordersErr, orders) => {

                        if (ordersErr) {
                            console.error(
                                'Technician Assigned Orders Error:',
                                ordersErr
                            );

                            return res.status(500).json({
                                success: false,
                                message:
                                    'Unable to load assigned orders.'
                            });
                        }

                        return res.json({
                            success: true,

                            technician: {
                                technician_id:
                                    technician.technician_id,
                                name:
                                    technician.name
                            },

                            total:
                                orders
                                    ? orders.length
                                    : 0,

                            orders:
                                orders || []
                        });
                    }
                );
            }
        );
    }
);

// ==========================================
// TECHNICIAN - ACCEPT ASSIGNED ORDER
// JWT PROTECTED
// ==========================================
app.post(
    '/api/technicians/orders/:orderId/accept',
    authenticateTechnician,
    (req, res) => {

        const technicianId =
            String(
                req.technician.technician_id || ''
            ).trim();

        const orderId =
            String(
                req.params.orderId || ''
            ).trim();

        if (!orderId) {
            return res.status(400).json({
                success: false,
                message: 'Order ID is required.'
            });
        }

        const query = `
            UPDATE public.orders
            SET
                technician_response = 'Accepted',
                technician_response_reason = NULL,
                technician_responded_at = NOW(),
                status = 'Assigned'
            WHERE order_id = ?
              AND technician_id = ?
              AND COALESCE(is_deleted, 0) = 0
              AND COALESCE(technician_response, 'Pending') = 'Pending'
            RETURNING *
        `;

        db.query(
            query,
            [
                orderId,
                technicianId
            ],
            (err, rows) => {

                if (err) {
                    console.error(
                        'Technician Accept Order Error:',
                        err
                    );

                    return res.status(500).json({
                        success: false,
                        message:
                            'Unable to accept this order.'
                    });
                }

                if (
                    !rows ||
                    rows.length === 0
                ) {
                    return res.status(400).json({
                        success: false,
                        message:
                            'Order not found, already responded, or not assigned to you.'
                    });
                }

                return res.json({
                    success: true,
                    message:
                        'Job accepted successfully.',
                    order: rows[0]
                });
            }
        );
    }
);


// ==========================================
// TECHNICIAN - REJECT ASSIGNED ORDER
// JWT PROTECTED
// ==========================================
app.post(
    '/api/technicians/orders/:orderId/reject',
    authenticateTechnician,
    (req, res) => {

        const technicianId =
            String(
                req.technician.technician_id || ''
            ).trim();

        const orderId =
            String(
                req.params.orderId || ''
            ).trim();

        const reason =
            String(
                req.body.reason || ''
            ).trim();

        const allowedReasons = [
            'Too far',
            'Not available',
            'No spare/tools',
            'Schedule conflict',
            'Other'
        ];

        if (!orderId) {
            return res.status(400).json({
                success: false,
                message: 'Order ID is required.'
            });
        }

        if (
            !reason ||
            !allowedReasons.includes(reason)
        ) {
            return res.status(400).json({
                success: false,
                message:
                    'Please select a valid rejection reason.'
            });
        }

        const query = `
            UPDATE public.orders
            SET
    technician_response = 'Rejected',
    technician_response_reason = ?,
    technician_responded_at = NOW(),

    technician_id = NULL,
    technician_name = NULL,
    technician_phone = NULL,
    eta = NULL,

    status = 'Pending'
            WHERE order_id = ?
              AND technician_id = ?
              AND COALESCE(is_deleted, 0) = 0
              AND COALESCE(technician_response, 'Pending') = 'Pending'
            RETURNING *
        `;

        db.query(
            query,
            [
                reason,
                orderId,
                technicianId
            ],
            (err, rows) => {

                if (err) {
                    console.error(
                        'Technician Reject Order Error:',
                        err
                    );

                    return res.status(500).json({
                        success: false,
                        message:
                            'Unable to reject this order.'
                    });
                }

                if (
                    !rows ||
                    rows.length === 0
                ) {
                    return res.status(400).json({
                        success: false,
                        message:
                            'Order not found, already responded, or not assigned to you.'
                    });
                }

                return res.json({
                    success: true,
                    message:
                        'Job rejected successfully.',
                    order: rows[0]
                });
            }
        );
    }
);

// ==========================================
// TECHNICIAN - SINGLE ASSIGNED ORDER
// JWT PROTECTED
// ==========================================
app.get(
    '/api/technicians/orders/:orderId',
    authenticateTechnician,
    (req, res) => {

        const technicianId =
            String(
                req.technician.technician_id || ''
            ).trim();

        const orderId =
            String(
                req.params.orderId || ''
            ).trim();


        if (!orderId) {

            return res.status(400).json({
                success: false,
                message: 'Order ID is required.'
            });
        }


        // First confirm technician is still Active
        const technicianQuery = `
            SELECT
                technician_id,
                status
            FROM public.technicians
            WHERE technician_id = ?
            LIMIT 1
        `;


        db.query(
            technicianQuery,
            [technicianId],
            (techErr, technicians) => {

                if (techErr) {

                    console.error(
                        'Technician Order Check Error:',
                        techErr
                    );

                    return res.status(500).json({
                        success: false,
                        message:
                            'Unable to verify technician.'
                    });
                }


                if (
                    !technicians ||
                    technicians.length === 0
                ) {

                    return res.status(404).json({
                        success: false,
                        message:
                            'Technician account not found.'
                    });
                }


                if (
                    technicians[0].status !== 'Active'
                ) {

                    return res.status(403).json({
                        success: false,
                        message:
                            'Technician account is not active.'
                    });
                }


                // IMPORTANT:
                // Order must belong to logged-in technician
               const orderQuery = `
    SELECT *
    FROM public.orders
    WHERE order_id = ?
      AND technician_id = ?
      AND COALESCE(status, '') <> 'Trash'
    LIMIT 1
`;


                db.query(
                    orderQuery,
                    [
                        orderId,
                        technicianId
                    ],
                    (orderErr, orders) => {

                        if (orderErr) {

                            console.error(
                                'Technician Single Order Error:',
                                orderErr
                            );

                            return res.status(500).json({
                                success: false,
                                message:
                                    'Unable to load order.'
                            });
                        }


                        if (
                            !orders ||
                            orders.length === 0
                        ) {

                            return res.status(404).json({
                                success: false,
                                message:
                                    'Order not found or not assigned to you.'
                            });
                        }


                        return res.json({
                            success: true,
                            order: orders[0]
                        });
                    }
                );
            }
        );
    }
);

// ==========================================
// TECHNICIAN - UPLOAD WORK PROOF
// JWT PROTECTED
// ==========================================
app.post(
    '/api/technicians/orders/:orderId/work-proof',

    authenticateTechnician,

    technicianMediaUpload.fields([
        {
            name: 'before_photo',
            maxCount: 1
        },
        {
            name: 'after_photo',
            maxCount: 1
        },
        {
            name: 'work_video',
            maxCount: 1
        }
    ]),

    async (req, res) => {

        try {

            const technicianId =
                String(
                    req.technician.technician_id || ''
                ).trim();

            const orderId =
                String(
                    req.params.orderId || ''
                ).trim();


            if (!orderId) {

                return res.status(400).json({
                    success: false,
                    message: 'Order ID is required.'
                });
            }


            const beforePhoto =
                req.files?.before_photo?.[0] || null;

            const afterPhoto =
                req.files?.after_photo?.[0] || null;

            const workVideo =
                req.files?.work_video?.[0] || null;

            const technicianNote =
                String(
                    req.body.technician_note || ''
                ).trim();


            if (
                !beforePhoto &&
                !afterPhoto &&
                !workVideo &&
                !technicianNote
            ) {

                return res.status(400).json({
                    success: false,
                    message:
                        'Upload at least one work proof or enter a note.'
                });
            }


            // ==========================================
            // FIELD TYPE SECURITY
            // ==========================================

            if (
                beforePhoto &&
                !beforePhoto.mimetype.startsWith('image/')
            ) {

                return res.status(400).json({
                    success: false,
                    message:
                        'Before photo must be an image.'
                });
            }


            if (
                afterPhoto &&
                !afterPhoto.mimetype.startsWith('image/')
            ) {

                return res.status(400).json({
                    success: false,
                    message:
                        'After photo must be an image.'
                });
            }


            if (
                workVideo &&
                ![
                    'video/mp4',
                    'video/webm'
                ].includes(workVideo.mimetype)
            ) {

                return res.status(400).json({
                    success: false,
                    message:
                        'Work video must be MP4 or WebM.'
                });
            }


            // ==========================================
            // VERIFY ACTIVE TECHNICIAN + ORDER OWNERSHIP
            // ==========================================

            const verifyQuery = `
                SELECT
    o.order_id,
    o.technician_id,
    o.status AS order_status,
    t.status AS technician_status,
    wp.status AS work_proof_status
                FROM public.orders o

                JOIN public.technicians t
                    ON t.technician_id = o.technician_id
                    LEFT JOIN public.technician_work_proofs wp
    ON wp.order_id = o.order_id

                WHERE o.order_id = ?
  AND o.technician_id = ?
  AND COALESCE(o.technician_response, 'Pending') = 'Accepted'
  AND COALESCE(o.status, '') <> 'Trash'

                LIMIT 1
            `;


            db.query(
                verifyQuery,
                [
                    orderId,
                    technicianId
                ],
                async (verifyErr, rows) => {

                    if (verifyErr) {

                        console.error(
                            'Work Proof Order Verify Error:',
                            verifyErr
                        );

                        return res.status(500).json({
                            success: false,
                            message:
                                'Unable to verify service order.'
                        });
                    }


                    if (
                        !rows ||
                        rows.length === 0
                    ) {

                        return res.status(404).json({
                            success: false,
                            message:
                                'Order not found or not assigned to you.'
                        });
                    }


                   if (
    rows[0].technician_status !==
    'Active'
) {
    return res.status(403).json({
        success: false,
        message:
            'Technician account is not active.'
    });
}

const existingProofStatus =
    String(
        rows[0].work_proof_status || ''
    ).trim();

const orderStatus =
    String(
        rows[0].order_status || ''
    ).trim();

if (
    existingProofStatus === 'Submitted'
) {
    return res.status(409).json({
        success: false,
        code: 'WORK_PROOF_PENDING',
        message:
            'Work proof already submitted. Please wait for admin approval.'
    });
}

if (
    existingProofStatus === 'Approved' ||
    orderStatus === 'Completed'
) {
    return res.status(409).json({
        success: false,
        code: 'WORK_PROOF_APPROVED',
        message:
            'This work proof is already approved and the order is completed.'
    });
}


                    // ==========================================
                    // SUPABASE CONFIG
                    // ==========================================

                    const SUPABASE_URL =
                        String(
                            process.env.SUPABASE_URL ||
                            process.env.PROJECT_URL ||
                            ''
                        ).replace(
                            /\/rest\/v1\/?$/,
                            ''
                        );


                    const SUPABASE_SECRET_KEY =
                        process.env.SUPABASE_SECRET_KEY ||
                        process.env.SUPABASE_SERVICE_ROLE_KEY ||
                        process.env.SUPABASE_SERVICE_KEY ||
                        '';


                    if (
                        !SUPABASE_URL ||
                        !SUPABASE_SECRET_KEY
                    ) {

                        return res.status(500).json({
                            success: false,
                            message:
                                'Storage configuration is missing.'
                        });
                    }


                    // ==========================================
                    // SAFE STORAGE PATH
                    // ==========================================

                    const safeTechnicianId =
                        technicianId.replace(
                            /[^a-zA-Z0-9-_]/g,
                            '-'
                        );

                    const safeOrderId =
                        orderId.replace(
                            /[^a-zA-Z0-9-_]/g,
                            '-'
                        );


                    const baseFolder =
                        `technician-work/${safeTechnicianId}/${safeOrderId}`;


                    async function uploadBuffer(
                        storagePath,
                        buffer,
                        contentType
                    ) {

                        await axios.post(
                            `${SUPABASE_URL}/storage/v1/object/catus-images/${storagePath}`,
                            buffer,
                            {
                                headers: {
                                    Authorization:
                                        `Bearer ${SUPABASE_SECRET_KEY}`,

                                    apikey:
                                        SUPABASE_SECRET_KEY,

                                    'Content-Type':
                                        contentType
                                },

                                maxBodyLength:
                                    Infinity
                            }
                        );


                        return (
                            `${SUPABASE_URL}` +
                            `/storage/v1/object/public/` +
                            `catus-images/${storagePath}`
                        );
                    }


                    let beforePhotoUrl = null;
                    let afterPhotoUrl = null;
                    let workVideoUrl = null;


                    // ==========================================
                    // BEFORE PHOTO -> WEBP
                    // ==========================================

                    if (beforePhoto) {

                        const optimizedBefore =
                            await sharp(
                                beforePhoto.buffer
                            )
                                .rotate()
                                .resize({
                                    width: 1600,
                                    height: 1600,
                                    fit: 'inside',
                                    withoutEnlargement: true
                                })
                                .webp({
                                    quality: 82
                                })
                                .toBuffer();


                        beforePhotoUrl =
                            await uploadBuffer(
                                `${baseFolder}/${Date.now()}-before.webp`,
                                optimizedBefore,
                                'image/webp'
                            );
                    }


                    // ==========================================
                    // AFTER PHOTO -> WEBP
                    // ==========================================

                    if (afterPhoto) {

                        const optimizedAfter =
                            await sharp(
                                afterPhoto.buffer
                            )
                                .rotate()
                                .resize({
                                    width: 1600,
                                    height: 1600,
                                    fit: 'inside',
                                    withoutEnlargement: true
                                })
                                .webp({
                                    quality: 82
                                })
                                .toBuffer();


                        afterPhotoUrl =
                            await uploadBuffer(
                                `${baseFolder}/${Date.now()}-after.webp`,
                                optimizedAfter,
                                'image/webp'
                            );
                    }


                    // ==========================================
                    // VIDEO
                    // ==========================================

                    if (workVideo) {

                        const videoExtension =
                            workVideo.mimetype ===
                            'video/webm'
                                ? 'webm'
                                : 'mp4';


                        workVideoUrl =
                            await uploadBuffer(
                                `${baseFolder}/${Date.now()}-work.${videoExtension}`,
                                workVideo.buffer,
                                workVideo.mimetype
                            );
                    }


                    // ==========================================
                    // SAVE / UPDATE WORK PROOF
                    // ==========================================

                    const saveQuery = `
                        INSERT INTO public.technician_work_proofs
                        (
                            order_id,
                            technician_id,
                            before_photo_url,
                            after_photo_url,
                            work_video_url,
                            technician_note,
                            status,
                            created_at,
                            updated_at
                        )

                        VALUES (
                            ?, ?, ?, ?, ?, ?, 'Submitted',
                            CURRENT_TIMESTAMP,
                            CURRENT_TIMESTAMP
                        )

                        ON CONFLICT (order_id)

                        DO UPDATE SET

                            technician_id =
                                EXCLUDED.technician_id,

                            before_photo_url =
                                COALESCE(
                                    EXCLUDED.before_photo_url,
                                    technician_work_proofs.before_photo_url
                                ),

                            after_photo_url =
                                COALESCE(
                                    EXCLUDED.after_photo_url,
                                    technician_work_proofs.after_photo_url
                                ),

                            work_video_url =
                                COALESCE(
                                    EXCLUDED.work_video_url,
                                    technician_work_proofs.work_video_url
                                ),

                            technician_note =
                                CASE
                                    WHEN EXCLUDED.technician_note IS NOT NULL
                                         AND EXCLUDED.technician_note <> ''
                                    THEN EXCLUDED.technician_note
                                    ELSE technician_work_proofs.technician_note
                                END,

                            status = 'Submitted',

                            updated_at =
                                CURRENT_TIMESTAMP

                        RETURNING *
                    `;


                    db.query(
                        saveQuery,
                        [
                            orderId,
                            technicianId,
                            beforePhotoUrl,
                            afterPhotoUrl,
                            workVideoUrl,
                            technicianNote || null
                        ],
                        (saveErr, savedRows) => {

                            if (saveErr) {

                                console.error(
                                    'Work Proof Save Error:',
                                    saveErr
                                );

                                return res.status(500).json({
                                    success: false,
                                    message:
                                        'Unable to save work proof.'
                                });
                            }


                            return res.json({
                                success: true,
                                message:
                                    'Work proof submitted successfully.',
                                work_proof:
                                    savedRows?.[0] || null
                            });
                        }
                    );
                }
            );

        } catch (error) {

            console.error(
                'Technician Work Proof Upload Error:',
                error.response?.data ||
                error.message
            );


            return res.status(500).json({
                success: false,
                message:
                    'Work proof upload failed.'
            });
        }
    }
);

// ==========================================
// TECHNICIAN - GET WORK PROOF
// JWT PROTECTED
// ==========================================
app.get(
    '/api/technicians/orders/:orderId/work-proof',
    authenticateTechnician,
    (req, res) => {

        const technicianId =
            String(
                req.technician.technician_id || ''
            ).trim();

        const orderId =
            String(
                req.params.orderId || ''
            ).trim();


        if (!orderId) {

            return res.status(400).json({
                success: false,
                message: 'Order ID is required.'
            });
        }


        // ==========================================
        // VERIFY ORDER BELONGS TO TECHNICIAN
        // ==========================================

        const orderCheckQuery = `
    SELECT
        order_id,
        technician_id
    FROM public.orders
    WHERE order_id = ?
      AND technician_id = ?
      AND COALESCE(status, '') <> 'Trash'
    LIMIT 1
`;


        db.query(
            orderCheckQuery,
            [
                orderId,
                technicianId
            ],
            (orderErr, orderRows) => {

                if (orderErr) {

                    console.error(
                        'Work Proof Order Check Error:',
                        orderErr
                    );

                    return res.status(500).json({
                        success: false,
                        message:
                            'Unable to verify service order.'
                    });
                }


                if (
                    !orderRows ||
                    orderRows.length === 0
                ) {

                    return res.status(404).json({
                        success: false,
                        message:
                            'Order not found or not assigned to you.'
                    });
                }


                // ==========================================
                // GET WORK PROOF
                // ==========================================

                const proofQuery = `
                    SELECT
                        id,
                        order_id,
                        technician_id,
                        before_photo_url,
                        after_photo_url,
                        work_video_url,
                        technician_note,
                        status,
                        created_at,
                        updated_at
                    FROM public.technician_work_proofs
                    WHERE order_id = ?
                      AND technician_id = ?
                    LIMIT 1
                `;


                db.query(
                    proofQuery,
                    [
                        orderId,
                        technicianId
                    ],
                    (proofErr, proofRows) => {

                        if (proofErr) {

                            console.error(
                                'Get Work Proof Error:',
                                proofErr
                            );

                            return res.status(500).json({
                                success: false,
                                message:
                                    'Unable to load work proof.'
                            });
                        }


                        return res.json({
                            success: true,
                            work_proof:
                                proofRows &&
                                proofRows.length > 0
                                    ? proofRows[0]
                                    : null
                        });
                    }
                );
            }
        );
    }
);

// ==========================================
// ADMIN - CUSTOMER REVIEWS
// ==========================================
app.get('/api/admin/customer-reviews', (req, res) => {

    const query = `
        SELECT
            pr.id,
            pr.order_id,
            pr.service_id,
            pr.customer_name,
            pr.rating,
            pr.review_text,
            pr.created_at,
            pr.moderation_status,
            pr.moderation_reason,

            o.phone AS customer_phone,
            o.status AS order_status,
            o.technician_id,

            s.service_name,

            t.name AS technician_name,
            t.phone AS technician_phone

        FROM public.product_reviews pr

        LEFT JOIN public.orders o
            ON o.order_id = pr.order_id

        LEFT JOIN public.services s
            ON CAST(s.service_id AS TEXT) =
               CAST(pr.service_id AS TEXT)

        LEFT JOIN public.technicians t
            ON t.technician_id = o.technician_id

        ORDER BY pr.id DESC
    `;

    db.query(query, [], (err, rows) => {

        if (err) {

            console.error(
                'Admin Customer Reviews Error:',
                err
            );

            return res.status(500).json({
                success: false,
                message: 'Unable to load customer reviews.'
            });
        }

        return res.json({
            success: true,
            total: rows ? rows.length : 0,
            reviews: rows || []
        });
    });
});

// ==========================================
// ADMIN - UPDATE CUSTOMER REVIEW MODERATION
// VISIBLE / HIDDEN
// ==========================================
app.patch('/api/admin/customer-reviews/:reviewId/moderation', (req, res) => {

    const reviewId =
        String(req.params.reviewId || '').trim();

    const moderationStatus =
        String(req.body.moderation_status || '').trim();

    const moderationReason =
        String(req.body.moderation_reason || '').trim();

    if (!reviewId) {
        return res.status(400).json({
            success: false,
            message: 'Review ID is required.'
        });
    }

    if (
        moderationStatus !== 'Visible' &&
        moderationStatus !== 'Hidden'
    ) {
        return res.status(400).json({
            success: false,
            message:
                'Moderation status must be Visible or Hidden.'
        });
    }

    const reason =
        moderationStatus === 'Hidden'
            ? moderationReason
            : '';

    const query = `
        UPDATE public.product_reviews
        SET
            moderation_status = ?,
            moderation_reason = ?
        WHERE id = ?
        RETURNING *
    `;

    db.query(
        query,
        [
            moderationStatus,
            reason,
            reviewId
        ],
        (err, rows) => {

            if (err) {

                console.error(
                    'Admin Review Moderation Error:',
                    err
                );

                return res.status(500).json({
                    success: false,
                    message:
                        'Unable to update review moderation.'
                });
            }

            if (!rows || rows.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'Review not found.'
                });
            }

            return res.json({
                success: true,
                message:
                    moderationStatus === 'Hidden'
                        ? 'Review hidden successfully.'
                        : 'Review restored successfully.',
                review: rows[0]
            });
        }
    );
});

// ==========================================
// ADMIN - TECHNICIAN WORK PROOFS
// ==========================================
app.get(
    '/api/admin/technician-work-proofs',
    requireAdminAuth,
    (req, res) => {

        const query = `
            SELECT
                wp.id,
                wp.order_id,
                wp.technician_id,
                wp.before_photo_url,
                wp.after_photo_url,
                wp.work_video_url,
                wp.technician_note,
                wp.status,
                wp.created_at,
                wp.updated_at,

                t.name AS technician_name,
                t.phone AS technician_phone,

                o.status AS order_status

            FROM public.technician_work_proofs wp

            LEFT JOIN public.technicians t
                ON t.technician_id = wp.technician_id

            LEFT JOIN public.orders o
                ON o.order_id = wp.order_id

            ORDER BY
                CASE
                    WHEN wp.status = 'Submitted' THEN 1
                    WHEN wp.status = 'Rejected' THEN 2
                    WHEN wp.status = 'Approved' THEN 3
                    ELSE 4
                END,
                wp.updated_at DESC
        `;


        db.query(
            query,
            [],
            (error, rows) => {

                if (error) {

                    console.error(
                        'Admin Work Proofs Error:',
                        error
                    );

                    return res.status(500).json({
                        success: false,
                        message:
                            'Unable to load technician work proofs.'
                    });
                }


                return res.json({
                    success: true,
                    total:
                        rows
                            ? rows.length
                            : 0,
                    work_proofs:
                        rows || []
                });
            }
        );
    }
);

// ==========================================
// PUBLIC - APPROVED WORK PROOFS BY SERVICE
// ==========================================
app.get(
    '/api/public/work-proofs/service/:serviceId',
    (req, res) => {

        const serviceId =
            String(
                req.params.serviceId || ''
            ).trim();

        if (!serviceId) {

            return res.status(400).json({
                success: false,
                message: 'Service ID is required.'
            });
        }

        const query = `
            SELECT
                wp.id,
                wp.before_photo_url,
                wp.after_photo_url,
                wp.work_video_url,
                wp.technician_note,
                wp.updated_at,

                o.order_id,
                o.product_id,
                o.district,

                t.name AS technician_name

            FROM public.technician_work_proofs wp

            INNER JOIN public.orders o
                ON o.order_id = wp.order_id

            LEFT JOIN public.technicians t
                ON t.technician_id = wp.technician_id

            WHERE CAST(o.product_id AS TEXT) = ?
              AND wp.status = 'Approved'
              AND COALESCE(o.status, '') = 'Completed'

            ORDER BY wp.updated_at DESC

            LIMIT 12
        `;

        db.query(
            query,
            [serviceId],
            (error, rows) => {

                if (error) {

                    console.error(
                        'Public Work Proofs Error:',
                        error
                    );

                    return res.status(500).json({
                        success: false,
                        message:
                            'Unable to load work proofs.'
                    });
                }

                return res.json({
                    success: true,
                    total: rows ? rows.length : 0,
                    work_proofs: rows || []
                });
            }
        );
    }
);

// ==========================================
// ADMIN - UPDATE TECHNICIAN WORK PROOF STATUS
// APPROVE / REJECT
// ==========================================
app.patch(
    '/api/admin/technician-work-proofs/:proofId/status',
    requireAdminAuth,
    (req, res) => {

        const proofId =
            String(req.params.proofId || '').trim();

        const status =
            String(req.body.status || '').trim();

        if (!proofId) {
            return res.status(400).json({
                success: false,
                message: 'Work proof ID is required.'
            });
        }

        if (
            status !== 'Approved' &&
            status !== 'Rejected'
        ) {
            return res.status(400).json({
                success: false,
                message: 'Status must be Approved or Rejected.'
            });
        }

        const query = `
            WITH updated_proof AS (

                UPDATE public.technician_work_proofs

                SET
                    status = ?,
                    updated_at = CURRENT_TIMESTAMP

                WHERE id = ?

                RETURNING
                    id,
                    order_id,
                    technician_id,
                    before_photo_url,
                    after_photo_url,
                    work_video_url,
                    technician_note,
                    status,
                    created_at,
                    updated_at
            ),

            updated_order AS (

                UPDATE public.orders o

                SET
                    status =
                        CASE
                            WHEN ? = 'Approved'
                                THEN 'Completed'

                            WHEN ? = 'Rejected'
                                THEN 'Assigned'

                            ELSE o.status
                        END

                WHERE o.order_id = (
                    SELECT order_id
                    FROM updated_proof
                    LIMIT 1
                )

                RETURNING
                    order_id,
                    status
            )

            SELECT
                up.*,

                (
                    SELECT uo.status
                    FROM updated_order uo
                    LIMIT 1
                ) AS order_status

            FROM updated_proof up
        `;

        db.query(
            query,
            [
                status,
                proofId,
                status,
                status
            ],
            (error, rows) => {

                if (error) {

                    console.error(
                        'Admin Work Proof Status Update Error:',
                        error
                    );

                    return res.status(500).json({
                        success: false,
                        message:
                            'Unable to update work proof status.'
                    });
                }

                if (
                    !rows ||
                    rows.length === 0
                ) {
                    return res.status(404).json({
                        success: false,
                        message: 'Work proof not found.'
                    });
                }

                return res.json({
                    success: true,

                    message:
                        status === 'Approved'
                            ? 'Work proof approved and order completed successfully.'
                            : 'Work proof rejected. Technician can resubmit proof.',

                    work_proof: rows[0]
                });
            }
        );
    }
);

// ==========================================
// CUSTOMER REVIEW - ORDER DETAILS
// ==========================================

app.get('/api/customer-reviews/order/:orderId', (req, res) => {

    const orderId =
        String(req.params.orderId || '').trim();

    if (!orderId) {
        return res.status(400).json({
            success: false,
            message: 'Order ID is required.'
        });
    }

    const query = `
        SELECT
            o.order_id,
            o.product_id,
            o.service_name,
            o.customer_name,
            o.phone,
            o.address,
            o.district,
            o.pincode,
            o.order_date,
            o.status,
            o.technician_id,
            o.technician_name,

            s.image_url AS product_image,
            s.category AS service_category

        FROM public.orders o

        LEFT JOIN public.services s
            ON CAST(s.service_id AS TEXT) =
               CAST(o.product_id AS TEXT)

        WHERE o.order_id = ?

        LIMIT 1
    `;

    db.query(
        query,
        [orderId],
        (err, rows) => {

            if (err) {

                console.error(
                    'Customer Review Order Details Error:',
                    err
                );

                return res.status(500).json({
                    success: false,
                    message: 'Unable to load service order.'
                });
            }

            if (!rows || rows.length === 0) {

                return res.status(404).json({
                    success: false,
                    message: 'Service order not found.'
                });
            }

            const order = rows[0];

            return res.json({
                success: true,

                review_allowed:
                    String(order.status || '')
                        .trim()
                        .toLowerCase() === 'completed',

                order: {
                    order_id:
                        order.order_id,

                    product_id:
                        order.product_id,

                    product_name:
                        order.service_name,

                    product_image:
                        order.product_image || '',

                    service_category:
                        order.service_category || '',

                    customer_name:
                        order.customer_name,

                    customer_phone:
                        order.phone,

                    address:
                        order.address,

                    district:
                        order.district,

                    pincode:
                        order.pincode,

                    order_date:
                        order.order_date,

                    status:
                        order.status,

                    technician_id:
                        order.technician_id || null,

                    technician_name:
                        order.technician_name || null
                }
            });
        }
    );
});

// ==========================================
// CUSTOMER REVIEW - SUBMIT
// ==========================================

app.post('/api/customer-reviews/submit', (req, res) => {

    const orderId =
        String(req.body.order_id || '').trim();

    const customerPhone =
        String(req.body.customer_phone || '')
            .replace(/\D/g, '')
            .slice(-10);

    const rating =
        Number(req.body.rating);

    const reviewText =
        String(req.body.review_text || '')
            .trim()
            .slice(0, 1000);


    // ==========================================
    // BASIC VALIDATION
    // ==========================================

    if (!orderId) {
        return res.status(400).json({
            success: false,
            message: 'Order ID is required.'
        });
    }

    if (!/^[6-9]\d{9}$/.test(customerPhone)) {
        return res.status(400).json({
            success: false,
            message: 'Valid customer mobile number is required.'
        });
    }

    if (
        !Number.isInteger(rating) ||
        rating < 1 ||
        rating > 5
    ) {
        return res.status(400).json({
            success: false,
            message: 'Rating must be between 1 and 5.'
        });
    }


    // ==========================================
    // VERIFY COMPLETED ORDER + CUSTOMER
    // ==========================================

    const orderQuery = `
        SELECT *
        FROM public.orders
        WHERE order_id = ?
          AND status = 'Completed'
        LIMIT 1
    `;

    db.query(
        orderQuery,
        [orderId],
        (orderError, orderRows) => {

            if (orderError) {

                console.error(
                    'Customer Review Order Check Error:',
                    orderError
                );

                return res.status(500).json({
                    success: false,
                    message: 'Unable to verify service order.'
                });
            }


            if (!orderRows || orderRows.length === 0) {

                return res.status(404).json({
                    success: false,
                    message:
                        'Completed service order not found.'
                });
            }


            const order = orderRows[0];

            const orderPhone =
                String(
                    order.phone ||
                    order.customer_phone ||
                    order.mobile ||
                    ''
                )
                    .replace(/\D/g, '')
                    .slice(-10);


            if (
                !orderPhone ||
                orderPhone !== customerPhone
            ) {

                return res.status(403).json({
                    success: false,
                    message:
                        'Mobile number does not match this order.'
                });
            }


            // ==========================================
            // SAVE REVIEW
            // ==========================================

            const insertQuery = `
                INSERT INTO public.customer_reviews
                (
                    order_id,
                    technician_id,
                    customer_name,
                    customer_phone,
                    rating,
                    review_text,
                    status,
                    created_at,
                    updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, 'Pending',
                        CURRENT_TIMESTAMP,
                        CURRENT_TIMESTAMP)

                ON CONFLICT (order_id)
                DO NOTHING

                RETURNING *
            `;


            db.query(
                insertQuery,
                [
                    orderId,
                    order.technician_id || null,

                    order.customer_name ||
                    order.name ||
                    'Cerood Customer',

                    customerPhone,
                    rating,
                    reviewText
                ],
                (reviewError, reviewRows) => {

                    if (reviewError) {

                        console.error(
                            'Customer Review Submit Error:',
                            reviewError
                        );

                        return res.status(500).json({
                            success: false,
                            message:
                                'Unable to submit review.'
                        });
                    }


                    if (
                        !reviewRows ||
                        reviewRows.length === 0
                    ) {

                        return res.status(409).json({
                            success: false,
                            code: 'REVIEW_ALREADY_SUBMITTED',
                            message:
                                'A review has already been submitted for this order.'
                        });
                    }


                    return res.json({
                        success: true,
                        message:
                            'Thank you! Your review has been submitted.',
                        review: reviewRows[0]
                    });
                }
            );
        }
    );
});

app.get('/api/admin/orders', (req, res) => {
    const query = 'SELECT * FROM orders ORDER BY id DESC';
    db.query(query, (err, results) => {
        if (err) return res.status(500).json({ success: false, error: err.message });
        res.json({ success: true, orders: results });
    });
});

app.post('/api/admin/assign-technician-manual', (req, res) => {

    const {
        order_id,
        technician_id,
        technician_name,
        technician_phone,
        eta
    } = req.body;


    if (
        !order_id ||
        !technician_id ||
        !technician_name ||
        !technician_phone
    ) {
        return res.status(400).json({
            success: false,
            message: 'Technician assignment details are incomplete.'
        });
    }


    const query = `
    UPDATE public.orders
    SET
        technician_id = ?,
        technician_name = ?,
        technician_phone = ?,
        eta = ?,

        status = ?,

        technician_response = 'Pending',
        technician_response_reason = NULL,
        technician_responded_at = NULL,

        assigned_at = CURRENT_TIMESTAMP

    WHERE order_id = ?

    RETURNING
        order_id,
        technician_id,
        technician_name,
        technician_phone,
        status,
        technician_response,
        assigned_at
`;


    db.query(
        query,
        [
            technician_id,
            technician_name,
            technician_phone,
            eta || null,
            'Assigned',
            order_id
        ],
        (err, rows) => {

            if (err) {

                console.error(
                    'Manual Technician Assignment Error:',
                    err
                );

                return res.status(500).json({
                    success: false,
                    message: 'Unable to assign technician.',
                    error: err.message
                });
            }


            if (!rows || rows.length === 0) {

                return res.status(404).json({
                    success: false,
                    message: 'Order not found.'
                });
            }


            return res.json({
                success: true,
                message: 'Technician assigned successfully!',
                assignment: rows[0]
            });
        }
    );
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
    
    db.query(query, [title, subtitle, image_url, product_id, bg_color || '#f4f3f1', text_color || '#111', button_text || 'Get Service'], (err, result) => {
        if (err) return res.status(500).json({ success: false, error: err.message });
        res.json({ success: true, message: 'New banner added successfully!' });
    });
});

app.post('/api/admin/delete-banner', (req, res) => {
    const { id } = req.body;

    const query = `
        DELETE FROM public.hero_banners
        WHERE id = ?
        RETURNING image_url
    `;

    db.query(query, [id], async (err, results) => {

        if (err) {
            return res.status(500).json({
                success: false,
                error: err.message
            });
        }

        if (!results || results.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Banner not found.'
            });
        }

        if (results[0].image_url) {
            await deleteSupabaseImage(results[0].image_url);
        }

        res.json({
            success: true,
            message: 'Banner deleted successfully!'
        });
    });
});

app.post('/api/admin/edit-banner', (req, res) => {

    const {
        id,
        title,
        subtitle,
        image_url,
        product_id,
        bg_color,
        text_color,
        button_text
    } = req.body;

    const oldBannerQuery = `
        SELECT image_url
        FROM public.hero_banners
        WHERE id = ?
        LIMIT 1
    `;

    db.query(oldBannerQuery, [id], (findErr, oldRows) => {

        if (findErr) {
            return res.status(500).json({
                success: false,
                error: findErr.message
            });
        }

        const oldImageUrl =
            oldRows && oldRows[0]
                ? oldRows[0].image_url
                : '';

        const query = `
            UPDATE public.hero_banners
            SET title = ?,
                subtitle = ?,
                image_url = ?,
                product_id = ?,
                bg_color = ?,
                text_color = ?,
                button_text = ?
            WHERE id = ?
        `;

        db.query(
            query,
            [
                title,
                subtitle,
                image_url,
                product_id,
                bg_color,
                text_color,
                button_text,
                id
            ],
            async (err) => {

                if (err) {
                    return res.status(500).json({
                        success: false,
                        error: err.message
                    });
                }

                if (oldImageUrl && oldImageUrl !== image_url) {
                    await deleteSupabaseImage(oldImageUrl);
                }

                res.json({
                    success: true,
                    message: 'Banner updated successfully!'
                });
            }
        );
    });
});



// ==========================================
// REVIEWS API ROUTES
// ==========================================

// ==========================================
// CHECK WHETHER ORDER ALREADY HAS REVIEW
// ==========================================

app.get('/api/reviews/order-status/:orderId', (req, res) => {

    const orderId =
        String(req.params.orderId || '').trim();

    if (!orderId) {

        return res.status(400).json({
            success: false,
            message: 'Order ID is required.'
        });
    }

    const query = `
        SELECT
            id,
            service_id,
            order_id,
            customer_name,
            rating,
            review_text
        FROM public.product_reviews
        WHERE order_id = ?
        LIMIT 1
    `;

    db.query(
        query,
        [orderId],
        (err, rows) => {

            if (err) {

                console.error(
                    'Review Status Check Error:',
                    err
                );

                return res.status(500).json({
                    success: false,
                    message:
                        'Unable to check review status.'
                });
            }

            const review =
                rows && rows.length > 0
                    ? rows[0]
                    : null;

            return res.json({
                success: true,

                reviewed:
                    Boolean(review),

                review:
                    review
            });
        }
    );
});

app.get('/api/reviews/:service_id', (req, res) => {

    const serviceId = req.params.service_id;

    const query = `
    SELECT *
    FROM public.product_reviews
    WHERE service_id = ?
      AND COALESCE(moderation_status, 'Visible') = 'Visible'
    ORDER BY id DESC
`;

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
                    order.customer_name || 'Cerood Customer',
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
// SEO - OLD NUMERIC SERVICE URL -> SLUG 301
// ==========================================

app.get(
    '/api/seo-redirect/:state/:district/:location/:serviceId',
    (req, res) => {

        const serviceId =
            String(req.params.serviceId || '').trim();

        if (!/^\d+$/.test(serviceId)) {
            return res.status(404).send('Service not found');
        }

        const query = `
            SELECT slug
            FROM public.services
            WHERE service_id = ?
              AND slug IS NOT NULL
              AND TRIM(slug) <> ''
            LIMIT 1
        `;

        db.query(query, [serviceId], (err, rows) => {

            if (err) {
                console.error(
                    'SEO Redirect Service Lookup Error:',
                    err.message
                );

                return res.status(500).send(
                    'Unable to redirect service'
                );
            }

            if (!rows || rows.length === 0) {
                return res.status(404).send(
                    'Service not found'
                );
            }

            const slug =
                String(rows[0].slug).trim();

            const state =
                encodeURIComponent(req.params.state);

            const district =
                encodeURIComponent(req.params.district);

            const location =
                encodeURIComponent(req.params.location);

            const newUrl =
                `https://www.cerood.com/${state}/${district}/${location}/${encodeURIComponent(slug)}`;

            return res.redirect(301, newUrl);
        });
    }
);

// ==========================================
// SEO - DUPLICATE DISTRICT/LOCATION -> CLEAN URL 301
// Example:
// /tamil-nadu/chennai/chennai/tv-repair
// ->
// /tamil-nadu/chennai/tv-repair
// ==========================================

app.get(
    '/api/seo-clean-redirect/:state/:district/:location/:service',
    (req, res) => {

        const state =
            String(req.params.state || '').trim().toLowerCase();

        const district =
            String(req.params.district || '').trim().toLowerCase();

        const location =
            String(req.params.location || '').trim().toLowerCase();

        const service =
            String(req.params.service || '').trim();

        if (
            !state ||
            !district ||
            !location ||
            !service
        ) {
            return res.status(404).send('SEO page not found');
        }

        if (district !== location) {
            return res.status(404).send('Redirect not required');
        }

        const cleanUrl =
            `https://www.cerood.com/` +
            `${encodeURIComponent(state)}/` +
            `${encodeURIComponent(district)}/` +
            `${encodeURIComponent(service)}`;

        return res.redirect(301, cleanUrl);
    }
);

// ==========================================
// SEO - SCALABLE DYNAMIC SITEMAPS
// ==========================================

// Google limit = 50,000 URLs.
// Safety-ku 45,000 URLs per child sitemap.
const SITEMAP_MAX_URLS = 45000;

function sitemapSlugify(value) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

function sitemapEscapeXml(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}


// ==========================================
// CEROOD STORES — DATABASE-DRIVEN PRODUCT SITEMAPS
// Existing Home Services sitemap routes remain unchanged.
// ==========================================
const CEROOD_STORE_SITEMAP_PAGE_SIZE = 10000;
const CEROOD_STORE_SITEMAPS = Object.freeze({
    renewed: {
        table: 'public.renewed_products',
        filter: "status = 'published'",
        productPath: '/renewed-product.html'
    },
    beauty: {
        table: 'public.cosmetics_products',
        filter: "status = 'published' AND (expiry_date IS NULL OR expiry_date >= CURRENT_DATE)",
        productPath: '/cosmetics-product.html'
    },
    fashion: {
        table: 'public.clothing_products',
        filter: "status = 'published'",
        productPath: '/clothing-product.html'
    }
});
const ceroodSitemapQuery = (sql, params = []) => new Promise((resolve, reject) => {
    db.query(sql, params, (error, rows) => error ? reject(error) : resolve(rows || []));
});

app.get('/api/sitemaps/:division/:page.xml', async (req, res) => {
    const cfg = CEROOD_STORE_SITEMAPS[req.params.division];
    const rawPage = String(req.params.page || '');
    if (!cfg || !/^[1-9]\d{0,7}$/.test(rawPage)) {
        return res.status(404).type('text/plain').send('Sitemap not found');
    }
    const page = Number(rawPage);
    try {
        const countRows = await ceroodSitemapQuery(
            `SELECT COUNT(*)::int AS total FROM ${cfg.table} WHERE ${cfg.filter}`
        );
        const count = Number(countRows[0]?.total || 0);
        if (page > Math.ceil(count / CEROOD_STORE_SITEMAP_PAGE_SIZE)) {
            return res.status(404).type('text/plain').send('Sitemap not found');
        }
        const offset = (page - 1) * CEROOD_STORE_SITEMAP_PAGE_SIZE;
        const products = await ceroodSitemapQuery(
            `SELECT id, updated_at FROM ${cfg.table} WHERE ${cfg.filter}
             ORDER BY id LIMIT ? OFFSET ?`,
            [CEROOD_STORE_SITEMAP_PAGE_SIZE, offset]
        );
        const base = 'https://www.cerood.com';
        const xml = '<?xml version="1.0" encoding="UTF-8"?>\n' +
            '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
            products.map(p => {
                const loc = `${base}${cfg.productPath}?id=${encodeURIComponent(String(p.id))}`;
                const date = p.updated_at ? new Date(p.updated_at) : null;
                const lastmod = date && !Number.isNaN(date.getTime())
                    ? `\n    <lastmod>${date.toISOString()}</lastmod>` : '';
                return `  <url>\n    <loc>${sitemapEscapeXml(loc)}</loc>${lastmod}\n  </url>`;
            }).join('\n') + '\n</urlset>';
        return res.status(200)
            .set('Content-Type', 'application/xml; charset=utf-8')
            .set('Cache-Control', 'public, max-age=0, s-maxage=300')
            .send(xml);
    } catch (error) {
        console.error('Store product sitemap error:', error);
        return res.status(503).type('text/plain').send('Unable to generate sitemap');
    }
});

// ==========================================
// MAIN SITEMAP INDEX
// /api/sitemap.xml
// ==========================================

app.get('/api/sitemap.xml', (req, res) => {

    const frontendBase = 'https://www.cerood.com';

    const locationCountQuery = `
    SELECT COUNT(*)::int AS total
    FROM public.seo_locations
    WHERE is_active = TRUE
      AND location_slug IS NOT NULL
      AND TRIM(location_slug) <> ''
      AND district IS NOT NULL
      AND TRIM(district) <> ''
      AND state IS NOT NULL
      AND TRIM(state) <> ''
`;

    const serviceCountQuery = `
        SELECT COUNT(*)::int AS total
        FROM public.services
        WHERE slug IS NOT NULL
          AND TRIM(slug) <> ''
    `;

    db.query(
        locationCountQuery,
        [],
        (locationErr, locationRows) => {

            if (locationErr) {

                console.error(
                    'Sitemap location count error:',
                    locationErr
                );

                return res
                    .status(500)
                    .type('text/plain')
                    .send('Unable to generate sitemap index');
            }

            db.query(
                serviceCountQuery,
                [],
                async (serviceErr, serviceRows) => {

                    if (serviceErr) {

                        console.error(
                            'Sitemap service count error:',
                            serviceErr
                        );

                        return res
                            .status(500)
                            .type('text/plain')
                            .send('Unable to generate sitemap index');
                    }

                    const totalLocations =
                        Number(locationRows?.[0]?.total || 0);

                    const totalServices =
                        Number(serviceRows?.[0]?.total || 0);

                    if (totalServices <= 0) {

                        return res
                            .status(404)
                            .type('text/plain')
                            .send('No sitemap services found');
                    }

                    // First child sitemap-la homepage-um irukkum.
                    // Every page safe-ah same location limit use pannuvom.
                    const locationsPerSitemap =
    Math.max(
        1,
        Math.floor(
            (SITEMAP_MAX_URLS - 1000) /
            (totalServices + 2)
        )
    );

                    const totalPages =
                        Math.max(
                            1,
                            Math.ceil(
                                totalLocations /
                                locationsPerSitemap
                            )
                        );

                    const sitemapUrls = [];

                    for (
                        let page = 1;
                        page <= totalPages;
                        page++
                    ) {
                        sitemapUrls.push(
                            `${frontendBase}/sitemap-${page}.xml`
                        );
                    }

                    // Store sitemaps: include only existing published database products.
                    // Do not alter the existing Home Services child sitemap calculation.
                    try {
                        const storeCounts = await Promise.all(
                            Object.entries(CEROOD_STORE_SITEMAPS).map(async ([division, cfg]) => {
                                const rows = await ceroodSitemapQuery(
                                    `SELECT COUNT(*)::int AS total FROM ${cfg.table} WHERE ${cfg.filter}`
                                );
                                return [division, Number(rows[0]?.total || 0)];
                            })
                        );
                        for (const [division, count] of storeCounts) {
                            for (let page = 1; page <= Math.ceil(count / CEROOD_STORE_SITEMAP_PAGE_SIZE); page++) {
                                sitemapUrls.push(`${frontendBase}/sitemaps/${division}/${page}.xml`);
                            }
                        }
                    } catch (error) {
                        console.error('Store sitemap index error:', error);
                        return res.status(503).type('text/plain').send('Unable to generate sitemap index');
                    }

                    const xml =
                        `<?xml version="1.0" encoding="UTF-8"?>\n` +
                        `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
                        sitemapUrls
                            .map(url =>
                                `  <sitemap>\n` +
                                `    <loc>${sitemapEscapeXml(url)}</loc>\n` +
                                `  </sitemap>`
                            )
                            .join('\n') +
                        `\n</sitemapindex>`;

                    return res
                        .status(200)
                        .set(
                            'Content-Type',
                            'application/xml; charset=utf-8'
                        )
                        .send(xml);
                }
            );
        }
    );
});


// ==========================================
// CHILD SITEMAPS
// /api/sitemap/1
// /api/sitemap/2
// /api/sitemap/3 ...
// ==========================================

app.get('/api/sitemap/:page', (req, res) => {

    const page =
        parseInt(req.params.page, 10);

    if (
        !Number.isInteger(page) ||
        page < 1
    ) {

        return res
            .status(400)
            .type('text/plain')
            .send('Invalid sitemap page');
    }

    const serviceQuery = `
        SELECT service_id, slug
        FROM public.services
        WHERE slug IS NOT NULL
          AND TRIM(slug) <> ''
        ORDER BY service_id
    `;

    db.query(
        serviceQuery,
        [],
        (serviceErr, services) => {

            if (serviceErr) {

                console.error(
                    'Sitemap services error:',
                    serviceErr
                );

                return res
                    .status(500)
                    .type('text/plain')
                    .send('Unable to generate sitemap');
            }

            const sitemapServices =
                (services || [])
                    .map(service => ({
                        serviceId:
                            String(
                                service.service_id || ''
                            ).trim(),

                        slug:
                            String(
                                service.slug || ''
                            ).trim()
                    }))
                    .filter(
                        service =>
                            service.serviceId &&
                            service.slug
                    );

            if (sitemapServices.length === 0) {

                return res
                    .status(404)
                    .type('text/plain')
                    .send('No sitemap services found');
            }

            const locationsPerSitemap =
    Math.max(
        1,
        Math.floor(
            (SITEMAP_MAX_URLS - 1000) /
            (sitemapServices.length + 2)
        )
    );

            const offset =
                (page - 1) *
                locationsPerSitemap;

            const locationCountQuery = `
    SELECT COUNT(*)::int AS total
    FROM public.seo_locations
    WHERE is_active = TRUE
      AND location_slug IS NOT NULL
      AND TRIM(location_slug) <> ''
      AND district IS NOT NULL
      AND TRIM(district) <> ''
      AND state IS NOT NULL
      AND TRIM(state) <> ''
`;

            db.query(
                locationCountQuery,
                [],
                (countErr, countRows) => {

                    if (countErr) {

                        console.error(
                            'Sitemap location count error:',
                            countErr
                        );

                        return res
                            .status(500)
                            .type('text/plain')
                            .send('Unable to generate sitemap');
                    }

                    const totalLocations =
                        Number(
                            countRows?.[0]?.total || 0
                        );

                    const totalPages =
                        Math.max(
                            1,
                            Math.ceil(
                                totalLocations /
                                locationsPerSitemap
                            )
                        );

                    if (page > totalPages) {

                        return res
                            .status(404)
                            .type('text/plain')
                            .send('Sitemap page not found');
                    }

                    const locationsQuery = `
    SELECT
        id,
        location_name AS name,
        location_slug AS slug,
        district,
        state
    FROM public.seo_locations
    WHERE is_active = TRUE
      AND location_slug IS NOT NULL
      AND TRIM(location_slug) <> ''
      AND district IS NOT NULL
      AND TRIM(district) <> ''
      AND state IS NOT NULL
      AND TRIM(state) <> ''
    ORDER BY
    LOWER(TRIM(state)),
    LOWER(TRIM(district)),
    id
    LIMIT ${locationsPerSitemap}
    OFFSET ${offset}
`;

                    db.query(
                        locationsQuery,
                        [],
                        (locationErr, locations) => {

                            if (locationErr) {

                                console.error(
                                    'Child sitemap locations error:',
                                    locationErr
                                );

                                return res
                                    .status(500)
                                    .type('text/plain')
                                    .send(
                                        'Unable to generate sitemap'
                                    );
                            }

                            const frontendBase =
                                'https://www.cerood.com';

                            const urls = [];

// Static pages only in sitemap-1
if (page === 1) {
    // Common Cerood homepage and separate Home Services homepage.
    urls.push(
        `${frontendBase}/`
    );

    urls.push(
        `${frontendBase}/home-services.html`
    );

    urls.push(
        `${frontendBase}/about`
    );

    urls.push(
        `${frontendBase}/contact`
    );

    urls.push(
        `${frontendBase}/services`
    );

    urls.push(
        `${frontendBase}/faq`
    );
}

// District hub pages for every sitemap batch
{
    const districtHubSet = new Set();

    (locations || []).forEach(location => {

        const stateSlug =
            sitemapSlugify(location.state);

        const districtSlug =
            sitemapSlugify(location.district);

        if (!stateSlug || !districtSlug) {
            return;
        }

        districtHubSet.add(
            `${frontendBase}/${stateSlug}/${districtSlug}`
        );
    });

    districtHubSet.forEach(url => {
        urls.push(url);
    });
}

// Location hub pages for every sitemap batch
{

    const locationHubSet = new Set();

    (locations || []).forEach(location => {

        const stateSlug =
            sitemapSlugify(location.state);

        const districtSlug =
            sitemapSlugify(location.district);

        const locationSlug =
            sitemapSlugify(location.slug);

        if (
            !stateSlug ||
            !districtSlug ||
            !locationSlug
        ) {
            return;
        }

        // District HQ already has district hub URL
        if (locationSlug === districtSlug) {
            return;
        }

        locationHubSet.add(
            `${frontendBase}/${stateSlug}/${districtSlug}/location/${locationSlug}`
        );
    });

    locationHubSet.forEach(url => {
        urls.push(url);
    });
}

                            (locations || [])
                                .forEach(location => {

                                    const stateSlug =
                                        sitemapSlugify(
                                            location.state
                                        );

                                    const districtSlug =
                                        sitemapSlugify(
                                            location.district
                                        );

                                    const locationSlug =
                                        sitemapSlugify(
                                            location.slug
                                        );

                                    if (
                                        !stateSlug ||
                                        !districtSlug ||
                                        !locationSlug
                                    ) {
                                        return;
                                    }

                                    sitemapServices
                                        .forEach(service => {

                                            const seoUrl =
    districtSlug === locationSlug
        ? `${frontendBase}/${stateSlug}/${districtSlug}/${service.slug}`
        : `${frontendBase}/${stateSlug}/${districtSlug}/${locationSlug}/${service.slug}`;

urls.push(seoUrl);
                                        });
                                });

                            const xml =
                                `<?xml version="1.0" encoding="UTF-8"?>\n` +
                                `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
                                urls
                                    .map(url =>
                                        `  <url>\n` +
                                        `    <loc>${sitemapEscapeXml(url)}</loc>\n` +
                                        `  </url>`
                                    )
                                    .join('\n') +
                                `\n</urlset>`;

                            return res
                                .status(200)
                                .set(
                                    'Content-Type',
                                    'application/xml; charset=utf-8'
                                )
                                .send(xml);
                        }
                    );
                }
            );
        }
    );
});


// Root URL check
app.get('/', (req, res) => {
    res.send('Cerood Backend Server is running successfully!');
});

function createServiceSlug(serviceName) {
    return String(serviceName || '')
        .trim()
        .toLowerCase()
        .replace(/&/g, ' and ')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

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

    const slug = createServiceSlug(service_name);

if (!slug) {
    return res.status(400).json({
        success: false,
        error: 'Unable to create service slug.'
    });
}

    const query = `
        INSERT INTO services
        (
            service_id,
            service_name,
            slug,
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
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    db.query(query, [
        service_id,
        service_name,
        slug,
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
                message: 'Location not found in Cerood service database.'
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
            message: 'Multiple Cerood locations matched.',
            locations: results
        });
    });
});

// ==========================================
// SEO OLD NUMERIC URL -> SLUG 301 REDIRECT
// ==========================================
app.get(
    '/api/seo-redirect/:state/:district/:location/:serviceId',
    (req, res) => {

        const stateSlug = String(req.params.state || '')
            .trim()
            .toLowerCase();

        const districtSlug = String(req.params.district || '')
            .trim()
            .toLowerCase();

        const locationSlug = String(req.params.location || '')
            .trim()
            .toLowerCase();

        const serviceId = String(req.params.serviceId || '')
            .trim();

        if (
            !stateSlug ||
            !districtSlug ||
            !locationSlug ||
            !serviceId
        ) {
            return res.status(400).send('Invalid URL');
        }

        const query = `
            SELECT slug
            FROM public.services
            WHERE CAST(service_id AS TEXT) = ?
              AND slug IS NOT NULL
              AND TRIM(slug) <> ''
            LIMIT 1
        `;

        db.query(
            query,
            [serviceId],
            (err, results) => {

                if (err) {
                    console.error(
                        'SEO Redirect Error:',
                        err
                    );

                    return res
                        .status(500)
                        .send('Redirect lookup failed');
                }

                if (
                    !results ||
                    results.length === 0
                ) {
                    return res
                        .status(404)
                        .send('Service not found');
                }

                const serviceSlug =
                    String(results[0].slug || '')
                        .trim();

                const redirectUrl =
    districtSlug === locationSlug
        ? (
            `https://www.cerood.com/` +
            `${stateSlug}/` +
            `${districtSlug}/` +
            `${serviceSlug}`
        )
        : (
            `https://www.cerood.com/` +
            `${stateSlug}/` +
            `${districtSlug}/` +
            `${locationSlug}/` +
            `${serviceSlug}`
        );

                return res.redirect(
                    301,
                    redirectUrl
                );
            }
        );
    }
);

// ==========================================
// SEO LOCATION HUB API
// ==========================================

app.get('/api/seo-locations', (req, res) => {

    const query = `
        SELECT
            location_name,
            location_slug,
            district,
            state
        FROM public.seo_locations
        WHERE is_active = TRUE
          AND location_slug IS NOT NULL
          AND TRIM(location_slug) <> ''
        ORDER BY state, district, location_name
    `;

    db.query(query, [], (err, results) => {

        if (err) {
            console.error(
                'SEO Locations API Error:',
                err
            );

            return res.status(500).json({
                success: false,
                locations: []
            });
        }

        return res.json({
            success: true,
            locations: results || []
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

    const serviceIdentifier = String(req.params.service || '')
    .trim()
    .toLowerCase();

    if (
        !stateSlug ||
        !districtSlug ||
        !locationSlug ||
        !serviceIdentifier
    ) {
        return res.status(400).json({
            success: false,
            message:
                'State, district, location and service are required.'
        });
    }

    const query = `
        SELECT
    l.id AS location_id,
    l.location_name AS location_name,
    l.location_slug AS location_slug,
    l.district,
    l.state,
    NULL AS pincode,

    s.service_id,
            s.service_name,
            s.category,
            s.price AS service_price,
            s.mrp,
            s.is_hot_deal,
            s.select_options,
            s.enable_select_options,
            s.image_url,
            s.image_url_2,
            s.image_url_3,
            s.image_url_4,
            s.why_choose_us,
            s.discount_text,
            s.product_note,

            NULL AS location_price,
            TRUE AS is_available,
            (
    s.service_name ||
    ' in ' ||
    l.location_name ||
    ' | Cerood'
) AS seo_title,

(
    'Book ' ||
    LOWER(s.service_name) ||
    ' in ' ||
    l.location_name ||
    CASE
        WHEN LOWER(TRIM(l.location_name)) =
             LOWER(TRIM(l.district))
        THEN ''
        ELSE ', ' || l.district
    END ||
    ' with Cerood. Check technician availability and request doorstep service online.'
) AS seo_description,

NULL AS content

        FROM public.seo_locations l

        CROSS JOIN public.services s

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

            AND LOWER(TRIM(l.location_slug)) = ?

            AND (
    LOWER(TRIM(s.slug)) = ?
    OR CAST(s.service_id AS TEXT) = ?
)

            AND l.is_active = TRUE

        LIMIT 1
    `;

    db.query(
        query,
        [
    stateSlug,
    districtSlug,
    locationSlug,
    serviceIdentifier,
    serviceIdentifier
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
                        'Location or service not found.'
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

// ==========================================
// TEMPORARY SEO SITEMAP DATA CHECK
// ==========================================
app.get('/api/test-sitemap-data', (req, res) => {

    const query = `
        SELECT
            (SELECT COUNT(*) FROM public.locations) AS locations_count,
            (SELECT COUNT(*) FROM public.locations WHERE is_active = TRUE) AS active_locations_count,

            (SELECT COUNT(*) FROM public.services) AS services_count,
            (SELECT COUNT(*) FROM public.services WHERE slug IS NOT NULL AND TRIM(slug) <> '') AS services_with_slug_count,

            (SELECT COUNT(*) FROM public.location_services) AS location_services_count,
            (SELECT COUNT(*) FROM public.location_services WHERE is_available = TRUE) AS available_location_services_count,

            (
                SELECT COUNT(*)
                FROM public.locations l
                INNER JOIN public.location_services ls
                    ON ls.location_id = l.id
                INNER JOIN public.services s
                    ON s.service_id = ls.service_id
                WHERE l.is_active = TRUE
                  AND ls.is_available = TRUE
                  AND s.slug IS NOT NULL
                  AND TRIM(s.slug) <> ''
            ) AS sitemap_ready_rows
    `;

    db.query(query, [], (err, results) => {

        if (err) {
            console.error('Sitemap data test error:', err);

            return res.status(500).json({
                success: false,
                error: err.message
            });
        }

        return res.json({
            success: true,
            counts: results[0]
        });
    });
});

// ==========================================
// TEMPORARY SITEMAP SERVICE MATCH CHECK
// ==========================================
app.get('/api/test-sitemap-service-match', (req, res) => {

    const query = `
        SELECT
            ls.service_id,
            COUNT(*) AS mapping_count,
            s.service_name,
            s.slug
        FROM public.location_services ls
        LEFT JOIN public.services s
            ON s.service_id = ls.service_id
        WHERE ls.is_available = TRUE
        GROUP BY
            ls.service_id,
            s.service_name,
            s.slug
        ORDER BY mapping_count DESC
    `;

    db.query(query, [], (err, results) => {

        if (err) {
            console.error('Sitemap service match test error:', err);

            return res.status(500).json({
                success: false,
                error: err.message
            });
        }

        return res.json({
            success: true,
            services: results
        });
    });
});

// ==========================================
// TEMPORARY SERVICES ID CHECK
// ==========================================
app.get('/api/test-service-ids', (req, res) => {

    const query = `
        SELECT
            service_id,
            service_name,
            slug
        FROM public.services
        ORDER BY service_id
    `;

    db.query(query, [], (err, results) => {

        if (err) {
            return res.status(500).json({
                success: false,
                error: err.message
            });
        }

        return res.json({
            success: true,
            services: results || []
        });
    });
});

// ==========================================
// TEMPORARY LOCATION SERVICE SAMPLE CHECK
// ==========================================
app.get('/api/test-location-service-samples', (req, res) => {

    const query = `
        SELECT *
        FROM public.location_services
        ORDER BY location_id, service_id
        LIMIT 30
    `;

    db.query(query, [], (err, results) => {

        if (err) {
            return res.status(500).json({
                success: false,
                error: err.message
            });
        }

        return res.json({
            success: true,
            rows: results || []
        });
    });
});

// ==========================================
// TEMPORARY CUSTOM SERVICE ID IDENTIFIER
// ==========================================
app.get('/api/test-custom-service-identifiers', (req, res) => {

    const query = `
        SELECT
            service_id,
            MIN(price) AS min_price,
            MAX(price) AS max_price,
            COUNT(*) AS total_locations,
            COUNT(seo_title) AS seo_title_count,
            COUNT(seo_description) AS seo_description_count,
            COUNT(content) AS content_count,
            MIN(seo_title) AS sample_seo_title,
            MIN(seo_description) AS sample_seo_description
        FROM public.location_services
        GROUP BY service_id
        ORDER BY service_id
    `;

    db.query(query, [], (err, results) => {

        if (err) {
            return res.status(500).json({
                success: false,
                error: err.message
            });
        }

        return res.json({
            success: true,
            services: results || []
        });
    });
});

// ==========================================
// TEMPORARY LOCATION STRUCTURE CHECK
// ==========================================
app.get('/api/test-location-structure', (req, res) => {

    const query = `
        SELECT *
        FROM public.locations
        ORDER BY id
        LIMIT 10
    `;

    db.query(query, [], (err, results) => {

        if (err) {
            return res.status(500).json({
                success: false,
                error: err.message
            });
        }

        return res.json({
            success: true,
            rows: results || []
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
 

// PHASE 5F — ADMIN-ONLY DRAFT TEST PREVIEW (NO RAZORPAY CHARGE).
// Registered after /api/admin auth middleware; no draft data in public product APIs.
app.get('/api/admin/renewed/test-preview/:id', async (req,res) => {
    res.set('Cache-Control','no-store');
    try {
        const id = String(req.params.id || '');
        if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id))
            return res.status(400).json({success:false,message:'Invalid product ID.'});
        const rows = await new Promise((resolve,reject) => db.query(
            `SELECT id,name,price,stock,status,condition,warranty_days FROM public.renewed_products WHERE id=? LIMIT 1`,
            [id],(error,data)=>error?reject(error):resolve(data||[])));
        if (!rows.length) return res.status(404).json({success:false,message:'Product not found.'});
        const p=rows[0];
        return res.json({success:true,test_only:true,payment_created:false,reservation_created:false,
            product:{id:p.id,name:p.name,price:Number(p.price),stock:Number(p.stock),status:p.status,
                     condition:p.condition,warranty_days:Number(p.warranty_days)},
            message:'Admin preview only. No Razorpay order or payment is created.'});
    } catch(e) {console.error('Renewed admin test preview:',e.message);
        return res.status(503).json({success:false,message:'Test preview unavailable.'});}
});

// ==========================================
// CEROOD RENEWED STORE — PHASE 4
// Requires cerood_renewed_phase4.sql to be run in Supabase first.
// Admin routes inherit /api/admin authentication middleware above.
// ==========================================
const renewedQuery = (sql, params = []) => new Promise((resolve, reject) => {
    db.query(sql, params, (error, rows) => error ? reject(error) : resolve(rows || []));
});
const renewedAllowedCategories = new Set(['tv', 'refrigerator', 'washing-machine', 'ac', 'laptop', 'other']);
const renewedAllowedConditions = new Set(['Refurbished', 'Pre-owned', 'Open box']);
const renewedPublicFields = `id, name, category, condition, brand, model, price, compare_price,
 stock, warranty_days, location, delivery, image_url, video_url,
 known_defects, accessories, warranty_terms, status, created_at, updated_at`;
function renewedPublicProduct(row) {
    const p = { ...row };
    p.media = [p.image_url && {type:'image',url:p.image_url,alt:p.name},
               p.video_url && {type:'video',url:p.video_url}].filter(Boolean);
    p.warranty = Number(p.warranty_days) > 0 ? `${p.warranty_days} day(s)` : 'No warranty';
    p.condition_description = p.condition;
    p.inspection = [];
    p.accessories = String(p.accessories || '').split(/\r?\n|,/).map(s=>s.trim()).filter(Boolean);
    p.specifications = { Brand: p.brand || 'Not specified', Model: p.model || 'Not specified' };
    return p;
}
function renewedClean(body) {
    const text = (key, max) => String(body[key] ?? '').trim().slice(0, max);
    const num = key => Number(body[key]);
    const name = text('name',140), category = text('category',40), condition = text('condition',40);
    const price = num('price'), stock = num('stock'), warranty_days = num('warranty_days');
    const compare_price = body.compare_price === '' || body.compare_price == null ? null : num('compare_price');
    const status = text('status',20) || 'draft';
    if (!name || !renewedAllowedCategories.has(category) || !renewedAllowedConditions.has(condition) ||
        !Number.isSafeInteger(price) || price < 1 || price > 100000000 ||
        !Number.isSafeInteger(stock) || stock < 0 || stock > 99999 ||
        !Number.isSafeInteger(warranty_days) || warranty_days < 0 || warranty_days > 3650 ||
        (compare_price !== null && (!Number.isSafeInteger(compare_price) || compare_price < 0)) ||
        !['draft','published'].includes(status)) throw Object.assign(new Error('Invalid product fields, price, stock, warranty or status.'),{status:400});
    const image_url = text('image_url',2048), video_url = text('video_url',2048);
    for (const url of [image_url,video_url]) {
        if (url && (!/^https:\/\//i.test(url) || !URL.canParse(url))) throw Object.assign(new Error('Use valid HTTPS media URLs.'),{status:400});
    }
    if (status === 'published' && (!image_url || !text('known_defects',2000) || !text('warranty_terms',1500)))
        throw Object.assign(new Error('Publish requires actual photo URL, condition/defects and warranty terms.'),{status:400});
    return {name,category,condition,brand:text('brand',80),model:text('model',80),price,compare_price,stock,warranty_days,
        location:text('location',100),delivery:text('delivery',160),image_url,video_url,
        known_defects:text('known_defects',2000),accessories:text('accessories',1000),
        warranty_terms:text('warranty_terms',1500),status};
}
function renewedError(res,error) {
    console.error('Renewed Store:',error.message);
    res.status(error.status || 500).json({success:false,message:error.status ? error.message : 'Renewed Store database request failed.'});
}
app.get('/api/renewed/products', async (req,res) => {
    try {
        const rows = await renewedQuery(`SELECT ${renewedPublicFields} FROM public.renewed_products WHERE status = 'published' AND (seller_id IS NULL OR approval_status = 'approved') ORDER BY created_at DESC LIMIT 250`);
        res.json({success:true,products:rows.map(renewedPublicProduct)});
    } catch(error) { renewedError(res,error); }
});
app.get('/api/renewed/products/:id', async (req,res) => {
    try {
        if(!/^[a-zA-Z0-9_-]{1,80}$/.test(req.params.id)) return res.status(400).json({success:false,message:'Invalid product ID.'});
        const rows = await renewedQuery(`SELECT ${renewedPublicFields} FROM public.renewed_products WHERE id = ? AND status = 'published' AND (seller_id IS NULL OR approval_status = 'approved') LIMIT 1`,[req.params.id]);
        if(!rows.length) return res.status(404).json({success:false,message:'Product not found.'});
        res.json({success:true,product:renewedPublicProduct(rows[0])});
    } catch(error) { renewedError(res,error); }
});
app.get('/api/admin/renewed/products', async (req,res) => {
    try {
        const rows = await renewedQuery(`SELECT ${renewedPublicFields} FROM public.renewed_products ORDER BY updated_at DESC LIMIT 500`);
        res.json({success:true,products:rows});
    } catch(error) { renewedError(res,error); }
});
app.post('/api/admin/renewed/products', async (req,res) => {
    try {
        const p = renewedClean(req.body || {}), id = crypto.randomUUID();
        const fields = Object.keys(p);
        const rows = await renewedQuery(`INSERT INTO public.renewed_products (id, ${fields.join(', ')}) VALUES (?, ${fields.map(()=>'?').join(', ')}) RETURNING ${renewedPublicFields}`,[id,...Object.values(p)]);
        res.status(201).json({success:true,product:rows[0]});
    } catch(error) { renewedError(res,error); }
});
app.put('/api/admin/renewed/products/:id', async (req,res) => {
    try {
        if(!/^[a-zA-Z0-9_-]{1,80}$/.test(req.params.id)) return res.status(400).json({success:false,message:'Invalid ID.'});
        const p = renewedClean(req.body || {}), fields = Object.keys(p);
        const rows = await renewedQuery(`UPDATE public.renewed_products SET ${fields.map(f=>`${f} = ?`).join(', ')}, updated_at = NOW() WHERE id = ? RETURNING ${renewedPublicFields}`,[...Object.values(p),req.params.id]);
        if(!rows.length) return res.status(404).json({success:false,message:'Product not found.'});
        res.json({success:true,product:rows[0]});
    } catch(error) { renewedError(res,error); }
});
app.delete('/api/admin/renewed/products/:id', async (req,res) => {
    try {
        if(!/^[a-zA-Z0-9_-]{1,80}$/.test(req.params.id)) return res.status(400).json({success:false,message:'Invalid ID.'});
        const rows = await renewedQuery('DELETE FROM public.renewed_products WHERE id = ? RETURNING id',[req.params.id]);
        if(!rows.length) return res.status(404).json({success:false,message:'Product not found.'});
        res.json({success:true,deleted_id:rows[0].id});
    } catch(error) { renewedError(res,error); }
});
// ==========================================
// CEROOD RENEWED — PHASE 5A: SERVER-VERIFIED PRICE QUOTE
// Does NOT create orders, reserve stock, or accept payments yet.
// ==========================================
app.post('/api/renewed/quote', async (req, res) => {
    try {
        const items = req.body && req.body.items;
        if (!Array.isArray(items) || items.length < 1 || items.length > 20) {
            return res.status(400).json({success:false,message:'Provide 1–20 product items.'});
        }
        const quantities = new Map();
        for (const item of items) {
            const id = String(item && item.product_id || '').trim();
            const quantity = Number(item && item.quantity);
            if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id) || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 99) {
                return res.status(400).json({success:false,message:'Invalid product ID or quantity.'});
            }
            const combined = (quantities.get(id) || 0) + quantity;
            if (combined > 99) return res.status(400).json({success:false,message:'Quantity limit exceeded.'});
            quantities.set(id, combined);
        }
        const ids = [...quantities.keys()];
        const placeholders = ids.map(() => '?').join(',');
        const rows = await renewedQuery(
            `SELECT id, name, price, stock, status, image_url, condition, warranty_days
             FROM public.renewed_products WHERE id IN (${placeholders})`, ids
        );
        const byId = new Map(rows.map(row => [row.id, row]));
        let subtotal = 0;
        const quoteItems = [];
        for (const id of ids) {
            const p = byId.get(id), quantity = quantities.get(id);
            if (!p || p.status !== 'published' || p.stock < quantity) {
                return res.status(409).json({success:false,message:'A product is unavailable or has insufficient stock.',product_id:id});
            }
            const unitPrice = Number(p.price);
            if (!Number.isSafeInteger(unitPrice) || unitPrice < 1) throw Error('Invalid stored price');
            const lineTotal = unitPrice * quantity;
            subtotal += lineTotal;
            if (!Number.isSafeInteger(subtotal)) throw Error('Quote amount overflow');
            quoteItems.push({product_id:id,name:p.name,quantity,unit_price:unitPrice,line_total:lineTotal,
                image_url:p.image_url,condition:p.condition,warranty_days:p.warranty_days});
        }
        return res.json({success:true,currency:'INR',items:quoteItems,subtotal,
            delivery_fee:null,total:null,checkout_enabled:false,
            message:'Price quote only. Delivery fee and payment will be enabled after secure stock reservation integration.'});
    } catch (error) {
        return renewedError(res,error);
    }
});


// ==========================================
// CEROOD RENEWED — PHASE 5E: DESTINATION DISTRICT DELIVERY QUOTE
// Price and stock rechecked server-side. No order, reservation or payment.
// Admin must explicitly activate a verified rate for each district.
// ==========================================
app.post('/api/renewed/delivery-quote', async (req,res) => {
    try {
        const items = req.body && req.body.items;
        const address = req.body && req.body.address;
        if (!Array.isArray(items) || items.length < 1 || items.length > 20 || !address || typeof address !== 'object' || Array.isArray(address))
            return res.status(400).json({success:false,message:'Items and delivery address are required.'});
        const state = String(address.state || '').trim().replace(/\s+/g,' ').toLowerCase();
        const district = String(address.district || '').trim().replace(/\s+/g,' ').toLowerCase();
        const pincode = String(address.pincode || '').trim();
        if (!['tamil nadu','tamilnadu','tn'].includes(state) || !/^[a-z][a-z .'-]{1,99}$/.test(district) || !/^\d{6}$/.test(pincode))
            return res.status(400).json({success:false,message:'Enter a valid Tamil Nadu district and six-digit pincode.'});
        // TN PIN prefixes are a preliminary input check, not a deliverability guarantee.
        if (!/^[56]\d{5}$/.test(pincode))
            return res.status(400).json({success:false,message:'Enter a Tamil Nadu pincode.'});
        const quantities = new Map();
        for (const item of items) {
            const id = String(item && item.product_id || '').trim();
            const qty = Number(item && item.quantity);
            if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id) || !Number.isSafeInteger(qty) || qty < 1 || qty > 99)
                return res.status(400).json({success:false,message:'Invalid product or quantity.'});
            const combined = (quantities.get(id) || 0) + qty;
            if (combined > 99) return res.status(400).json({success:false,message:'Quantity limit exceeded.'});
            quantities.set(id,combined);
        }
        const ids = [...quantities.keys()];
        const rows = await renewedQuery(`SELECT id,price,stock,status FROM public.renewed_products WHERE id IN (${ids.map(()=>'?').join(',')})`,ids);
        const byId = new Map(rows.map(p=>[p.id,p]));
        let subtotal = 0;
        for (const id of ids) {
            const p = byId.get(id),qty = quantities.get(id);
            if (!p || p.status !== 'published' || Number(p.stock) < qty)
                return res.status(409).json({success:false,message:'A product is unavailable or has insufficient stock.'});
            subtotal += Number(p.price)*qty;
            if (!Number.isSafeInteger(subtotal) || subtotal < 1)
                throw new Error('Invalid stored quote price.');
        }
        const rates = await renewedQuery(`SELECT fee FROM public.renewed_delivery_rates WHERE LOWER(TRIM(district)) = ? AND active = TRUE AND fee IS NOT NULL LIMIT 1`,[district]);
        if (!rates.length) return res.json({success:true,currency:'INR',district,pincode,subtotal,delivery_fee:null,total:null,
            delivery_status:'pending',checkout_enabled:false,message:'Tamil Nadu delivery requested. Cerood has not configured/confirmed a delivery rate for this district.'});
        const fee = Number(rates[0].fee);
        if (!Number.isSafeInteger(fee) || fee < 0 || !Number.isSafeInteger(subtotal+fee)) throw new Error('Invalid delivery amount.');
        return res.json({success:true,currency:'INR',district,pincode,subtotal,delivery_fee:fee,total:subtotal+fee,
            delivery_status:'rate_configured',checkout_enabled:false,
            message:'Estimated total only. Final delivery availability and amount must be reconfirmed before payment.'});
    } catch(e) { renewedError(res,e); }
});

// ==========================================
// CEROOD RENEWED — PHASE 5F STEP 2: VERIFIED CUSTOMER PRICE CHECK
// No order, stock reservation or Razorpay charge is created here.
// MSG91 token must be freshly verified by MSG91, not trusted from localStorage.
// ==========================================
app.post('/api/renewed/secure-quote', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
        const accessToken = String(req.body?.accessToken || '').trim();
        if (!accessToken || accessToken.length > 8192) {
            return res.status(401).json({success:false,message:'Verified customer OTP access token is required.'});
        }
        let verifiedPhone;
        try {
            const verification = await verifyMsg91AccessToken(accessToken);
            if (String(verification?.type || '').toLowerCase() !== 'success') {
                return res.status(401).json({success:false,message:'Customer OTP verification failed.'});
            }
            verifiedPhone = extractVerifiedPhoneFromMsg91(verification, accessToken);
        } catch (e) {
            console.error('Renewed customer verification failed:', e.message);
            return res.status(401).json({success:false,message:'Customer OTP verification failed.'});
        }
        if (!/^[6-9]\d{9}$/.test(verifiedPhone || '')) {
            return res.status(401).json({success:false,message:'Verified mobile number is unavailable.'});
        }
        const users = await renewedQuery('SELECT id FROM public.users WHERE phone = ? LIMIT 1',[verifiedPhone]);
        if (!users.length) return res.status(401).json({success:false,message:'Register or login before checkout.'});
        const address = req.body?.address;
        const items = req.body?.items;
        if (!address || typeof address !== 'object' || Array.isArray(address) ||
            !Array.isArray(items) || items.length < 1 || items.length > 20) {
            return res.status(400).json({success:false,message:'Delivery address and 1–20 items are required.'});
        }
        const state = String(address.state || '').trim().replace(/\s+/g,' ').toLowerCase();
        const district = String(address.district || '').trim().replace(/\s+/g,' ').toLowerCase();
        const pincode = String(address.pincode || '').trim();
        const fullName = String(address.full_name || address.name || '').trim();
        const street = String(address.street || address.address || '').trim();
        const city = String(address.city || '').trim();
        if (!['tamil nadu','tamilnadu','tn'].includes(state) ||
            !/^[a-z][a-z .'-]{1,99}$/.test(district) || !/^[56]\d{5}$/.test(pincode) ||
            fullName.length < 2 || fullName.length > 140 || street.length < 5 || street.length > 500 ||
            city.length < 2 || city.length > 100) {
            return res.status(400).json({success:false,message:'Enter a complete Tamil Nadu delivery address.'});
        }
        const quantities = new Map();
        for (const item of items) {
            const id = String(item?.product_id || '').trim();
            const qty = Number(item?.quantity);
            if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id) || !Number.isSafeInteger(qty) || qty < 1 || qty > 99) {
                return res.status(400).json({success:false,message:'Invalid product ID or quantity.'});
            }
            const sum = (quantities.get(id) || 0) + qty;
            if (sum > 99) return res.status(400).json({success:false,message:'Quantity limit exceeded.'});
            quantities.set(id,sum);
        }
        const ids = [...quantities.keys()];
        const products = await renewedQuery(
            `SELECT id,name,price,stock,status,warranty_days FROM public.renewed_products WHERE id IN (${ids.map(()=>'?').join(',')})`,ids);
        const byId = new Map(products.map(p=>[String(p.id),p]));
        let subtotal = 0;
        const quoteItems = [];
        for (const id of ids) {
            const p = byId.get(id), qty = quantities.get(id);
            if (!p || p.status !== 'published' || Number(p.stock) < qty) {
                return res.status(409).json({success:false,message:'Product unavailable or insufficient stock.'});
            }
            const unit = Number(p.price), line = unit * qty;
            if (!Number.isSafeInteger(unit) || unit < 1 || !Number.isSafeInteger(line)) throw Error('Invalid product price.');
            subtotal += line;
            if (!Number.isSafeInteger(subtotal)) throw Error('Amount overflow.');
            quoteItems.push({product_id:id,name:p.name,quantity:qty,unit_price:unit,line_total:line});
        }
        const rates = await renewedQuery(
            'SELECT fee FROM public.renewed_delivery_rates WHERE LOWER(TRIM(district)) = ? AND active = TRUE AND fee IS NOT NULL LIMIT 1',
            [district]);
        if (!rates.length) return res.status(409).json({success:false,message:'Delivery rate not configured for this district.'});
        const fee = Number(rates[0].fee), total = subtotal + fee;
        if (!Number.isSafeInteger(fee) || fee < 0 || !Number.isSafeInteger(total) || total < 1) throw Error('Invalid delivery amount.');
        return res.json({success:true,currency:'INR',items:quoteItems,subtotal,delivery_fee:fee,total,
            district,pincode,customer_verified:true,checkout_enabled:false,payment_enabled:false,
            message:'Verified quote only. No order, reservation or payment created.'});
    } catch (e) { return renewedError(res,e); }
});

// ==========================================
// CEROOD RENEWED — PHASE 5B: ATOMIC STOCK RESERVATION
// Not customer-facing yet. Enable only after login/payment workflow is ready.
// ==========================================
const RENEWED_RESERVE_LOCK = 51029019;
const RENEWED_RESERVE_MINUTES = 15;

// Lock + release is performed in one transaction, serializing reserve/release.
// Payment finalization is idempotent and must run under the global advisory lock.
async function renewedFinalizePayment(client, orderId, razorpayOrderId, paymentId) {
    const rows = await client.query(
        `SELECT id,status,total,razorpay_order_id,razorpay_payment_id FROM public.renewed_orders
         WHERE id=$1 FOR UPDATE`,[orderId]);
    const order = rows[0];
    if (!order || order.razorpay_order_id !== razorpayOrderId) return 'mismatch';
    if (order.status === 'paid') return order.razorpay_payment_id === paymentId ? 'paid' : 'mismatch';
    if (!['pending_payment','creating_order'].includes(order.status)) {
        // Expired/cancelled stock may already be sold: never silently mark fulfilled.
        await client.query(`UPDATE public.renewed_orders SET status='payment_review',
          razorpay_payment_id=$2,updated_at=NOW() WHERE id=$1 AND status <> 'paid'`,[orderId,paymentId]);
        return 'payment_review';
    }
    await client.query(`UPDATE public.renewed_orders SET status='paid',
      razorpay_payment_id=$2,paid_at=NOW(),updated_at=NOW() WHERE id=$1`,[orderId,paymentId]);
    return 'paid';
}
async function renewedVerifyAndFinalize(razorpayOrderId,paymentId) {
    const rows = await renewedQuery(`SELECT id,total FROM public.renewed_orders
      WHERE razorpay_order_id=? LIMIT 1`,[razorpayOrderId]);
    if (!rows.length) return 'not_found';
    const payment = await razorpayInstance.payments.fetch(paymentId);
    if (payment.order_id !== razorpayOrderId || payment.currency !== 'INR' ||
        Number(payment.amount) !== Number(rows[0].total)*100 || payment.status !== 'captured')
        return 'not_captured';
    const client = await db.getClient();
    try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock($1)',[RENEWED_RESERVE_LOCK]);
        const outcome = await renewedFinalizePayment(client,rows[0].id,razorpayOrderId,paymentId);
        await client.query('COMMIT');
        return outcome;
    } catch(e) {await client.query('ROLLBACK').catch(()=>{});throw e;}
    finally {client.release();}
}

async function renewedReleaseExpired(client) {
    // IMPORTANT: No Razorpay HTTP calls while holding the DB transaction/advisory lock.
    // A Razorpay order can receive a late capture even after the local reservation deadline.
    // Fail closed: only reservations that NEVER received a Razorpay order can be
    // automatically released. Reservations with a Razorpay order require payment
    // reconciliation before stock is returned; they remain pending and unavailable.
    const expired = await client.query(`
        SELECT id FROM public.renewed_orders
        WHERE status = 'pending_payment'
          AND reserved_until <= NOW()
          AND razorpay_order_id IS NULL
        ORDER BY id FOR UPDATE
    `);
    if (!expired.length) return 0;
    const ids = expired.map(row => row.id);
    const changed = await client.query(`
        UPDATE public.renewed_orders SET status = 'expired', updated_at = NOW()
        WHERE id = ANY($1::uuid[])
          AND status = 'pending_payment'
          AND razorpay_order_id IS NULL
        RETURNING id
    `,[ids]);
    const releasedIds = changed.map(row => row.id);
    if (!releasedIds.length) return 0;
    await client.query(`
        UPDATE public.renewed_products p
        SET stock = p.stock + r.qty, updated_at = NOW()
        FROM (
          SELECT product_id, SUM(quantity)::integer AS qty
          FROM public.renewed_order_items
          WHERE order_id = ANY($1::uuid[])
          GROUP BY product_id
        ) r
        WHERE p.id = r.product_id
    `,[releasedIds]);
    return releasedIds.length;
}

async function renewedRunExpiry() {
    const client = await db.getClient();
    try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock($1)', [RENEWED_RESERVE_LOCK]);
        const count = await renewedReleaseExpired(client);
        await client.query('COMMIT');
        return count;
    } catch(e) {
        await client.query('ROLLBACK').catch(()=>{});
        throw e;
    } finally { client.release(); }
}

// ==========================================
// CEROOD RENEWED — PHASE 5F STEP 3 (STAGED)
// Atomic stock reservation + Razorpay order creation.
// HARD DISABLED until payment verification, webhook and reconciliation ship.
// Do not remove this gate or expose the route in production yet.
// ==========================================
// RENEWED CASH ON DELIVERY: atomic stock decrement + order creation.
// Independent from Razorpay; only enabled by explicit environment switch.
app.post('/api/renewed/place-cod-order', async (req,res)=>{
    res.set('Cache-Control','no-store');
    if(process.env.RENEWED_COD_ENABLED !== 'true')
        return res.status(503).json({success:false,message:'Cash on delivery is not enabled by Cerood yet.'});
    let client;
    try{
        // Guest checkout is an explicit deployment choice; existing OTP flow remains when disabled.
        const guestCheckout = process.env.RENEWED_GUEST_CHECKOUT_ENABLED === 'true';
        let phone = String(req.body?.address?.phone || '').trim();
        if (!guestCheckout) {
            const token=String(req.body?.accessToken||'').trim();
            if(!token||token.length>8192)return res.status(401).json({success:false,message:'Verify mobile before ordering.'});
            const verified=await verifyMsg91AccessToken(token);
            if(String(verified?.type||'').toLowerCase()!=='success')return res.status(401).json({success:false,message:'Mobile OTP verification expired.'});
            phone=extractVerifiedPhoneFromMsg91(verified,token);
        }
        if(!/^[6-9]\d{9}$/.test(phone||''))return res.status(400).json({success:false,message:'Valid mobile number required.'});
        const requestId=String(req.body?.request_id||'').trim();
        if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId))
            return res.status(400).json({success:false,message:'Invalid order request ID.'});
        const address=req.body?.address, items=req.body?.items;
        if(!address||typeof address!=='object'||Array.isArray(address)||!Array.isArray(items)||items.length<1||items.length>20)
            return res.status(400).json({success:false,message:'Address and 1–20 products required.'});
        const state=String(address.state||'').trim().replace(/\s+/g,' ').toLowerCase();
        const district=String(address.district||'').trim().replace(/\s+/g,' ').toLowerCase();
        const pincode=String(address.pincode||'').trim();
        const fullName=String(address.full_name||'').trim();
        const street=String(address.street||'').trim();
        const city=String(address.city||'').trim();
        if(!['tamil nadu','tamilnadu','tn'].includes(state)||!/^[a-z][a-z .'-]{1,99}$/.test(district)||
           !/^[56]\d{5}$/.test(pincode)||fullName.length<2||fullName.length>140||
           street.length<5||street.length>500||city.length<2||city.length>100||
           String(address.phone||'').trim()!==phone)
            return res.status(400).json({success:false,message:'Complete Tamil Nadu address and verified mobile are required.'});
        const quantities=new Map();
        for(const item of items){
            const id=String(item?.product_id||'').trim(),qty=Number(item?.quantity);
            if(!/^[a-zA-Z0-9_-]{1,80}$/.test(id)||!Number.isSafeInteger(qty)||qty<1||qty>99)
                return res.status(400).json({success:false,message:'Invalid product or quantity.'});
            const sum=(quantities.get(id)||0)+qty;
            if(sum>99)return res.status(400).json({success:false,message:'Quantity limit exceeded.'});
            quantities.set(id,sum);
        }
        const ids=[...quantities.keys()].sort();
        client=await db.getClient();
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock($1)',[RENEWED_RESERVE_LOCK]);
        const duplicate=await client.query(`SELECT id,total,customer_phone FROM public.renewed_orders
          WHERE cod_request_id=$1 LIMIT 1`,[requestId]);
        if(duplicate.length){
            if(duplicate[0].customer_phone!==phone){await client.query('ROLLBACK');return res.status(409).json({success:false,message:'Order request conflict.'});}
            await client.query('COMMIT');return res.json({success:true,order_id:duplicate[0].id,total:Number(duplicate[0].total),payment_method:'cod',already_created:true});
        }
        const users=guestCheckout?[]:await client.query('SELECT id,email FROM public.users WHERE phone=$1 LIMIT 1',[phone]);
        if(!guestCheckout&&!users.length){await client.query('ROLLBACK');return res.status(401).json({success:false,message:'Register or login before checkout.'});}
        const products=await client.query(
  `SELECT id,name,price,stock,status,warranty_days,seller_id
   FROM public.renewed_products
   WHERE id=ANY($1::text[])
   ORDER BY id
   FOR UPDATE`,
  [ids]
);
        const byId=new Map(products.map(p=>[String(p.id),p]));
        let subtotal=0;const orderItems=[];
        for(const id of ids){
            const p=byId.get(id),qty=quantities.get(id);
            if(!p||p.status!=='published'||Number(p.stock)<qty){const e=Error('Product unavailable or sold out.');e.status=409;throw e;}
            const unit=Number(p.price),line=unit*qty;subtotal+=line;
            if(!Number.isSafeInteger(unit)||unit<1||!Number.isSafeInteger(line)||!Number.isSafeInteger(subtotal))throw Error('Invalid price.');
            orderItems.push({
    id,
    name: p.name,
    qty,
    unit,
    line,
    warranty_days: Number(p.warranty_days || 0),
    seller_id: p.seller_id || null
});
        }
        const rates=await client.query(`SELECT fee FROM public.renewed_delivery_rates
          WHERE LOWER(TRIM(district))=$1 AND active=TRUE AND fee IS NOT NULL LIMIT 1`,[district]);
        if(!rates.length){const e=Error('Delivery rate unavailable for this district.');e.status=409;throw e;}
        const fee=Number(rates[0].fee),total=subtotal+fee;
        if(!Number.isSafeInteger(fee)||fee<0||!Number.isSafeInteger(total)||total<1||total>10000000)throw Error('Invalid order total.');
        const id=crypto.randomUUID();
        const savedAddress={full_name:fullName,street,area:String(address.area||'').trim().slice(0,200),
          city,district,state:'Tamil Nadu',pincode};
        await client.query(`INSERT INTO public.renewed_orders
          (id,customer_id,customer_name,customer_phone,customer_email,delivery_address,
           subtotal,delivery_fee,total,currency,status,delivery_status,payment_method,cod_request_id)
          VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,'INR','processing','confirmed','cod',$10)`,
          [id,guestCheckout?null:String(users[0].id),fullName,phone,guestCheckout?null:(users[0].email||null),JSON.stringify(savedAddress),subtotal,fee,total,requestId]);
        for(const item of orderItems){
            const reduced=await client.query(`UPDATE public.renewed_products SET stock=stock-$1,updated_at=NOW()
              WHERE id=$2 AND status='published' AND stock >= $1 RETURNING id`,[item.qty,item.id]);
            if(!reduced.length){const e=Error('Product sold out.');e.status=409;throw e;}
            await client.query(
    `INSERT INTO public.renewed_order_items
    (
        order_id,
        product_id,
        product_name,
        unit_price,
        quantity,
        line_total,
        warranty_days_at_purchase,
        seller_id
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
        id,
        item.id,
        item.name,
        item.unit,
        item.qty,
        item.line,
        item.warranty_days,
        item.seller_id
    ]
);
        }
        await client.query('COMMIT');
        return res.status(201).json({success:true,order_id:id,total,payment_method:'cod',payment_due:total,
          message:'COD order confirmed. Pay on delivery.'});
    }catch(e){if(client)await client.query('ROLLBACK').catch(()=>{});
        console.error('Renewed COD order:',e.message);
        return res.status(e.status||503).json({success:false,message:e.status?e.message:'Could not place COD order. Please retry with the same request.'});
    }finally{if(client)client.release();}
});

app.post('/api/renewed/prepare-payment', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const RENEWED_PAYMENT_FLOW_READY = process.env.RENEWED_LIVE_CHECKOUT_ENABLED === 'true' && Boolean(process.env.RENEWED_RAZORPAY_WEBHOOK_SECRET && process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);
    if (!RENEWED_PAYMENT_FLOW_READY) {
        return res.status(503).json({success:false,
            message:'Renewed payment preparation is disabled. Configure webhook and explicitly enable Renewed checkout after testing.'});
    }

    let client;
    let committedOrderId = null;
    try {
        const guestCheckout = process.env.RENEWED_GUEST_CHECKOUT_ENABLED === 'true';
        let verifiedPhone = String(req.body?.address?.phone || '').trim();
        let users = [];
        if (!guestCheckout) {
            const accessToken = String(req.body?.accessToken || '').trim();
            if (!accessToken || accessToken.length > 8192)
                return res.status(401).json({success:false,message:'Customer OTP verification required.'});
            try {
                const verification = await verifyMsg91AccessToken(accessToken);
                if (String(verification?.type || '').toLowerCase() !== 'success')
                    return res.status(401).json({success:false,message:'Customer OTP verification failed.'});
                verifiedPhone = extractVerifiedPhoneFromMsg91(verification, accessToken);
            } catch (_) { return res.status(401).json({success:false,message:'Customer OTP verification failed.'}); }
            users = await renewedQuery('SELECT id, name, email FROM public.users WHERE phone = ? LIMIT 1', [verifiedPhone]);
            if (!users.length) return res.status(401).json({success:false,message:'Register before checkout.'});
        }
        if (!/^[6-9]\d{9}$/.test(verifiedPhone || ''))
            return res.status(400).json({success:false,message:'Valid mobile number required.'});
        const address = req.body?.address;
        const items = req.body?.items;
        if (!address || typeof address !== 'object' || Array.isArray(address) ||
            !Array.isArray(items) || items.length < 1 || items.length > 20)
            return res.status(400).json({success:false,message:'Address and 1–20 items required.'});
        const state = String(address.state || '').trim().replace(/\s+/g,' ').toLowerCase();
        const district = String(address.district || '').trim().replace(/\s+/g,' ').toLowerCase();
        const pincode = String(address.pincode || '').trim();
        const fullName = String(address.full_name || address.name || '').trim();
        const street = String(address.street || address.address || '').trim();
        const city = String(address.city || '').trim();
        if (!['tamil nadu','tamilnadu','tn'].includes(state) ||
            !/^[a-z][a-z .'-]{1,99}$/.test(district) || !/^[56]\d{5}$/.test(pincode) ||
            fullName.length < 2 || fullName.length > 140 ||
            street.length < 5 || street.length > 500 || city.length < 2 || city.length > 100)
            return res.status(400).json({success:false,message:'Complete Tamil Nadu delivery address required.'});
        const quantities = new Map();
        for (const item of items) {
            const id = String(item?.product_id || '').trim();
            const qty = Number(item?.quantity);
            if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id) || !Number.isSafeInteger(qty) || qty < 1 || qty > 99)
                return res.status(400).json({success:false,message:'Invalid item.'});
            const sum = (quantities.get(id) || 0) + qty;
            if (sum > 99) return res.status(400).json({success:false,message:'Quantity limit exceeded.'});
            quantities.set(id,sum);
        }
        const sortedIds = [...quantities.keys()].sort();
        client = await db.getClient();
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock($1)', [RENEWED_RESERVE_LOCK]);
        await renewedReleaseExpired(client);
        const products = await client.query(
    `SELECT id,name,price,stock,status,warranty_days,seller_id
     FROM public.renewed_products
     WHERE id = ANY($1::text[])
     ORDER BY id
     FOR UPDATE`,
    [sortedIds]
);
        const byId = new Map(products.map(p => [String(p.id),p]));
        let subtotal = 0;
        const orderItems = [];
        for (const id of sortedIds) {
            const p = byId.get(id), qty = quantities.get(id);
            if (!p || p.status !== 'published' || Number(p.stock) < qty) {
                const e = new Error('Product unavailable or insufficient stock.'); e.status = 409; throw e;
            }
            const unit = Number(p.price), line = unit * qty;
            if (!Number.isSafeInteger(unit) || unit < 1 || !Number.isSafeInteger(line)) throw Error('Invalid product price.');
            subtotal += line;
            if (!Number.isSafeInteger(subtotal)) throw Error('Amount overflow.');
            orderItems.push({
    id,
    name: p.name,
    qty,
    unit,
    line,
    warranty_days: Number(p.warranty_days || 0),
    seller_id: p.seller_id || null
});
        }
        const rates = await client.query(
            `SELECT fee FROM public.renewed_delivery_rates
             WHERE LOWER(TRIM(district)) = $1 AND active = TRUE AND fee IS NOT NULL LIMIT 1`,[district]);
        if (!rates.length) {const e=new Error('Delivery rate not configured.');e.status=409;throw e;}
        const fee = Number(rates[0].fee), total = subtotal + fee;
        if (!Number.isSafeInteger(fee) || fee < 0 || !Number.isSafeInteger(total) ||
            total < 1 || total > 10000000) throw Error('Invalid payment amount.');
        const orderId = crypto.randomUUID();
        const savedAddress = {
            full_name:fullName,street,city,district,state:'Tamil Nadu',pincode,
            area:String(address.area || '').trim().slice(0,200)
        };
        await client.query(
            `INSERT INTO public.renewed_orders
             (id,customer_id,customer_name,customer_phone,customer_email,delivery_address,
              subtotal,delivery_fee,total,currency,status,reserved_until)
             VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,'INR','creating_order',
        NOW() + INTERVAL '15 minutes')`,
            [orderId,guestCheckout?null:String(users[0].id),fullName,verifiedPhone,guestCheckout?null:(users[0].email || null),
             JSON.stringify(savedAddress),subtotal,fee,total]);
        for (const item of orderItems) {
            const reduced = await client.query(
                `UPDATE public.renewed_products SET stock = stock - $1,updated_at = NOW()
                 WHERE id = $2 AND status = 'published' AND stock >= $1 RETURNING id`,
                [item.qty,item.id]);
            if (!reduced.length) {const e=new Error('Product sold out.');e.status=409;throw e;}
            await client.query(
    `INSERT INTO public.renewed_order_items
    (
        order_id,
        product_id,
        product_name,
        unit_price,
        quantity,
        line_total,
        warranty_days_at_purchase,
        seller_id
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
        orderId,
        item.id,
        item.name,
        item.unit,
        item.qty,
        item.line,
        item.warranty_days,
        item.seller_id
    ]
);
        }
        await client.query('COMMIT');
        client.release(); client = null;
        committedOrderId = orderId;

        // Network call is OUTSIDE the DB transaction; ambiguous failures require review, never blind stock release.
        const razorpayOrder = await razorpayInstance.orders.create({
            amount:total * 100,currency:'INR',receipt:`renewed_${orderId.slice(0,24)}`,
            notes:{renewed_order_id:orderId}
        });
        const updated = await renewedQuery(
    `UPDATE public.renewed_orders
     SET razorpay_order_id = ?,
         status = 'pending_payment',
         updated_at = NOW()
     WHERE id = ?
       AND status = 'creating_order'
       AND razorpay_order_id IS NULL
     RETURNING id,reserved_until`,
    [razorpayOrder.id,orderId]);
        if (!updated.length) {
            // External order exists; do not release inventory or offer another payment.
            console.error('RENEWED_ORDER_LINK_REVIEW:', orderId, razorpayOrder.id);
            return res.status(503).json({success:false,message:'Payment preparation needs support review. Do not retry payment.'});
        }
        if (new Date(updated[0].reserved_until).getTime() <= Date.now()) {
            // Keep the Razorpay link for reconciliation, but never offer expired checkout.
            return res.status(409).json({success:false,message:'Reservation timed out. Contact support before retrying.'});
        }
        // Read-only, order-scoped guest recovery capability; never use the order ID as authentication.
        const recoverySecret = crypto.createHash('sha256')
            .update('cerood-renewed-recovery-v1:' + process.env.RAZORPAY_KEY_SECRET).digest();
        const recoveryToken = jwt.sign({order_id:orderId,razorpay_order_id:razorpayOrder.id,
            scope:'renewed_payment_status'},recoverySecret,
            {algorithm:'HS256',expiresIn:'30d',issuer:'cerood-renewed-recovery'});
        return res.json({success:true,order_id:orderId,razorpay_order_id:razorpayOrder.id,
            amount:razorpayOrder.amount,currency:'INR',key_id:process.env.RAZORPAY_KEY_ID,
            reserved_until:updated[0].reserved_until,recovery_token:recoveryToken});
    } catch (e) {
        if (client) {
            await client.query('ROLLBACK').catch(()=>{});
            client.release(); client = null;
        }
       if (committedOrderId) {
    // Razorpay creation may have succeeded even if its API call failed.
    // Keep stock reserved until the order is safely reconciled.
    console.error(
        'RENEWED_ORDER_REQUIRES_REVIEW:',
        committedOrderId,
        e.message
    );
}
        console.error('Renewed prepare payment:',e.message);
        return res.status(e.status || 503).json({success:false,
            message:e.status ? e.message : 'Unable to prepare payment. Please retry.'});
    }
});

// In Phase 5B reservation is disabled by default. Do NOT enable for public
// traffic until verified customer auth, payment initiation and webhook exist.
// Phase 5F safety gate: do not expose the unauthenticated Phase 5B reservation
// implementation by flipping an environment variable on a LIVE Razorpay account.
// Future replacement must atomically verify identity, delivery amount, stock,
// Razorpay order creation and webhook reconciliation before opening checkout.
// Customer callback: signature plus server-side payment fetch; never trust client success alone.
app.post('/api/renewed/verify-payment',async(req,res)=>{
    res.set('Cache-Control','no-store');
    try {
        const {razorpay_order_id:orderId,razorpay_payment_id:paymentId,razorpay_signature:signature} = req.body || {};
        if (![orderId,paymentId,signature].every(v=>typeof v==='string' && v.length>3 && v.length<256))
            return res.status(400).json({success:false,message:'Missing payment proof.'});
        const expected=crypto.createHmac('sha256',process.env.RAZORPAY_KEY_SECRET || '')
            .update(orderId+'|'+paymentId).digest('hex');
        if (!/^[a-f0-9]{64}$/i.test(signature) ||
            !crypto.timingSafeEqual(Buffer.from(expected,'hex'),Buffer.from(signature,'hex')))
            return res.status(401).json({success:false,message:'Invalid payment signature.'});
        const result=await renewedVerifyAndFinalize(orderId,paymentId);
        return res.status(result==='paid'?200:409).json({success:result==='paid',status:result,
            message:result==='paid'?'Payment verified.': 'Payment requires reconciliation; contact support if debited.'});
    }catch(e){console.error('Renewed payment verification:',e.message);
        return res.status(503).json({success:false,message:'Verification pending. If debited, do not pay again; contact support.'});}
});

// Configure Razorpay Dashboard webhook URL /api/renewed/razorpay-webhook,
// event payment.captured; secret is distinct from RAZORPAY_KEY_SECRET.
app.post('/api/renewed/razorpay-webhook',async(req,res)=>{
    res.set('Cache-Control','no-store');
    try {
        const secret=process.env.RENEWED_RAZORPAY_WEBHOOK_SECRET;
        const sig=String(req.get('x-razorpay-signature') || '');
        if (!secret || !Buffer.isBuffer(req.body) || !/^[a-f0-9]{64}$/i.test(sig))
            return res.status(401).json({success:false});
        const expected=crypto.createHmac('sha256',secret).update(req.body).digest('hex');
        if (!crypto.timingSafeEqual(Buffer.from(expected,'hex'),Buffer.from(sig,'hex')))
            return res.status(401).json({success:false});
        const event=JSON.parse(req.body.toString('utf8'));
        if (event.event !== 'payment.captured') return res.json({success:true,ignored:true});
        const payment=event.payload?.payment?.entity;
        if (!payment?.id || !payment?.order_id) return res.status(400).json({success:false});
        const result=await renewedVerifyAndFinalize(payment.order_id,payment.id);
        // Unknown orders may belong to Doorstep checkout: ignore.
        return res.json({success:true,status:result});
    }catch(e){console.error('Renewed webhook:',e.message);
        return res.status(503).json({success:false,message:'Retry webhook.'});}
});

// RENEWED ADMIN ORDER MANAGEMENT — payment status and delivery status are separate.
// Protected by the existing /api/admin Bearer-token middleware above.
const renewedDeliveryStages = ['confirmed','packing','packed','shipped','out_for_delivery','delivered'];
app.get('/api/admin/renewed/orders', async (req,res) => {
    res.set('Cache-Control','no-store');
    try {
        const orders = await renewedQuery(`SELECT id,customer_name,customer_phone,customer_email,
          delivery_address,subtotal,delivery_fee,total,currency,status,delivery_status,status_timestamps,payment_method,
          delivered_at,razorpay_order_id,razorpay_payment_id,paid_at,created_at,updated_at
          FROM public.renewed_orders ORDER BY created_at DESC LIMIT 300`);
        const ids = orders.map(o=>o.id);
        const items = ids.length ? await renewedQuery(`SELECT
          order_id,
          product_id,
          product_name,
          unit_price,
          quantity,
          line_total,
          seller_id,
          COALESCE(seller_order_status,'new') AS seller_order_status,
          seller_accepted_at,
          seller_rejected_at,
          seller_packed_at,
          seller_shipped_at,
          seller_order_note
          FROM public.renewed_order_items
          WHERE order_id IN (${ids.map(()=>'?').join(',')})
          ORDER BY id`,ids) : [];
        const byOrder = new Map();
        for(const item of items){const k=String(item.order_id);if(!byOrder.has(k))byOrder.set(k,[]);byOrder.get(k).push(item);}
        return res.json({success:true,orders:orders.map(o=>({...o,items:byOrder.get(String(o.id))||[]}))});
    } catch(e){console.error('Renewed admin orders:',e.message);
        return res.status(503).json({success:false,message:'Renewed orders unavailable. Check database migration.'});}
});
app.patch('/api/admin/renewed/orders/:id/delivery-status', async(req,res)=>{
    res.set('Cache-Control','no-store');
    try {
        const id=String(req.params.id||'');
        const next=String(req.body?.delivery_status||'');
        if(!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id) || !renewedDeliveryStages.includes(next))
            return res.status(400).json({success:false,message:'Invalid order ID or delivery status.'});
        const rows=await renewedQuery(`UPDATE public.renewed_orders
          SET delivery_status=?,delivered_at=CASE WHEN ?='delivered' THEN COALESCE(delivered_at,NOW()) ELSE delivered_at END,
          status_timestamps=CASE WHEN delivery_status IS DISTINCT FROM ?
            THEN jsonb_set(COALESCE(status_timestamps,'{}'::jsonb),ARRAY[?]::text[],to_jsonb(NOW()),true)
            ELSE COALESCE(status_timestamps,'{}'::jsonb) END,updated_at=NOW()
          WHERE id=? AND (status='paid' OR (status='processing' AND payment_method='cod')) AND
          (delivery_status IS NULL OR delivery_status IN ('confirmed','packing','packed','shipped','out_for_delivery','delivered'))
          AND (CASE COALESCE(delivery_status,'confirmed')
            WHEN 'confirmed' THEN 0 WHEN 'packing' THEN 1 WHEN 'packed' THEN 2
            WHEN 'shipped' THEN 3 WHEN 'out_for_delivery' THEN 4 WHEN 'delivered' THEN 5 ELSE 99 END)
          <= (CASE ? WHEN 'confirmed' THEN 0 WHEN 'packing' THEN 1 WHEN 'packed' THEN 2
            WHEN 'shipped' THEN 3 WHEN 'out_for_delivery' THEN 4 WHEN 'delivered' THEN 5 ELSE -1 END)
          RETURNING id,status,delivery_status,status_timestamps,delivered_at,updated_at`,[next,next,next,next,id,next]);
        if(!rows.length)return res.status(409).json({success:false,message:'Only paid online or confirmed COD orders can advance; status cannot move backward. Refresh orders.'});
        return res.json({success:true,order:rows[0]});
    } catch(e){console.error('Renewed delivery update:',e.message);
        return res.status(503).json({success:false,message:'Could not update delivery status.'});}
});

// Device-bound COD receipt access: the random checkout request UUID is a bearer
// credential, not a phone number or order ID alone. Never log or expose it in URLs.
app.post('/api/renewed/device-orders',async(req,res)=>{
  res.set('Cache-Control','no-store');
  const entries=req.body?.receipts;
  const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if(!Array.isArray(entries)||entries.length>30||entries.some(e=>!uuid.test(String(e?.id||''))||!uuid.test(String(e?.request_id||''))))
    return res.status(400).json({success:false,message:'Invalid device receipts.'});
  try{
    const orders=[];
    for(const entry of entries){
      const rows=await renewedQuery(`SELECT id,customer_name,subtotal,delivery_fee,total,currency,status,delivery_status,status_timestamps,payment_method,delivered_at,created_at,updated_at
        FROM public.renewed_orders WHERE id=? AND cod_request_id=? AND payment_method='cod' LIMIT 1`,[entry.id,entry.request_id]);
      if(!rows.length)continue;
      const items=await renewedQuery(`SELECT i.product_id,i.product_name,i.unit_price,i.quantity,i.line_total,p.image_url,p.condition,p.warranty_days,i.warranty_days_at_purchase
        FROM public.renewed_order_items i LEFT JOIN public.renewed_products p ON p.id=i.product_id WHERE i.order_id=? ORDER BY i.id`,[entry.id]);
      orders.push({...rows[0],items});
    }
    orders.sort((a,b)=>new Date(b.created_at)-new Date(a.created_at));
    return res.json({success:true,orders});
  }catch(e){console.error('Renewed device orders:',e.message);return res.status(503).json({success:false,message:'Order history temporarily unavailable.'});}
});

// Renewed customer session: existing Cerood account credentials, no OTP on dashboard.
// Keep RENEWED_CUSTOMER_JWT_SECRET private on Render; never trust localStorage user/phone as identity.
function renewedCustomerSession(req,res,next){
  const secret=String(process.env.RENEWED_CUSTOMER_JWT_SECRET||'');
  if(secret.length<32)return res.status(503).json({success:false,message:'Renewed account sessions are not configured.'});
  const m=/^Bearer (\S+)$/.exec(String(req.headers.authorization||''));
  if(!m)return res.status(401).json({success:false,message:'Sign in to view your orders.'});
  try{const claims=jwt.verify(m[1],secret,{algorithms:['HS256'],issuer:'cerood-renewed'});
    if(claims.role!=='renewed_customer'||! /^[6-9]\d{9}$/.test(claims.phone)||!/^\d+$/.test(String(claims.sub||'')))throw Error('Invalid session');
    req.renewedCustomerId=String(claims.sub);req.renewedCustomerPhone=claims.phone;next();
  }catch(e){return res.status(401).json({success:false,message:'Session expired. Please sign in again.'});}
}
app.post('/api/renewed/customer-login',(req,res)=>{
  res.set('Cache-Control','no-store');
  const phone=String(req.body?.phone||'').trim(),password=String(req.body?.password||'');
  if(!/^[6-9]\d{9}$/.test(phone)||!password||password.length>256)return res.status(400).json({success:false,message:'Enter your registered mobile and password.'});
  const secret=String(process.env.RENEWED_CUSTOMER_JWT_SECRET||'');
  if(secret.length<32)return res.status(503).json({success:false,message:'Renewed account sessions are not configured.'});
  db.query('SELECT id,name,phone,password FROM public.users WHERE phone=? LIMIT 1',[phone],async(err,rows)=>{
    if(err){console.error('Renewed customer login:',err.message);return res.status(503).json({success:false,message:'Login temporarily unavailable.'});}
    const u=rows?.[0];let valid=false;
    try{valid=Boolean(u?.password)&&await bcrypt.compare(password,String(u.password));}catch(e){valid=false;}
    if(!valid)return res.status(401).json({success:false,message:'Invalid mobile number or password.'});
    const token=jwt.sign({sub:String(u.id),phone:u.phone,role:'renewed_customer'},secret,{algorithm:'HS256',expiresIn:'7d',issuer:'cerood-renewed'});
    return res.json({success:true,token,user:{name:u.name,phone:u.phone}});
  });
});
// Explicit guest COD receipt claim. A signed-in user must possess the original
// checkout request UUID AND the order's checkout phone must match their account.
// Never claim by phone/order ID alone; never overwrite another account's ownership.
app.post('/api/renewed/claim-guest-orders',renewedCustomerSession,async(req,res)=>{
  res.set('Cache-Control','no-store');
  const entries=req.body?.receipts;
  const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if(!Array.isArray(entries)||entries.length<1||entries.length>30||
     entries.some(e=>!uuid.test(String(e?.id||''))||!uuid.test(String(e?.request_id||''))))
    return res.status(400).json({success:false,message:'Valid checkout receipts required (maximum 30).'});
  try{
    // Confirm the current account phone from the DB, not a client-supplied value.
    const users=await renewedQuery('SELECT phone FROM public.users WHERE id=? LIMIT 1',[req.renewedCustomerId]);
    if(!users.length||String(users[0].phone)!==req.renewedCustomerPhone)
      return res.status(401).json({success:false,message:'Account session changed. Please sign in again.'});
    const linked=[];
    for(const entry of entries){
      const rows=await renewedQuery(`UPDATE public.renewed_orders
        SET customer_id=?,updated_at=NOW()
        WHERE id=? AND cod_request_id=? AND payment_method='cod'
          AND customer_id IS NULL AND customer_phone=?
        RETURNING id`,[req.renewedCustomerId,entry.id,entry.request_id,req.renewedCustomerPhone]);
      if(rows.length)linked.push(rows[0].id);
    }
    return res.json({success:true,linked_count:linked.length,linked_order_ids:linked,
      message:linked.length?'Guest orders linked to your account.':'No eligible unlinked orders for this account. Check the checkout phone and receipt.'});
  }catch(e){console.error('Renewed guest claim:',e.message);
    return res.status(503).json({success:false,message:'Could not link guest orders. Please retry.'});}
});
app.get('/api/renewed/customer-session',renewedCustomerSession,(req,res)=>res.json({success:true,phone:req.renewedCustomerPhone}));
app.get('/api/renewed/customer-orders',renewedCustomerSession,async(req,res)=>{
  res.set('Cache-Control','no-store');
  try{const orders=await renewedQuery(`SELECT id,customer_name,subtotal,delivery_fee,total,currency,status,delivery_status,status_timestamps,payment_method,delivered_at,paid_at,created_at,updated_at FROM public.renewed_orders WHERE customer_id=? ORDER BY created_at DESC LIMIT 100`,[req.renewedCustomerId]);
    const ids=orders.map(o=>o.id);
    const items=ids.length?await renewedQuery(`SELECT
    i.order_id,
    i.product_id,
    i.product_name,
    i.unit_price,
    i.quantity,
    i.line_total,
    i.seller_id,
    COALESCE(i.seller_order_status,'new') AS seller_order_status,
    i.seller_accepted_at,
    i.seller_rejected_at,
    i.seller_packed_at,
    i.seller_shipped_at,
    p.image_url,
    p.condition,
    p.warranty_days,
    i.warranty_days_at_purchase
    FROM public.renewed_order_items i
    LEFT JOIN public.renewed_products p ON p.id=i.product_id
    WHERE i.order_id IN (${ids.map(()=>'?').join(',')})
    ORDER BY i.id`,ids):[];
    const byId=new Map();for(const item of items){const id=String(item.order_id);if(!byId.has(id))byId.set(id,[]);byId.get(id).push(item)}
    return res.json({success:true,orders:orders.map(o=>({...o,items:byId.get(String(o.id))||[]}))});
  }catch(e){console.error('Renewed customer orders:',e.message);return res.status(503).json({success:false,message:'Orders temporarily unavailable.'});}
});
app.get('/api/renewed/customer-order/:id',renewedCustomerSession,async(req,res)=>{
  res.set('Cache-Control','no-store');
  const id=String(req.params.id||'');if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))return res.status(400).json({success:false,message:'Invalid order ID.'});
  try{const rows=await renewedQuery(`SELECT id,status,delivery_status,status_timestamps,payment_method,total,currency,created_at,paid_at,updated_at FROM public.renewed_orders WHERE id=? AND customer_id=? LIMIT 1`,[id,req.renewedCustomerId]);
    if(!rows.length)return res.status(404).json({success:false,message:'Order not found for this account.'});return res.json({success:true,order:rows[0]});
  }catch(e){console.error('Renewed customer tracking:',e.message);return res.status(503).json({success:false,message:'Order status temporarily unavailable.'});}
});

// Renewed customer dashboard V2: all orders for the MSG91-verified checkout phone.
// Never accept a phone number from the client as proof of identity.
app.post('/api/renewed/my-orders', async (req,res)=>{
    res.set('Cache-Control','no-store');
    try {
        const token=String(req.body?.accessToken||'').trim();
        if(!token||token.length>8192)return res.status(401).json({success:false,message:'Verify your mobile number.'});
        const verified=await verifyMsg91AccessToken(token);
        if(String(verified?.type||'').toLowerCase()!=='success')return res.status(401).json({success:false,message:'Mobile verification expired.'});
        const phone=extractVerifiedPhoneFromMsg91(verified,token);
        if(!/^[6-9]\d{9}$/.test(phone))return res.status(401).json({success:false,message:'Verified phone not available.'});
        const orders=await renewedQuery(`SELECT id,customer_name,subtotal,delivery_fee,total,currency,status,delivery_status,status_timestamps,payment_method,delivered_at,
            paid_at,created_at,updated_at FROM public.renewed_orders
            WHERE customer_phone=? ORDER BY created_at DESC LIMIT 100`,[phone]);
        const ids=orders.map(o=>o.id);
        const items=ids.length?await renewedQuery(`SELECT
    i.order_id,
    i.product_id,
    i.product_name,
    i.unit_price,
    i.quantity,
    i.line_total,
    i.seller_id,
    COALESCE(i.seller_order_status,'new') AS seller_order_status,
    i.seller_accepted_at,
    i.seller_rejected_at,
    i.seller_packed_at,
    i.seller_shipped_at,
    p.image_url,
    p.condition,
    p.warranty_days,
    i.warranty_days_at_purchase
    FROM public.renewed_order_items i
    LEFT JOIN public.renewed_products p ON p.id=i.product_id
    WHERE i.order_id IN (${ids.map(()=>'?').join(',')})
    ORDER BY i.id`,ids):[];
        const byId=new Map();
        for(const item of items){const id=String(item.order_id);if(!byId.has(id))byId.set(id,[]);byId.get(id).push(item);}
        return res.json({success:true,orders:orders.map(o=>({...o,items:byId.get(String(o.id))||[]}))});
    }catch(e){console.error('Renewed my-orders:',e.message);
        return res.status(503).json({success:false,message:'Orders are temporarily unavailable.'});}
});

// Read-only order status. Phone OTP token is required to prevent order enumeration.
// Read-only guest payment recovery. A signed, order-scoped capability is returned ONLY
// to the browser that prepared the Razorpay order. Never accept an order ID alone.
app.post('/api/renewed/guest-payment-status',async(req,res)=>{
    res.set('Cache-Control','no-store');
    try {
        const token=String(req.body?.recovery_token||'');
        if(!token || token.length>4096 || !process.env.RAZORPAY_KEY_SECRET)
            return res.status(401).json({success:false,message:'Recovery authorization unavailable. Contact Cerood with the order ID.'});
        const secret=crypto.createHash('sha256')
            .update('cerood-renewed-recovery-v1:' + process.env.RAZORPAY_KEY_SECRET).digest();
        const claim=jwt.verify(token,secret,{algorithms:['HS256'],issuer:'cerood-renewed-recovery'});
        if(claim.scope!=='renewed_payment_status' ||
            !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(String(claim.order_id||'')) ||
            !/^order_[a-zA-Z0-9]+$/.test(String(claim.razorpay_order_id||'')))
            return res.status(401).json({success:false,message:'Invalid recovery authorization.'});
        const rows=await renewedQuery(`SELECT id,status,total,currency,paid_at
            FROM public.renewed_orders WHERE id=? AND razorpay_order_id=? LIMIT 1`,
            [claim.order_id,claim.razorpay_order_id]);
        if(!rows.length)return res.status(404).json({success:false,message:'Order not found. Contact Cerood.'});
        const o=rows[0];
        return res.json({success:true,order:{id:o.id,status:o.status,total:o.total,currency:o.currency,paid_at:o.paid_at}});
    }catch(e){
        if(e.name==='JsonWebTokenError'||e.name==='TokenExpiredError'||e.name==='NotBeforeError')
            return res.status(401).json({success:false,message:'Recovery authorization expired or invalid. Contact Cerood with the order ID.'});
        console.error('Renewed guest payment recovery:',e.message);
        return res.status(503).json({success:false,message:'Payment status temporarily unavailable. Do not pay again.'});
    }
});

app.post('/api/renewed/order-status',async(req,res)=>{
    res.set('Cache-Control','no-store');
    try {
        const orderId=String(req.body?.order_id||'');
        if (!/^[0-9a-f-]{36}$/i.test(orderId)) return res.status(400).json({success:false});
        const token=String(req.body?.accessToken||'');
        if (!token || token.length>8192) return res.status(401).json({success:false});
        const verified=await verifyMsg91AccessToken(token);
        if (String(verified?.type||'').toLowerCase()!=='success') return res.status(401).json({success:false});
        const phone=extractVerifiedPhoneFromMsg91(verified,token);
        const rows=await renewedQuery(`SELECT id,status,delivery_status,status_timestamps,payment_method,total,currency,created_at,paid_at,updated_at
          FROM public.renewed_orders WHERE id=? AND customer_phone=? LIMIT 1`,[orderId,phone]);
        if (!rows.length) return res.status(404).json({success:false});
        return res.json({success:true,order:rows[0]});
    }catch(e){console.error('Renewed order status:',e.message);
        return res.status(503).json({success:false,message:'Order status unavailable.'});}
});

app.post('/api/renewed/reservations', (req,res) => {
    return res.status(503).json({success:false,
        message:'Renewed checkout is not enabled yet. Secure payment integration is in progress.'});
});

app.get('/api/renewed/checkout-status', (req,res) => {
    res.set('Cache-Control','no-store');
    const enabled = process.env.RENEWED_LIVE_CHECKOUT_ENABLED === 'true' &&
        Boolean(process.env.RENEWED_RAZORPAY_WEBHOOK_SECRET && process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);
    const codEnabled = process.env.RENEWED_COD_ENABLED === 'true';
    return res.json({success:true,guest_checkout_enabled:process.env.RENEWED_GUEST_CHECKOUT_ENABLED === 'true',checkout_enabled:enabled||codEnabled,payment_enabled:enabled,cod_enabled:codEnabled,
        reservations_enabled:enabled,currency:'INR',
        message:enabled?'Renewed online payment backend enabled.':codEnabled?'Renewed COD available; online payment disabled.':'Renewed purchases remain disabled until explicitly enabled.'});
});

// Phase 5H: Recover captured payments when the browser callback or webhook was missed.
// Razorpay network calls stay OUTSIDE all database transactions and advisory locks.
// Unpaid Razorpay-linked reservations remain held for manual review: a snapshot
// showing no capture cannot rule out a late capture or an in-flight payment.
let renewedReconciliationRunning = false;
async function renewedReconcileCapturedPayments() {
    if (renewedReconciliationRunning || !process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) return;
    renewedReconciliationRunning = true;
    try {
        const candidates = await renewedQuery(`
            SELECT id,razorpay_order_id FROM public.renewed_orders
            WHERE status IN ('pending_payment','creating_order') AND razorpay_order_id IS NOT NULL
              AND reserved_until <= NOW()
            ORDER BY reserved_until ASC LIMIT 20
        `);
        // Ambiguous remote creation must be reviewed against Razorpay receipt/notes.
        // Never auto-release this stock based only on elapsed time.
        const unlinked = await renewedQuery(`
            SELECT id,created_at,reserved_until FROM public.renewed_orders
            WHERE status='creating_order' AND razorpay_order_id IS NULL
              AND reserved_until <= NOW()
            ORDER BY reserved_until ASC LIMIT 20
        `);
        for (const order of unlinked) {
            console.error('RENEWED_CREATION_MANUAL_REVIEW:', order.id);
        }
        for (const order of candidates) {
            try {
                // Query payment records by the *server-stored* Razorpay order ID.
                const response = await razorpayInstance.orders.fetchPayments(order.razorpay_order_id);
                const payments = Array.isArray(response?.items) ? response.items : [];
                for (const payment of payments) {
                    if (payment?.status !== 'captured' || !payment?.id) continue;
                    const result = await renewedVerifyAndFinalize(order.razorpay_order_id,payment.id);
                    console.log('Renewed payment reconciliation:',order.id,result);
                    if (result === 'paid' || result === 'payment_review') break;
                }
                // Deliberately DO NOT release stock when no captured payment is found.
            } catch (error) {
                console.error('Renewed reconciliation retry pending:',order.id,error.message);
            }
        }
    } finally {
        renewedReconciliationRunning = false;
    }
}
const renewedReconciliationTimer = setInterval(() => {
    renewedReconcileCapturedPayments().catch(e =>
        console.error('Renewed reconciliation:',e.message));
}, 5*60*1000);
renewedReconciliationTimer.unref();

// Release expired stock periodically, including when there are no customers.
// Keep the timer unref'd so it does not hold up shutdown.
const renewedExpiryTimer = setInterval(() => {
    renewedRunExpiry().catch(e=>console.error('Renewed expiry cleanup:',e.message));
},60*1000);
renewedExpiryTimer.unref();

// No payment success, cancellation or manual stock-release endpoints in Phase 5B.
// Those must authenticate the customer and verify payment server-side first.

initDatabase();

// =============================================================
// CEROOD COSMETICS — PHASE 1: SAFE PRODUCT INVENTORY
// Uses the existing admin middleware and the existing db adapter.
// No live payment/order routes are enabled in this phase.
// =============================================================
const cosmeticsDb = (sql, values=[]) => new Promise((resolve,reject)=>
    db.query(sql,values,(error,rows)=>error?reject(error):resolve(rows||[])));
const cosmeticsFields = `id,name,category,brand,description,variant,shade,net_quantity,
 ingredients,directions,warnings,batch_number,manufacture_date,expiry_date,
 price,compare_price,stock,image_url,video_url,manufacturer,importer,status,created_at,updated_at`;
const cosmeticsIdOk = id => /^[a-zA-Z0-9_-]{1,80}$/.test(String(id||''));
function cosmeticsClean(b){
    const str=(k,n)=>String(b[k]??'').trim().slice(0,n);
    const name=str('name',140),category=str('category',80),price=Number(b.price),stock=Number(b.stock);
    const compare_price=b.compare_price==null||b.compare_price===''?null:Number(b.compare_price);
    const status=str('status',20)||'draft';
    if(!name||!category||!Number.isFinite(price)||price<=0||price>10000000||
       !Number.isSafeInteger(stock)||stock<0||stock>1000000||
       (compare_price!==null&&(!Number.isFinite(compare_price)||compare_price<0))||
       !['draft','published'].includes(status))
       throw Object.assign(new Error('Enter a valid name, category, price, stock and status.'),{status:400});
    const image_url=str('image_url',2048),video_url=str('video_url',2048);
    for(const u of [image_url,video_url]) if(u&&(!/^https:\/\//i.test(u)||!URL.canParse(u)))
       throw Object.assign(new Error('Product media URLs must use HTTPS.'),{status:400});
    const expiry_date=str('expiry_date',10)||null,manufacture_date=str('manufacture_date',10)||null;
    for(const d of [expiry_date,manufacture_date]) if(d&&(!/^\d{4}-\d{2}-\d{2}$/.test(d)||Number.isNaN(Date.parse(d))))
       throw Object.assign(new Error('Use YYYY-MM-DD for dates.'),{status:400});
    if(expiry_date&&manufacture_date&&expiry_date<manufacture_date)
       throw Object.assign(new Error('Expiry must follow manufacture date.'),{status:400});
    if(status==='published'&&(!image_url||!str('brand',100)||!str('net_quantity',100)||!expiry_date))
       throw Object.assign(new Error('Publish requires image, brand, net quantity and expiry date.'),{status:400});
    return {name,category,brand:str('brand',100),description:str('description',5000),
      variant:str('variant',100),shade:str('shade',100),net_quantity:str('net_quantity',100),
      ingredients:str('ingredients',5000),directions:str('directions',5000),warnings:str('warnings',5000),
      batch_number:str('batch_number',100),manufacture_date,expiry_date,price,compare_price,stock,
      image_url,video_url,manufacturer:str('manufacturer',250),importer:str('importer',250),status};
}
function cosmeticsFail(res,e){console.error('Cosmetics inventory:',e.message);
  return res.status(e.status||503).json({success:false,message:e.status?e.message:'Cosmetics inventory is unavailable.'});}
app.get('/api/cosmetics/products',async(req,res)=>{
  try {const rows=await cosmeticsDb(`SELECT ${cosmeticsFields} FROM public.cosmetics_products
    WHERE status='published' AND (expiry_date IS NULL OR expiry_date>=CURRENT_DATE)
    ORDER BY created_at DESC LIMIT 250`);
    return res.json({success:true,products:rows.map(p=>({...p,image:p.image_url,media:[p.image_url&&{type:'image',url:p.image_url},p.video_url&&{type:'video',url:p.video_url}].filter(Boolean)}))});
  }catch(e){return cosmeticsFail(res,e);}
});
app.get('/api/cosmetics/products/:id',async(req,res)=>{
  if(!cosmeticsIdOk(req.params.id))return res.status(400).json({success:false,message:'Invalid ID.'});
  try {const rows=await cosmeticsDb(`SELECT ${cosmeticsFields} FROM public.cosmetics_products
    WHERE id=? AND status='published' AND (expiry_date IS NULL OR expiry_date>=CURRENT_DATE) LIMIT 1`,[req.params.id]);
    if(!rows.length)return res.status(404).json({success:false,message:'Product not found.'});
    const p=rows[0];return res.json({success:true,product:{...p,image:p.image_url,media:[p.image_url&&{type:'image',url:p.image_url},p.video_url&&{type:'video',url:p.video_url}].filter(Boolean)}});
  }catch(e){return cosmeticsFail(res,e);}
});
// Admin endpoints are BELOW app.use('/api/admin', requireAdminAuth).
app.get('/api/admin/cosmetics/products',async(req,res)=>{
  try{return res.json({success:true,products:await cosmeticsDb(`SELECT ${cosmeticsFields} FROM public.cosmetics_products ORDER BY updated_at DESC LIMIT 500`)});}
  catch(e){return cosmeticsFail(res,e);}
});
app.get('/api/admin/cosmetics/test-preview/:id',async(req,res)=>{
  if(!cosmeticsIdOk(req.params.id))return res.status(400).json({success:false,message:'Invalid ID.'});
  try{const rows=await cosmeticsDb(`SELECT ${cosmeticsFields} FROM public.cosmetics_products WHERE id=? LIMIT 1`,[req.params.id]);
    if(!rows.length)return res.status(404).json({success:false,message:'Product not found.'});
    return res.json({success:true,test_only:true,payment_created:false,product:rows[0]});}
  catch(e){return cosmeticsFail(res,e);}
});
app.post('/api/admin/cosmetics/products',async(req,res)=>{
  try{const p=cosmeticsClean(req.body||{}),keys=Object.keys(p),id=crypto.randomUUID();
    const rows=await cosmeticsDb(`INSERT INTO public.cosmetics_products (id,${keys.join(',')}) VALUES (?,${keys.map(()=>'?').join(',')}) RETURNING ${cosmeticsFields}`,[id,...Object.values(p)]);
    return res.status(201).json({success:true,product:rows[0]});}
  catch(e){return cosmeticsFail(res,e);}
});
app.put('/api/admin/cosmetics/products/:id',async(req,res)=>{
  if(!cosmeticsIdOk(req.params.id))return res.status(400).json({success:false,message:'Invalid ID.'});
  try{const p=cosmeticsClean(req.body||{}),keys=Object.keys(p);
    const rows=await cosmeticsDb(`UPDATE public.cosmetics_products SET ${keys.map(k=>k+'=?').join(',')},updated_at=NOW() WHERE id=? RETURNING ${cosmeticsFields}`,[...Object.values(p),req.params.id]);
    if(!rows.length)return res.status(404).json({success:false,message:'Product not found.'});
    return res.json({success:true,product:rows[0]});}
  catch(e){return cosmeticsFail(res,e);}
});
app.delete('/api/admin/cosmetics/products/:id',async(req,res)=>{
  if(!cosmeticsIdOk(req.params.id))return res.status(400).json({success:false,message:'Invalid ID.'});
  try{const rows=await cosmeticsDb('DELETE FROM public.cosmetics_products WHERE id=? RETURNING id',[req.params.id]);
    if(!rows.length)return res.status(404).json({success:false,message:'Product not found.'});
    return res.json({success:true,deleted_id:rows[0].id});}
  catch(e){return cosmeticsFail(res,e);}
});
// Phase 1 checkout intentionally blocked; never simulate an accepted order.



// CEROOD BEAUTY — Phase 2: server-priced quote and atomic COD checkout.
// Online payments remain OFF until a dedicated, verified Razorpay flow is tested.
const beautyFee = () => { const n=Number(process.env.COSMETICS_INDIA_DELIVERY_FEE ?? 79); return Number.isSafeInteger(n)&&n>=0&&n<=10000?n:79; };
const beautyCodOn = () => process.env.COSMETICS_COD_ENABLED === 'true' && process.env.COSMETICS_LIVE_CHECKOUT_ENABLED === 'true';
const beautyErr = (res,e) => { console.error('Beauty checkout:',e.message);return res.status(e.httpStatus||503).json({success:false,message:e.httpStatus?e.message:'Beauty checkout temporarily unavailable.'}); };
function beautyRequest(body){
 const a=body?.address, items=body?.items;
 const invalid=m=>{throw Object.assign(new Error(m),{httpStatus:400})};
 if(!a||typeof a!=='object'||Array.isArray(a)||!Array.isArray(items)||items.length<1||items.length>20)invalid('Address and 1–20 products required.');
 const address={full_name:String(a.full_name||'').trim(),phone:String(a.phone||'').trim(),street:String(a.street||'').trim(),area:String(a.area||'').trim(),city:String(a.city||'').trim(),district:String(a.district||'').trim(),state:String(a.state||'').trim(),pincode:String(a.pincode||'').trim()};
 if(address.full_name.length<2||address.full_name.length>140||!/^[6-9]\d{9}$/.test(address.phone)||address.street.length<5||address.street.length>500||address.city.length<2||address.city.length>100||address.district.length<2||address.district.length>100||address.state.length<2||address.state.length>100||!/^[1-9]\d{5}$/.test(address.pincode)||address.area.length>200)invalid('Enter a complete Indian delivery address and valid mobile number.');
 const counts=new Map();
 for(const item of items){const id=String(item?.product_id||'').trim(),qty=Number(item?.quantity);if(!cosmeticsIdOk(id)||!Number.isSafeInteger(qty)||qty<1||qty>99)invalid('Invalid product or quantity.');const total=(counts.get(id)||0)+qty;if(total>99)invalid('Maximum quantity per product is 99.');counts.set(id,total);}
 return {address,counts};
}
function beautyTotals(products,counts){
 const map=new Map(products.map(p=>[String(p.id),p]));let subtotal=0;const lines=[];
 for(const [id,qty] of counts){const p=map.get(id);if(!p||p.status!=='published'||(p.expiry_date&&new Date(p.expiry_date).getTime()<Date.now()-86400000)||Number(p.stock)<qty)throw Object.assign(new Error('Product unavailable, expired or insufficient stock. Refresh your cart.'),{httpStatus:409});
 const price=Number(p.price),line=price*qty;if(!Number.isSafeInteger(price)||price<=0||!Number.isSafeInteger(line))throw Object.assign(new Error('Invalid product price.'),{httpStatus:409});subtotal+=line;if(!Number.isSafeInteger(subtotal)||subtotal>10000000)throw Object.assign(new Error('Order amount exceeds limit.'),{httpStatus:400});
 lines.push({product_id:id,product_name:p.name,variant:p.variant||null,quantity:qty,unit_price:price,total_price:line});}
 const delivery_fee=beautyFee();return {items:lines,subtotal,delivery_fee,discount:0,total:subtotal+delivery_fee,currency:'INR'};
}
app.get('/api/cosmetics/checkout-status',(req,res)=>res.json({success:true,cod_enabled:beautyCodOn(),online_enabled:beautyOnlineOn(),delivery_fee:beautyFee(),live_checkout:beautyCodOn()||beautyOnlineOn()}));
app.post('/api/cosmetics/quote',async(req,res)=>{
 res.set('Cache-Control','no-store');try{const {counts}=beautyRequest(req.body||{}),ids=[...counts.keys()];const products=await cosmeticsDb(`SELECT id,name,variant,price,stock,status,expiry_date FROM public.cosmetics_products WHERE id IN (${ids.map(()=>'?').join(',')})`,ids);return res.json({success:true,...beautyTotals(products,counts),cod_enabled:beautyCodOn(),online_enabled:beautyOnlineOn()});}catch(e){return beautyErr(res,e);}
});
app.post('/api/cosmetics/place-cod-order',async(req,res)=>{
 res.set('Cache-Control','no-store');if(!beautyCodOn())return res.status(503).json({success:false,message:'Beauty checkout is not live yet.'});
 let client;try{
 const {address,counts}=beautyRequest(req.body||{}),id=String(req.body?.request_id||'').trim();
 if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))return res.status(400).json({success:false,message:'Valid checkout request ID required.'});
 if(process.env.COSMETICS_GUEST_CHECKOUT_ENABLED!=='true'){
 const token=String(req.body?.accessToken||'').trim();if(!token||token.length>8192)return res.status(401).json({success:false,message:'Verify mobile OTP before ordering.'});
 const verified=await verifyMsg91AccessToken(token);if(String(verified?.type||'').toLowerCase()!=='success'||extractVerifiedPhoneFromMsg91(verified,token)!==address.phone)return res.status(401).json({success:false,message:'Verified mobile does not match delivery address.'});
 }
 client=await db.getClient();await client.query('BEGIN');
 // A stable UUID makes retries safe; serialise duplicate attempts with transaction advisory lock.
 await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[id]);
 const existing=await client.query('SELECT id,customer_phone,total,payment_method FROM public.cosmetics_orders WHERE id=$1',[id]);
 if(existing.length){await client.query('COMMIT');if(existing[0].customer_phone!==address.phone||existing[0].payment_method!=='cod')return res.status(409).json({success:false,message:'Checkout request conflict.'});return res.json({success:true,order_id:id,total:Number(existing[0].total),already_created:true,payment_method:'cod'});}
 const ids=[...counts.keys()];const products=await client.query(`SELECT id,name,variant,price,stock,status,expiry_date FROM public.cosmetics_products WHERE id=ANY($1::text[]) ORDER BY id FOR UPDATE`,[ids]);
 const totals=beautyTotals(products,counts);
 await client.query(`INSERT INTO public.cosmetics_orders (id,customer_name,customer_phone,customer_email,delivery_address,subtotal,delivery_fee,discount,total,payment_method,payment_status,status) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,'cod','pending','confirmed')`,[id,address.full_name,address.phone,null,JSON.stringify(address),totals.subtotal,totals.delivery_fee,0,totals.total]);
 for(const line of totals.items){await client.query(`UPDATE public.cosmetics_products SET stock=stock-$1,updated_at=NOW() WHERE id=$2`,[line.quantity,line.product_id]);await client.query(`INSERT INTO public.cosmetics_order_items(order_id,product_id,product_name,variant,quantity,unit_price,total_price) VALUES ($1,$2,$3,$4,$5,$6,$7)`,[id,line.product_id,line.product_name,line.variant,line.quantity,line.unit_price,line.total_price]);}
 await client.query('COMMIT');return res.status(201).json({success:true,order_id:id,payment_method:'cod',...totals,message:'Beauty COD order confirmed.'});
 }catch(e){if(client)await client.query('ROLLBACK').catch(()=>{});return beautyErr(res,e);}finally{if(client)client.release();}
});
// CEROOD BEAUTY — Razorpay order creation (preparation stage).
// Keep COSMETICS_ONLINE_ENABLED unset/false until verification, recovery and
// webhook finalisation are deployed. This endpoint cannot mark an order paid.
const beautyOnlineOn = () => process.env.COSMETICS_ONLINE_ENABLED === 'true'
    && process.env.COSMETICS_LIVE_CHECKOUT_ENABLED === 'true'
    && !!process.env.RAZORPAY_KEY_ID && !!process.env.RAZORPAY_KEY_SECRET
    && !!process.env.COSMETICS_RAZORPAY_WEBHOOK_SECRET;
app.post('/api/cosmetics/create-razorpay-order', async (req, res) => {
 res.set('Cache-Control', 'no-store');
 if (!beautyOnlineOn()) return res.status(503).json({success:false,message:'Beauty online payment is not enabled yet.'});
 let client;
 try {
  const {address,counts}=beautyRequest(req.body||{});
  const id=String(req.body?.request_id||'').trim();
  if(!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id))
   return res.status(400).json({success:false,message:'Valid checkout request ID required.'});
  if(process.env.COSMETICS_GUEST_CHECKOUT_ENABLED!=='true') {
   const token=String(req.body?.accessToken||'').trim();
   if(!token||token.length>8192)return res.status(401).json({success:false,message:'Verify mobile OTP before ordering.'});
   const verified=await verifyMsg91AccessToken(token);
   if(String(verified?.type||'').toLowerCase()!=='success'||extractVerifiedPhoneFromMsg91(verified,token)!==address.phone)
    return res.status(401).json({success:false,message:'Verified mobile does not match delivery address.'});
  }
  client=await db.getClient();await client.query('BEGIN');
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[id]);
  const existing=await client.query(`SELECT id,customer_phone,total,payment_method,payment_status,razorpay_order_id,status,payment_expires_at
    FROM public.cosmetics_orders WHERE id=$1 FOR UPDATE`,[id]);
  if(existing.length){
   const o=existing[0];await client.query('COMMIT');
   if(o.customer_phone!==address.phone||o.payment_method!=='razorpay')
    return res.status(409).json({success:false,message:'Checkout request ID already belongs to another order.'});
   if(o.status==='expired'||o.status==='payment_review'||(o.payment_expires_at&&new Date(o.payment_expires_at).getTime()<Date.now()))return res.status(409).json({success:false,message:'This payment attempt is closed. Please start a new checkout or contact support.'});
   if(o.payment_status==='paid')return res.json({success:true,already_paid:true,order_id:id,total:Number(o.total)});
   if(!o.razorpay_order_id)return res.status(409).json({success:false,message:'Payment preparation incomplete; contact support.'});
   return res.json({success:true,already_created:true,order_id:id,razorpay_order_id:o.razorpay_order_id,
    key_id:process.env.RAZORPAY_KEY_ID,amount:Math.round(Number(o.total)*100),currency:'INR',total:Number(o.total)});
  }
  const ids=[...counts.keys()];
  const products=await client.query(`SELECT id,name,variant,price,stock,status,expiry_date
    FROM public.cosmetics_products WHERE id=ANY($1::text[]) ORDER BY id FOR UPDATE`,[ids]);
  const totals=beautyTotals(products,counts);
  const amount=totals.total*100;
  if(!Number.isSafeInteger(amount)||amount<100)throw Object.assign(new Error('Invalid online payment amount.'),{httpStatus:400});
  // Razorpay order amount is computed on the server, never trusted from browser.
  const razorpayOrder=await razorpayInstance.orders.create({amount,currency:'INR',receipt:id,
    notes:{store:'cerood_beauty',beauty_order_id:id}});
  if(!razorpayOrder?.id||Number(razorpayOrder.amount)!==amount)
   throw new Error('Razorpay returned an invalid order.');
  await client.query(`INSERT INTO public.cosmetics_orders
    (id,customer_name,customer_phone,customer_email,delivery_address,subtotal,delivery_fee,discount,total,
     payment_method,payment_status,status,razorpay_order_id,payment_expires_at)
    VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,'razorpay','pending','pending',$10,NOW()+INTERVAL '24 hours')`,
    [id,address.full_name,address.phone,null,JSON.stringify(address),totals.subtotal,totals.delivery_fee,
     totals.discount,totals.total,razorpayOrder.id]);
  // Reserve stock in this same transaction. Never release a Razorpay reservation
  // without checking Razorpay capture status; a late payment could otherwise oversell.
  for(const line of totals.items){
   const changed=await client.query(`UPDATE public.cosmetics_products SET stock=stock-$1,updated_at=NOW()
     WHERE id=$2 AND stock >= $1 RETURNING id`,[line.quantity,line.product_id]);
   if(!changed.length)throw Object.assign(new Error('Product stock changed. Refresh your cart.'),{httpStatus:409});
   await client.query(`INSERT INTO public.cosmetics_order_items
    (order_id,product_id,product_name,variant,quantity,unit_price,total_price)
    VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [id,line.product_id,line.product_name,line.variant,line.quantity,line.unit_price,line.total_price]);
  }
  await client.query('COMMIT');
  return res.status(201).json({success:true,order_id:id,razorpay_order_id:razorpayOrder.id,
    key_id:process.env.RAZORPAY_KEY_ID,amount,currency:'INR',total:totals.total});
 }catch(e){if(client)await client.query('ROLLBACK').catch(()=>{});return beautyErr(res,e);}
 finally{if(client)client.release();}
});

// Beauty payment finalisation: only Razorpay-confirmed CAPTURED payments become paid.
// An order's inventory was reserved atomically during create-razorpay-order.
async function beautyFinalizeCaptured(razorpayOrderId,paymentId){
 if(!/^order_[A-Za-z0-9]+$/.test(String(razorpayOrderId||''))||
    !/^pay_[A-Za-z0-9]+$/.test(String(paymentId||'')))return 'invalid';
 const rows=await cosmeticsDb(`SELECT id,total,payment_status,razorpay_payment_id FROM public.cosmetics_orders
    WHERE razorpay_order_id=? AND payment_method='razorpay' LIMIT 1`,[razorpayOrderId]);
 if(!rows.length)return 'not_found';
 const payment=await razorpayInstance.payments.fetch(paymentId);
 if(payment.order_id!==razorpayOrderId||payment.currency!=='INR'||
    Number(payment.amount)!==Math.round(Number(rows[0].total)*100)||payment.status!=='captured')return 'not_captured';
 let client;
 try{
  client=await db.getClient();await client.query('BEGIN');
  const locked=await client.query(`SELECT id,payment_status,razorpay_payment_id,status FROM public.cosmetics_orders
    WHERE razorpay_order_id=$1 AND payment_method='razorpay' FOR UPDATE`,[razorpayOrderId]);
  const order=locked[0];if(!order){await client.query('ROLLBACK');return 'not_found';}
  if(order.payment_status==='paid'){
   await client.query('COMMIT');return order.razorpay_payment_id===paymentId?'paid':'payment_review';
  }
  if(order.razorpay_payment_id&&order.razorpay_payment_id!==paymentId){
   await client.query('ROLLBACK');return 'payment_review';
  }
  if(order.status!=='pending'){
   // A late captured payment must NEVER silently confirm an expired/released reservation.
   await client.query(`UPDATE public.cosmetics_orders SET payment_status='payment_review',
     razorpay_payment_id=$2,updated_at=NOW() WHERE id=$1 AND payment_status<>'paid'`,[order.id,paymentId]);
   await client.query('COMMIT');return 'payment_review';
  }
  await client.query(`UPDATE public.cosmetics_orders SET payment_status='paid',status='confirmed',
    razorpay_payment_id=$2,paid_at=NOW(),updated_at=NOW() WHERE id=$1`,[order.id,paymentId]);
  await client.query('COMMIT');return 'paid';
 }catch(e){if(client)await client.query('ROLLBACK').catch(()=>{});throw e;}
 finally{if(client)client.release();}
}
app.post('/api/cosmetics/verify-razorpay-payment',async(req,res)=>{
 res.set('Cache-Control','no-store');
 try{
  const orderId=String(req.body?.razorpay_order_id||''),paymentId=String(req.body?.razorpay_payment_id||'');
  const signature=String(req.body?.razorpay_signature||'');
  if(!/^order_[A-Za-z0-9]+$/.test(orderId)||!/^pay_[A-Za-z0-9]+$/.test(paymentId)||
     !/^[0-9a-f]{64}$/i.test(signature))return res.status(400).json({success:false,message:'Invalid payment verification data.'});
  const expected=crypto.createHmac('sha256',process.env.RAZORPAY_KEY_SECRET||'')
    .update(orderId+'|'+paymentId).digest('hex');
  if(!crypto.timingSafeEqual(Buffer.from(expected,'hex'),Buffer.from(signature,'hex')))
    return res.status(401).json({success:false,message:'Payment signature verification failed.'});
  const result=await beautyFinalizeCaptured(orderId,paymentId);
  if(result!=='paid')return res.status(result==='not_captured'?202:409).json({success:false,
    message:result==='not_captured'?'Payment is not captured yet. Please check again shortly.':'Payment requires support review.',payment_state:result});
  const orders=await cosmeticsDb('SELECT id,total,customer_phone FROM public.cosmetics_orders WHERE razorpay_order_id=?',[orderId]);
  return res.json({success:true,order_id:orders[0].id,total:Number(orders[0].total),payment_status:'paid'});
 }catch(e){return beautyErr(res,e);}
});
// Browser-close recovery: UUID and matching delivery phone required; server fetches
// Razorpay payments rather than trusting a browser-supplied payment status.
app.post('/api/cosmetics/recover-razorpay-payment',async(req,res)=>{
 res.set('Cache-Control','no-store');
 try{
  const id=String(req.body?.order_id||''),phone=String(req.body?.phone||'');
  if(!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)||!/^[6-9]\d{9}$/.test(phone))
   return res.status(400).json({success:false,message:'Valid order ID and phone required.'});
  const rows=await cosmeticsDb(`SELECT id,customer_phone,razorpay_order_id,payment_status,total
    FROM public.cosmetics_orders WHERE id=? AND payment_method='razorpay'`,[id]);
  if(!rows.length||rows[0].customer_phone!==phone)return res.status(404).json({success:false,message:'Order not found.'});
  const order=rows[0];if(order.payment_status==='paid')return res.json({success:true,paid:true,order_id:id,total:Number(order.total)});
  const payments=await razorpayInstance.orders.fetchPayments(order.razorpay_order_id);
  const captured=(payments.items||[]).find(x=>x.status==='captured'&&x.order_id===order.razorpay_order_id);
  if(!captured)return res.json({success:true,paid:false,order_id:id,message:'No captured payment found yet.'});
  const result=await beautyFinalizeCaptured(order.razorpay_order_id,captured.id);
  return res.json({success:true,paid:result==='paid',order_id:id,payment_state:result,total:Number(order.total)});
 }catch(e){return beautyErr(res,e);}
});
// Razorpay Dashboard: set a dedicated Beauty webhook secret and subscribe to payment.captured.
app.post('/api/cosmetics/razorpay-webhook',async(req,res)=>{
 try{
  const secret=process.env.COSMETICS_RAZORPAY_WEBHOOK_SECRET||'';
  const signature=String(req.get('x-razorpay-signature')||'');
  if(!secret||!Buffer.isBuffer(req.body)||!/^[0-9a-f]{64}$/i.test(signature))return res.sendStatus(401);
  const expected=crypto.createHmac('sha256',secret).update(req.body).digest('hex');
  if(!crypto.timingSafeEqual(Buffer.from(expected,'hex'),Buffer.from(signature,'hex')))return res.sendStatus(401);
  const event=JSON.parse(req.body.toString('utf8'));
  if(event.event==='payment.captured'){
   const payment=event.payload?.payment?.entity;
   if(payment?.order_id&&payment?.id){const result=await beautyFinalizeCaptured(payment.order_id,payment.id);
    if(result==='not_captured'||result==='payment_review')return res.sendStatus(503);
   }
  }
  return res.status(200).json({success:true});
 }catch(e){console.error('Beauty webhook:',e.message);return res.sendStatus(503);}
});

// Expired Beauty reservations: only release after querying Razorpay; never assume a
// browser-close or failed callback means the customer was not charged.
async function beautyReconcileExpired(limit=12){
 const pending=await cosmeticsDb(`SELECT id,razorpay_order_id FROM public.cosmetics_orders
  WHERE payment_method='razorpay' AND payment_status='pending' AND status='pending'
  AND payment_expires_at < NOW() ORDER BY payment_expires_at LIMIT ?`,[limit]);
 for(const o of pending){
  try{
   const payments=await razorpayInstance.orders.fetchPayments(o.razorpay_order_id);
   const captured=(payments.items||[]).find(p=>p.status==='captured'&&p.order_id===o.razorpay_order_id);
   if(captured){await beautyFinalizeCaptured(o.razorpay_order_id,captured.id);continue;}
   // Do not release an authorised payment: it may be captured asynchronously.
   if((payments.items||[]).some(p=>p.status==='authorized'))continue;
   let client;
   try{
    client=await db.getClient();await client.query('BEGIN');
    const locked=await client.query(`SELECT id,status,payment_status FROM public.cosmetics_orders
      WHERE id=$1 FOR UPDATE`,[o.id]);
    if(locked[0]?.status==='pending'&&locked[0]?.payment_status==='pending'){
     const items=await client.query(`SELECT product_id,quantity FROM public.cosmetics_order_items WHERE order_id=$1`,[o.id]);
     for(const item of items)await client.query(`UPDATE public.cosmetics_products SET stock=stock+$1,updated_at=NOW() WHERE id=$2`,[item.quantity,item.product_id]);
     await client.query(`UPDATE public.cosmetics_orders SET status='expired',payment_status='expired',updated_at=NOW() WHERE id=$1`,[o.id]);
    }
    await client.query('COMMIT');
   }catch(e){if(client)await client.query('ROLLBACK').catch(()=>{});throw e;}
   finally{if(client)client.release();}
  }catch(e){console.error('Beauty reservation reconciliation:',o.id,e.message);}
 }
}
// Run in a single Render instance; DB row locks prevent duplicate stock releases.
setInterval(()=>{if(beautyOnlineOn())beautyReconcileExpired().catch(e=>console.error('Beauty sweep:',e.message));},15*60*1000).unref();
app.post('/api/cosmetics/reconcile-my-payment',async(req,res)=>{
 res.set('Cache-Control','no-store');
 try{
  const id=String(req.body?.order_id||''),phone=String(req.body?.phone||'');
  if(!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)||!/^[6-9]\d{9}$/.test(phone))
   return res.status(400).json({success:false,message:'Invalid order reference.'});
  const rows=await cosmeticsDb(`SELECT razorpay_order_id,payment_status,status FROM public.cosmetics_orders
    WHERE id=? AND customer_phone=? AND payment_method='razorpay'`,[id,phone]);
  if(!rows.length)return res.status(404).json({success:false,message:'Order not found.'});
  if(rows[0].payment_status==='paid')return res.json({success:true,paid:true,order_id:id});
  const payments=await razorpayInstance.orders.fetchPayments(rows[0].razorpay_order_id);
  const captured=(payments.items||[]).find(p=>p.status==='captured'&&p.order_id===rows[0].razorpay_order_id);
  if(captured){const state=await beautyFinalizeCaptured(rows[0].razorpay_order_id,captured.id);
   return res.json({success:true,paid:state==='paid',order_id:id,payment_state:state});}
  return res.json({success:true,paid:false,order_id:id,payment_state:rows[0].status});
 }catch(e){return beautyErr(res,e);}
});

// Device receipt lookup: UUID + delivery phone are both required. No public order listing.
app.post('/api/cosmetics/device-orders',async(req,res)=>{
 res.set('Cache-Control','no-store');
 try{
  const input=req.body?.receipts;
  if(!Array.isArray(input)||input.length>30)return res.status(400).json({success:false,message:'Invalid order receipts.'});
  const keys=[];
  for(const x of input){const id=String(x?.id||'');const phone=String(x?.phone||'');if(/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)&&/^[6-9]\d{9}$/.test(phone))keys.push({id,phone});}
  if(!keys.length)return res.json({success:true,orders:[]});
  const ids=[...new Set(keys.map(x=>x.id))];
  const rows=await cosmeticsDb(`SELECT o.id,o.customer_name,o.customer_phone,o.delivery_address,o.subtotal,o.delivery_fee,o.total,o.payment_method,o.payment_status,o.status,o.tracking_number,o.courier_name,o.tracking_url,o.created_at,o.updated_at FROM public.cosmetics_orders o WHERE o.id IN (${ids.map(()=>'?').join(',')})`,ids);
  const safe=rows.filter(o=>keys.some(k=>k.id===o.id&&k.phone===o.customer_phone) && (o.payment_method==='cod'||o.payment_status==='paid'||o.payment_status==='payment_review'));
  for(const o of safe){o.delivery_status=o.status;o.items=await cosmeticsDb(`SELECT i.product_id,i.product_name,i.variant,i.quantity,i.unit_price,i.total_price AS line_total,p.image_url FROM public.cosmetics_order_items i LEFT JOIN public.cosmetics_products p ON p.id=i.product_id WHERE i.order_id=?`,[o.id]);}
  return res.json({success:true,orders:safe});
 }catch(e){return beautyErr(res,e);}
});
app.get('/api/admin/cosmetics/orders',async(req,res)=>{
 try{const rows=await cosmeticsDb(`SELECT id,customer_name,customer_phone,delivery_address,subtotal,delivery_fee,total,payment_method,payment_status,status,tracking_number,courier_name,tracking_url,created_at FROM public.cosmetics_orders ORDER BY created_at DESC LIMIT 200`);return res.json({success:true,orders:rows});}catch(e){return beautyErr(res,e);}
});
app.patch('/api/admin/cosmetics/orders/:id/tracking',async(req,res)=>{
 try{if(!/^[0-9a-f-]{36}$/i.test(req.params.id))return res.status(400).json({success:false,message:'Invalid order ID.'});const status=String(req.body?.status||'').trim(),allowed=['confirmed','processing','packed','shipped','out_for_delivery','delivered'];if(!allowed.includes(status))return res.status(400).json({success:false,message:'Invalid delivery status.'});const courier=String(req.body?.courier_name||'').trim().slice(0,100),number=String(req.body?.tracking_number||'').trim().slice(0,120),url=String(req.body?.tracking_url||'').trim().slice(0,500);if(url&&!/^https:\/\//i.test(url))return res.status(400).json({success:false,message:'Tracking URL must use HTTPS.'});const rows=await cosmeticsDb(`UPDATE public.cosmetics_orders SET status=?,courier_name=?,tracking_number=?,tracking_url=?,updated_at=NOW() WHERE id=? AND (payment_method='cod' OR payment_status='paid') RETURNING id,status,tracking_number,courier_name,tracking_url`,[status,courier,number,url,req.params.id]);return rows.length?res.json({success:true,order:rows[0]}):res.status(404).json({success:false,message:'Order not found.'});}catch(e){return beautyErr(res,e);}
});


// CEROOD CLOTHING — isolated new routes, after existing admin auth.
// CEROOD CLOTHING — isolated inventory routes; no existing business tables touched.
// Included by server.js AFTER existing /api/admin authentication middleware.
const clothingDb = (sql,values=[])=>new Promise((resolve,reject)=>db.query(sql,values,(err,rows)=>err?reject(err):resolve(rows||[])));
const clothingFields = `id,name,category,brand,description,variant,shade,net_quantity,ingredients,directions,warnings,batch_number,manufacture_date,expiry_date,price,compare_price,stock,image_url,video_url,manufacturer,importer,status,created_at,updated_at`;
const clothingIdOk=id=>/^[a-zA-Z0-9_-]{1,80}$/.test(String(id||''));
const clothingError=(res,e)=>{console.error('Clothing inventory:',e.message);return res.status(e.httpStatus||503).json({success:false,message:e.httpStatus?e.message:'Clothing inventory temporarily unavailable. Check clothing schema.'});};
function clothingClean(b){
 const s=(k,n)=>String(b[k]??'').trim().slice(0,n);
 const name=s('name',140),category=s('category',80),price=Number(b.price),stock=Number(b.stock),status=s('status',20)||'draft';
 const compare_price=b.compare_price===''||b.compare_price==null?null:Number(b.compare_price);
 const image_url=s('image_url',2048),video_url=s('video_url',2048);
 if(!name||!category||!Number.isFinite(price)||price<=0||price>10000000||!Number.isSafeInteger(stock)||stock<0||stock>1000000||!['draft','published'].includes(status)||compare_price!==null&&(!Number.isFinite(compare_price)||compare_price<0))throw Object.assign(new Error('Invalid clothing name, category, price, stock or status.'),{httpStatus:400});
 if([image_url,video_url].some(u=>u&&!/^https:\/\//i.test(u)))throw Object.assign(new Error('Media must use HTTPS URLs.'),{httpStatus:400});
 if(status==='published'&&!image_url)throw Object.assign(new Error('Upload a product image before publishing.'),{httpStatus:400});
 // Clothing fields are mapped to the existing frontend form; no cosmetics table is reused.
 return {name,category,brand:s('brand',100),description:s('description',5000),variant:s('variant',100),shade:s('shade',100),net_quantity:s('net_quantity',100),ingredients:s('ingredients',5000),directions:s('directions',5000),warnings:s('warnings',5000),batch_number:s('batch_number',100),manufacture_date:null,expiry_date:null,price,compare_price,stock,image_url,video_url,manufacturer:s('manufacturer',250),importer:s('importer',250),status};
}
const clothingPublic=p=>({...p,image:p.image_url,media:[p.image_url&&{type:'image',url:p.image_url},p.video_url&&{type:'video',url:p.video_url}].filter(Boolean)});
app.get('/api/clothing/products',async(req,res)=>{try{const rows=await clothingDb(`SELECT ${clothingFields} FROM public.clothing_products WHERE status='published' ORDER BY created_at DESC LIMIT 250`);res.json({success:true,products:rows.map(clothingPublic)});}catch(e){clothingError(res,e);}});
app.get('/api/clothing/products/:id',async(req,res)=>{if(!clothingIdOk(req.params.id))return res.status(400).json({success:false,message:'Invalid product ID.'});try{const rows=await clothingDb(`SELECT ${clothingFields} FROM public.clothing_products WHERE id=? AND status='published' LIMIT 1`,[req.params.id]);return rows.length?res.json({success:true,product:clothingPublic(rows[0])}):res.status(404).json({success:false,message:'Product not found.'});}catch(e){clothingError(res,e);}});
app.get('/api/admin/clothing/products',async(req,res)=>{try{res.json({success:true,products:await clothingDb(`SELECT ${clothingFields} FROM public.clothing_products ORDER BY updated_at DESC LIMIT 500`)});}catch(e){clothingError(res,e);}});
app.post('/api/admin/clothing/products',async(req,res)=>{try{const p=clothingClean(req.body||{}),keys=Object.keys(p),id=crypto.randomUUID();const rows=await clothingDb(`INSERT INTO public.clothing_products(id,${keys.join(',')}) VALUES (?,${keys.map(()=>'?').join(',')}) RETURNING ${clothingFields}`,[id,...Object.values(p)]);res.status(201).json({success:true,product:rows[0]});}catch(e){clothingError(res,e);}});
app.put('/api/admin/clothing/products/:id',async(req,res)=>{if(!clothingIdOk(req.params.id))return res.status(400).json({success:false,message:'Invalid product ID.'});try{const p=clothingClean(req.body||{}),keys=Object.keys(p),rows=await clothingDb(`UPDATE public.clothing_products SET ${keys.map(k=>k+'=?').join(',')},updated_at=NOW() WHERE id=? RETURNING ${clothingFields}`,[...Object.values(p),req.params.id]);return rows.length?res.json({success:true,product:rows[0]}):res.status(404).json({success:false,message:'Product not found.'});}catch(e){clothingError(res,e);}});
app.delete('/api/admin/clothing/products/:id',async(req,res)=>{if(!clothingIdOk(req.params.id))return res.status(400).json({success:false,message:'Invalid product ID.'});try{const rows=await clothingDb('DELETE FROM public.clothing_products WHERE id=? RETURNING id',[req.params.id]);return rows.length?res.json({success:true,deleted_id:rows[0].id}):res.status(404).json({success:false,message:'Product not found.'});}catch(e){clothingError(res,e);}});
// CEROOD FASHION — independent ₹99 checkout. Live gates default OFF until staged tests pass.
const fashionFee=()=>99;
const fashionCodOn=()=>process.env.CLOTHING_COD_ENABLED==='true'&&process.env.CLOTHING_LIVE_CHECKOUT_ENABLED==='true';
const fashionOnlineOn=()=>process.env.CLOTHING_ONLINE_ENABLED==='true'&&process.env.CLOTHING_LIVE_CHECKOUT_ENABLED==='true'&&!!process.env.RAZORPAY_KEY_ID&&!!process.env.RAZORPAY_KEY_SECRET&&!!process.env.CLOTHING_RAZORPAY_WEBHOOK_SECRET;
const fashionFail=(res,e)=>{console.error('Fashion checkout:',e.message);return res.status(e.httpStatus||503).json({success:false,message:e.httpStatus?e.message:'Fashion checkout temporarily unavailable.'});};
const fashionBad=(message,status=400)=>{throw Object.assign(new Error(message),{httpStatus:status});};
const fashionUUID=id=>/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(String(id||''));
function fashionRequest(body){
 const a=body?.address,items=body?.items;
 if(!a||typeof a!=='object'||Array.isArray(a)||!Array.isArray(items)||items.length<1||items.length>20)fashionBad('Address and 1–20 products required.');
 const address={};for(const k of ['full_name','phone','street','area','city','district','state','pincode'])address[k]=String(a[k]||'').trim();
 if(address.full_name.length<2||address.full_name.length>140||!/^[6-9]\d{9}$/.test(address.phone)||address.street.length<5||address.street.length>500||address.area.length>200||address.city.length<2||address.city.length>100||address.district.length<2||address.district.length>100||address.state.length<2||address.state.length>100||!/^[1-9]\d{5}$/.test(address.pincode))fashionBad('Enter a complete delivery address and valid Indian mobile/PIN.');
 const counts=new Map();for(const x of items){const id=String(x?.product_id||''),qty=Number(x?.quantity);if(!clothingIdOk(id)||!Number.isSafeInteger(qty)||qty<1||qty>99)fashionBad('Invalid Fashion product or quantity.');const n=(counts.get(id)||0)+qty;if(n>99)fashionBad('Maximum 99 per product.');counts.set(id,n);}return {address,counts};
}
function fashionTotals(products,counts){
 const map=new Map(products.map(p=>[String(p.id),p]));let subtotal=0;const lines=[];
 for(const [id,qty] of counts){const p=map.get(id);if(!p||p.status!=='published'||Number(p.stock)<qty)fashionBad('Product unavailable or insufficient stock. Refresh your Fashion cart.',409);
 const price=Number(p.price),amount=price*qty;if(!Number.isSafeInteger(price)||price<=0||!Number.isSafeInteger(amount))fashionBad('Invalid Fashion product price.',409);
 subtotal+=amount;if(!Number.isSafeInteger(subtotal)||subtotal>10000000)fashionBad('Fashion order exceeds amount limit.');lines.push({product_id:id,product_name:p.name,variant:p.variant||null,quantity:qty,unit_price:price,total_price:amount});}
 return {items:lines,subtotal,delivery_fee:fashionFee(),discount:0,total:subtotal+fashionFee(),currency:'INR'};
}
async function fashionVerifiedCustomer(body,address){
 // Checkout is guest-compatible like current Fashion UI. Enable OTP gate once frontend sends accessToken.
 if(process.env.CLOTHING_GUEST_CHECKOUT_ENABLED==='false'){
 const token=String(body?.accessToken||'').trim();if(!token||token.length>8192)fashionBad('Verify mobile OTP before ordering.',401);
 const data=await verifyMsg91AccessToken(token);if(String(data?.type||'').toLowerCase()!=='success'||extractVerifiedPhoneFromMsg91(data,token)!==address.phone)fashionBad('OTP mobile does not match delivery address.',401);
 }
}
const fashionRazorpay=()=>new Razorpay({key_id:process.env.RAZORPAY_KEY_ID,key_secret:process.env.RAZORPAY_KEY_SECRET});
app.get('/api/clothing/checkout-status',(req,res)=>res.json({success:true,cod_enabled:fashionCodOn(),online_enabled:fashionOnlineOn(),live_checkout:fashionCodOn()||fashionOnlineOn(),delivery_fee:fashionFee()}));
app.post('/api/clothing/quote',async(req,res)=>{res.set('Cache-Control','no-store');try{const {counts}=fashionRequest(req.body||{}),ids=[...counts.keys()];const rows=await clothingDb(`SELECT id,name,variant,price,stock,status FROM public.clothing_products WHERE id IN (${ids.map(()=>'?').join(',')})`,ids);res.json({success:true,...fashionTotals(rows,counts),cod_enabled:fashionCodOn(),online_enabled:fashionOnlineOn()});}catch(e){fashionFail(res,e);}});
app.post('/api/clothing/place-cod-order',async(req,res)=>{
 res.set('Cache-Control','no-store');if(!fashionCodOn())return res.status(503).json({success:false,message:'Fashion COD is not enabled yet.'});let c;
 try{const {address,counts}=fashionRequest(req.body||{}),id=String(req.body?.request_id||'');if(!fashionUUID(id))fashionBad('Valid checkout request ID required.');await fashionVerifiedCustomer(req.body,address);
 c=await db.getClient();await c.query('BEGIN');await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',[id]);const existing=await c.query('SELECT id,customer_phone,total,payment_method FROM public.clothing_orders WHERE id=$1',[id]);if(existing.length){await c.query('COMMIT');if(existing[0].customer_phone!==address.phone||existing[0].payment_method!=='cod')fashionBad('Checkout request conflict.',409);return res.json({success:true,order_id:id,total:Number(existing[0].total),already_created:true});}
 const ids=[...counts.keys()],products=await c.query('SELECT id,name,variant,price,stock,status FROM public.clothing_products WHERE id=ANY($1::text[]) ORDER BY id FOR UPDATE',[ids]),t=fashionTotals(products,counts);
 await c.query(`INSERT INTO public.clothing_orders(id,request_id,customer_name,customer_phone,delivery_address,subtotal,delivery_fee,discount,total,payment_method,payment_status,status) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,0,$8,'cod','pending','confirmed')`,[id,id,address.full_name,address.phone,JSON.stringify(address),t.subtotal,t.delivery_fee,t.total]);
 for(const line of t.items){await c.query('UPDATE public.clothing_products SET stock=stock-$1,updated_at=NOW() WHERE id=$2',[line.quantity,line.product_id]);await c.query('INSERT INTO public.clothing_order_items(order_id,product_id,product_name,variant,quantity,unit_price,total_price) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,line.product_id,line.product_name,line.variant,line.quantity,line.unit_price,line.total_price]);}
 await c.query('COMMIT');return res.status(201).json({success:true,order_id:id,payment_method:'cod',...t});
 }catch(e){if(c)await c.query('ROLLBACK').catch(()=>{});return fashionFail(res,e);}finally{if(c)c.release();}
});
app.post('/api/clothing/create-razorpay-order',async(req,res)=>{
 res.set('Cache-Control','no-store');if(!fashionOnlineOn())return res.status(503).json({success:false,message:'Fashion online payment is not enabled yet.'});let c;
 try{const {address,counts}=fashionRequest(req.body||{}),id=String(req.body?.request_id||'');if(!fashionUUID(id))fashionBad('Valid checkout request ID required.');await fashionVerifiedCustomer(req.body,address);
 c=await db.getClient();await c.query('BEGIN');await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',[id]);const existing=await c.query('SELECT id,customer_phone,payment_method,payment_status,razorpay_order_id,total FROM public.clothing_orders WHERE id=$1 FOR UPDATE',[id]);
 if(existing.length){const o=existing[0];await c.query('COMMIT');if(o.customer_phone!==address.phone||o.payment_method!=='razorpay')fashionBad('Checkout request conflict.',409);if(o.payment_status==='paid')return res.json({success:true,already_paid:true,order_id:id,total:Number(o.total)});if(o.payment_status==='payment_review'||!o.razorpay_order_id)fashionBad('Payment requires support review.',409);return res.json({success:true,order_id:id,razorpay_order_id:o.razorpay_order_id,key_id:process.env.RAZORPAY_KEY_ID,amount:Math.round(Number(o.total)*100),currency:'INR',total:Number(o.total)});}
 const ids=[...counts.keys()],products=await c.query('SELECT id,name,variant,price,stock,status FROM public.clothing_products WHERE id=ANY($1::text[]) ORDER BY id FOR UPDATE',[ids]),t=fashionTotals(products,counts);
 const r=await fashionRazorpay().orders.create({amount:Math.round(t.total*100),currency:'INR',receipt:id,notes:{business:'cerood_fashion',fashion_order_id:id}});
 await c.query(`INSERT INTO public.clothing_orders(id,request_id,customer_name,customer_phone,delivery_address,subtotal,delivery_fee,discount,total,payment_method,payment_status,status,razorpay_order_id) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,0,$8,'razorpay','pending','pending',$9)`,[id,id,address.full_name,address.phone,JSON.stringify(address),t.subtotal,t.delivery_fee,t.total,r.id]);
 for(const line of t.items)await c.query('INSERT INTO public.clothing_order_items(order_id,product_id,product_name,variant,quantity,unit_price,total_price) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,line.product_id,line.product_name,line.variant,line.quantity,line.unit_price,line.total_price]);
 await c.query('COMMIT');return res.status(201).json({success:true,order_id:id,razorpay_order_id:r.id,key_id:process.env.RAZORPAY_KEY_ID,amount:Math.round(t.total*100),currency:'INR',total:t.total});
 }catch(e){if(c)await c.query('ROLLBACK').catch(()=>{});return fashionFail(res,e);}finally{if(c)c.release();}
});
async function fashionFinalize(orderId,paymentId){
 const orders=await clothingDb(`SELECT id,total,payment_status,razorpay_payment_id FROM public.clothing_orders WHERE razorpay_order_id=? AND payment_method='razorpay'`,[orderId]);if(!orders.length)return 'not_found';
 const p=await fashionRazorpay().payments.fetch(paymentId);if(p.order_id!==orderId||p.currency!=='INR'||Number(p.amount)!==Math.round(Number(orders[0].total)*100)||p.status!=='captured')return 'not_captured';
 let c;try{c=await db.getClient();await c.query('BEGIN');const rows=await c.query(`SELECT id,payment_status,razorpay_payment_id,status FROM public.clothing_orders WHERE razorpay_order_id=$1 AND payment_method='razorpay' FOR UPDATE`,[orderId]);const o=rows[0];if(!o){await c.query('ROLLBACK');return 'not_found';}if(o.payment_status==='paid'){await c.query('COMMIT');return o.razorpay_payment_id===paymentId?'paid':'payment_review';}if(o.payment_status==='payment_review'||o.razorpay_payment_id&&o.razorpay_payment_id!==paymentId){await c.query('ROLLBACK');return 'payment_review';}
 const lines=await c.query('SELECT product_id,quantity FROM public.clothing_order_items WHERE order_id=$1 ORDER BY product_id',[o.id]);const products=await c.query('SELECT id,stock,status FROM public.clothing_products WHERE id=ANY($1::text[]) ORDER BY id FOR UPDATE',[lines.map(x=>x.product_id)]);const map=new Map(products.map(x=>[x.id,x]));
 if(o.status!=='pending'||lines.some(x=>!map.has(x.product_id)||map.get(x.product_id).status!=='published'||Number(map.get(x.product_id).stock)<Number(x.quantity))){await c.query(`UPDATE public.clothing_orders SET payment_status='payment_review',razorpay_payment_id=$2,updated_at=NOW() WHERE id=$1`,[o.id,paymentId]);await c.query('COMMIT');return 'payment_review';}
 for(const x of lines)await c.query('UPDATE public.clothing_products SET stock=stock-$1,updated_at=NOW() WHERE id=$2',[x.quantity,x.product_id]);await c.query(`UPDATE public.clothing_orders SET payment_status='paid',status='confirmed',razorpay_payment_id=$2,updated_at=NOW() WHERE id=$1`,[o.id,paymentId]);await c.query('COMMIT');return 'paid';
 }catch(e){if(c)await c.query('ROLLBACK').catch(()=>{});throw e;}finally{if(c)c.release();}
}
app.post('/api/clothing/verify-razorpay-payment',async(req,res)=>{res.set('Cache-Control','no-store');try{const orderId=String(req.body?.razorpay_order_id||''),paymentId=String(req.body?.razorpay_payment_id||''),signature=String(req.body?.razorpay_signature||'');if(!fashionOnlineOn())fashionBad('Fashion payment verification unavailable.',503);if(!/^order_[A-Za-z0-9]+$/.test(orderId)||!/^pay_[A-Za-z0-9]+$/.test(paymentId)||!/^[0-9a-f]{64}$/i.test(signature))fashionBad('Invalid payment details.');const expected=crypto.createHmac('sha256',process.env.RAZORPAY_KEY_SECRET).update(orderId+'|'+paymentId).digest('hex');if(!crypto.timingSafeEqual(Buffer.from(expected,'hex'),Buffer.from(signature,'hex')))fashionBad('Invalid payment signature.',401);const result=await fashionFinalize(orderId,paymentId);if(result!=='paid')fashionBad(result==='not_captured'?'Payment capture pending. Do not pay again.':'Payment needs support review. Do not pay again.',409);const rows=await clothingDb('SELECT id,total FROM public.clothing_orders WHERE razorpay_order_id=?',[orderId]);res.json({success:true,order_id:rows[0].id,total:Number(rows[0].total),payment_status:'paid'});}catch(e){fashionFail(res,e);}});
app.post('/api/clothing/recover-razorpay-payment',async(req,res)=>{res.set('Cache-Control','no-store');try{const id=String(req.body?.order_id||''),phone=String(req.body?.phone||'');if(!fashionUUID(id)||!/^[6-9]\d{9}$/.test(phone))fashionBad('Valid order ID and phone required.');const rows=await clothingDb(`SELECT id,customer_phone,total,payment_status,razorpay_order_id FROM public.clothing_orders WHERE id=? AND payment_method='razorpay'`,[id]);if(!rows.length||rows[0].customer_phone!==phone)fashionBad('Order not found.',404);const o=rows[0];if(o.payment_status==='paid')return res.json({success:true,paid:true,order_id:id,total:Number(o.total)});if(o.payment_status==='payment_review')return res.json({success:true,paid:false,payment_state:'payment_review',order_id:id});if(!fashionOnlineOn())fashionBad('Fashion recovery temporarily unavailable.',503);const payments=await fashionRazorpay().orders.fetchPayments(o.razorpay_order_id),captured=(payments.items||[]).find(x=>x.status==='captured'&&x.order_id===o.razorpay_order_id);if(!captured)return res.json({success:true,paid:false,order_id:id});const state=await fashionFinalize(o.razorpay_order_id,captured.id);res.json({success:true,paid:state==='paid',payment_state:state,order_id:id,total:Number(o.total)});}catch(e){fashionFail(res,e);}});
app.post('/api/clothing/razorpay-webhook',async(req,res)=>{try{const secret=process.env.CLOTHING_RAZORPAY_WEBHOOK_SECRET||'',signature=String(req.get('x-razorpay-signature')||'');if(!secret||!Buffer.isBuffer(req.body)||!/^[0-9a-f]{64}$/i.test(signature))return res.sendStatus(401);const expected=crypto.createHmac('sha256',secret).update(req.body).digest('hex');if(!crypto.timingSafeEqual(Buffer.from(expected,'hex'),Buffer.from(signature,'hex')))return res.sendStatus(401);const event=JSON.parse(req.body.toString('utf8'));if(event.event==='payment.captured'){const p=event.payload?.payment?.entity;if(p?.order_id&&p?.id){const state=await fashionFinalize(p.order_id,p.id);if(state==='not_captured')return res.sendStatus(503);}}return res.json({success:true});}catch(e){console.error('Fashion webhook:',e.message);return res.sendStatus(503);}});
app.get('/api/admin/clothing/orders',async(req,res)=>{try{const rows=await clothingDb(`SELECT id,customer_name,customer_phone,delivery_address,subtotal,delivery_fee,total,payment_method,payment_status,status,tracking_number,courier_name,tracking_url,created_at FROM public.clothing_orders ORDER BY created_at DESC LIMIT 300`);res.json({success:true,orders:rows});}catch(e){fashionFail(res,e);}});
app.patch('/api/admin/clothing/orders/:id/tracking',async(req,res)=>{try{if(!fashionUUID(req.params.id))fashionBad('Invalid Fashion order ID.');const status=String(req.body?.status||''),allowed=['confirmed','processing','packed','shipped','out_for_delivery','delivered'];if(!allowed.includes(status))fashionBad('Invalid delivery status.');const courier=String(req.body?.courier_name||'').trim().slice(0,100),tracking=String(req.body?.tracking_number||'').trim().slice(0,120),url=String(req.body?.tracking_url||'').trim().slice(0,500);if(url&&!/^https:\/\//i.test(url))fashionBad('Tracking URL must use HTTPS.');const rows=await clothingDb(`UPDATE public.clothing_orders SET status=?,courier_name=?,tracking_number=?,tracking_url=?,updated_at=NOW() WHERE id=? AND (payment_method='cod' OR payment_status='paid') RETURNING id,status,tracking_number,courier_name,tracking_url`,[status,courier,tracking,url,req.params.id]);return rows.length?res.json({success:true,order:rows[0]}):res.status(404).json({success:false,message:'Order not found.'});}catch(e){fashionFail(res,e);}});




// CEROOD FASHION — receipt-bound customer tracking (separate from other stores).
// A checkout receipt contains an unpredictable order UUID and the checkout phone.
// Never accept a phone-only lookup or return other customers' orders.
app.post('/api/clothing/device-orders',async(req,res)=>{
 res.set('Cache-Control','no-store');
 try{
  const receipts=req.body?.receipts;
  if(!Array.isArray(receipts)||receipts.length>30)return res.status(400).json({success:false,message:'Invalid Fashion receipts.'});
  const valid=new Map();
  for(const x of receipts){
   const id=String(x?.id||''),request=String(x?.request_id||''),phone=String(x?.phone||'');
   if(fashionUUID(id)&&id===request&&/^[6-9]\d{9}$/.test(phone))valid.set(id,phone);
  }
  if(!valid.size)return res.json({success:true,orders:[]});
  const ids=[...valid.keys()];
  const rows=await clothingDb(`SELECT id,customer_name,customer_phone,delivery_address,subtotal,delivery_fee,discount,total,payment_method,payment_status,status,courier_name,tracking_number,tracking_url,created_at,updated_at FROM public.clothing_orders WHERE id=ANY(?::uuid[]) ORDER BY created_at DESC LIMIT 30`,[ids]);
  const allowed=rows.filter(o=>valid.get(o.id)===o.customer_phone);
  if(!allowed.length)return res.json({success:true,orders:[]});
  const items=await clothingDb(`SELECT i.order_id,i.product_id,i.product_name,i.variant,i.quantity,i.unit_price,i.total_price,p.image_url FROM public.clothing_order_items i LEFT JOIN public.clothing_products p ON p.id=i.product_id WHERE i.order_id=ANY(?::uuid[]) ORDER BY i.id`,[allowed.map(o=>o.id)]);
  const grouped=new Map();for(const item of items){if(!grouped.has(item.order_id))grouped.set(item.order_id,[]);grouped.get(item.order_id).push({...item,line_total:Number(item.total_price)});}
  return res.json({success:true,orders:allowed.map(o=>({
   ...o,status:o.payment_method==='cod'?'pending':o.payment_status,
   delivery_status:o.status,items:grouped.get(o.id)||[],
   status_timestamps:{confirmed:o.created_at,...(o.status==='delivered'?{delivered:o.updated_at}:{})}
  }))});
 }catch(e){return fashionFail(res,e);}
});
