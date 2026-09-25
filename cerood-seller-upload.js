
'use strict';

// ==========================================
// CEROOD SELLER MEDIA UPLOAD
// Seller authentication required
// ==========================================

const multer = require('multer');
const axios = require('axios');
const crypto = require('crypto');

module.exports = function registerSellerUpload(
    app,
    requireSellerAuth
) {

    const BUCKET = 'catus-images';

    const MAX_FILE_SIZE =
        25 * 1024 * 1024;


    // ======================================
    // ALLOWED MEDIA TYPES
    // ======================================

    const allowedTypes = {

        'image/jpeg': '.jpg',

        'image/png': '.png',

        'image/webp': '.webp',

        'video/mp4': '.mp4',

        'video/webm': '.webm'

    };


    const sellerUpload = multer({

        storage: multer.memoryStorage(),

        limits: {

            fileSize: MAX_FILE_SIZE,

            files: 1

        },

        fileFilter: (req, file, cb) => {

            if (
                !allowedTypes[file.mimetype]
            ) {

                return cb(
                    new Error(
                        'Only JPG, PNG, WebP, MP4 and WebM files are allowed.'
                    )
                );

            }

            cb(null, true);

        }

    }).single('file');


    // ======================================
    // VERIFY FILE SIGNATURE
    // ======================================

    function matchesFileType(
        buffer,
        mime
    ) {

        if (!buffer || buffer.length < 12) {
            return false;
        }

        if (mime === 'image/jpeg') {

            return (
                buffer[0] === 0xff &&
                buffer[1] === 0xd8 &&
                buffer[2] === 0xff
            );

        }

        if (mime === 'image/png') {

            return (
                buffer.subarray(0, 8).equals(
                    Buffer.from([
                        137, 80, 78, 71,
                        13, 10, 26, 10
                    ])
                )
            );

        }

        if (mime === 'image/webp') {

            return (
                buffer.toString(
                    'ascii', 0, 4
                ) === 'RIFF' &&

                buffer.toString(
                    'ascii', 8, 12
                ) === 'WEBP'
            );

        }

        if (mime === 'video/mp4') {

            return (
                buffer.toString(
                    'ascii', 4, 8
                ) === 'ftyp'
            );

        }

        if (mime === 'video/webm') {

            return (
                buffer.subarray(0, 4).equals(
                    Buffer.from([
                        0x1a, 0x45,
                        0xdf, 0xa3
                    ])
                )
            );

        }

        return false;

    }


    // ======================================
    // SELLER UPLOAD ENDPOINT
    // ======================================

    app.post(

        '/api/sellers/upload-media',

        requireSellerAuth,

        (req, res) => {

            sellerUpload(
                req,
                res,
                async error => {

                    if (error) {

                        return res.status(
                            400
                        ).json({

                            success: false,

                            message:
                                error.code ===
                                'LIMIT_FILE_SIZE'

                                    ? 'Maximum file size is 25 MB.'

                                    : error.message

                        });

                    }


                    try {

                        if (!req.file) {

                            return res.status(
                                400
                            ).json({

                                success: false,

                                message:
                                    'Select a product photo or video.'

                            });

                        }


                        // ==================
                        // FILE VERIFICATION
                        // ==================

                        if (

                            !matchesFileType(

                                req.file.buffer,

                                req.file.mimetype

                            )

                        ) {

                            return res.status(
                                400
                            ).json({

                                success: false,

                                message:
                                    'File content does not match its media type.'

                            });

                        }


                        // ==================
                        // SUPABASE SETTINGS
                        // ==================

                        const SUPABASE_URL =

                            String(

                                process.env.SUPABASE_URL ||

                                process.env.PROJECT_URL ||

                                ''

                            )

                            .replace(
                                /\/rest\/v1\/?$/,
                                ''
                            )

                            .replace(
                                /\/$/,
                                ''
                            );


                        const SUPABASE_KEY =

                            process.env.SUPABASE_SECRET_KEY ||

                            process.env.SUPABASE_SERVICE_ROLE_KEY ||

                            process.env.SUPABASE_SERVICE_KEY ||

                            '';


                        if (

                            !SUPABASE_URL ||

                            !SUPABASE_KEY

                        ) {

                            return res.status(
                                500
                            ).json({

                                success: false,

                                message:
                                    'Storage configuration missing.'

                            });

                        }


                        // ==================
                        // SAFE STORAGE PATH
                        // ==================

                        const isVideo =

                            req.file.mimetype.startsWith(
                                'video/'
                            );


                        const mediaType =

                            isVideo

                                ? 'videos'

                                : 'images';


                        const extension =

                            allowedTypes[
                                req.file.mimetype
                            ];


                        const sellerId =

                            String(
                                req.seller.id
                            );


                        const fileName =

                            crypto.randomUUID() +

                            extension;


                        const storagePath =

                            'seller-products/' +

                            sellerId + '/' +

                            mediaType + '/' +

                            fileName;


                        // ==================
                        // UPLOAD TO SUPABASE
                        // ==================

                        const uploadUrl =

                            SUPABASE_URL +

                            '/storage/v1/object/' +

                            BUCKET + '/' +

                            storagePath;


                        await axios.post(

                            uploadUrl,

                            req.file.buffer,

                            {

                                headers: {

                                    Authorization:

                                        'Bearer ' +
                                        SUPABASE_KEY,

                                    apikey:
                                        SUPABASE_KEY,

                                    'Content-Type':

                                        req.file.mimetype,

                                    'x-upsert':
                                        'false'

                                },

                                maxBodyLength:
                                    MAX_FILE_SIZE,

                                timeout:
                                    60000

                            }

                        );


                        // ==================
                        // PUBLIC MEDIA URL
                        // ==================

                        const publicUrl =

                            SUPABASE_URL +

                            '/storage/v1/object/public/' +

                            BUCKET + '/' +

                            storagePath;


                        return res.status(
                            201
                        ).json({

                            success: true,

                            message:
                                'Product media uploaded successfully.',

                            url:
                                publicUrl,

                            media_type:

                                isVideo

                                    ? 'video'

                                    : 'image',

                            storage_path:
                                storagePath

                        });


                    } catch (uploadError) {

                        console.error(

                            'Seller media upload failed:',

                            uploadError.response?.status ||

                            uploadError.message

                        );


                        return res.status(
                            500
                        ).json({

                            success: false,

                            message:
                                'Unable to upload product media.'

                        });

                    }

                }

            );

        }

    );

};
