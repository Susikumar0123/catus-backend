'use strict';
const {randomUUID}=require('node:crypto');
const error=(message,status=400)=>Object.assign(new Error(message),{status,httpStatus:status});
const uuid=value=>/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(String(value||''));
const combination=values=>JSON.stringify(Object.keys(values).sort().map(k=>[k,String(values[k]).trim().toLowerCase()]));

function validateVariants(raw,attributes) {
  if(!Array.isArray(raw)||raw.length>100)throw error('Supply at most 100 product variants.');
  const fields=attributes.filter(a=>a.is_variant===true);
  if(fields.length&&!raw.length)throw error('Add at least one product variant.');
  if(!fields.length&&raw.length)throw error('This category does not support product variants.');
  const keys=new Set(fields.map(a=>String(a.attribute_key)));
  const skus=new Set(),combinations=new Set(),ids=new Set();
  return raw.map((v,index)=>{
    const row=index+1;
    if(!v||typeof v!=='object'||Array.isArray(v))throw error(`Invalid variant row ${row}.`);
    if(v.id&&!uuid(v.id))throw error(`Invalid variant ID at row ${row}.`);
    if(v.id&&ids.has(v.id))throw error('Duplicate variant ID.');
    if(v.id)ids.add(v.id);
    const source=v.variant_values;
    if(!source||typeof source!=='object'||Array.isArray(source))throw error(`Invalid variant options at row ${row}.`);
    for(const key of Object.keys(source))if(!keys.has(key))throw error(`Unknown variant option: ${key}.`);
    const values={};
    for(const field of fields) {
      const value=source[field.attribute_key];
      if(!['string','number','boolean'].includes(typeof value)||!String(value).trim()||String(value).length>160)throw error(`Enter ${field.label||field.attribute_key} at row ${row}.`);
      const text=String(value).trim();
      const options=Array.isArray(field.options)?field.options:[];
      if(options.length&&!options.map(String).includes(text))throw error(`Invalid ${field.label||field.attribute_key} at row ${row}.`);
      values[field.attribute_key]=text;
    }
    const sku=String(v.sku||'').trim();
    if(!sku||sku.length>120||skus.has(sku.toLowerCase()))throw error(`Missing or duplicate SKU at row ${row}.`);
    skus.add(sku.toLowerCase());
    const key=combination(values);
    if(combinations.has(key))throw error(`Duplicate variant options at row ${row}.`);
    combinations.add(key);
    const price=Number(v.price),stock=Number(v.stock);
    const compare=v.compare_price==null||v.compare_price===''?null:Number(v.compare_price);
    if(v.price==null||v.price===''||!Number.isFinite(price)||price<=0||price>100000000)throw error(`Invalid variant price at row ${row}.`);
    if(v.stock==null||v.stock===''||!Number.isSafeInteger(stock)||stock<0||stock>1000000)throw error(`Invalid variant stock at row ${row}.`);
    if(compare!==null&&(!Number.isFinite(compare)||compare<price||compare>100000000))throw error(`Invalid variant MRP at row ${row}.`);
    return {id:v.id||null,sku,variant_values:values,price,compare_price:compare,stock};
  });
}

