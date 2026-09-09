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
        fileSize: 5 * 1024 * 1024 // 5 MB
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
                message: 'No image uploaded'
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
            message: 'Image upload failed',
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
app.post('/api/login-password', (req, res) => {
    const { phone, password } = req.body;
    const query = 'SELECT * FROM users WHERE phone = ?';
    db.query(query, [phone], async (err, results) => {
        if (err) return res.status(500).json({ success: false, error: err.message });
        
        if (results && results.length > 0) {
            const user = results[0];
            // Passwords-ah trim panrathu space error-ai thavirkkum
            if (await bcrypt.compare(String(password), String(user.password))) {
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
                    payment_verification
                        .razorpay_order_id +
                    '|' +
                    payment_verification
                        .razorpay_payment_id;

                const expectedSignature =
                    crypto
                        .createHmac(
                            'sha256',
                            process.env
                                .RAZORPAY_KEY_SECRET
                        )
                        .update(
                            verificationBody
                        )
                        .digest('hex');

                if (
                    expectedSignature ===
                    payment_verification
                        .razorpay_signature
                ) {
                    safeStatus = 'Paid';
                } else {
                    return res
                        .status(400)
                        .json({
                            success: false,
                            message:
                                'Invalid Razorpay payment verification.'
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

            let insertedOrders = [];
            let insertIndex = 0;

            function insertNextOrder() {

                if (
                    insertIndex >=
                    orderRows.length
                ) {
                    return res.json({
                        success: true,
                        message:
                            'Separate service orders created successfully!',
                        total_amount:
                            finalAmount,
                        orders:
                            insertedOrders
                    });
                }

                const order =
                    orderRows[insertIndex];

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
                    order.amount,
order_date,
'Pending',
safeStatus === 'Paid' ? 'Paid' : 'Pending',
safeStatus === 'Paid' ? 'Online' : 'Pay Later'
                ];

                db.query(
                    insertQuery,
                    values,
                    (insertErr) => {

                        if (insertErr) {

                            console.error(
                                'Bulk Insert Order Error:',
                                insertErr.message
                            );

                            return res
                                .status(500)
                                .json({
                                    success: false,
                                    message:
                                        'Unable to create all service orders.',
                                    error:
                                        insertErr.message
                                });
                        }

                        insertedOrders.push(
                            order
                        );

                        insertIndex++;

                        insertNextOrder();
                    }
                );
            }

            insertNextOrder();
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
    finalAmount,
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

// Protect every /api/admin/* route below this line
app.use('/api/admin', requireAdminAuth);

// ==========================================
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

const finalAmount =
    subtotal +
    convenienceFee +
    taxes;

        
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
            assigned_at = COALESCE(
                assigned_at,
                CURRENT_TIMESTAMP
            )
        WHERE order_id = ?
        RETURNING
            order_id,
            technician_id,
            technician_name,
            technician_phone,
            status
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
    
    db.query(query, [title, subtitle, image_url, product_id, bg_color || '#f4f3f1', text_color || '#111', button_text || 'Book now'], (err, result) => {
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
// HOMEPAGE PROMO BANNERS
// ==========================================

// Public - Index page
app.get('/api/promo-banners', (req, res) => {

    const query = `
        SELECT *
        FROM public.promo_banners
        WHERE is_active = TRUE
        ORDER BY slot_no ASC
    `;

    db.query(query, [], (err, results) => {

        if (err) {
            console.error('Promo Banners Fetch Error:', err);

            return res.status(500).json({
                success: false,
                error: err.message
            });
        }

        res.json({
            success: true,
            banners: results || []
        });
    });
});


// Admin - Get both promo slots
app.get('/api/admin/promo-banners', (req, res) => {

    const query = `
        SELECT *
        FROM public.promo_banners
        ORDER BY slot_no ASC
    `;

    db.query(query, [], (err, results) => {

        if (err) {
            console.error('Admin Promo Fetch Error:', err);

            return res.status(500).json({
                success: false,
                error: err.message
            });
        }

        res.json({
            success: true,
            banners: results || []
        });
    });
});


// Admin - Save / Update promo banner
app.post('/api/admin/update-promo-banner', (req, res) => {

    const {
        slot_no,
        image_url,
        title,
        tag,
        button_text,
        service_id,
        is_active
    } = req.body;

    const slot = Number(slot_no);

    if (slot !== 1 && slot !== 2) {
        return res.status(400).json({
            success: false,
            message: 'Invalid promo banner slot.'
        });
    }

    const oldQuery = `
        SELECT image_url
        FROM public.promo_banners
        WHERE slot_no = ?
        LIMIT 1
    `;

    db.query(oldQuery, [slot], (findErr, oldRows) => {

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
            INSERT INTO public.promo_banners
            (
                slot_no,
                image_url,
                title,
                tag,
                button_text,
                service_id,
                is_active,
                updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, NOW())

            ON CONFLICT (slot_no)
            DO UPDATE SET
                image_url = EXCLUDED.image_url,
                title = EXCLUDED.title,
                tag = EXCLUDED.tag,
                button_text = EXCLUDED.button_text,
                service_id = EXCLUDED.service_id,
                is_active = EXCLUDED.is_active,
                updated_at = NOW()

            RETURNING *
        `;

        db.query(
            query,
            [
                slot,
                String(image_url || '').trim(),
                String(title || '').trim(),
                String(tag || '').trim(),
                String(button_text || 'Book now').trim(),
                String(service_id || '').trim(),
                is_active === false ? false : true
            ],
            async (err, results) => {

                if (err) {
                    console.error(
                        'Promo Banner Update Error:',
                        err
                    );

                    return res.status(500).json({
                        success: false,
                        error: err.message
                    });
                }

                const newImageUrl =
                    String(image_url || '').trim();

                if (
                    oldImageUrl &&
                    oldImageUrl !== newImageUrl
                ) {
                    await deleteSupabaseImage(oldImageUrl);
                }

                res.json({
                    success: true,
                    message: 'Promo banner updated successfully!',
                    banner: results?.[0] || null
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

    const query =
        'SELECT * FROM product_reviews WHERE service_id = ? ORDER BY id DESC';

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
                (serviceErr, serviceRows) => {

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
                                (SITEMAP_MAX_URLS - 1) /
                                totalServices
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
                        (SITEMAP_MAX_URLS - 1) /
                        sitemapServices.length
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
    ORDER BY id
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

                            // Homepage only sitemap-1
                            if (page === 1) {
                                urls.push(
                                    `${frontendBase}/`
                                );
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

                                            urls.push(
                                                `${frontendBase}/${stateSlug}/${districtSlug}/${locationSlug}/${service.slug}`
                                            );
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
                    `https://www.cerood.com/` +
                    `${stateSlug}/` +
                    `${districtSlug}/` +
                    `${locationSlug}/` +
                    `${serviceSlug}`;

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
    ' Near Me | Doorstep Repair & Service'
) AS seo_title,

(
    'Book ' ||
    LOWER(s.service_name) ||
    ' in ' ||
    l.location_name ||
    ', ' ||
    l.district ||
    '. Doorstep appliance service by Cerood with easy online booking and local service support.'
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
 
initDatabase();