
'use strict';

// CEROOD seller inventory and product approval.
// No payment/order modifications.

const crypto = require('crypto');

module.exports = function registerSellerProductRoutes(
  app,
  db,
  requireSellerAuth,
  requireAdminAuth
) {

  const query = (sql, values = []) =>
    new Promise((resolve, reject) => {

      db.query(sql, values, (error, rows) => {

        if (error) {
          return reject(error);
        }

        resolve(rows || []);

      });

    });


  const fields = `
    id,
    seller_id,
    name,
    category,
    condition,
    brand,
    model,
    price,
    compare_price,
    stock,
    warranty_days,
    location,
    delivery,
    image_url,
    video_url,
    known_defects,
    accessories,
    warranty_terms,
    status,
    approval_status,
    created_at,
    updated_at
  `;


  const categories = new Set([
    'tv',
    'refrigerator',
    'washing-machine',
    'ac',
    'laptop',
    'other'
  ]);


  const conditions = new Set([
    'Refurbished',
    'Pre-owned',
    'Open box'
  ]);


  const uuid = value =>

    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      String(value || '')
    );


  const bad = message =>

    Object.assign(
      new Error(message),
      { status: 400 }
    );


  const err = (res, error) => {

    console.error(
      'Seller products:',
      error.message
    );

    return res.status(
      error.status || 500
    ).json({

      success: false,

      message: error.status
        ? error.message
        : 'Product service unavailable.'

    });

  };


  // ==========================================
  // VALIDATE SELLER PRODUCT
  // ==========================================

  function clean(body) {

    const text = (key, maxLength) =>

      String(
        body[key] ?? ''
      ).trim().slice(0, maxLength);


    const integer = (key, min, max) => {

      const value = Number(
        body[key]
      );

      if (

        body[key] === '' ||

        body[key] == null ||

        !Number.isSafeInteger(value) ||

        value < min ||

        value > max

      ) {

        throw bad(
          `Invalid ${key}.`
        );

      }

      return value;

    };


    const name =
      text('name', 140);

    const category =
      text('category', 40);

    const condition =
      text('condition', 40);


    if (

      !name ||

      !categories.has(category) ||

      !conditions.has(condition)

    ) {

      throw bad(
        'Name, category and condition are required.'
      );

    }


    const price =
      integer('price', 1, 100000000);

    const stock =
      integer('stock', 0, 99999);

    const warranty_days =
      integer('warranty_days', 0, 3650);


    const compare_price =

      body.compare_price === '' ||

      body.compare_price == null

        ? null

        : integer(
            'compare_price',
            0,
            100000000
          );


    const image_url =
      text('image_url', 2048);

    const video_url =
      text('video_url', 2048);


    const storageUrl = String(

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


    const prefix =

      storageUrl +

      '/storage/v1/object/public/catus-images/';


    if (

      !storageUrl ||

      !image_url.startsWith(prefix) ||

      image_url.length <= prefix.length ||

      /[?#]/.test(image_url)

    ) {

      throw bad(
        'Upload an actual product photo to CEROOD storage first.'
      );

    }


    if (

      video_url && (

        !video_url.startsWith(prefix) ||

        video_url.length <= prefix.length ||

        /[?#]/.test(video_url)

      )

    ) {

      throw bad(
        'Video must be uploaded to CEROOD storage.'
      );

    }


    const known_defects =
      text('known_defects', 2000);

    const warranty_terms =
      text('warranty_terms', 1500);


    if (

      !known_defects ||

      !warranty_terms

    ) {

      throw bad(
        'Describe known defects (or None) and warranty terms.'
      );

    }


    return {

      name,

      category,

      condition,

      brand:
        text('brand', 80),

      model:
        text('model', 80),

      price,

      compare_price,

      stock,

      warranty_days,

      location:
        text('location', 100),

      delivery:
        text('delivery', 160),

      image_url,

      video_url,

      known_defects,

      accessories: Array.isArray(
    body.accessories
)
    ? body.accessories
        .slice(0, 30)
        .map(item =>
            String(item)
                .trim()
                .slice(0, 100)
        )
        .filter(Boolean)
    : [],

      warranty_terms

    };

  }


  // ==========================================
  // SELLER — MY PRODUCTS
  // ==========================================

  app.get(

    '/api/sellers/products',

    requireSellerAuth,

    async (req, res) => {

      try {

        const products = await query(

          `
          SELECT ${fields}

          FROM public.renewed_products

          WHERE seller_id = ?

          ORDER BY created_at DESC

          LIMIT 250
          `,

          [
            req.seller.id
          ]

        );


        return res.json({

          success: true,

          products

        });


      } catch (error) {

        return err(res, error);

      }

    }

  );


  // ==========================================
  // SELLER — ADD PRODUCT
  // ==========================================

  app.post(

    '/api/sellers/products',

    requireSellerAuth,

    async (req, res) => {

      try {

        const product = clean(
          req.body || {}
        );


        const keys =
          Object.keys(product);


        const id =
          crypto.randomUUID();


        const products = await query(

          `
          INSERT INTO public.renewed_products

          (
            id,
            seller_id,
            ${keys.join(',')},
            status,
            approval_status
          )

          VALUES

          (
            ?,
            ?,
            ${keys.map(() => '?').join(',')},
            'draft',
            'pending'
          )

          RETURNING ${fields}
          `,

          [

            id,

            req.seller.id,

            ...Object.values(product)

          ]

        );


        return res.status(201).json({

          success: true,

          product: products[0]

        });


      } catch (error) {

        return err(res, error);

      }

    }

  );


  // ==========================================
  // SELLER — EDIT OWN PRODUCT
  // ==========================================

  app.put(

    '/api/sellers/products/:id',

    requireSellerAuth,

    async (req, res) => {

      try {

        if (!uuid(req.params.id)) {

          throw bad(
            'Invalid product ID.'
          );

        }


        const product = clean(
          req.body || {}
        );


        const keys =
          Object.keys(product);


        const products = await query(

          `
          UPDATE public.renewed_products

          SET

            ${keys.map(
              key => `${key} = ?`
            ).join(',')},

            status = 'draft',

            approval_status = 'pending',

            updated_at = NOW()

          WHERE

            id = ?

            AND seller_id = ?

          RETURNING ${fields}
          `,

          [

            ...Object.values(product),

            req.params.id,

            req.seller.id

          ]

        );


        if (!products.length) {

          return res.status(404).json({

            success: false,

            message:
              'Your product was not found.'

          });

        }


        return res.json({

          success: true,

          product: products[0]

        });


      } catch (error) {

        return err(res, error);

      }

    }

  );


  // ==========================================
  // SELLER — WITHDRAW PRODUCT
  // ==========================================

  app.patch(

    '/api/sellers/products/:id/withdraw',

    requireSellerAuth,

    async (req, res) => {

      try {

        if (!uuid(req.params.id)) {

          throw bad(
            'Invalid product ID.'
          );

        }


        const products = await query(

          `
          UPDATE public.renewed_products

          SET

            status = 'draft',

            approval_status = 'pending',

            updated_at = NOW()

          WHERE

            id = ?

            AND seller_id = ?

          RETURNING ${fields}
          `,

          [

            req.params.id,

            req.seller.id

          ]

        );


        if (!products.length) {

          return res.status(404).json({

            success: false,

            message:
              'Your product was not found.'

          });

        }


        return res.json({

          success: true,

          product: products[0]

        });


      } catch (error) {

        return err(res, error);

      }

    }

  );


  // ==========================================
  // ADMIN — SELLER PRODUCTS
  // ==========================================

  app.get(

    '/api/admin/seller-products',

    requireAdminAuth,

    async (req, res) => {

      try {

        const products = await query(

          `
          SELECT

            p.*,

            s.shop_name,

            s.owner_name,

            s.phone AS seller_phone

          FROM public.renewed_products p

          JOIN public.cerood_sellers s

            ON s.id = p.seller_id

          ORDER BY p.updated_at DESC

          LIMIT 500
          `

        );


        return res.json({

          success: true,

          products

        });


      } catch (error) {

        return err(res, error);

      }

    }

  );


  // ==========================================
  // ADMIN — APPROVE / REJECT PRODUCT
  // ==========================================

  app.patch(

    '/api/admin/seller-products/:id/approval',

    requireAdminAuth,

    async (req, res) => {

      try {

        if (!uuid(req.params.id)) {

          throw bad(
            'Invalid product ID.'
          );

        }


        const approval = String(

          req.body?.approval_status || ''

        );


        if (

          ![
            'approved',
            'rejected',
            'pending'
          ].includes(approval)

        ) {

          throw bad(
            'Invalid approval status.'
          );

        }


        const products = await query(

          `
          UPDATE public.renewed_products p

          SET

            approval_status = ?,

            status = CASE

              WHEN

                ? = 'approved'

                AND p.stock > 0

              THEN 'published'

              ELSE 'draft'

            END,

            updated_at = NOW()

          FROM public.cerood_sellers s

          WHERE

            p.id = ?

            AND p.seller_id = s.id

            AND s.status = 'approved'

          RETURNING

            p.id,
            p.seller_id,
            p.name,
            p.category,
            p.condition,
            p.brand,
            p.model,
            p.price,
            p.compare_price,
            p.stock,
            p.warranty_days,
            p.location,
            p.delivery,
            p.image_url,
            p.video_url,
            p.known_defects,
            p.accessories,
            p.warranty_terms,
            p.status,
            p.approval_status,
            p.created_at,
            p.updated_at
          `,

          [

            approval,

            approval,

            req.params.id

          ]

        );


        if (!products.length) {

          return res.status(404).json({

            success: false,

            message:
              'Product or active seller not found.'

          });

        }


        return res.json({

          success: true,

          product: products[0]

        });


      } catch (error) {

        return err(res, error);

      }

    }

  );

};