async function publish(db,submission,product) {
  const client=await db.getClient();let begun=false;
  try {
    await client.query('BEGIN');begun=true;
    const seller=await client.query("SELECT id FROM public.cerood_sellers WHERE id=$1 AND status='approved' FOR SHARE",[submission.seller_id]);
    if(!seller.length)throw error('Seller account must be approved first.',409);
    const pending=await client.query(`SELECT id FROM public.cerood_seller_catalog_submissions
      WHERE id=$1 AND seller_id=$2 AND marketplace='general' AND approval_status='pending'
      AND product_data=$3::jsonb AND published_product_id IS NOT DISTINCT FROM $4::uuid FOR UPDATE`,
      [submission.id,submission.seller_id,JSON.stringify(submission.product_data),submission.published_product_id||null]);
    if(!pending.length)throw error('Submission changed during approval. Refresh and retry.',409);
    const productId=submission.published_product_id||submission.id;
    const existing=await client.query('SELECT id,seller_id,status FROM public.cerood_shop_products WHERE id=$1 FOR UPDATE',[productId]);
    if(existing.length&&(!submission.published_product_id||existing[0].status!=='draft'||String(existing[0].seller_id)!==String(submission.seller_id)))throw error('Existing product conflicts with this submission.',409);
    if(!existing.length&&submission.published_product_id)throw error('Previously published product is missing.',409);
    const columns=['category_id','name','category','subcategory','brand','model','description','price','compare_price','stock','image_url','video_url','product_attributes','product_images'];
    const values=columns.map(k=>['product_attributes','product_images'].includes(k)?JSON.stringify(product[k]):product[k]);
    if(existing.length) {
      await client.query(`UPDATE public.cerood_shop_products SET ${columns.map((k,i)=>`${k}=$${i+1}${['product_attributes','product_images'].includes(k)?'::jsonb':''}`).join(',')},status='published',approval_status='approved',updated_at=now() WHERE id=$15`,[...values,productId]);
    }else {
      await client.query(`INSERT INTO public.cerood_shop_products(id,seller_id,${columns.join(',')},status,approval_status)
        VALUES($1,$2,${columns.map((k,i)=>`$${i+3}${['product_attributes','product_images'].includes(k)?'::jsonb':''}`).join(',')},'published','approved')`,[productId,submission.seller_id,...values]);
    }
    const old=await client.query(`SELECT id,variant_values FROM public.cerood_product_variants WHERE marketplace='general' AND product_id=$1 FOR UPDATE`,[String(productId)]);
    const byId=new Map(old.map(v=>[String(v.id),v]));
    const byOptions=new Map(old.map(v=>[combination(v.variant_values),v]));
    const selected=new Set();
    for(const variant of product.product_variants) {
      if(variant.id&&!byId.has(variant.id))throw error('Variant ID does not belong to this product.');
      const previous=variant.id?byId.get(variant.id):byOptions.get(combination(variant.variant_values));
      // Never change an option identity under an existing ID: order/cart references retain meaning.
      if(previous&&combination(previous.variant_values)!==combination(variant.variant_values))throw error('Changed variant options require a new variant.');
      const id=previous?.id||randomUUID();
      if(selected.has(id))throw error('Duplicate variant identity.');selected.add(id);
      if(previous)await client.query(`UPDATE public.cerood_product_variants SET sku=$1,variant_values=$2::jsonb,price=$3,compare_price=$4,stock=$5,is_active=true,updated_at=now() WHERE id=$6`,[variant.sku,JSON.stringify(variant.variant_values),variant.price,variant.compare_price,variant.stock,id]);
      else await client.query(`INSERT INTO public.cerood_product_variants(id,marketplace,product_id,sku,variant_values,price,compare_price,stock,is_active)
        VALUES($1,'general',$2,$3,$4::jsonb,$5,$6,$7,true)`,[id,String(productId),variant.sku,JSON.stringify(variant.variant_values),variant.price,variant.compare_price,variant.stock]);
    }
    // Retire removed variants instead of deleting references from past orders.
    await client.query(`UPDATE public.cerood_product_variants SET is_active=false,updated_at=now()
      WHERE marketplace='general' AND product_id=$1 AND NOT(id=ANY($2::uuid[]))`,[String(productId),[...selected]]);
    await client.query(`UPDATE public.cerood_seller_catalog_submissions SET approval_status='approved',published_product_id=$1,rejection_reason=NULL,updated_at=now() WHERE id=$2`,[productId,submission.id]);
    await client.query('COMMIT');begun=false;return productId;
  }finally {
    if(begun)await client.query('ROLLBACK').catch(()=>{});
    client.release();
  }
}
module.exports={validateVariants,publish};
