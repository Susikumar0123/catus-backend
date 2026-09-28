
'use strict';
// CEROOD seller inventory and product approval. No payment/order modifications.
const crypto = require('crypto');

module.exports = function registerSellerProductRoutes(app, db, requireSellerAuth, requireAdminAuth) {
  const query = (sql, values = []) => new Promise((resolve, reject) =>
    db.query(sql, values, (error, rows) => error ? reject(error) : resolve(rows || [])));

  const fields = `id,seller_id,name,category,condition,brand,model,price,compare_price,stock,
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

  // Resolve effective schema through schema_parent_id inheritance.
  // More-specific child definitions override inherited keys/slots.
  async function resolveCategorySchema(categoryId) {
    const chain=[];
    const seen=new Set();
    let currentId=String(categoryId || '').trim();

    while (currentId) {
      if (!uuid(currentId)) throw bad('Invalid Renewed category schema reference.');
      if (seen.has(currentId)) throw bad('Renewed category schema inheritance cycle detected.');
      seen.add(currentId);

      const rows=await query(
        `SELECT id,name,slug,parent_id,schema_parent_id,category_level,is_leaf,category_path
         FROM public.cerood_product_categories
         WHERE id=? AND marketplace='renewed' AND is_active=true
         LIMIT 1`,
        [currentId]
      );
      if (!rows.length) throw bad('Renewed category schema reference was not found.');

      chain.push(rows[0]);
      currentId=rows[0].schema_parent_id ? String(rows[0].schema_parent_id) : '';
      if (chain.length>12) throw bad('Renewed category schema inheritance is too deep.');
    }

    const ids=chain.map(x=>String(x.id));
    const attributeRows=await query(
      `SELECT a.id,a.category_id,a.attribute_key,a.label,a.input_type,a.unit,
              a.options,a.placeholder,a.is_required,a.is_variant,a.sort_order
       FROM public.cerood_product_attributes a
       WHERE a.is_active=true AND a.category_id IN (${ids.map(()=>'?').join(',')})
       ORDER BY a.sort_order ASC,a.label ASC`,
      ids
    );
    const slotRows=await query(
      `SELECT i.id,i.category_id,i.slot_key,i.label,i.description,
              i.is_required,i.sort_order
       FROM public.cerood_category_image_slots i
       WHERE i.is_active=true AND i.category_id IN (${ids.map(()=>'?').join(',')})
       ORDER BY i.sort_order ASC,i.label ASC`,
      ids
    );

    const rank=new Map([...ids].reverse().map((id,index)=>[id,index]));
    const merge=(rows,keyName)=>{
      const merged=new Map();
      for (const row of [...rows].sort((a,b)=>
        (rank.get(String(a.category_id))??0)-(rank.get(String(b.category_id))??0) ||
        Number(a.sort_order||0)-Number(b.sort_order||0)
      )) merged.set(String(row[keyName]),row);

      return [...merged.values()].sort((a,b)=>
        Number(a.sort_order||0)-Number(b.sort_order||0) ||
        String(a.label||'').localeCompare(String(b.label||''))
      );
    };

    return {
      chain,
      attributes:merge(attributeRows,'attribute_key'),
      image_slots:merge(slotRows,'slot_key')
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
         ORDER BY sort_order ASC,name ASC`
      );

      const attributes = await query(
        `SELECT a.id,a.category_id,a.attribute_key,a.label,a.input_type,a.unit,
                a.options,a.placeholder,a.is_required,a.is_variant,a.sort_order
         FROM public.cerood_product_attributes a
         JOIN public.cerood_product_categories c ON c.id=a.category_id
         WHERE c.marketplace='renewed' AND c.is_active=true AND a.is_active=true
         ORDER BY a.category_id,a.sort_order ASC,a.label ASC`
      );

      const imageSlots = await query(
        `SELECT i.id,i.category_id,i.slot_key,i.label,i.description,
                i.is_required,i.sort_order
         FROM public.cerood_category_image_slots i
         JOIN public.cerood_product_categories c ON c.id=i.category_id
         WHERE c.marketplace='renewed' AND c.is_active=true AND i.is_active=true
         ORDER BY i.category_id,i.sort_order ASC,i.label ASC`
      );

      const attrsByCategory = new Map();
      for (const row of attributes) {
        const key=String(row.category_id);
        if (!attrsByCategory.has(key)) attrsByCategory.set(key,[]);
        attrsByCategory.get(key).push(row);
      }

      const imagesByCategory = new Map();
      for (const row of imageSlots) {
        const key=String(row.category_id);
        if (!imagesByCategory.has(key)) imagesByCategory.set(key,[]);
        imagesByCategory.get(key).push(row);
      }

      const result=[];
      for (const category of categories) {
        if (!category.schema_parent_id) {
          result.push({
            ...category,
            attributes:attrsByCategory.get(String(category.id)) || [],
            image_slots:imagesByCategory.get(String(category.id)) || [],
            schema_chain:[String(category.id)]
          });
          continue;
        }

        const resolved=await resolveCategorySchema(category.id);
        result.push({
          ...category,
          attributes:resolved.attributes,
          image_slots:resolved.image_slots,
          schema_chain:resolved.chain.map(x=>String(x.id))
        });
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
      `SELECT id,name,slug,parent_id
       FROM public.cerood_product_categories
       WHERE id=? AND marketplace='renewed' AND is_active=true
       LIMIT 1`,
      [categoryId]
    );
    if (!categoryRows.length) throw bad('Choose an active Renewed category.');

    const category=categoryRows[0];
    const resolvedSchema=await resolveCategorySchema(categoryId);
    const attributeRows=resolvedSchema.attributes;
    const slotRows=resolvedSchema.image_slots;

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

    const variants=rawVariants.slice(0,250).map((v,index)=>{
      const values=(v?.variant_values && typeof v.variant_values==='object' && !Array.isArray(v.variant_values)) ? v.variant_values : {};
      const sku=String(v?.sku||'').trim().slice(0,120) || null;
      const price=v?.price===''||v?.price==null ? null : Number(v.price);
      const compare=v?.compare_price===''||v?.compare_price==null ? null : Number(v.compare_price);
      const stock=Number(v?.stock??0);
      if (price!==null && (!Number.isFinite(price)||price<0)) throw bad(`Invalid variant price at row ${index+1}.`);
      if (compare!==null && (!Number.isFinite(compare)||compare<0)) throw bad(`Invalid variant compare price at row ${index+1}.`);
      if (!Number.isSafeInteger(stock)||stock<0||stock>1000000) throw bad(`Invalid variant stock at row ${index+1}.`);
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
      if (dynamic) p.category = String(dynamic.category.slug || p.category).slice(0,40);
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
      if (dynamic) p.category = String(dynamic.category.slug || p.category).slice(0,40);
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
};
