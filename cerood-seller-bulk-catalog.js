'use strict';

// CEROOD seller bulk catalog importer.
// Purpose: initial supplier/wholesaler catalog onboarding only.
// Rows are staged for the existing CEROOD admin QC workflow; this module never
// auto-publishes products and never stores supplier API credentials in the browser.

const crypto = require('crypto');

module.exports = function registerSellerBulkCatalogRoutes(app, db, requireSellerAuth) {
  const query = (sql, values = []) => new Promise((resolve, reject) =>
    db.query(sql, values, (error, rows) => error ? reject(error) : resolve(rows || [])));

  const allowedMarketplaces = new Set(['general', 'clothing', 'cosmetics']);
  const uuid = value => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''));
  const text = (value, max = 250) => String(value ?? '').trim().slice(0, max);
  const fail = (message, status = 400) => Object.assign(new Error(message), { status });

  function sendError(res, error) {
    console.error('Seller bulk catalog:', error.message);
    return res.status(error.status || 500).json({
      success: false,
      message: error.status ? error.message : 'Bulk catalog service unavailable.'
    });
  }

  let tableReady = null;
  function ensureBatchTable() {
    if (tableReady) return tableReady;
    tableReady = query(`
      CREATE TABLE IF NOT EXISTS public.cerood_catalog_import_batches (
        id uuid PRIMARY KEY,
        seller_id uuid NOT NULL,
        marketplace text NOT NULL,
        category_id uuid NULL,
        category_path text NULL,
        file_name text NULL,
        total_rows integer NOT NULL DEFAULT 0,
        accepted_rows integer NOT NULL DEFAULT 0,
        updated_rows integer NOT NULL DEFAULT 0,
        skipped_rows integer NOT NULL DEFAULT 0,
        rejected_rows integer NOT NULL DEFAULT 0,
        status text NOT NULL DEFAULT 'processing',
        error_report jsonb NOT NULL DEFAULT '[]'::jsonb,
        created_at timestamptz NOT NULL DEFAULT NOW(),
        updated_at timestamptz NOT NULL DEFAULT NOW()
      )
    `).catch(error => {
      tableReady = null;
      throw error;
    });
    return tableReady;
  }

  function money(value, key, required = false) {
    if (value === '' || value == null) {
      if (required) throw fail(`${key} is required.`);
      return null;
    }
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0 || n > 100000000) throw fail(`Invalid ${key}.`);
    if (required && n <= 0) throw fail(`${key} must be greater than zero.`);
    return n;
  }

  function stock(value) {
    const n = Number(value);
    if (!Number.isSafeInteger(n) || n < 0 || n > 1000000) throw fail('Invalid stock.');
    return n;
  }

  function httpsUrl(value, key, required = false) {
    const v = text(value, 2048);
    if (!v) {
      if (required) throw fail(`${key} is required.`);
      return '';
    }
    if (!/^https:\/\//i.test(v)) throw fail(`${key} must use HTTPS.`);
    return v;
  }

  function isoDate(value, key, required = false) {
    const v = text(value, 10);
    if (!v) {
      if (required) throw fail(`${key} is required.`);
      return null;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) throw fail(`Invalid ${key}.`);
    return v;
  }

  function cleanBase(row, batchId) {
    const supplierSku = text(row.supplier_sku, 120);
    const name = text(row.product_name || row.name, 140);
    const brand = text(row.brand, 100);
    const category = text(row.product_type || row.category, 250);
    if (!supplierSku) throw fail('supplier_sku is required for safe duplicate handling.');
    if (!name) throw fail('product_name is required.');
    if (!brand) throw fail('brand is required.');
    if (!category) throw fail('product_type/category is required.');

    const price = money(row.selling_price ?? row.price, 'selling_price', true);
    const compare = money(row.mrp ?? row.compare_price, 'mrp', false);
    if (compare !== null && compare < price) throw fail('MRP must be greater than or equal to selling price.');

    return {
      supplier_sku: supplierSku,
      catalog_batch_id: batchId,
      name,
      brand,
      category,
      price,
      compare_price: compare,
      stock: stock(row.stock),
      description: text(row.description, 5000),
      image_url: httpsUrl(row.image_url, 'image_url', true),
      video_url: httpsUrl(row.video_url, 'video_url', false),
      manufacturer: text(row.manufacturer, 250),
      importer: text(row.importer, 250)
    };
  }

  async function getGeneralCategory(categoryId) {
    if (!uuid(categoryId)) throw fail('Choose a valid Cerood Main Store category.');
    const rows = await query(`
      SELECT c.id,c.name,c.parent_id,p.name AS parent_name
      FROM public.cerood_shop_categories c
      LEFT JOIN public.cerood_shop_categories p
        ON p.id=c.parent_id
       AND p.marketplace='general'
       AND p.is_active=true
      WHERE c.id=?
        AND c.marketplace='general'
        AND c.is_active=true
      LIMIT 1
    `, [categoryId]);
    if (!rows.length) throw fail('Selected Cerood Main Store category is inactive or missing.');
    if (rows[0].parent_id && !rows[0].parent_name) throw fail('Selected category parent is inactive.');
    return rows[0];
  }

  function buildProduct(marketplace, row, meta) {
    const b = cleanBase(row, meta.batchId);

    if (marketplace === 'general') {
      const productAttributes = {
        supplier_sku: b.supplier_sku,
        source: 'seller_bulk_catalog'
      };
      for (const key of ['size', 'color', 'variant', 'shade']) {
        const value = text(row[key], 250);
        if (value) productAttributes[key] = value;
      }
      return {
        supplier_sku: b.supplier_sku,
        catalog_batch_id: b.catalog_batch_id,
        name: b.name,
        category: meta.generalCategory.parent_name || meta.generalCategory.name,
        subcategory: meta.generalCategory.parent_id ? meta.generalCategory.name : '',
        brand: b.brand,
        model: text(row.model, 120),
        description: b.description,
        price: b.price,
        compare_price: b.compare_price,
        stock: b.stock,
        image_url: b.image_url,
        video_url: b.video_url,
        category_id: String(meta.generalCategory.id),
        product_attributes: productAttributes,
        product_images: {}
      };
    }

    if (marketplace === 'clothing') {
      const size = text(row.size, 100);
      const color = text(row.color || row.shade, 100);
      const explicitVariant = text(row.variant, 100);
      return {
        supplier_sku: b.supplier_sku,
        catalog_batch_id: b.catalog_batch_id,
        name: b.name,
        category: text(meta.categoryLeaf || b.category, 250),
        brand: b.brand,
        description: b.description,
        variant: explicitVariant || size,
        shade: color,
        net_quantity: '',
        ingredients: '',
        directions: '',
        warnings: '',
        batch_number: '',
        manufacture_date: null,
        expiry_date: null,
        price: b.price,
        compare_price: b.compare_price,
        stock: b.stock,
        image_url: b.image_url,
        video_url: b.video_url,
        manufacturer: b.manufacturer,
        importer: b.importer
      };
    }

    const expiry = isoDate(row.expiry_date, 'expiry_date', true);
    const manufacture = isoDate(row.manufacture_date, 'manufacture_date', false);
    if (manufacture && expiry && manufacture > expiry) throw fail('expiry_date must be after manufacture_date.');
    if (expiry < new Date().toISOString().slice(0, 10)) throw fail('expiry_date must be in the future.');
    const netQuantity = text(row.net_quantity, 120);
    if (!netQuantity) throw fail('net_quantity is required for cosmetics.');

    return {
      supplier_sku: b.supplier_sku,
      catalog_batch_id: b.catalog_batch_id,
      name: b.name,
      category: text(meta.categoryLeaf || b.category, 250),
      brand: b.brand,
      description: b.description,
      variant: text(row.variant || row.size, 100),
      shade: text(row.shade || row.color, 100),
      net_quantity: netQuantity,
      ingredients: text(row.ingredients, 5000),
      directions: text(row.directions, 5000),
      warnings: text(row.warnings, 5000),
      batch_number: text(row.batch_number, 250),
      manufacture_date: manufacture,
      expiry_date: expiry,
      price: b.price,
      compare_price: b.compare_price,
      stock: b.stock,
      image_url: b.image_url,
      video_url: b.video_url,
      manufacturer: b.manufacturer,
      importer: b.importer
    };
  }

  async function stageSubmission(sellerId, marketplace, product) {
    const existing = await query(`
      SELECT id,approval_status,published_product_id
      FROM public.cerood_seller_catalog_submissions
      WHERE seller_id=?
        AND marketplace=?
        AND product_data->>'supplier_sku'=?
      ORDER BY updated_at DESC
      LIMIT 1
    `, [sellerId, marketplace, product.supplier_sku]);

    if (existing.length) {
      const old = existing[0];
      if (old.approval_status === 'approved' || old.published_product_id) {
        return { action: 'skipped', reason: 'SKU already has an approved/live product. Use the inventory or API sync workflow for price/stock changes.' };
      }
      const changed = await query(`
        UPDATE public.cerood_seller_catalog_submissions
        SET product_data=?::jsonb,
            approval_status='pending',
            rejection_reason=NULL,
            updated_at=NOW()
        WHERE id=? AND seller_id=?
        RETURNING id
      `, [JSON.stringify(product), old.id, sellerId]);
      if (!changed.length) throw fail('Existing SKU changed while importing.', 409);
      return { action: 'updated', id: changed[0].id };
    }

    const inserted = await query(`
      INSERT INTO public.cerood_seller_catalog_submissions
        (seller_id,marketplace,product_data)
      VALUES (?,?,?::jsonb)
      RETURNING id
    `, [sellerId, marketplace, JSON.stringify(product)]);
    return { action: 'inserted', id: inserted[0]?.id };
  }

  app.get('/api/sellers/bulk-catalog/imports', requireSellerAuth, async (req, res) => {
    try {
      await ensureBatchTable();
      const rows = await query(`
        SELECT id,marketplace,category_id,category_path,file_name,total_rows,
               accepted_rows,updated_rows,skipped_rows,rejected_rows,status,
               error_report,created_at,updated_at
        FROM public.cerood_catalog_import_batches
        WHERE seller_id=?
        ORDER BY created_at DESC
        LIMIT 100
      `, [req.seller.id]);
      return res.json({ success: true, imports: rows });
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.post('/api/sellers/bulk-catalog/import', requireSellerAuth, async (req, res) => {
    try {
      await ensureBatchTable();
      const body = req.body || {};
      const marketplace = text(body.marketplace, 30);
      if (!allowedMarketplaces.has(marketplace)) {
        throw fail('Bulk supplier catalogs currently support Cerood Main Store, Fashion and Cosmetics. Renewed products require individual condition/photo verification.');
      }

      const batchId = text(body.batch_id, 50);
      if (!uuid(batchId)) throw fail('Invalid bulk batch ID.');
      const rows = Array.isArray(body.rows) ? body.rows : [];
      if (!rows.length || rows.length > 250) throw fail('Each bulk request must contain 1 to 250 rows.');

      const fileName = text(body.file_name, 255);
      const categoryPath = text(body.category_path, 1000);
      const categoryLeaf = text(body.category_leaf, 250);
      const categoryId = body.category_id ? text(body.category_id, 50) : null;
      const finalChunk = body.final_chunk === true;
      const rowOffset = Number.isSafeInteger(Number(body.row_offset)) && Number(body.row_offset) >= 0 ? Number(body.row_offset) : 0;

      let generalCategory = null;
      if (marketplace === 'general') generalCategory = await getGeneralCategory(categoryId);

      await query(`
        INSERT INTO public.cerood_catalog_import_batches
          (id,seller_id,marketplace,category_id,category_path,file_name,status)
        VALUES (?, ?, ?, ?::uuid, ?, ?, 'processing')
        ON CONFLICT (id) DO NOTHING
      `, [batchId, req.seller.id, marketplace, marketplace === 'general' ? categoryId : null, categoryPath || null, fileName || null]);

      const owned = await query(`SELECT id,marketplace FROM public.cerood_catalog_import_batches WHERE id=? AND seller_id=? LIMIT 1`, [batchId, req.seller.id]);
      if (!owned.length) throw fail('Bulk batch does not belong to this seller.', 403);
      if (owned[0].marketplace !== marketplace) throw fail('Bulk batch marketplace mismatch.', 409);

      let inserted = 0, updated = 0, skipped = 0, rejected = 0;
      const errors = [];
      const seen = new Set();

      for (let index = 0; index < rows.length; index++) {
        try {
          const raw = rows[index] && typeof rows[index] === 'object' && !Array.isArray(rows[index]) ? rows[index] : {};
          const sku = text(raw.supplier_sku, 120).toLowerCase();
          if (sku && seen.has(sku)) throw fail('Duplicate supplier_sku inside this upload chunk.');
          if (sku) seen.add(sku);

          const product = buildProduct(marketplace, raw, {
            batchId,
            categoryLeaf,
            generalCategory
          });
          const result = await stageSubmission(req.seller.id, marketplace, product);
          if (result.action === 'inserted') inserted++;
          else if (result.action === 'updated') updated++;
          else { skipped++; errors.push({ row: rowOffset + index + 2, supplier_sku: product.supplier_sku, error: result.reason }); }
        } catch (error) {
          rejected++;
          errors.push({
            row: rowOffset + index + 2,
            supplier_sku: text(rows[index]?.supplier_sku, 120) || null,
            error: text(error.message || 'Invalid row.', 500)
          });
        }
      }

      const accepted = inserted + updated;
      const batchStatus = finalChunk
        ? (rejected > 0 || skipped > 0 ? (accepted > 0 ? 'partial' : 'failed') : 'completed')
        : 'processing';

      const previous = await query(`SELECT error_report FROM public.cerood_catalog_import_batches WHERE id=? AND seller_id=? LIMIT 1`, [batchId, req.seller.id]);
      const oldErrors = Array.isArray(previous[0]?.error_report) ? previous[0].error_report : [];
      const mergedErrors = [...oldErrors, ...errors].slice(0, 500);

      const changed = await query(`
        UPDATE public.cerood_catalog_import_batches
        SET total_rows=total_rows+?,
            accepted_rows=accepted_rows+?,
            updated_rows=updated_rows+?,
            skipped_rows=skipped_rows+?,
            rejected_rows=rejected_rows+?,
            status=?,
            error_report=?::jsonb,
            updated_at=NOW()
        WHERE id=? AND seller_id=?
        RETURNING id,marketplace,category_id,category_path,file_name,total_rows,
                  accepted_rows,updated_rows,skipped_rows,rejected_rows,status,
                  error_report,created_at,updated_at
      `, [rows.length, accepted, updated, skipped, rejected, batchStatus, JSON.stringify(mergedErrors), batchId, req.seller.id]);

      return res.status(201).json({
        success: true,
        message: finalChunk ? 'Bulk catalog staged for CEROOD admin QC.' : 'Bulk catalog chunk accepted.',
        chunk: { rows: rows.length, inserted, updated, skipped, rejected, errors },
        batch: changed[0]
      });
    } catch (error) {
      return sendError(res, error);
    }
  });
};
