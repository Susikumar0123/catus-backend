'use strict';
const accounting=require('./cerood-order-accounting');
function register(app,db,auth){
 const q=(sql,args=[])=>new Promise((resolve,reject)=>db.query(sql,args,(e,r)=>e?reject(e):resolve(r||[])));
 const handle=fn=>async(req,res)=>{res.set('Cache-Control','no-store');try{await fn(req,res)}catch(e){res.status(e.status||503).json({success:false,message:e.status?e.message:'Seller workspace unavailable. Refresh or contact support with the failing section.'})}};
 app.get('/api/sellers/workspace/payment-review',auth,handle(async(req,res)=>{
  const raw=String(req.query?.page??'1');
  if(!/^[1-9]\d{0,5}$/.test(raw))throw Object.assign(Error('Choose a valid payment review page.'),{status:400});
  const page=Number(raw),limit=20,parts=[];
  for(const [source,items,parent] of [['shop','cerood_shop_order_items','cerood_shop_orders'],['renewed','renewed_order_items','renewed_orders'],['cosmetics','cosmetics_order_items','cosmetics_orders'],['clothing','clothing_order_items','clothing_orders']]){
   const relations=(await q('SELECT to_regclass($1) AS items,to_regclass($2) AS orders',['public.'+items,'public.'+parent]))[0];
   if(!relations?.items||!relations?.orders)continue;
   const shop=source==='shop';
   parts.push(`SELECT '${source}'::text AS source,i.id::text AS order_item_id,i.order_id::text AS order_id,
    to_jsonb(i)->>'product_name' AS product_name,to_jsonb(i)->>'quantity' AS quantity,${accounting.itemValue()} AS product_value,
    to_jsonb(o)->>'created_at' AS created_at,to_jsonb(o)->>'payment_method' AS payment_method,
    ${shop?"CASE WHEN EXISTS(SELECT 1 FROM public.cerood_shop_return_requests r WHERE r.order_item_id=i.id AND r.status NOT IN ('rejected','replaced')) THEN 'return_review' ELSE 'not_prepared' END":"'legacy_review'::text"} AS review_reason
    FROM public.${items} i JOIN public.${parent} o ON o.id=i.order_id
    WHERE to_jsonb(i)->>'seller_id'=$1 AND ${accounting.delivery(source)}='delivered'
    AND ${accounting.eligible(source)}
    AND COALESCE(to_jsonb(o)->>'fulfillment_outcome','') NOT IN ('rto','customer_returned')
    ${shop?'AND NOT EXISTS(SELECT 1 FROM public.cerood_shop_settlements s WHERE s.order_item_id=i.id)':''}`);
  }
  if(!parts.length)return res.json({success:true,items:[],page,total:0,page_size:limit,has_more:false});
  const cte='WITH review AS ('+parts.join(' UNION ALL ')+') ',id=String(req.seller.id);
  const total=Number((await q(cte+'SELECT count(*)::int AS total FROM review',[id]))[0].total);
  const rows=await q(cte+'SELECT * FROM review ORDER BY created_at DESC NULLS LAST,source,order_item_id LIMIT $2 OFFSET $3',[id,limit,(page-1)*limit]);
  res.json({success:true,items:rows,page,total,page_size:limit,has_more:page*limit<total,note:'Delivered items for payment review, not a payable balance. Legacy items may already have been paid outside this ledger. COD receipt, returns and agreed deductions must be verified by admin.'});
 }));
 app.get('/api/sellers/workspace/summary',auth,handle(async(req,res)=>{
  const id=req.seller.id;
  const catalog=(await q("SELECT count(*)::int AS total,count(*) FILTER(WHERE approval_status='pending')::int AS pending,count(*) FILTER(WHERE approval_status='rejected')::int AS rejected,count(*) FILTER(WHERE approval_status='approved')::int AS approved FROM cerood_seller_catalog_submissions WHERE seller_id=$1",[id]))[0];
  const orders=[];
  for(const [market,items,parent] of [['Main Store','cerood_shop_order_items','cerood_shop_orders'],['Renewed','renewed_order_items','renewed_orders'],['Beauty','cosmetics_order_items','cosmetics_orders'],['Fashion','clothing_order_items','clothing_orders']]){
   if(!(await q('SELECT to_regclass($1) AS relation',['public.'+items]))[0]?.relation)continue;
   const row=(await q(`SELECT count(*)::int AS items,
    count(*) FILTER(WHERE COALESCE(to_jsonb(i)->>'seller_order_status','new')='new' AND ${accounting.delivery(market)}<>'delivered')::int AS new,
    count(*) FILTER(WHERE to_jsonb(i)->>'seller_order_status'='accepted' AND ${accounting.delivery(market)}<>'delivered')::int AS accepted,
    count(*) FILTER(WHERE to_jsonb(i)->>'seller_order_status'='packed' AND ${accounting.delivery(market)}<>'delivered')::int AS packed,
    count(*) FILTER(WHERE to_jsonb(i)->>'seller_order_status'='shipped' AND ${accounting.delivery(market)}<>'delivered')::int AS shipped,
    count(*) FILTER(WHERE ${accounting.delivery(market)}='delivered')::int AS delivered
    FROM ${items} i JOIN ${parent} o ON o.id=i.order_id WHERE to_jsonb(i)->>'seller_id'=$1
    AND ${accounting.eligible(market)}`,[String(id)]))[0];orders.push({marketplace:market,...row});
  }
  const finance=(await q(`SELECT count(*) FILTER(WHERE s.status='paid')::int AS paid_records,
   COALESCE(sum(s.gross_amount-s.deductions) FILTER(WHERE s.status='paid'),0) AS recorded_paid,
   COALESCE(sum(s.gross_amount-s.deductions) FILTER(WHERE s.status='pending' AND NOT EXISTS(SELECT 1 FROM cerood_shop_return_requests r WHERE r.order_item_id=s.order_item_id AND r.status NOT IN ('rejected','replaced'))),0) AS prepared_payable,
   COALESCE(sum(s.gross_amount-s.deductions) FILTER(WHERE s.status='pending' AND EXISTS(SELECT 1 FROM cerood_shop_return_requests r WHERE r.order_item_id=s.order_item_id AND r.status NOT IN ('rejected','replaced'))),0) AS held_preparations,
   count(*) FILTER(WHERE s.status='void')::int AS cancelled_preparations
   FROM cerood_shop_settlements s WHERE s.seller_id=$1`,[id]))[0];
  finance.recorded_recovered=0;if(await require('./cerood-shop-finance-reconciliation').hasTable(q,'cerood_shop_settlement_recoveries'))finance.recorded_recovered=(await q('SELECT COALESCE(sum(r.recovered_amount),0) AS amount FROM cerood_shop_settlement_recoveries r JOIN cerood_shop_settlements s ON s.id=r.settlement_id WHERE s.seller_id=$1',[id]))[0].amount;finance.retained_paid=(Number(finance.recorded_paid)-Number(finance.recorded_recovered)).toFixed(2);
  const returns=(await q("SELECT count(*)::int AS total,count(*) FILTER(WHERE r.status='requested')::int AS needs_response,count(*) FILTER(WHERE r.status NOT IN ('rejected','refunded','replaced'))::int AS open FROM cerood_shop_return_requests r JOIN cerood_shop_order_items i ON i.id=r.order_item_id WHERE i.seller_id=$1",[id]))[0];
  res.json({success:true,catalog,orders,finance,returns,finance_scope:'Recorded connected-store settlements only; verify actual bank receipt. No automatic payout.',payment_coverage:{ledger_source:'shop',legacy_delivered_items:orders.filter(r=>r.marketplace!=='Main Store').reduce((n,r)=>n+Number(r.delivered||0),0),automatic_payout:false}});
 }));
 app.get('/api/sellers/workspace/report',auth,handle(async(req,res)=>{
  const range=require('./cerood-seller-shop-report').dates(req.query),markets=[];
  for(const [market,items,parent] of [['Main Store','cerood_shop_order_items','cerood_shop_orders'],['Renewed','renewed_order_items','renewed_orders'],['Beauty','cosmetics_order_items','cosmetics_orders'],['Fashion','clothing_order_items','clothing_orders']]){
   if(!(await q('SELECT to_regclass($1) AS relation',['public.'+items]))[0]?.relation)continue;
   const row=(await q(`SELECT count(DISTINCT i.order_id)::int AS orders,COALESCE(sum(i.quantity),0)::int AS units,COALESCE(sum(${accounting.itemValue()}),0) AS product_value,
    COALESCE(sum(${accounting.itemValue()}) FILTER(WHERE ${accounting.delivery(market)}='delivered'),0) AS delivered_value
    FROM ${items} i JOIN ${parent} o ON o.id=i.order_id WHERE to_jsonb(i)->>'seller_id'=$1
    AND o.created_at>=($2::date::timestamp AT TIME ZONE 'Asia/Kolkata') AND o.created_at<(($3::date+1)::timestamp AT TIME ZONE 'Asia/Kolkata')
    AND ${accounting.eligible(market)}`,[String(req.seller.id),range.from,range.to]))[0];markets.push({marketplace:market,...row});
  }
  res.json({success:true,range,markets,note:'IST order dates. Saved item values include item-level discounts where recorded; order-level discounts, shipping, refunds, commission and tax are not allocated. These values are not payout or net earnings.'});
 }));
 app.get('/api/sellers/workspace/quality',auth,handle(async(req,res)=>{
  const rows=await q(`SELECT s.id,s.marketplace,s.approval_status,s.rejection_reason,s.published_product_id,s.product_data,s.updated_at,
   COALESCE((SELECT count(*) FROM cerood_shop_reviews r WHERE r.product_id=s.published_product_id AND r.status='approved'),0)::int AS review_count,
   (SELECT round(avg(r.rating)::numeric,1) FROM cerood_shop_reviews r WHERE r.product_id=s.published_product_id AND r.status='approved') AS rating
   FROM cerood_seller_catalog_submissions s WHERE s.seller_id=$1 ORDER BY s.updated_at DESC LIMIT 500`,[req.seller.id]);
  res.json({success:true,products:rows.map(r=>{
   const d=r.product_data||{},issues=[];
   if(!String(d.name||'').trim())issues.push('Product name missing');
   if(!String(d.description||'').trim())issues.push('Add a clear description');
   if(!d.image_url&&!Object.values(d.product_images||{}).some(x=>typeof x==='string'?x:!!x?.url))issues.push('Product photo missing');
   if(!Number.isFinite(Number(d.price))||Number(d.price)<=0)issues.push('Selling price requires attention');
   if(r.approval_status==='rejected')issues.push(r.rejection_reason||'Correct admin feedback');
   return {id:r.id,marketplace:r.marketplace,name:d.name||'Untitled',approval_status:r.approval_status,issues,review_count:r.marketplace==='general'?r.review_count:null,rating:r.marketplace==='general'?r.rating:null};
  })});
 }));
 app.get('/api/sellers/workspace/shipments',auth,handle(async(req,res)=>{
  const shipments=[];
  for(const [table,courier,key] of [['cerood_ekart_shipments','Ekart','tracking_id'],['cerood_delhivery_shipments','Delhivery','waybill']]){
   if(!(await q('SELECT to_regclass($1) AS relation',['public.'+table]))[0]?.relation)continue;
   const rows=await q(`SELECT id,to_jsonb(x)->>'marketplace' AS marketplace,to_jsonb(x)->>'order_id' AS order_id,to_jsonb(x)->>'${key}' AS tracking_number,
    to_jsonb(x)->>'booking_state' AS booking_state,to_jsonb(x)->>'last_tracking_status' AS tracking_status,
    to_jsonb(x)->>'last_tracking_at' AS checked_at,to_jsonb(x)->>'booked_at' AS booked_at,to_jsonb(x)->>'cancelled_at' AS cancelled_at
    FROM ${table} x WHERE to_jsonb(x)->>'seller_id'=$1 ORDER BY created_at DESC LIMIT 200`,[String(req.seller.id)]);
   shipments.push(...rows.map(r=>({...r,courier})));
  }
  shipments.sort((a,b)=>String(b.booked_at||'').localeCompare(String(a.booked_at||'')));res.json({success:true,shipments,scope:'Up to 200 saved bookings per courier. Refresh tracking from the order; courier state remains separate from customer delivery status.'});
 }));
}
module.exports={register};
