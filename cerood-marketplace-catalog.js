
'use strict';

// Cosmetics and Fashion seller submissions.
// Existing Renewed routes remain untouched.

const crypto = require('crypto');

module.exports = function (
  app,
  db,
  requireSellerAuth,
  requireAdminAuth
) {

  const query = (sql, args = []) =>
    new Promise((resolve, reject) =>
      db.query(sql, args, (error, rows) =>
        error ? reject(error) : resolve(rows || [])
      )
    );

  const uuid = value =>
    /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(
      String(value || '')
    );

  const allowed = new Set([
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

  const fail = (res, error) => {
    console.error('Marketplace catalog:', error);

    res.status(error.httpStatus || 503).json({
      success: false,
      message: error.httpStatus
        ? error.message
        : 'Catalog service unavailable. Check database migration and logs.'
    });
  };

  const bad = message =>
    Object.assign(new Error(message), {
      httpStatus: 400
    });

  function validate(marketplace, body) {

    const product = {};

    for (const key of fields) {
      product[key] = body[key] ?? '';
    }

    for (
      const key of fields.filter(
        key => ![
          'price',
          'compare_price',
          'stock'
        ].includes(key)
      )
    ) {

      product[key] = String(product[key])
        .trim()
        .slice(
          0,
          [
            'description',
            'ingredients',
            'directions',
            'warnings'
          ].includes(key)
            ? 5000
            : key.endsWith('_url')
              ? 2048
              : 250
        );
    }

    product.price = Number(product.price);

    product.stock = Number(product.stock);

    product.compare_price =
      product.compare_price === ''
        ? null
        : Number(product.compare_price);

    if (
      !product.name ||
      !product.category ||
      !product.brand ||
      !product.image_url ||
      !Number.isFinite(product.price) ||
      product.price <= 0 ||
      product.price > 10000000 ||
      !Number.isSafeInteger(product.stock) ||
      product.stock < 0 ||
      product.stock > 1000000 ||
      (
        product.compare_price !== null &&
        (
          !Number.isFinite(product.compare_price) ||
          product.compare_price < 0
        )
      )
    ) {

      throw bad(
        'Name, category, brand, image, price and valid stock are required.'
      );
    }

    if (
      !/^https:\/\//i.test(product.image_url) ||
      (
        product.video_url &&
        !/^https:\/\//i.test(product.video_url)
      )
    ) {

      throw bad(
        'Product media must use HTTPS.'
      );
    }

    if (marketplace === 'cosmetics') {

      if (
        !product.net_quantity ||
        !/^\d{4}-\d\d-\d\d$/.test(
          product.expiry_date
        ) ||
        Number.isNaN(
          Date.parse(product.expiry_date)
        ) ||
        product.expiry_date <
          new Date().toISOString().slice(0, 10)
      ) {

        throw bad(
          'Cosmetics require net quantity and a valid future expiry date.'
        );
      }

      if (
        product.manufacture_date &&
        !/^\d{4}-\d\d-\d\d$/.test(
          product.manufacture_date
        )
      ) {

        throw bad(
          'Invalid manufacture date.'
        );
      }

      if (
        product.manufacture_date &&
        product.manufacture_date >
          product.expiry_date
      ) {

        throw bad(
          'Expiry must follow manufacture date.'
        );
      }

    } else {

      product.manufacture_date = null;

      product.expiry_date = null;

    }

    return product;
  }

  // ==================================================
  // SELLER: GET COSMETICS + FASHION SUBMISSIONS
  // ==================================================

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

        res.json({
          success: true,
          products
        });

      } catch (error) {

        fail(res, error);

      }

    }
  );

  // ==================================================
  // SELLER: SUBMIT NEW COSMETICS / FASHION PRODUCT
  // ==================================================

  app.post(
    '/api/sellers/catalog-submissions',
    requireSellerAuth,
    async (req, res) => {

      try {

        const marketplace = String(
          req.body?.marketplace || ''
        );

        if (!allowed.has(marketplace)) {

          throw bad(
            'Choose Cosmetics or Fashion.'
          );

        }

        const product = validate(
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
          VALUES
            (
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

        res.status(201).json({
          success: true,
          submission: rows[0]
        });

      } catch (error) {

        fail(res, error);

      }

    }
  );

  // ==================================================
  // SELLER: EDIT COSMETICS / FASHION PRODUCT
  // ==================================================

  app.patch(
    '/api/sellers/catalog-submissions/:id',
    requireSellerAuth,
    async (req, res) => {

      try {

        if (!uuid(req.params.id)) {

          throw bad(
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

          throw bad(
            'Withdrawn product cannot be edited.'
          );

        }

        const product = validate(
          submission.marketplace,
          req.body?.product || {}
        );

        const target =
          submission.marketplace === 'cosmetics'
            ? 'cosmetics_products'
            : 'clothing_products';

        // Approved product:
        // Unpublish before sending for re-approval.

        if (
          submission.approval_status ===
          'approved'
        ) {

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
                published_product_id = NULL,
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
                'Live listing changed; refresh before editing.'
            });

          }

          return res.json({
            success: true,
            submission: changed[0]
          });

        }

        // Pending / Rejected product:
        // Save and send to admin review.

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
              'Product changed; refresh.'
          });

        }

        res.json({
          success: true,
          submission: changed[0]
        });

      } catch (error) {

        fail(res, error);

      }

    }
  );

  // ==================================================
  // SELLER: WITHDRAW COSMETICS / FASHION PRODUCT
  // ==================================================

  app.delete(
    '/api/sellers/catalog-submissions/:id',
    requireSellerAuth,
    async (req, res) => {

      try {

        if (!uuid(req.params.id)) {

          throw bad(
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

        // Approved product:
        // Remove from public storefront.

        if (
          submission.approval_status ===
          'approved'
        ) {

          const target =
            submission.marketplace === 'cosmetics'
              ? 'cosmetics_products'
              : 'clothing_products';

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
              submission.published_product_id,
              submission.id,
              req.seller.id
            ]
          );

          if (!changed.length) {

            return res.status(409).json({
              success: false,
              message:
                'Live listing changed; refresh before withdrawing.'
            });

          }

          return res.json({
            success: true,
            submission: changed[0]
          });

        }

        // Pending / Rejected product:
        // Mark withdrawn.

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
              'Product changed; refresh.'
          });

        }

        res.json({
          success: true,
          submission: changed[0]
        });

      } catch (error) {

        fail(res, error);

      }

    }
  );

  // ==================================================
  // ADMIN: GET COSMETICS / FASHION APPROVAL QUEUE
  // ==================================================

  app.get(
    '/api/admin/catalog-submissions',
    requireAdminAuth,
    async (req, res) => {

      try {

        const marketplace = String(
          req.query.marketplace || ''
        );

        if (!allowed.has(marketplace)) {

          throw bad(
            'Choose cosmetics or clothing marketplace.'
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

        res.json({
          success: true,
          products
        });

      } catch (error) {

        fail(res, error);

      }

    }
  );

  // ==================================================
  // ADMIN: APPROVE / REJECT SUBMISSION
  // ==================================================

  app.patch(
    '/api/admin/catalog-submissions/:id/approval',
    requireAdminAuth,
    async (req, res) => {

      try {

        if (!uuid(req.params.id)) {

          throw bad(
            'Invalid submission ID.'
          );

        }

        const state = String(
          req.body?.approval_status || ''
        );

        if (
          ![
            'approved',
            'rejected'
          ].includes(state)
        ) {

          throw bad(
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
          [req.params.id]
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
              'This submission was already reviewed. Refresh the page.'
          });

        }

        if (
          state === 'approved' &&
          submission.seller_status !==
          'approved'
        ) {

          throw bad(
            'Seller account must be approved first.'
          );

        }

        // -------------------------------
        // REJECT
        // -------------------------------

        if (state === 'rejected') {

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
              req.params.id
            ]
          );

          if (!changed.length) {

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

        // -------------------------------
        // APPROVE + PUBLISH
        // -------------------------------

        const product = validate(
          submission.marketplace,
          submission.product_data
        );

        const columns = fields.join(',');

        const values = fields
          .map(() => '?')
          .join(',');

        const target =
          submission.marketplace ===
          'cosmetics'
            ? 'cosmetics_products'
            : 'clothing_products';

        const sql = `
          WITH claim AS (

            UPDATE
              public.cerood_seller_catalog_submissions

            SET
              approval_status = 'approved',
              published_product_id = id,
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
              claim.id,
              ${values},
              'published'

            FROM claim

            RETURNING id

          )

          SELECT id
          FROM inserted
        `;

        const published = await query(
          sql,
          [
            submission.id,
            ...fields.map(
              key => product[key]
            )
          ]
        );

        if (!published.length) {

          return res.status(409).json({
            success: false,
            message:
              'Already reviewed.'
          });

        }

        res.json({
          success: true,
          product_id: published[0].id
        });

      } catch (error) {

        fail(res, error);

      }

    }
  );

};
