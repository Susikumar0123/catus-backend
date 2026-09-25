
'use strict';
// Authenticated seller-only media upload. Does not change Home Services uploads.

const crypto = require('crypto');
const multer = require('multer');
const axios = require('axios');

module.exports = function registerSellerMedia(app, requireSellerAuth) {
  const MAX_IMAGE = 10 * 1024 * 1024;
  const MAX_VIDEO = 25 * 1024 * 1024;

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: MAX_VIDEO,
      files: 1,
      fields: 0
    },

    fileFilter(req, file, cb) {
      if (
        ![
          'image/jpeg',
          'image/png',
          'image/webp',
          'video/mp4',
          'video/webm'
        ].includes(file.mimetype)
      ) {
        return cb(
          Object.assign(
            new Error('Use JPG, PNG, WebP, MP4 or WebM.'),
            {status:400}
          )
        );
      }

      cb(null, true);
    }
  }).single('file');

  function detectType(b) {
    if (
      b.length >= 3 &&
      b.subarray(0,3).equals(
        Buffer.from([0xff,0xd8,0xff])
      )
    ) {
      return ['image/jpeg','jpg'];
    }

    if (
      b.length >= 8 &&
      b.subarray(0,8).equals(
        Buffer.from([137,80,78,71,13,10,26,10])
      )
    ) {
      return ['image/png','png'];
    }

    if (
      b.length >= 12 &&
      b.toString('ascii',0,4)==='RIFF' &&
      b.toString('ascii',8,12)==='WEBP'
    ) {
      return ['image/webp','webp'];
    }

    if (
      b.length >= 12 &&
      b.toString('ascii',4,8)==='ftyp' &&
      [
        'isom',
        'iso2',
        'mp41',
        'mp42',
        'avc1',
        'M4V ',
        'MSNV'
      ].includes(
        b.toString('ascii',8,12)
      )
    ) {
      return ['video/mp4','mp4'];
    }

    if (
      b.length >= 4 &&
      b.subarray(0,4).equals(
        Buffer.from([0x1a,0x45,0xdf,0xa3])
      )
    ) {
      return ['video/webm','webm'];
    }

    return null;
  }

  app.post(
    '/api/sellers/upload-media',
    requireSellerAuth,
    (req,res) => {

      upload(req,res,async error => {
        if (error) {
          return res.status(
            error.status ||
            (
              error.code === 'LIMIT_FILE_SIZE'
                ? 413
                : 400
            )
          ).json({
            success:false,
            message:
              error.code === 'LIMIT_FILE_SIZE'
                ? 'File exceeds 25 MB.'
                : error.message
          });
        }

        try {
          if (!req.file) {
            return res.status(400).json({
              success:false,
              message:'Select a product photo or video.'
            });
          }

          const detected = detectType(
            req.file.buffer
          );

          if (
            !detected ||
            detected[0] !== req.file.mimetype
          ) {
            return res.status(400).json({
              success:false,
              message:'File contents do not match its media type.'
            });
          }

          if (
            detected[0].startsWith('image/') &&
            req.file.size > MAX_IMAGE
          ) {
            return res.status(413).json({
              success:false,
              message:'Product photos must be 10 MB or smaller.'
            });
          }

          const url = String(
            process.env.SUPABASE_URL ||
            process.env.PROJECT_URL ||
            ''
          )
            .replace(/\/rest\/v1\/?$/,'')
            .replace(/\/$/,'');

          const key =
            process.env.SUPABASE_SECRET_KEY ||
            process.env.SUPABASE_SERVICE_ROLE_KEY ||
            process.env.SUPABASE_SERVICE_KEY;

          if (!url || !key) {
            return res.status(503).json({
              success:false,
              message:'Media storage is not configured.'
            });
          }

          const storagePath =
            `seller-products/${req.seller.id}/` +
            `${crypto.randomUUID()}.${detected[1]}`;

          await axios.post(
            `${url}/storage/v1/object/catus-images/${storagePath}`,
            req.file.buffer,
            {
              headers: {
                Authorization:`Bearer ${key}`,
                apikey:key,
                'Content-Type':detected[0],
                'x-upsert':'false'
              },

              maxBodyLength:MAX_VIDEO + 1024,
              timeout:60000
            }
          );

          return res.status(201).json({
            success:true,
            url:
              `${url}/storage/v1/object/public/` +
              `catus-images/${storagePath}`,
            media_type:detected[0]
          });

        } catch(e) {
          console.error(
            'Seller media upload:',
            e.response?.status || e.message
          );

          return res.status(502).json({
            success:false,
            message:
              'Media upload failed. Check Supabase storage and try again.'
          });
        }
      });
    }
  );
};
