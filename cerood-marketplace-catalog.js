
'use strict';

// CEROOD Marketplace Catalog
// Cosmetics + Fashion seller products.
// Existing Renewed and Home Services routes are untouched.

module.exports = function (
  app,
  db,
  requireSellerAuth,
  requireAdminAuth
) {

  // ============================================
  // DATABASE HELPER
  // ============================================

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

  const marketplaces = new Set([
    'cosmetics',
    'clothing'
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

  const badRequest = message =>
    Object.assign(new Error(message), {
      httpStatus: 400
    });

  function handleError(res, error) {

    console.error(
      'Marketplace catalog:',
      error
    );

    res.status(
      error.httpStatus || 503
    ).json({
      success: false,
      message: error.httpStatus
        ? error.message
        : 'Catalog service unavailable. Check database migration and Render logs.'
    });

  }

  function getProductTable(marketplace) {

    if (marketplace === 'cosmetics') {
      return 'cosmetics_products';
    }

    if (marketplace === 'clothing') {
      return 'clothing_products';
    }

    throw badRequest(
      'Invalid marketplace.'
    );

  }

  // ============================================
  // PRODUCT VALIDATION
  // ============================================

  function validateProduct(
    marketplace,
    body
  ) {

    if (!marketplaces.has(marketplace)) {
      throw badRequest(
        'Choose Cosmetics or Fashion.'
      );
    }

    const product = {};

    for (const key of fields) {
      product[key] = body[key] ?? '';
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

      product[key] = String(
        product[key]
      )
        .trim()
        .slice(0, maxLength);

    }

    product.price = Number(
      product.price
    );

    product.stock = Number(
      product.stock
    );

    product.compare_price =
      product.compare_price === ''
        ? null
        : Number(
            product.compare_price
          );

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

    if (
      !Number.isFinite(
        product.price
      ) ||
      product.price <= 0 ||
      product.price > 10000000
    ) {
      throw badRequest(
        'Enter a valid product price.'
      );
    }

    if (
      !Number.isSafeInteger(
        product.stock
      ) ||
      product.stock < 0 ||
      product.stock > 1000000
    ) {
      throw badRequest(
        'Enter a valid stock quantity.'
      );
    }

    if (
      product.compare_price !== null &&
      (
        !Number.isFinite(
          product.compare_price
        ) ||
        product.compare_price < 0
      )
    ) {
      throw badRequest(
        'Enter a valid compare price.'
      );
    }

    if (
      !/^https:\/\//i.test(
        product.image_url
      )
    ) {
      throw badRequest(
        'Product image must use HTTPS.'
      );
    }

    if (
      product.video_url &&
      !/^https:\/\//i.test(
        product.video_url
      )
    ) {
      throw badRequest(
        'Product video must use HTTPS.'
      );
    }

    if (
      marketplace === 'cosmetics'
    ) {

      if (
        !product.net_quantity
      ) {
        throw badRequest(
          'Cosmetics net quantity is required.'
        );
      }

      if (
        !/^\d{4}-\d\d-\d\d$/.test(
          product.expiry_date
        ) ||
        Number.isNaN(
          Date.parse(
            product.expiry_date
          )
        ) ||
        product.expiry_date <
          new Date()
            .toISOString()
            .slice(0, 10)
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

  // ============================================
  // SELLER: GET ALL SUBMISSIONS
  // ============================================

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
          [
            req.seller.id
          ]
        );

        res.json({
          success: true,
          products
        });

      } catch (error) {

        handleError(
          res,
          error
        );

      }

    }
  );

  // ============================================
  // SELLER: ADD NEW PRODUCT
  // ============================================

  app.post(
    '/api/sellers/catalog-submissions',
    requireSellerAuth,
    async (req, res) => {

      try {

        const marketplace = String(
          req.body?.marketplace || ''
        );

        if (
          !marketplaces.has(
            marketplace
          )
        ) {
          throw badRequest(
            'Choose Cosmetics or Fashion.'
          );
        }

        const product = validateProduct(
          marketplace,
          req.body?.product || {}
        );

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
            JSON.stringify(
              product
            )
          ]
        );

        res.status(201).json({
          success: true,
          submission: rows[0]
        });

      } catch (error) {

        handleError(
          res,
          error
        );

      }

    }
  );

  // ============================================
  // SELLER: EDIT PRODUCT
  // ============================================

  app.patch(
    '/api/sellers/catalog-submissions/:id',
    requireSellerAuth,
    async (req, res) => {

      try {

        if (
          !isUUID(
            req.params.id
          )
        ) {
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
          submission.approval_status ===
          'withdrawn'
        ) {
          throw badRequest(
            'Withdrawn product cannot be edited.'
          );
        }

        const product = validateProduct(
          submission.marketplace,
          req.body?.product || {}
        );

        const target = getProductTable(
          submission.marketplace
        );

        // ==================================
        // EDIT ALREADY APPROVED PRODUCT
        // ==================================

        if (
          submission.approval_status ===
          'approved'
        ) {

          if (
            !submission.published_product_id
          ) {
            return res.status(409).json({
              success: false,
              message:
                'Published product link missing. Contact admin.'
            });
          }

          const changed = await query(
            `
            WITH unpublished AS (

              UPDATE public.${target}

              SET status = 'draft'

              WHERE id = ?
                AND status = 'published'

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
              String(
                submission.published_product_id
              ),
              JSON.stringify(
                product
              ),
              submission.id,
              req.seller.id
            ]
          );

          if (
            !changed.length
          ) {
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

        // ==================================
        // EDIT PENDING / REJECTED PRODUCT
        // ==================================

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
            JSON.stringify(
              product
            ),
            submission.id,
            req.seller.id
          ]
        );

        if (
          !changed.length
        ) {
          return res.status(409).json({
            success: false,
            message:
              'Product changed. Refresh and retry.'
          });
        }

        res.json({
          success: true,
          submission: changed[0]
        });

      } catch (error) {

        handleError(
          res,
          error
        );

      }

    }
  );

  // ============================================
  // SELLER: WITHDRAW PRODUCT
  // ============================================

  app.delete(
    '/api/sellers/catalog-submissions/:id',
    requireSellerAuth,
    async (req, res) => {

      try {

        if (
          !isUUID(
            req.params.id
          )
        ) {
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
          submission.approval_status ===
          'withdrawn'
        ) {

          return res.json({
            success: true
          });

        }

        // ==================================
        // WITHDRAW APPROVED PRODUCT
        // ==================================

        if (
          submission.approval_status ===
          'approved'
        ) {

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
              String(
                submission.published_product_id
              ),
              submission.id,
              req.seller.id
            ]
          );

          if (
            !changed.length
          ) {
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

        // ==================================
        // WITHDRAW PENDING / REJECTED
        // ==================================

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

        if (
          !changed.length
        ) {
          return res.status(409).json({
            success: false,
            message:
              'Product changed. Refresh.'
          });
        }

        res.json({
          success: true,
          submission: changed[0]
        });

      } catch (error) {

        handleError(
          res,
          error
        );

      }

    }
  );

  // ============================================
  // ADMIN: GET APPROVAL QUEUE
  // ============================================

  app.get(
    '/api/admin/catalog-submissions',
    requireAdminAuth,
    async (req, res) => {

      try {

        const marketplace = String(
          req.query.marketplace || ''
        );

        if (
          !marketplaces.has(
            marketplace
          )
        ) {
          throw badRequest(
            'Choose Cosmetics or Fashion marketplace.'
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
          [
            marketplace
          ]
        );

        res.json({
          success: true,
          products
        });

      } catch (error) {

        handleError(
          res,
          error
        );

      }

    }
  );

  // ============================================
  // ADMIN: APPROVE / REJECT
  // ============================================

  app.patch(
    '/api/admin/catalog-submissions/:id/approval',
    requireAdminAuth,
    async (req, res) => {

      try {

        if (
          !isUUID(
            req.params.id
          )
        ) {
          throw badRequest(
            'Invalid submission ID.'
          );
        }

        const action = String(
          req.body?.approval_status || ''
        );

        if (
          ![
            'approved',
            'rejected'
          ].includes(action)
        ) {
          throw badRequest(
            'Invalid approval action.'
          );
        }

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
          `,
          [
            req.params.id
          ]
        );

        const submission = rows[0];

        if (!submission) {

          return res.status(404).json({
            success: false,
            message:
              'Submission not found.'
          });

        }

        if (
          submission.approval_status !==
          'pending'
        ) {

          return res.status(409).json({
            success: false,
            message:
              'Submission already reviewed. Refresh the page.'
          });

        }

        // ==================================
        // REJECT
        // ==================================

        if (
          action === 'rejected'
        ) {

          const reason = String(
            req.body?.rejection_reason || ''
          )
            .trim()
            .slice(0, 500);

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

          if (
            !changed.length
          ) {

            return res.status(409).json({
              success: false,
              message:
                'Already reviewed.'
            });

          }

          return res.json({
            success: true,
            submission: changed[0]
          });

        }

        // ==================================
        // APPROVE: SELLER CHECK
        // ==================================

        if (
          submission.seller_status !==
          'approved'
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

        // Submission ID is UUID.
        // Product table ID is TEXT.

        const productId = String(
          submission.published_product_id ||
          submission.id
        );

        // ==================================
        // CHECK EXISTING PRODUCT
        // ==================================

        const existing = await query(
          `
          SELECT
            id,
            name,
            image_url,
            status

          FROM public.${target}

          WHERE id = ?
          `,
          [
            productId
          ]
        );

        let published = [];

        // ==================================
        // CASE 1: PRODUCT ALREADY EXISTS
        // ==================================

        if (
          existing.length
        ) {

          const old = existing[0];

          const linked =
            String(
              submission.published_product_id || ''
            ) === String(
              old.id
            );

          // Recovery for an older edit that
          // accidentally removed the product link.

          const legacyMatch =
            !submission.published_product_id &&
            String(
              submission.id
            ) === String(
              old.id
            ) &&
            old.name === product.name &&
            old.image_url === product.image_url;

          if (
            old.status !== 'draft' ||
            (
              !linked &&
              !legacyMatch
            )
          ) {

            return res.status(409).json({
              success: false,
              message:
                'Existing product ID conflicts with this submission. Contact admin.'
            });

          }

          // Check whether another submission
          // already owns the product.

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

          if (
            owners.length
          ) {

            return res.status(409).json({
              success: false,
              message:
                'Product is linked to another submission.'
            });

          }

          // Build update fields.

          const assignments = fields
            .map(
              key => `${key} = ?`
            )
            .join(', ');

          // Update existing draft and approve
          // submission in one SQL statement.

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
              ...fields.map(
                key => product[key]
              ),

              productId,
              submission.id,

              productId,
              submission.id,

              productId,
              submission.id
            ]
          );

        } else {

          // ==================================
          // CASE 2: BRAND-NEW PRODUCT
          // ==================================

          const columns = fields.join(
            ', '
          );

          const values = fields
            .map(
              () => '?'
            )
            .join(', ');

          published = await query(
            `
            WITH claim AS (

              UPDATE
                public.cerood_seller_catalog_submissions

              SET
                approval_status = 'approved',
                published_product_id = id,
                rejection_reason = NULL,
                updated_at = NOW()

              WHERE id = ?
                AND approval_status = 'pending'

              RETURNING id

            ),

            inserted AS (

              INSERT INTO
                public.${target}
              (
                id,
                ${columns},
                status
              )

              SELECT
                claim.id::text,
                ${values},
                'published'

              FROM claim

              RETURNING id

            )

            SELECT id
            FROM inserted
            `,
            [
              submission.id,
              ...fields.map(
                key => product[key]
              )
            ]
          );

        }

        // ==================================
        // APPROVAL RESULT
        // ==================================

        if (
          !published.length
        ) {

          return res.status(409).json({
            success: false,
            message:
              'Product changed during approval. Refresh and retry.'
          });

        }

        return res.json({
          success: true,
          product_id:
            published[0].id
        });

      } catch (error) {

        handleError(
          res,
          error
        );

      }

    }
  );

};
