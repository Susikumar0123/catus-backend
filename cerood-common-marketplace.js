'use strict';

// Public, read-only product feed.
// Does not change checkout, seller approvals or Home Services.

module.exports = function registerCommonMarketplace(app, db) {

  const query = sql => new Promise((resolve, reject) =>
    db.query(sql, [], (error, rows) =>
      error ? reject(error) : resolve(rows || [])
    )
  );

  const sources = [

    {
      marketplace: 'renewed',
      path: '/renewed-product.html',

      sql: `
        SELECT
          id,
          name,
          category,
          brand,
          price,
          compare_price,
          stock,
          image_url,
          created_at

        FROM public.renewed_products

        WHERE status = 'published'
          AND stock > 0
          AND (
            seller_id IS NULL
            OR approval_status = 'approved'
          )

        ORDER BY created_at DESC

        LIMIT 250
      `
    },

    {
      marketplace: 'beauty',
      path: '/cosmetics-product.html',

      sql: `
        SELECT
          id,
          name,
          category,
          brand,
          price,
          compare_price,
          stock,
          image_url,
          created_at

        FROM public.cosmetics_products

        WHERE status = 'published'
          AND stock > 0
          AND (
            expiry_date IS NULL
            OR expiry_date >= CURRENT_DATE
          )

        ORDER BY created_at DESC

        LIMIT 250
      `
    },

    {
      marketplace: 'fashion',
      path: '/clothing-product.html',

      sql: `
        SELECT
          id,
          name,
          category,
          brand,
          price,
          compare_price,
          stock,
          image_url,
          created_at

        FROM public.clothing_products

        WHERE status = 'published'
          AND stock > 0

        ORDER BY created_at DESC

        LIMIT 250
      `
    }

  ];

  app.get('/api/marketplace/products', async (req, res) => {

    const results = await Promise.allSettled(

      sources.map(async source => {

        const rows = await query(source.sql);

        return rows.map(row => ({

          id: row.id,

          name: row.name,

          category: row.category,

          brand: row.brand,

          price: row.price,

          compare_price: row.compare_price,

          stock: row.stock,

          image_url: row.image_url,

          marketplace: source.marketplace,

          product_url:
            `${source.path}?id=${encodeURIComponent(String(row.id))}`,

          created_at: row.created_at

        }));

      })

    );

    if (
      results.every(
        result => result.status === 'rejected'
      )
    ) {

      console.error(
        'Common marketplace feed:',
        results.map(r => r.reason?.message)
      );

      return res.status(503).json({

        success: false,

        message: 'Product catalogue temporarily unavailable.'

      });

    }

    const products = results

      .flatMap(result =>
        result.status === 'fulfilled'
          ? result.value
          : []
      )

      .sort(
        (a, b) =>
          new Date(b.created_at || 0) -
          new Date(a.created_at || 0)
      )

      .map(({ created_at, ...product }) => product);

    const unavailable = results.flatMap(

      (result, i) =>
        result.status === 'rejected'
          ? [sources[i].marketplace]
          : []

    );

    if (unavailable.length) {

      console.error(
        'Partial marketplace feed:',
        unavailable
      );

    }

    res.set(
      'Cache-Control',
      'public, max-age=0, s-maxage=60'
    );

    return res.json({

      success: true,

      products,

      partial: unavailable.length > 0,

      unavailable

    });

  });

};