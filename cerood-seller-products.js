
'use strict';
// CEROOD seller inventory and product approval. No payment/order modifications.
const crypto = require('crypto');

module.exports = function registerSellerProductRoutes(app, db, requireSellerAuth, requireAdminAuth) {
  const query = (sql, values = []) => new Promise((resolve, reject) =>
    db.query(sql, values, (error, rows) => error ? reject(error) : resolve(rows || [])));

  const fields = `id,seller_id,category_id,name,category,condition,brand,model,price,compare_price,stock,
    warranty_days,location,delivery,image_url,video_url,known_defects,accessories,
    warranty_terms,status,approval_status,created_at,updated_at`;

  const categories = new Set(['tv','refrigerator','washing-machine','ac','laptop','other']);
  const conditions = new Set(['Refurbished','Pre-owned','Open box']);

  const uuid = v => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(v || ''));

  const err = (res,e) => {
    console.error('Seller products:',e.message);
    return res.status(e.status || 500).json({
      success:false,
      message:e.status ? e.message : 'Product service unavailable.'
    });
  };

  const bad = message => Object.assign(new Error(message),{status:400});

  function clean(body, sellerId) {
    const text = (k,n) => String(body[k] ?? '').trim().slice(0,n);

    const integer = (k,min,max) => {
      const v = Number(body[k]);

      if (
        body[k] === '' ||
        body[k] == null ||
        !Number.isSafeInteger(v) ||
        v < min ||
        v > max
      ) {
        throw bad(`Invalid ${k}.`);
      }

      return v;
    };

    const name = text('name',140);
    const category = text('category',40);
    const condition = text('condition',40);

    if (!name || !categories.has(category) || !conditions.has(condition)) {
      throw bad('Name, category and condition are required.');
    }

    const price = integer('price',1,100000000);
    const stock = integer('stock',0,99999);
    const warranty_days = integer('warranty_days',0,3650);

    const compare_price =
      body.compare_price === '' || body.compare_price == null
        ? null
        : integer('compare_price',0,100000000);

    const image_url = text('image_url',2048);
    const video_url = text('video_url',2048);

    const storageUrl = String(
      process.env.SUPABASE_URL ||
      process.env.PROJECT_URL ||
      ''
    )
      .replace(/\/rest\/v1\/?$/,'')
      .replace(/\/$/,'');

    const prefix =
      storageUrl +
      '/storage/v1/object/public/catus-images/seller-products/' +
      sellerId +
      '/';

    if (
      !storageUrl ||
      !image_url.startsWith(prefix) ||
      image_url.length <= prefix.length ||
      /[?#]/.test(image_url)
    ) {
      throw bad('Upload an actual product photo to CEROOD storage first.');
    }

    if (
      video_url &&
      (
        !video_url.startsWith(prefix) ||
        video_url.length <= prefix.length ||
        /[?#]/.test(video_url)
      )
    ) {
      throw bad('Video must be uploaded to CEROOD storage.');
    }

    const known_defects = text('known_defects',2000);
    const warranty_terms = text('warranty_terms',1500);

    if (!known_defects || !warranty_terms) {
      throw bad('Describe known defects (or None) and warranty terms.');
    }

    return {
      name,
      category,
      condition,
      brand:text('brand',80),
      model:text('model',80),
      price,
      compare_price,
      stock,
      warranty_days,
      location:text('location',100),
      delivery:text('delivery',160),
      image_url,
      video_url,
      known_defects,
      accessories:(
        Array.isArray(body.accessories)
          ? body.accessories
          : String(body.accessories || '').split(',')
      )
        .map(v => String(v).trim().slice(0,100))
        .filter(Boolean)
        .slice(0,30),
      warranty_terms
    };
  }

  // Resolve category schema inheritance safely.
  // Priority: schema_parent_id (explicit schema inheritance) -> parent_id (normal category inheritance).
  // Root definitions load first; child definitions override duplicate attribute_key / slot_key values.
  async function resolveCategorySchema(category, marketplace='renewed', categoryMap=null) {
    const chain=[];
    const seen=new Set();
    let node=category;
    let depth=0;

    while (node) {
      const nodeId=String(node.id);
      if (seen.has(nodeId)) throw bad('Circular category schema inheritance detected.');
      if (++depth > 25) throw bad('Category schema inheritance is too deep.');
      seen.add(nodeId);
      chain.unshift(node);

      const next=node.schema_parent_id || node.parent_id;
      if (!next) break;

      if (categoryMap && categoryMap.has(String(next))) {
        node=categoryMap.get(String(next));
      } else {
        const rows=await query(
          `SELECT id,marketplace,name,slug,parent_id,schema_parent_id,is_leaf
           FROM public.cerood_product_categories
           WHERE id=? AND marketplace=? AND is_active=true
           LIMIT 1`,
          [next,marketplace]
        );
        node=rows[0]||null;
      }
    }

    const attrs=new Map();
    const imgs=new Map();
    for (const c of chain) {
      const rows=await query(
        `SELECT id,category_id,attribute_key,label,input_type,unit,options,placeholder,is_required,is_variant,sort_order
         FROM public.cerood_product_attributes
         WHERE category_id=? AND is_active=true
         ORDER BY sort_order ASC,label ASC`,
        [c.id]
      );
      rows.forEach(r=>attrs.set(String(r.attribute_key),r));

      const slots=await query(
        `SELECT id,category_id,slot_key,label,description,is_required,sort_order
         FROM public.cerood_category_image_slots
         WHERE category_id=? AND is_active=true
         ORDER BY sort_order ASC,label ASC`,
        [c.id]
      );
      slots.forEach(r=>imgs.set(String(r.slot_key),r));
    }

    return {
      schema_chain: chain.map(c=>({id:c.id,name:c.name,slug:c.slug})),
      attributes:[...attrs.values()].sort((a,b)=>(a.sort_order||0)-(b.sort_order||0)||String(a.label).localeCompare(String(b.label))),
      image_slots:[...imgs.values()].sort((a,b)=>(a.sort_order||0)-(b.sort_order||0)||String(a.label).localeCompare(String(b.label)))
    };
  }

  // Dynamic Renewed category master for Seller Dashboard.
  // Reads the relational category/attribute/image-slot tables created for CEROOD Renewed.
  app.get('/api/sellers/renewed-categories',requireSellerAuth,async(req,res)=>{
    try {
      const categories = await query(
        `SELECT id,marketplace,parent_id,schema_parent_id,name,slug,sort_order,
                category_level,is_leaf,category_path
         FROM public.cerood_product_categories
         WHERE marketplace='renewed' AND is_active=true
         ORDER BY category_level ASC,sort_order ASC,name ASC`
      );

      const byId=new Map(categories.map(c=>[String(c.id),c]));
      const result=[];
      for(const category of categories){
        const schema=await resolveCategorySchema(category,'renewed',byId);
        result.push({...category,...schema});
      }

      res.json({success:true,categories:result});
    } catch(e) {
      err(res,e);
    }
  });

  // Validate and persist optional dynamic Renewed catalog data.
  // Legacy seller forms can omit these fields and continue working unchanged.
  async function prepareDynamicCatalog(body) {
    const categoryId=String(body?.category_id||'').trim();
    if (!categoryId) return null;
    if (!uuid(categoryId)) throw bad('Invalid Renewed category ID.');

    const categoryRows=await query(
      `SELECT id,name,slug,parent_id,schema_parent_id,is_leaf
       FROM public.cerood_product_categories
       WHERE id=? AND marketplace='renewed' AND is_active=true
       LIMIT 1`,
      [categoryId]
    );
    if (!categoryRows.length || !categoryRows[0].is_leaf) throw bad('Choose a final active Renewed category.');

    const category=categoryRows[0];
    const resolved=await resolveCategorySchema(category,'renewed');
    const attributeRows=resolved.attributes;
    const slotRows=resolved.image_slots;

    const rawAttrs=(body?.product_attributes && typeof body.product_attributes==='object' && !Array.isArray(body.product_attributes))
      ? body.product_attributes : {};
    const rawImages=(body?.product_images && typeof body.product_images==='object' && !Array.isArray(body.product_images))
      ? body.product_images : {};
    const rawVariants=Array.isArray(body?.product_variants) ? body.product_variants : [];

    const attributes=[];
    for (const a of attributeRows) {
      const value=rawAttrs[a.attribute_key];
      const empty=value===undefined || value===null || value==='' || (Array.isArray(value)&&!value.length);
      if (a.is_required && empty) throw bad(`${a.label} is required.`);
      if (!empty) attributes.push({attribute_id:a.id,value});
    }

    const allowedSlots=new Map(slotRows.map(x=>[String(x.slot_key),x]));
    const images=[];
    for (const slot of slotRows) {
      const value=String(rawImages[slot.slot_key]||'').trim();
      if (slot.is_required && !value) throw bad(`${slot.label} image is required.`);
      if (value) {
        if (!/^https:\/\//i.test(value)) throw bad(`${slot.label} image must use HTTPS.`);
        images.push({slot_key:slot.slot_key,image_url:value});
      }
    }
    // Ignore gallery here; gallery is not a configured category image slot.
    for (const key of Object.keys(rawImages)) {
      if (key==='gallery') continue;
      if (!allowedSlots.has(key)) throw bad('Invalid Renewed product image slot.');
    }

    // Variant persistence: only attributes marked is_variant may appear in variant_values.
    // Every generated combination must be unique and have its own SKU / price / stock.
    const variantAttrs=attributeRows.filter(a=>a.is_variant);
    const variantKeys=new Set(variantAttrs.map(a=>String(a.attribute_key)));
    if (rawVariants.length > 250) throw bad('A product can have a maximum of 250 variants.');
    if (variantAttrs.length && !rawVariants.length) throw bad('Add at least one product variant.');
    if (!variantAttrs.length && rawVariants.length) throw bad('This category does not support product variants.');

    const seenSkus=new Set();
    const seenCombinations=new Set();
    const variants=rawVariants.map((v,index)=>{
      const row=index+1;
      const source=(v?.variant_values && typeof v.variant_values==='object' && !Array.isArray(v.variant_values)) ? v.variant_values : {};
      for (const key of Object.keys(source)) {
        if (!variantKeys.has(String(key))) throw bad(`Invalid variant option at row ${row}.`);
      }

      const values={};
      for (const a of variantAttrs) {
        const key=String(a.attribute_key);
        const value=String(source[key]??'').trim().slice(0,160);
        if (!value) throw bad(`${a.label} is required for variant row ${row}.`);
        values[key]=value;
      }

      const sku=String(v?.sku||'').trim().slice(0,120);
      if (!sku) throw bad(`Seller SKU is required for variant row ${row}.`);
      const skuKey=sku.toLowerCase();
      if (seenSkus.has(skuKey)) throw bad(`Duplicate seller SKU at variant row ${row}.`);
      seenSkus.add(skuKey);

      const combinationKey=[...variantKeys].sort().map(k=>`${k}=${String(values[k]||'').trim().toLowerCase()}`).join('|');
      if (seenCombinations.has(combinationKey)) throw bad(`Duplicate variant combination at row ${row}.`);
      seenCombinations.add(combinationKey);

      const price=Number(v?.price);
      const compare=v?.compare_price===''||v?.compare_price==null ? null : Number(v.compare_price);
      const stock=Number(v?.stock??0);
      if (!Number.isFinite(price)||price<=0||price>100000000) throw bad(`Invalid variant price at row ${row}.`);
      if (compare!==null && (!Number.isFinite(compare)||compare<0||compare>100000000)) throw bad(`Invalid variant MRP at row ${row}.`);
      if (compare!==null && compare<price) throw bad(`Variant MRP cannot be lower than selling price at row ${row}.`);
      if (!Number.isSafeInteger(stock)||stock<0||stock>1000000) throw bad(`Invalid variant stock at row ${row}.`);
      return {sku,variant_values:values,price,compare_price:compare,stock};
    });

    return {category,attributes,images,variants};
  }

  async function replaceDynamicCatalog(productId,dynamic) {
    if (!dynamic) return;
    await query(`DELETE FROM public.cerood_product_attribute_values WHERE marketplace='renewed' AND product_id=?`,[productId]);
    await query(`DELETE FROM public.cerood_product_images WHERE marketplace='renewed' AND product_id=?`,[productId]);
    await query(`DELETE FROM public.cerood_product_variants WHERE marketplace='renewed' AND product_id=?`,[productId]);

    for (const a of dynamic.attributes) {
      await query(
        `INSERT INTO public.cerood_product_attribute_values
         (marketplace,product_id,attribute_id,value)
         VALUES ('renewed',?,?,?::jsonb)`,
        [productId,a.attribute_id,JSON.stringify(a.value)]
      );
    }
    for (let i=0;i<dynamic.images.length;i++) {
      const img=dynamic.images[i];
      await query(
        `INSERT INTO public.cerood_product_images
         (marketplace,product_id,slot_key,image_url,sort_order)
         VALUES ('renewed',?,?,?,?)`,
        [productId,img.slot_key,img.image_url,(i+1)*10]
      );
    }
    for (const v of dynamic.variants) {
      await query(
        `INSERT INTO public.cerood_product_variants
         (marketplace,product_id,sku,variant_values,price,compare_price,stock,is_active)
         VALUES ('renewed',?,?,?::jsonb,?,?,?,true)`,
        [productId,v.sku,JSON.stringify(v.variant_values),v.price,v.compare_price,v.stock]
      );
    }
  }

  // ==========================================================
  // CEROOD CATALOG LATCH — search existing approved Renewed products
  // Seller can attach an offer to an existing master product instead
  // of creating a duplicate product row.
  // ==========================================================
  app.get('/api/sellers/catalog-search',requireSellerAuth,async(req,res)=>{
    try {
      const q=String(req.query.q||'').trim().slice(0,120);
      if (q.length < 2) return res.json({success:true,products:[]});
      const like=`%${q}%`;
      const products=await query(
        `SELECT id,name,category,condition,brand,model,image_url,warranty_days,status,approval_status
         FROM public.renewed_products
         WHERE approval_status='approved'
           AND status='published'
           AND (
             LOWER(COALESCE(name,'')) LIKE LOWER(?) OR
             LOWER(COALESCE(brand,'')) LIKE LOWER(?) OR
             LOWER(COALESCE(model,'')) LIKE LOWER(?) OR
             LOWER(CONCAT(COALESCE(brand,''),' ',COALESCE(model,''))) LIKE LOWER(?)
           )
         ORDER BY
           CASE WHEN LOWER(COALESCE(name,''))=LOWER(?) THEN 0 ELSE 1 END,
           updated_at DESC
         LIMIT 20`,
        [like,like,like,like,q]
      );
      res.json({success:true,products});
    } catch(e) { err(res,e); }
  });

  // Create/update this seller's offer for an existing product.
  app.post('/api/sellers/products/:id/latch',requireSellerAuth,async(req,res)=>{
    try {
      const productId=String(req.params.id||'').trim();
      if (!productId || productId.length > 200) throw bad('Invalid product ID.');

      const master=await query(
        `SELECT id,name,condition,warranty_days
         FROM public.renewed_products
         WHERE id=? AND approval_status='approved' AND status='published'
         LIMIT 1`,
        [productId]
      );
      if (!master.length) return res.status(404).json({success:false,message:'Approved product was not found in the CEROOD catalog.'});

      const money=(key,required=false)=>{
        const raw=req.body?.[key];
        if (!required && (raw==='' || raw==null)) return null;
        const n=Number(raw);
        if (!Number.isFinite(n) || n < 0 || n > 100000000) throw bad(`Invalid ${key}.`);
        if (required && n <= 0) throw bad(`${key} must be greater than zero.`);
        return n;
      };
      const integer=(key,min,max,def)=>{
        const raw=req.body?.[key];
        if ((raw==='' || raw==null) && def!==undefined) return def;
        const n=Number(raw);
        if (!Number.isSafeInteger(n) || n<min || n>max) throw bad(`Invalid ${key}.`);
        return n;
      };

      const price=money('price',true);
      const comparePrice=money('compare_price',false);
      const stock=integer('stock',0,99999);
      const warrantyDays=integer('warranty_days',0,3650,Number(master[0].warranty_days||0));
      const dispatchDays=integer('dispatch_days',0,60,1);
      const sellerSku=String(req.body?.seller_sku||'').trim().slice(0,120) || null;
      const condition=String(req.body?.condition||master[0].condition||'Refurbished').trim().slice(0,40);

      // UNIQUE(seller_id,product_id) makes this idempotent: a repeat submission
      // updates the seller offer and sends it back for admin approval.
      const rows=await query(
        `INSERT INTO public.cerood_seller_listings
          (seller_id,product_id,seller_sku,price,compare_price,stock,warranty_days,dispatch_days,condition,approval_status,rejection_reason,is_active)
         VALUES (?,?,?,?,?,?,?,?,?,'pending',NULL,true)
         ON CONFLICT (seller_id,product_id)
         DO UPDATE SET
           seller_sku=EXCLUDED.seller_sku,
           price=EXCLUDED.price,
           compare_price=EXCLUDED.compare_price,
           stock=EXCLUDED.stock,
           warranty_days=EXCLUDED.warranty_days,
           dispatch_days=EXCLUDED.dispatch_days,
           condition=EXCLUDED.condition,
           approval_status='pending',
           rejection_reason=NULL,
           is_active=true,
           updated_at=NOW()
         RETURNING *`,
        [req.seller.id,productId,sellerSku,price,comparePrice,stock,warrantyDays,dispatchDays,condition]
      );
      res.status(201).json({success:true,message:'Product latched successfully. Waiting for CEROOD admin approval.',listing:rows[0],product:master[0]});
    } catch(e) { err(res,e); }
  });

  // Seller's own latched offers.
  app.get('/api/sellers/latched-products',requireSellerAuth,async(req,res)=>{
    try {
      const rows=await query(
        `SELECT l.*,p.name,p.brand,p.model,p.image_url,p.category
         FROM public.cerood_seller_listings l
         JOIN public.renewed_products p ON p.id=l.product_id
         WHERE l.seller_id=?
         ORDER BY l.updated_at DESC
         LIMIT 250`,
        [req.seller.id]
      );
      res.json({success:true,products:rows});
    } catch(e) { err(res,e); }
  });

  // ==========================================================
  // CEROOD CATALOG LATCH — seller manages ONLY their own offer.
  // Commercial edits go back to pending admin approval.
  // ==========================================================
  async function updateOwnLatchedOffer(req,res) {
    try {
      if (!uuid(req.params.id)) throw bad('Invalid seller listing ID.');

      const current = await query(
        `SELECT id,seller_id,product_id,seller_sku,price,compare_price,stock,
                warranty_days,dispatch_days,condition,approval_status,is_active
         FROM public.cerood_seller_listings
         WHERE id=? AND seller_id=?
         LIMIT 1`,
        [req.params.id,req.seller.id]
      );

      if (!current.length) {
        return res.status(404).json({success:false,message:'Your seller offer was not found.'});
      }

      const old=current[0];
      const money=(key,required=false)=>{
        const raw=req.body?.[key];
        if (!required && (raw==='' || raw==null)) return null;
        const n=Number(raw);
        if (!Number.isFinite(n) || n<0 || n>100000000) throw bad(`Invalid ${key}.`);
        if (required && n<=0) throw bad(`${key} must be greater than zero.`);
        return n;
      };
      const integer=(key,min,max,def)=>{
        const raw=req.body?.[key];
        if ((raw==='' || raw==null) && def!==undefined) return def;
        const n=Number(raw);
        if (!Number.isSafeInteger(n) || n<min || n>max) throw bad(`Invalid ${key}.`);
        return n;
      };

      const price=money('price',true);
      const comparePrice=money('compare_price',false);
      const stock=integer('stock',0,99999,Number(old.stock||0));
      const warrantyDays=integer('warranty_days',0,3650,Number(old.warranty_days||0));
      const dispatchDays=integer('dispatch_days',0,60,Number(old.dispatch_days||1));
      const sellerSku=String(req.body?.seller_sku||'').trim().slice(0,120) || null;
      const condition=String(req.body?.condition||old.condition||'Refurbished').trim().slice(0,40);
      if (!conditions.has(condition)) throw bad('Invalid condition.');

      const listings=await query(
        `UPDATE public.cerood_seller_listings
         SET seller_sku=?,
             price=?,
             compare_price=?,
             stock=?,
             warranty_days=?,
             dispatch_days=?,
             condition=?,
             approval_status='pending',
             rejection_reason=NULL,
             updated_at=NOW()
         WHERE id=? AND seller_id=?
         RETURNING *`,
        [sellerSku,price,comparePrice,stock,warrantyDays,dispatchDays,condition,req.params.id,req.seller.id]
      );

      res.json({
        success:true,
        message:'Seller offer updated. Waiting for CEROOD admin approval.',
        listing:listings[0]
      });
    } catch(e) { err(res,e); }
  }

  // Step-12 dashboard tries PATCH first; PUT is kept as a compatible alias.
  app.patch('/api/sellers/latched-products/:id',requireSellerAuth,updateOwnLatchedOffer);
  app.put('/api/sellers/latched-products/:id',requireSellerAuth,updateOwnLatchedOffer);

  // Pause/resume does not alter another seller and never bypasses admin approval.
  app.patch('/api/sellers/latched-products/:id/active',requireSellerAuth,async(req,res)=>{
    try {
      if (!uuid(req.params.id)) throw bad('Invalid seller listing ID.');
      if (typeof req.body?.is_active !== 'boolean') throw bad('is_active must be true or false.');

      const listings=await query(
        `UPDATE public.cerood_seller_listings
         SET is_active=?,
             updated_at=NOW()
         WHERE id=? AND seller_id=?
         RETURNING *`,
        [req.body.is_active,req.params.id,req.seller.id]
      );

      if (!listings.length) {
        return res.status(404).json({success:false,message:'Your seller offer was not found.'});
      }

      res.json({
        success:true,
        message:req.body.is_active ? 'Seller offer resumed.' : 'Seller offer paused.',
        listing:listings[0]
      });
    } catch(e) { err(res,e); }
  });

  // Sellers can read ONLY their own inventory.
  app.get('/api/sellers/products',requireSellerAuth,async(req,res)=>{
    try {
      const products = await query(
        `SELECT ${fields}
         FROM public.renewed_products
         WHERE seller_id=?
         ORDER BY created_at DESC
         LIMIT 250`,
        [req.seller.id]
      );

      res.json({success:true,products});
    } catch(e) {
      err(res,e);
    }
  });

  // Create as DRAFT + PENDING, never immediately visible in customer store.
  app.post('/api/sellers/products',requireSellerAuth,async(req,res)=>{
    try {
      const dynamic = await prepareDynamicCatalog(req.body || {});
      const p = clean(req.body || {}, req.seller.id);
      if (dynamic) { p.category = String(dynamic.category.slug || p.category).slice(0,40); p.category_id = dynamic.category.id; }
      else p.category_id = null;
      const keys = Object.keys(p);
      const id = crypto.randomUUID();

      const products = await query(
        `INSERT INTO public.renewed_products
         (id,seller_id,${keys.join(',')},status,approval_status)
         VALUES
         (?,?,${keys.map(()=>'?').join(',')},'draft','pending')
         RETURNING ${fields}`,
        [id,req.seller.id,...Object.values(p)]
      );

      try {
        await replaceDynamicCatalog(id,dynamic);
      } catch (dynamicError) {
        // Do not leave a half-created product when its dynamic catalog data fails.
        await query(`DELETE FROM public.renewed_products WHERE id=? AND seller_id=?`,[id,req.seller.id]).catch(()=>{});
        throw dynamicError;
      }

      res.status(201).json({
        success:true,
        product:products[0]
      });
    } catch(e) {
      err(res,e);
    }
  });

  // Editing a seller product ALWAYS removes approval and unpublishes it.
  app.put('/api/sellers/products/:id',requireSellerAuth,async(req,res)=>{
    try {
      if (!uuid(req.params.id)) {
        throw bad('Invalid product ID.');
      }

      const dynamic = await prepareDynamicCatalog(req.body || {});
      const p = clean(req.body || {}, req.seller.id);
      if (dynamic) { p.category = String(dynamic.category.slug || p.category).slice(0,40); p.category_id = dynamic.category.id; }
      else p.category_id = null;
      const keys = Object.keys(p);

      const products = await query(
        `UPDATE public.renewed_products
         SET ${keys.map(k=>`${k}=?`).join(',')},
             status='draft',
             approval_status='pending',
             updated_at=NOW()
         WHERE id=? AND seller_id=?
         RETURNING ${fields}`,
        [...Object.values(p),req.params.id,req.seller.id]
      );

      if (!products.length) {
        return res.status(404).json({
          success:false,
          message:'Your product was not found.'
        });
      }

      await replaceDynamicCatalog(req.params.id,dynamic);

      res.json({
        success:true,
        product:products[0]
      });
    } catch(e) {
      err(res,e);
    }
  });

  // Seller can withdraw a listing; no hard delete of products referenced by orders.
  app.patch('/api/sellers/products/:id/withdraw',requireSellerAuth,async(req,res)=>{
    try {
      if (!uuid(req.params.id)) {
        throw bad('Invalid product ID.');
      }

      const products = await query(
        `UPDATE public.renewed_products
         SET status='draft',
             approval_status='pending',
             updated_at=NOW()
         WHERE id=? AND seller_id=?
         RETURNING ${fields}`,
        [req.params.id,req.seller.id]
      );

      if (!products.length) {
        return res.status(404).json({
          success:false,
          message:'Your product was not found.'
        });
      }

      res.json({
        success:true,
        product:products[0]
      });
    } catch(e) {
      err(res,e);
    }
  });

  // Admin review, with seller information; no password hashes.
  app.get('/api/admin/seller-products',requireAdminAuth,async(req,res)=>{
    try {
      const products = await query(
        `SELECT p.*,s.shop_name,s.owner_name,
                s.phone AS seller_phone
         FROM public.renewed_products p
         JOIN public.cerood_sellers s
           ON s.id=p.seller_id
         ORDER BY p.updated_at DESC
         LIMIT 500`
      );

      res.json({
        success:true,
        products
      });
    } catch(e) {
      err(res,e);
    }
  });

  app.patch('/api/admin/seller-products/:id/approval',requireAdminAuth,async(req,res)=>{
    try {
      if (!uuid(req.params.id)) {
        throw bad('Invalid product ID.');
      }

      const approval = String(
        req.body?.approval_status || ''
      );

      if (!['approved','rejected','pending'].includes(approval)) {
        throw bad('Invalid approval status.');
      }

      const products = await query(
        `UPDATE public.renewed_products p
         SET approval_status=?,
             status=CASE
               WHEN ?='approved' AND p.stock>0
               THEN 'published'
               ELSE 'draft'
             END,
             updated_at=NOW()
         FROM public.cerood_sellers s
         WHERE p.id=?
           AND p.seller_id=s.id
           AND s.status='approved'
         RETURNING p.${fields.split(',').map(x=>x.trim()).join(',p.')}`,
        [approval,approval,req.params.id]
      );

      if (!products.length) {
        return res.status(404).json({
          success:false,
          message:'Product or active seller not found.'
        });
      }

      res.json({
        success:true,
        product:products[0]
      });
    } catch(e) {
      err(res,e);
    }
  });

  // =========================================================
  // CEROOD LATCH — ADMIN REVIEW
  // Seller offer approval is separate from the master product.
  // =========================================================

  app.get('/api/admin/seller-listings',requireAdminAuth,async(req,res)=>{
    try {
      const listings = await query(
        `SELECT
           l.id,l.seller_id,l.product_id,l.seller_sku,l.price,l.compare_price,
           l.stock,l.warranty_days,l.dispatch_days,l.condition,
           l.approval_status,l.rejection_reason,l.is_active,
           l.created_at,l.updated_at,
           p.name,p.brand,p.model,p.category,p.image_url,
           s.shop_name,s.owner_name,s.phone AS seller_phone
         FROM public.cerood_seller_listings l
         JOIN public.renewed_products p ON p.id=l.product_id
         JOIN public.cerood_sellers s ON s.id=l.seller_id
         ORDER BY l.updated_at DESC
         LIMIT 500`
      );
      res.json({success:true,listings});
    } catch(e) {
      err(res,e);
    }
  });

  app.patch('/api/admin/seller-listings/:id/approval',requireAdminAuth,async(req,res)=>{
    try {
      if (!uuid(req.params.id)) throw bad('Invalid seller listing ID.');

      const approval = String(req.body?.approval_status || '').trim();
      if (!['approved','rejected','pending','suspended'].includes(approval)) {
        throw bad('Invalid approval status.');
      }

      const reason = approval === 'rejected'
        ? String(req.body?.rejection_reason || '').trim().slice(0,1000)
        : null;

      if (approval === 'rejected' && !reason) {
        throw bad('Rejection reason is required.');
      }

      const listings = await query(
        `UPDATE public.cerood_seller_listings l
         SET approval_status=?,
             rejection_reason=?,
             is_active=CASE WHEN ?='approved' THEN true
                            WHEN ? IN ('rejected','suspended') THEN false
                            ELSE l.is_active END,
             updated_at=NOW()
         FROM public.cerood_sellers s
         WHERE l.id=?
           AND l.seller_id=s.id
           AND s.status='approved'
         RETURNING l.*`,
        [approval,reason,approval,approval,req.params.id]
      );

      if (!listings.length) {
        return res.status(404).json({
          success:false,
          message:'Seller listing or active seller not found.'
        });
      }

      res.json({success:true,listing:listings[0]});
    } catch(e) {
      err(res,e);
    }
  });

};
