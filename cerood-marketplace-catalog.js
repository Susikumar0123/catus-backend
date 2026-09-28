'use strict';



// ============================================================

// CEROOD MARKETPLACE CATALOG

// Cosmetics + Fashion + Cerood Main Store

//

// Existing Renewed and Home Services routes are not registered

// or modified by this module.

// ============================================================



module.exports = function (

  app,

  db,

  requireSellerAuth,

  requireAdminAuth

) {



  // ============================================================

  // DATABASE HELPER

  // ============================================================



  const query = (sql, args = []) =>

    new Promise((resolve, reject) => {

      db.query(sql, args, (error, rows) => {

        if (error) return reject(error);

        resolve(rows || []);

      });

    });



  const isUUID = value =>

    /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(

      String(value || '')

    );



  const badRequest = message =>

    Object.assign(new Error(message), {

      httpStatus: 400

    });



  function handleError(res, error) {

    console.error('Marketplace catalog:', error);



    return res.status(error.httpStatus || 503).json({

      success: false,

      message: error.httpStatus

        ? error.message

        : 'Catalog service unavailable. Check Render logs.'

    });

  }



  const marketplaces = new Set([

    'cosmetics',

    'clothing',

    'general'

  ]);



  const fields = [

    'name',

    'category',

    'brand',

    'description',

    'variant',

    'shade',

    'net_quantity',

    'ingredients',

    'directions',

    'warnings',

    'batch_number',

    'manufacture_date',

    'expiry_date',

    'price',

    'compare_price',

    'stock',

    'image_url',

    'video_url',

    'manufacturer',

    'importer'

  ];



  const generalFields = [

    'name',

    'category',

    'subcategory',

    'brand',

    'model',

    'description',

    'price',

    'compare_price',

    'stock',

    'image_url',

    'video_url',

    'category_id',

    'product_attributes'

  ];



  function getProductTable(marketplace) {

    if (marketplace === 'cosmetics') {

      return 'cosmetics_products';

    }



    if (marketplace === 'clothing') {

      return 'clothing_products';

    }



    if (marketplace === 'general') {

      return 'cerood_shop_products';

    }



    throw badRequest('Invalid marketplace.');

  }



  // ============================================================

  // VALIDATION HELPERS

  // ============================================================



  function cleanText(value, maxLength = 250) {

    return String(value ?? '')

      .trim()

      .slice(0, maxLength);

  }



  function validateNumbers(product) {

    product.price = Number(product.price);

    product.stock = Number(product.stock);



    product.compare_price =

      product.compare_price === '' ||

      product.compare_price === null ||

      product.compare_price === undefined

        ? null

        : Number(product.compare_price);



    if (

      !Number.isFinite(product.price) ||

      product.price <= 0 ||

      product.price > 10000000

    ) {

      throw badRequest('Enter a valid product price.');

    }



    if (

      !Number.isSafeInteger(product.stock) ||

      product.stock < 0 ||

      product.stock > 1000000

    ) {

      throw badRequest('Enter a valid stock quantity.');

    }



    if (

      product.compare_price !== null &&

      (

        !Number.isFinite(product.compare_price) ||

        product.compare_price < 0

      )

    ) {

      throw badRequest('Enter a valid compare price.');

    }

  }



  function validateMedia(product) {
    if (!/^https:\/\//i.test(product.image_url)) {
      throw badRequest('Product image URL must use HTTPS.');
    }
    if (product.video_url && !/^https:\/\//i.test(product.video_url)) {
      throw badRequest('Product video URL must use HTTPS.');
    }
  }

  // ============================================================
  function validateProduct(marketplace, body) {



    if (!marketplaces.has(marketplace)) {

      throw badRequest(

        'Choose Cosmetics, Fashion or Cerood Main Store.'

      );

    }



    const data =

      body &&

      typeof body === 'object' &&

      !Array.isArray(body)

        ? body

        : {};



    // ==========================================================

    // CEROOOD MAIN STORE

    // ==========================================================



    if (marketplace === 'general') {



      const product = {};



      for (const key of generalFields) {

        product[key] = data[key] ?? '';

      }



      for (const key of [

        'name',

        'category',

        'subcategory',

        'brand',

        'model',

        'description',

        'image_url',

        'video_url'

      ]) {

        const maxLength =

          key === 'description'

            ? 5000

            : key.endsWith('_url')

              ? 2048

              : 250;



        product[key] = cleanText(

          product[key],

          maxLength

        );

      }



      product.category_id = cleanText(

        product.category_id,

        50

      );



      if (

        !product.name ||

        !product.category ||

        !product.brand ||

        !product.image_url ||

        !isUUID(product.category_id)

      ) {

        throw badRequest(

          'Name, category, category ID, brand and image are required.'

        );

      }



      validateNumbers(product);

      validateMedia(product);



      if (

        typeof product.product_attributes === 'string'

      ) {

        try {

          product.product_attributes = JSON.parse(

            product.product_attributes

          );

        } catch (_) {

          throw badRequest(

            'Invalid product attributes.'

          );

        }

      }



      if (

        !product.product_attributes ||

        typeof product.product_attributes !== 'object' ||

        Array.isArray(product.product_attributes)

      ) {

        product.product_attributes = {};

      }



      return product;

    }



    // ==========================================================

    // EXISTING COSMETICS / FASHION

    // ==========================================================



    const product = {};



    for (const key of fields) {

      product[key] = data[key] ?? '';

    }



    for (const key of fields) {



      if (

        key === 'price' ||

        key === 'compare_price' ||

        key === 'stock'

      ) {

        continue;

      }



      const maxLength = [

        'description',

        'ingredients',

        'directions',

        'warnings'

      ].includes(key)

        ? 5000

        : key.endsWith('_url')

          ? 2048

          : 250;



      product[key] = cleanText(

        product[key],

        maxLength

      );

    }



    if (

      !product.name ||

      !product.category ||

      !product.brand ||

      !product.image_url

    ) {

      throw badRequest(

        'Product name, category, brand and image are required.'

      );

    }



    validateNumbers(product);

    validateMedia(product);



    if (marketplace === 'cosmetics') {



      if (!product.net_quantity) {

        throw badRequest(

          'Cosmetics net quantity is required.'

        );

      }



      if (

        !/^\d{4}-\d\d-\d\d$/.test(product.expiry_date) ||

        Number.isNaN(Date.parse(product.expiry_date)) ||

        product.expiry_date <

          new Date().toISOString().slice(0, 10)

      ) {

        throw badRequest(

          'Enter a valid future expiry date.'

        );

      }



      if (

        product.manufacture_date &&

        !/^\d{4}-\d\d-\d\d$/.test(

          product.manufacture_date

        )

      ) {

        throw badRequest(

          'Invalid manufacture date.'

        );

      }



      // PostgreSQL DATE accepts NULL, not an empty string.
      if (!product.manufacture_date) {
        product.manufacture_date = null;
      }

      if (

        product.manufacture_date &&

        product.manufacture_date >

          product.expiry_date

      ) {

        throw badRequest(

          'Expiry date must follow manufacture date.'

        );

      }



    } else {



      product.manufacture_date = null;

      product.expiry_date = null;



    }



    return product;

  }



  // ============================================================

  // MAIN STORE CATEGORY VALIDATION

  // ============================================================



  async function validateGeneralCategory(product) {

    const categories = await query(
      `
      SELECT
        c.id, c.name, c.parent_id,
        p.name AS parent_name
      FROM public.cerood_shop_categories c
      LEFT JOIN public.cerood_shop_categories p
        ON p.id = c.parent_id
       AND p.marketplace = 'general'
       AND p.is_active = true
      WHERE c.id = ?
        AND c.marketplace = 'general'
        AND c.is_active = true
      LIMIT 1
      `,
      [product.category_id]
    );

    if (!categories.length) {
      throw badRequest('Choose an active Cerood Main Store category.');
    }

    const selected = categories[0];
    if (selected.parent_id && !selected.parent_name) {
      throw badRequest('Selected category parent is inactive.');
    }

    product.category = selected.parent_name || selected.name;
    product.subcategory = selected.parent_id ? selected.name : '';
    return product;
  }

  // ============================================================

  // SELLER: MAIN STORE CATEGORY SCHEMAS

  // ============================================================

  app.get(
    '/api/sellers/shop-categories',
    requireSellerAuth,
    async (req, res) => {
      try {
        const marketplace = cleanText(req.query.marketplace || 'general', 50);

        if (marketplace !== 'general') {
          throw badRequest('This category endpoint currently supports Cerood Main Store only.');
        }

        const categories = await query(
          `
            SELECT
              id, marketplace, parent_id, name, slug,
              attribute_schema, sort_order
            FROM public.cerood_shop_categories
            WHERE marketplace = 'general'
              AND is_active = true
            ORDER BY sort_order ASC, name ASC
          `
        );

        return res.json({
          success: true,
          categories: categories.map(category => ({
            ...category,
            attribute_schema: Array.isArray(category.attribute_schema)
              ? category.attribute_schema
              : []
          }))
        });
      } catch (error) {
        return handleError(res, error);
      }
    }
  );

  // ============================================================

  // SELLER: GET ALL SUBMISSIONS

  // ============================================================



  app.get(

    '/api/sellers/catalog-submissions',

    requireSellerAuth,

    async (req, res) => {



      try {



        const products = await query(

          `

          SELECT *

          FROM public.cerood_seller_catalog_submissions

          WHERE seller_id = ?

          ORDER BY created_at DESC

          LIMIT 250

          `,

          [req.seller.id]

        );



        return res.json({

          success: true,

          products

        });



      } catch (error) {

        return handleError(res, error);

      }



    }

  );



  // ============================================================

  // SELLER: SUBMIT NEW PRODUCT

  // ============================================================



  app.post(

    '/api/sellers/catalog-submissions',

    requireSellerAuth,

    async (req, res) => {



      try {



        const marketplace = cleanText(

          req.body?.marketplace,

          50

        );



        if (!marketplaces.has(marketplace)) {

          throw badRequest(

            'Choose Cosmetics, Fashion or Cerood Main Store.'

          );

        }



        const product = validateProduct(

          marketplace,

          req.body?.product || {}

        );



        if (marketplace === 'general') {

          await validateGeneralCategory(product);

        }



        const rows = await query(

          `

          INSERT INTO

            public.cerood_seller_catalog_submissions

          (

            seller_id,

            marketplace,

            product_data

          )

          VALUES (

            ?,

            ?,

            ?::jsonb

          )

          RETURNING *

          `,

          [

            req.seller.id,

            marketplace,

            JSON.stringify(product)

          ]

        );



        return res.status(201).json({

          success: true,

          submission: rows[0]

        });



      } catch (error) {

        return handleError(res, error);

      }



    }

  );



  // ============================================================

  // SELLER: EDIT SUBMISSION

  // ============================================================



  app.patch(

    '/api/sellers/catalog-submissions/:id',

    requireSellerAuth,

    async (req, res) => {



      try {



        if (!isUUID(req.params.id)) {

          throw badRequest(

            'Invalid submission ID.'

          );

        }



        const rows = await query(

          `

          SELECT *

          FROM public.cerood_seller_catalog_submissions

          WHERE id = ?

            AND seller_id = ?

          LIMIT 1

          `,

          [

            req.params.id,

            req.seller.id

          ]

        );



        const submission = rows[0];



        if (!submission) {

          return res.status(404).json({

            success: false,

            message: 'Product not found.'

          });

        }



        if (

          submission.approval_status === 'withdrawn'

        ) {

          throw badRequest(

            'Withdrawn product cannot be edited.'

          );

        }



        const product = validateProduct(

          submission.marketplace,

          req.body?.product || {}

        );



        if (submission.marketplace === 'general') {

          await validateGeneralCategory(product);

        }



        // ======================================================

        // EDIT AN ALREADY APPROVED PRODUCT

        // ======================================================



        if (

          submission.approval_status === 'approved'

        ) {



          if (!submission.published_product_id) {

            return res.status(409).json({

              success: false,

              message:

                'Published product link missing. Contact admin.'

            });

          }



          const target = getProductTable(

            submission.marketplace

          );



          const changed = await query(

            `

            WITH unpublished AS (

              UPDATE public.${target}

              SET status = 'draft'

              WHERE id = ?

                AND status = 'published'

                AND EXISTS (

                  SELECT 1

                  FROM public.cerood_seller_catalog_submissions

                  WHERE id = ?

                    AND seller_id = ?

                    AND approval_status = 'approved'

                    AND published_product_id = ?

                )

              RETURNING id

            ),

            changed AS (

              UPDATE

                public.cerood_seller_catalog_submissions

              SET

                product_data = ?::jsonb,

                approval_status = 'pending',

                rejection_reason = NULL,

                updated_at = NOW()

              WHERE id = ?

                AND seller_id = ?

                AND approval_status = 'approved'

                AND EXISTS (

                  SELECT 1

                  FROM unpublished

                )

              RETURNING *

            )

            SELECT *

            FROM changed

            `,

            [

              String(submission.published_product_id),

              submission.id,

              req.seller.id,

              submission.published_product_id,

              JSON.stringify(product),

              submission.id,

              req.seller.id

            ]

          );



          if (!changed.length) {

            return res.status(409).json({

              success: false,

              message:

                'Live listing changed. Refresh before editing.'

            });

          }



          return res.json({

            success: true,

            submission: changed[0]

          });



        }



        // ======================================================

        // EDIT PENDING OR REJECTED SUBMISSION

        // ======================================================



        const changed = await query(

          `

          UPDATE

            public.cerood_seller_catalog_submissions

          SET

            product_data = ?::jsonb,

            approval_status = 'pending',

            rejection_reason = NULL,

            updated_at = NOW()

          WHERE id = ?

            AND seller_id = ?

            AND approval_status IN (

              'pending',

              'rejected'

            )

          RETURNING *

          `,

          [

            JSON.stringify(product),

            submission.id,

            req.seller.id

          ]

        );



        if (!changed.length) {

          return res.status(409).json({

            success: false,

            message:

              'Product changed. Refresh and retry.'

          });

        }



        return res.json({

          success: true,

          submission: changed[0]

        });



      } catch (error) {

        return handleError(res, error);

      }



    }

  );



  // ============================================================

  // SELLER: WITHDRAW SUBMISSION

  // ============================================================



  app.delete(

    '/api/sellers/catalog-submissions/:id',

    requireSellerAuth,

    async (req, res) => {



      try {



        if (!isUUID(req.params.id)) {

          throw badRequest(

            'Invalid submission ID.'

          );

        }



        const rows = await query(

          `

          SELECT *

          FROM public.cerood_seller_catalog_submissions

          WHERE id = ?

            AND seller_id = ?

          LIMIT 1

          `,

          [

            req.params.id,

            req.seller.id

          ]

        );



        const submission = rows[0];



        if (!submission) {

          return res.status(404).json({

            success: false,

            message: 'Product not found.'

          });

        }



        if (

          submission.approval_status === 'withdrawn'

        ) {

          return res.json({

            success: true

          });

        }



        // ======================================================

        // WITHDRAW APPROVED PRODUCT

        // ======================================================



        if (

          submission.approval_status === 'approved'

        ) {



          if (!submission.published_product_id) {

            return res.status(409).json({

              success: false,

              message:

                'Published product link missing.'

            });

          }



          const target = getProductTable(

            submission.marketplace

          );



          const changed = await query(

            `

            WITH unpublished AS (

              UPDATE public.${target}

              SET status = 'draft'

              WHERE id = ?

                AND status = 'published'

                AND EXISTS (

                  SELECT 1

                  FROM public.cerood_seller_catalog_submissions

                  WHERE id = ?

                    AND seller_id = ?

                    AND approval_status = 'approved'

                    AND published_product_id = ?

                )

              RETURNING id

            ),

            changed AS (

              UPDATE

                public.cerood_seller_catalog_submissions

              SET

                approval_status = 'withdrawn',

                updated_at = NOW()

              WHERE id = ?

                AND seller_id = ?

                AND approval_status = 'approved'

                AND EXISTS (

                  SELECT 1

                  FROM unpublished

                )

              RETURNING *

            )

            SELECT *

            FROM changed

            `,

            [

              String(submission.published_product_id),

              submission.id,

              req.seller.id,

              submission.published_product_id,

              submission.id,

              req.seller.id

            ]

          );



          if (!changed.length) {

            return res.status(409).json({

              success: false,

              message:

                'Live listing changed. Refresh before withdrawing.'

            });

          }



          return res.json({

            success: true,

            submission: changed[0]

          });



        }



        // ======================================================

        // WITHDRAW PENDING / REJECTED PRODUCT

        // ======================================================



        const changed = await query(

          `

          UPDATE

            public.cerood_seller_catalog_submissions

          SET

            approval_status = 'withdrawn',

            updated_at = NOW()

          WHERE id = ?

            AND seller_id = ?

            AND approval_status IN (

              'pending',

              'rejected'

            )

          RETURNING *

          `,

          [

            submission.id,

            req.seller.id

          ]

        );



        if (!changed.length) {

          return res.status(409).json({

            success: false,

            message:

              'Product changed. Refresh.'

          });

        }



        return res.json({

          success: true,

          submission: changed[0]

        });



      } catch (error) {

        return handleError(res, error);

      }



    }

  );



  // ============================================================

  // COMMON ADMIN: ALL SUBMISSIONS

  // ============================================================



  app.get(

    '/api/admin/catalog-submissions-all',

    requireAdminAuth,

    async (req, res) => {



      try {



        const products = await query(

          `

          SELECT

            c.*,

            s.shop_name,

            s.owner_name,

            s.phone AS seller_phone

          FROM

            public.cerood_seller_catalog_submissions c

          JOIN

            public.cerood_sellers s

          ON

            s.id = c.seller_id

          ORDER BY

            c.created_at DESC

          LIMIT 1000

          `

        );



        return res.json({

          success: true,

          products

        });



      } catch (error) {

        return handleError(res, error);

      }



    }

  );



  // ============================================================

  // ADMIN: MARKETPLACE APPROVAL QUEUE

  // ============================================================



  app.get(

    '/api/admin/catalog-submissions',

    requireAdminAuth,

    async (req, res) => {



      try {



        const marketplace = cleanText(

          req.query.marketplace,

          50

        );



        if (!marketplaces.has(marketplace)) {

          throw badRequest(

            'Choose Cosmetics, Fashion or Cerood Main Store.'

          );

        }



        const products = await query(

          `

          SELECT

            c.*,

            s.shop_name,

            s.owner_name,

            s.phone AS seller_phone

          FROM

            public.cerood_seller_catalog_submissions c

          JOIN

            public.cerood_sellers s

          ON

            s.id = c.seller_id

          WHERE

            c.marketplace = ?

          ORDER BY

            c.created_at DESC

          LIMIT 500

          `,

          [marketplace]

        );



        return res.json({

          success: true,

          products

        });



      } catch (error) {

        return handleError(res, error);

      }



    }

  );



  // ============================================================

  // ADMIN: APPROVE OR REJECT PRODUCT

  // ============================================================



  app.patch(

    '/api/admin/catalog-submissions/:id/approval',

    requireAdminAuth,

    async (req, res) => {



      try {



        if (!isUUID(req.params.id)) {

          throw badRequest(

            'Invalid submission ID.'

          );

        }



        const action = cleanText(

          req.body?.approval_status,

          30

        );



        if (

          !['approved', 'rejected'].includes(action)

        ) {

          throw badRequest(

            'Invalid approval action.'

          );

        }



        // ======================================================

        // FIND SUBMISSION AND SELLER

        // ======================================================



        const rows = await query(

          `

          SELECT

            c.*,

            s.status AS seller_status

          FROM

            public.cerood_seller_catalog_submissions c

          JOIN

            public.cerood_sellers s

          ON

            s.id = c.seller_id

          WHERE

            c.id = ?

          LIMIT 1

          `,

          [req.params.id]

        );



        const submission = rows[0];



        if (!submission) {

          return res.status(404).json({

            success: false,

            message: 'Submission not found.'

          });

        }



        if (

          submission.approval_status !== 'pending'

        ) {

          return res.status(409).json({

            success: false,

            message:

              'Submission already reviewed. Refresh the page.'

          });

        }



        // ======================================================

        // REJECT

        // ======================================================



        if (action === 'rejected') {



          const reason = cleanText(

            req.body?.rejection_reason,

            500

          );



          const changed = await query(

            `

            UPDATE

              public.cerood_seller_catalog_submissions

            SET

              approval_status = 'rejected',

              rejection_reason = ?,

              updated_at = NOW()

            WHERE id = ?

              AND approval_status = 'pending'

            RETURNING *

            `,

            [

              reason,

              submission.id

            ]

          );



          if (!changed.length) {

            return res.status(409).json({

              success: false,

              message:

                'Already reviewed. Refresh the page.'

            });

          }



          return res.json({

            success: true,

            submission: changed[0]

          });

        }



        // ======================================================

        // SELLER STATUS

        // ======================================================



        if (

          submission.seller_status !== 'approved'

        ) {

          throw badRequest(

            'Seller account must be approved first.'

          );

        }



        const product = validateProduct(

          submission.marketplace,

          submission.product_data

        );



        const target = getProductTable(

          submission.marketplace

        );



        const productId = String(

          submission.published_product_id ||

          submission.id

        );



        // ======================================================

        // MAIN STORE APPROVAL

        // ======================================================



        if (

          submission.marketplace === 'general'

        ) {



          await validateGeneralCategory(product);



          const existing = await query(

            `

            SELECT

              id,

              seller_id,

              status

            FROM public.cerood_shop_products

            WHERE id = ?

            LIMIT 1

            `,

            [productId]

          );



          // ====================================================

          // APPROVE EDITED MAIN STORE PRODUCT

          // ====================================================



          if (existing.length) {



            const old = existing[0];



            if (

              old.status !== 'draft' ||

              String(old.seller_id) !==

                String(submission.seller_id) ||

              String(

                submission.published_product_id || ''

              ) !== String(old.id)

            ) {

              return res.status(409).json({

                success: false,

                message:

                  'Existing Main Store product conflicts with this submission.'

              });

            }



            const updated = await query(

              `

              WITH changed_product AS (

                UPDATE public.cerood_shop_products

                SET

                  category_id = ?::uuid,

                  name = ?,

                  category = ?,

                  subcategory = ?,

                  brand = ?,

                  model = ?,

                  description = ?,

                  price = ?,

                  compare_price = ?,

                  stock = ?,

                  image_url = ?,

                  video_url = ?,

                  product_attributes = ?::jsonb,

                  status = 'published',

                  approval_status = 'approved',

                  updated_at = NOW()

                WHERE id = ?

                  AND seller_id = ?

                  AND status = 'draft'

                  AND EXISTS (

                    SELECT 1

                    FROM

                      public.cerood_seller_catalog_submissions

                    WHERE id = ?

                      AND approval_status = 'pending'

                      AND published_product_id = ?

                  )

                RETURNING id

              ),

              approved AS (

                UPDATE

                  public.cerood_seller_catalog_submissions

                SET

                  approval_status = 'approved',

                  rejection_reason = NULL,

                  updated_at = NOW()

                WHERE id = ?

                  AND approval_status = 'pending'

                  AND EXISTS (

                    SELECT 1

                    FROM changed_product

                  )

                RETURNING published_product_id

              )

              SELECT

                published_product_id AS id

              FROM approved

              `,

              [

                product.category_id,

                product.name,

                product.category,

                product.subcategory,

                product.brand,

                product.model,

                product.description,

                product.price,

                product.compare_price,

                product.stock,

                product.image_url,

                product.video_url || null,

                JSON.stringify(

                  product.product_attributes

                ),

                productId,

                submission.seller_id,

                submission.id,

                submission.published_product_id,

                submission.id

              ]

            );



            if (!updated.length) {

              return res.status(409).json({

                success: false,

                message:

                  'Main Store product changed during approval.'

              });

            }



            return res.json({

              success: true,

              product_id: updated[0].id

            });

          }



          // ====================================================

          // PUBLISH BRAND-NEW MAIN STORE PRODUCT

          // ====================================================



          if (submission.published_product_id) {

            return res.status(409).json({

              success: false,

              message:

                'Previously published product is missing. Contact admin.'

            });

          }



          const published = await query(

            `

            WITH claimed AS (

              UPDATE

                public.cerood_seller_catalog_submissions

              SET

                approval_status = 'approved',

                published_product_id = id,

                rejection_reason = NULL,

                updated_at = NOW()

              WHERE id = ?

                AND approval_status = 'pending'

                AND published_product_id IS NULL

                AND NOT EXISTS (

                  SELECT 1

                  FROM public.cerood_shop_products

                  WHERE id = ?

                )

              RETURNING

                id,

                seller_id

            ),

            inserted AS (

              INSERT INTO

                public.cerood_shop_products

              (

                id,

                seller_id,

                category_id,

                name,

                category,

                subcategory,

                brand,

                model,

                description,

                price,

                compare_price,

                stock,

                image_url,

                video_url,

                product_attributes,

                status,

                approval_status

              )

              SELECT

                claimed.id,

                claimed.seller_id,

                ?::uuid,

                ?,

                ?,

                ?,

                ?,

                ?,

                ?,

                ?,

                ?,

                ?,

                ?,

                ?,

                ?::jsonb,

                'published',

                'approved'

              FROM claimed

              RETURNING id

            )

            SELECT id

            FROM inserted

            `,

            [

              submission.id,

              submission.id,

              product.category_id,

              product.name,

              product.category,

              product.subcategory,

              product.brand,

              product.model,

              product.description,

              product.price,

              product.compare_price,

              product.stock,

              product.image_url,

              product.video_url || null,

              JSON.stringify(

                product.product_attributes

              )

            ]

          );



          if (!published.length) {

            return res.status(409).json({

              success: false,

              message:

                'Product changed during approval. Refresh and retry.'

            });

          }



          return res.json({

            success: true,

            product_id: published[0].id

          });

        }



        // ======================================================

        // COSMETICS / FASHION APPROVAL

        // ======================================================



        const existing = await query(

          `

          SELECT

            id,

            name,

            image_url,

            status

          FROM public.${target}

          WHERE id = ?

          LIMIT 1

          `,

          [productId]

        );



        let published = [];



        // ======================================================

        // APPROVE EDITED COSMETICS / FASHION PRODUCT

        // ======================================================



        if (existing.length) {



          const old = existing[0];



          const linked =

            String(

              submission.published_product_id || ''

            ) === String(old.id);



          const legacyMatch =

            !submission.published_product_id &&

            String(submission.id) ===

              String(old.id) &&

            old.name === product.name &&

            old.image_url === product.image_url;



          if (

            old.status !== 'draft' ||

            (!linked && !legacyMatch)

          ) {

            return res.status(409).json({

              success: false,

              message:

                'Existing product ID conflicts with this submission.'

            });

          }



          const owners = await query(

            `

            SELECT id

            FROM public.cerood_seller_catalog_submissions

            WHERE published_product_id = ?

              AND id <> ?

            LIMIT 1

            `,

            [

              productId,

              submission.id

            ]

          );



          if (owners.length) {

            return res.status(409).json({

              success: false,

              message:

                'Product is linked to another submission.'

            });

          }



          const assignments = fields

            .map(key => `${key} = ?`)

            .join(', ');



          published = await query(

            `

            WITH changed_product AS (

              UPDATE public.${target}

              SET

                ${assignments},

                status = 'published'

              WHERE id = ?

                AND status = 'draft'

                AND EXISTS (

                  SELECT 1

                  FROM

                    public.cerood_seller_catalog_submissions

                  WHERE id = ?

                    AND approval_status = 'pending'

                )

                AND NOT EXISTS (

                  SELECT 1

                  FROM

                    public.cerood_seller_catalog_submissions

                  WHERE published_product_id = ?

                    AND id <> ?

                )

              RETURNING id

            ),

            approved AS (

              UPDATE

                public.cerood_seller_catalog_submissions

              SET

                approval_status = 'approved',

                published_product_id = ?,

                rejection_reason = NULL,

                updated_at = NOW()

              WHERE id = ?

                AND approval_status = 'pending'

                AND EXISTS (

                  SELECT 1

                  FROM changed_product

                )

              RETURNING published_product_id

            )

            SELECT

              published_product_id AS id

            FROM approved

            `,

            [

              ...fields.map(key => product[key]),

              productId,

              submission.id,

              productId,

              submission.id,

              productId,

              submission.id

            ]

          );



        } else {



          // ====================================================

          // PUBLISH BRAND-NEW COSMETICS / FASHION PRODUCT

          // ====================================================



          if (submission.published_product_id) {

            return res.status(409).json({

              success: false,

              message:

                'Previously published product is missing. Contact admin.'

            });

          }



          const columns = fields.join(', ');



          const values = fields

            .map(() => '?')

            .join(', ');



          published = await query(

            `

            WITH claimed AS (

              UPDATE

                public.cerood_seller_catalog_submissions

              SET

                approval_status = 'approved',

                published_product_id = id,

                rejection_reason = NULL,

                updated_at = NOW()

              WHERE id = ?

                AND approval_status = 'pending'

                AND published_product_id IS NULL

              RETURNING id

            ),

            inserted AS (

              INSERT INTO public.${target}

              (

                id,

                ${columns},

                status

              )

              SELECT

                claimed.id::text,

                ${values},

                'published'

              FROM claimed

              RETURNING id

            )

            SELECT id

            FROM inserted

            `,

            [

              submission.id,

              ...fields.map(key => product[key])

            ]

          );



        }



        if (!published.length) {

          return res.status(409).json({

            success: false,

            message:

              'Product changed during approval. Refresh and retry.'

          });

        }



        return res.json({

          success: true,

          product_id: published[0].id

        });



      } catch (error) {

        return handleError(res, error);

      }



    }

  );



};