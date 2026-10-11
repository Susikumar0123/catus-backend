'use strict';
function dates(query={}) {
 const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
 const day=s=>/^\d{4}-\d{2}-\d{2}$/.test(s)&&Number.isFinite(Date.parse(s+'T00:00:00Z'))&&new Date(s+'T00:00:00Z').toISOString().slice(0,10)===s;
 const end=String(query.to||today);
 if(!day(end))throw Object.assign(Error('Choose a valid end date.'),{status:400});
 const start=String(query.from||new Date(Date.parse(end+'T00:00:00Z')-29*86400000).toISOString().slice(0,10));
 if(!day(start)||!day(end)||start>end||(Date.parse(end)-Date.parse(start))/86400000>365)throw Object.assign(Error('Choose valid dates in order, covering no more than 366 days.'),{status:400});
 return {from:start,to:end};
}
const SQL=`WITH lines AS (
 SELECT oi.order_id,oi.product_id,oi.product_name,oi.quantity,oi.line_total,
 COALESCE(oi.seller_order_status,'new') AS fulfilment,o.status,o.payment_method,o.payment_status
 FROM public.cerood_shop_order_items oi JOIN public.cerood_shop_orders o ON o.id=oi.order_id
 WHERE oi.seller_id=$1 AND o.created_at >= ($2::date::timestamp AT TIME ZONE 'Asia/Kolkata')
 AND o.created_at < (($3::date+1)::timestamp AT TIME ZONE 'Asia/Kolkata')
), eligible AS (
 SELECT * FROM lines WHERE status NOT IN ('cancelled','canceled','failed','refunded','expired')
 AND fulfilment NOT IN ('rejected','cancelled') AND (payment_method='cod' OR payment_status IN ('paid','captured','success'))
), totals AS (
 SELECT COUNT(DISTINCT order_id)::int AS confirmed_orders,COALESCE(SUM(quantity),0)::int AS ordered_units,
 COALESCE(SUM(line_total),0) AS product_order_value,
 COALESCE(SUM(line_total) FILTER(WHERE status='delivered'),0) AS delivered_product_value,
 COUNT(DISTINCT order_id) FILTER(WHERE status='delivered')::int AS delivered_orders,
 COUNT(*) FILTER(WHERE fulfilment='new' AND status<>'delivered')::int AS new_items,
 COUNT(*) FILTER(WHERE fulfilment='accepted' AND status<>'delivered')::int AS packing_items,
 COUNT(*) FILTER(WHERE fulfilment='packed' AND status<>'delivered')::int AS dispatch_items FROM eligible
), top AS (
 SELECT product_id,MAX(product_name) AS product_name,SUM(quantity)::int AS units,SUM(line_total) AS product_order_value
 FROM eligible GROUP BY product_id ORDER BY SUM(line_total) DESC,product_id LIMIT 10
), stock_rows AS (
 SELECT p.id AS product_id,p.name,v.id AS variant_id,v.sku,v.variant_values,
 COALESCE(v.stock,p.stock) AS stock FROM public.cerood_shop_products p
 LEFT JOIN public.cerood_product_variants v ON v.product_id=p.id::text AND v.marketplace='general' AND v.is_active=true
 WHERE p.seller_id=$1 AND p.status='published' AND p.approval_status='approved'
), low AS (SELECT * FROM stock_rows WHERE stock<=5 ORDER BY stock,name,product_id,variant_id LIMIT 50)
SELECT (SELECT row_to_json(totals) FROM totals) AS summary,
 (SELECT COUNT(DISTINCT order_id)::int FROM lines WHERE status IN ('cancelled','canceled')) AS cancelled_orders,
 (SELECT COUNT(*)::int FROM lines WHERE fulfilment='rejected') AS rejected_items,
 COALESCE((SELECT json_agg(top) FROM top),'[]'::json) AS top_products,
 COALESCE((SELECT json_agg(low) FROM low),'[]'::json) AS low_stock,
 (SELECT COUNT(*)::int FROM stock_rows WHERE stock<=5) AS low_stock_count`;
function register(app,db,auth){app.get('/api/sellers/shop-report',auth,async(req,res)=>{
 res.set('Cache-Control','no-store');try{const range=dates(req.query);const rows=await new Promise((resolve,reject)=>db.query(SQL,[req.seller.id,range.from,range.to],(e,r)=>e?reject(e):resolve(r)));
 res.json({success:true,marketplace:'general',range,report:rows[0],note:'Product values exclude shipping, fees, taxes and returns adjustments. Delivered value is not a seller payout. Low stock is current inventory, independent of the selected order dates.'});
 }catch(e){res.status(e.status||500).json({success:false,message:e.status?e.message:'Unable to load the Main Store report. Try again.'})}
});}
module.exports={register,dates,SQL};
