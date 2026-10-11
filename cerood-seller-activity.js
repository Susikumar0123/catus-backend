'use strict';
const SOURCE=`WITH activity AS (
 SELECT 'order:'||i.id::text||':'||COALESCE(i.seller_order_status,'new')||':'||o.status AS id,'orders' AS category,
 CASE WHEN o.status='cancelled' THEN 'Order cancelled' WHEN COALESCE(i.seller_order_status,'new')='new' THEN 'New order to review' WHEN i.seller_order_status='accepted' THEN 'Order ready for packing' WHEN i.seller_order_status='packed' THEN 'Packed order ready for dispatch' ELSE 'Order fulfilment updated' END AS title,
 i.product_name AS description,i.order_id::text AS reference,
 CASE WHEN o.status='cancelled' THEN 'support' ELSE 'orders' END AS destination,
 CASE WHEN o.status='cancelled' THEN o.updated_at ELSE COALESCE(i.seller_shipped_at,i.seller_packed_at,i.seller_rejected_at,i.seller_accepted_at,o.created_at) END AS occurred_at
 FROM public.cerood_shop_order_items i JOIN public.cerood_shop_orders o ON o.id=i.order_id
 WHERE i.seller_id=$1 AND o.created_at>=now()-interval '30 days'
 AND (o.payment_method='cod' OR o.payment_status='paid') AND o.status NOT IN ('pending','payment_review')
 UNION ALL
 SELECT 'catalog:'||id::text||':'||approval_status||':'||updated_at::text,'products',
 CASE approval_status WHEN 'approved' THEN 'Product approval recorded' WHEN 'rejected' THEN 'Product needs changes' WHEN 'pending' THEN 'Product under review' ELSE 'Product submission updated' END,
 COALESCE(product_data->>'name','Product')||COALESCE(' — '||rejection_reason,''),id::text,'products',updated_at
 FROM public.cerood_seller_catalog_submissions WHERE seller_id=$1 AND updated_at>=now()-interval '30 days'
 UNION ALL
 SELECT 'return:'||r.id::text||':'||r.status,'returns','Return request: '||replace(r.status,'_',' '),i.product_name,r.id::text,'shop-returns',r.updated_at
 FROM public.cerood_shop_return_requests r JOIN public.cerood_shop_order_items i ON i.id=r.order_item_id WHERE i.seller_id=$1 AND r.updated_at>=now()-interval '30 days'
 UNION ALL
 SELECT 'settlement:'||s.id::text||':'||s.status,'payments',CASE s.status WHEN 'paid' THEN 'Settlement payment reference recorded' WHEN 'void' THEN 'Unpaid settlement preparation cancelled' ELSE 'Settlement prepared' END,
 i.product_name,s.id::text,'payments',COALESCE(s.voided_at,s.paid_at,s.created_at)
 FROM public.cerood_shop_settlements s JOIN public.cerood_shop_order_items i ON i.id=s.order_item_id WHERE s.seller_id=$1 AND COALESCE(s.voided_at,s.paid_at,s.created_at)>=now()-interval '30 days'
)`;
function keys(body={}){if(!Array.isArray(body.ids)||!body.ids.length||body.ids.length>100||body.ids.some(x=>typeof x!=='string'||!x.length||x.length>250))throw Object.assign(Error('Select up to 100 activity entries.'),{status:400});return [...new Set(body.ids)];}
function register(app,db,auth){const q=(sql,args)=>new Promise((resolve,reject)=>db.query(sql,args,(e,r)=>e?reject(e):resolve(r))),handle=fn=>async(req,res)=>{res.set('Cache-Control','no-store');try{await fn(req,res)}catch(e){res.status(e.status||500).json({success:false,message:e.status?e.message:'Seller activity is unavailable. Try again.'})}};
 async function source(){let sql=SOURCE.slice(0,-2);for(const [market,items,orders] of [['renewed','renewed_order_items','renewed_orders'],['cosmetics','cosmetics_order_items','cosmetics_orders'],['clothing','clothing_order_items','clothing_orders']]){
  if(!(await q('SELECT to_regclass($1) AS relation',['public.'+items]))[0]?.relation)continue;
  sql+=` UNION ALL SELECT 'order:${market}:'||i.id::text||':'||COALESCE(to_jsonb(i)->>'seller_order_status','new')||':'||COALESCE(to_jsonb(o)->>'status',''), 'orders',
   '${market} order: '||COALESCE(to_jsonb(i)->>'seller_order_status','new'),COALESCE(to_jsonb(i)->>'product_name','Product'),i.order_id::text,'orders',
   COALESCE(NULLIF(to_jsonb(i)->>'seller_shipped_at','')::timestamptz,NULLIF(to_jsonb(i)->>'seller_packed_at','')::timestamptz,NULLIF(to_jsonb(i)->>'seller_accepted_at','')::timestamptz,o.created_at)
   FROM ${items} i JOIN ${orders} o ON o.id=i.order_id WHERE to_jsonb(i)->>'seller_id'=$1::text AND o.created_at>=now()-interval '30 days'
   AND COALESCE(to_jsonb(o)->>'status','') NOT IN ('pending','payment_review','failed') AND (to_jsonb(o)->>'payment_method'='cod' OR to_jsonb(o)->>'payment_status' IN ('paid','captured','success'))`;
 }return sql+'\n)';}
 app.get('/api/sellers/activity',auth,handle(async(req,res)=>{const rows=await q((await source())+` SELECT a.*,r.read_at FROM activity a LEFT JOIN public.cerood_seller_activity_read r ON r.seller_id=$1 AND r.event_key=a.id ORDER BY a.occurred_at DESC,a.id LIMIT 100`,[req.seller.id]);res.json({success:true,activity:rows,scope:'Current seller order/catalog activity across available marketplaces, plus Main Store returns and settlements; up to 100 entries within 30 days.'});}));
 app.post('/api/sellers/activity/read',auth,handle(async(req,res)=>{const ids=keys(req.body);const rows=await q((await source())+` INSERT INTO public.cerood_seller_activity_read(seller_id,event_key) SELECT $1,a.id FROM activity a WHERE a.id=ANY($2::text[]) ON CONFLICT(seller_id,event_key) DO NOTHING RETURNING event_key`,[req.seller.id,ids]);res.json({success:true,marked_count:rows.length});}));}
module.exports={register,SOURCE,keys};
