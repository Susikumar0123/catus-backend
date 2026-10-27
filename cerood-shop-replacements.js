'use strict';
const uuid=x=>/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(String(x||''));
const fail=(message,status=409)=>Object.assign(Error(message),{status});
const inventory=require('./cerood-shop-inventory');
const canonical=x=>x&&typeof x==='object'?Array.isArray(x)?x.map(canonical):Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
const equal=(a,b)=>JSON.stringify(canonical(a||{}))===JSON.stringify(canonical(b||{}));
function note(value){const text=String(value||'').trim();if(text.length<10||text.length>1500)throw fail('Enter an explanation of 10–1500 characters.',400);return text;}
function tracking(body){if(body.dispatch_confirmed!==true)throw fail('Confirm the replacement was actually handed to the courier.',400);const courier=String(body.courier_name||'').trim(),number=String(body.tracking_number||'').trim(),url=String(body.tracking_url||'').trim();if(courier.length<2||courier.length>80||number.length<5||number.length>120||url.length>2000)throw fail('Enter the actual courier name and tracking number.',400);if(url){try{const u=new URL(url);if(u.protocol!=='https:'||u.username||u.password)throw Error();}catch{throw fail('Tracking URL must be a valid HTTPS address without login credentials.',400);}}return {courier,number,url};}
async function tx(db,fn){const c=await db.getClient();let done=false;try{await c.query('BEGIN');const value=await fn(c);await c.query('COMMIT');done=true;return value;}finally{try{if(!done)await c.query('ROLLBACK')}finally{c.release()}}}
async function purchased(c,returnId){
 const link=(await c.query('SELECT i.order_id,i.id FROM cerood_shop_return_requests r JOIN cerood_shop_order_items i ON i.id=r.order_item_id WHERE r.id=$1',[returnId]))[0];if(!link)throw fail('Return request not found.',404);
 const order=(await c.query('SELECT * FROM cerood_shop_orders WHERE id=$1 FOR UPDATE',[link.order_id]))[0];
 const item=(await c.query('SELECT * FROM cerood_shop_order_items WHERE id=$1 FOR UPDATE',[link.id]))[0];
 const request=(await c.query('SELECT * FROM cerood_shop_return_requests WHERE id=$1 FOR UPDATE',[returnId]))[0];return {order,item,request};
}
async function stock(c,item){
 const submissions=await c.query('SELECT id,approval_status FROM cerood_seller_catalog_submissions WHERE seller_id=$1 AND published_product_id=$2 ORDER BY id FOR UPDATE',[item.seller_id,item.product_id]);
 const product=(await c.query('SELECT * FROM cerood_shop_products WHERE id=$1 AND seller_id=$2 FOR UPDATE',[item.product_id,item.seller_id]))[0];if(!product)throw fail('Original seller/product unavailable. Inventory reconciliation is required.');
 const variants=await c.query("SELECT * FROM cerood_product_variants WHERE product_id=$1 AND marketplace='general' ORDER BY id FOR UPDATE",[String(item.product_id)]);
 return {product,variants,pending:submissions.some(s=>s.approval_status==='pending')};
}
function createService(db){
 const q=(sql,args=[])=>new Promise((resolve,reject)=>db.query(sql,args,(e,r)=>e?reject(e):resolve(r||[])));
 async function reserve(returnId,body={}){
  if(!uuid(returnId)||!uuid(body.request_key)||body.confirm_same_option!==true)throw fail('Confirm a same-option replacement and provide a valid request key.',400);const explanation=note(body.note);
  return tx(db,async c=>{
   const {order,item,request}=await purchased(c,returnId);
   await require('./cerood-shop-direct-exchange').assertNoDirect(c,returnId);
   const retry=(await c.query('SELECT * FROM cerood_shop_replacements WHERE request_key=$1',[body.request_key]))[0];if(retry){if(retry.return_request_id!==returnId||retry.reservation_note!==explanation)throw fail('This reservation key already belongs to another request.');return {replacement:retry,idempotent:true};}
   const existing=(await c.query("SELECT * FROM cerood_shop_replacements WHERE return_request_id=$1 AND status<>'cancelled'",[returnId]))[0];if(existing)return {replacement:existing,idempotent:true};
   if(!['exchange','replacement'].includes(request.request_type)||request.status!=='received'||!request.inspected_at||order.status!=='delivered'||!item.seller_id||['rejected','cancelled'].includes(item.seller_order_status))throw fail('Receive and inspect an approved exchange/replacement item first.');
   const quantity=Number(item.quantity);if(!Number.isSafeInteger(quantity)||quantity<1||quantity>1000000)throw fail('Purchased quantity requires review.');
   const {product,variants,pending}=await stock(c,item);const seller=(await c.query('SELECT status FROM cerood_sellers WHERE id=$1',[item.seller_id]))[0];
   if(pending||product.status!=='published'||product.approval_status!=='approved'||seller?.status!=='approved')throw fail('Resolve product/seller approval before reserving replacement stock.');
   const target=item.variant_id?variants.find(v=>String(v.id)===String(item.variant_id)&&v.is_active):product;
   if(!target||item.variant_id&&!equal(target.variant_values,item.variant_values)||!item.variant_id&&variants.some(v=>v.is_active))throw fail('The exact purchased option is unavailable. Different-product/option exchange requires separate review.');
   if(Number(target.stock)<quantity)throw fail('Insufficient stock for the full purchased quantity.');
   const changed=item.variant_id?await c.query('UPDATE cerood_product_variants SET stock=stock-$1,updated_at=now() WHERE id=$2 AND stock>=$1 RETURNING id',[quantity,item.variant_id]):await c.query('UPDATE cerood_shop_products SET stock=stock-$1,updated_at=now() WHERE id=$2 AND stock>=$1 RETURNING id',[quantity,item.product_id]);if(changed.length!==1)throw fail('Stock changed. Refresh before reserving.');
   if(item.variant_id)await inventory.syncVariantTotals(c,[item.product_id]);
   const row=(await c.query('INSERT INTO cerood_shop_replacements(request_key,return_request_id,order_item_id,seller_id,product_id,variant_id,quantity,product_name,variant_sku,variant_values,delivery_address,reservation_note) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12) RETURNING *',[body.request_key,returnId,item.id,item.seller_id,item.product_id,item.variant_id,quantity,item.product_name,item.variant_sku,JSON.stringify(item.variant_values||{}),JSON.stringify(order.delivery_address),explanation]))[0];return {replacement:row,idempotent:false};
  });
 }
 async function change(id,body={},seller=null){
  if(!uuid(id)||!['accepted','packed','shipped','out_for_delivery','delivered','cancelled'].includes(body.status))throw fail('Choose a valid replacement action.',400);
  if(!seller&&['accepted','packed'].includes(body.status))throw fail('Seller acceptance/packing must use the seller workflow.',403);
  if(seller&&!['accepted','packed'].includes(body.status))throw fail('Seller may accept and pack only.',403);
  const link=(await q('SELECT return_request_id,seller_id FROM cerood_shop_replacements WHERE id=$1'+(seller?' AND seller_id=$2':''),seller?[id,seller]:[id]))[0];if(!link)throw fail('Replacement not found.',404);
  const shipping=body.status==='shipped'?tracking(body):null,explanation=body.status==='cancelled'?note(body.note):null;
  return tx(db,async c=>{
   const {item,request}=await purchased(c,link.return_request_id);
   if(body.status==='cancelled'){await require('./cerood-shop-direct-exchange').assertNoDirect(c,link.return_request_id);await stock(c,item);}
   const row=(await c.query('SELECT * FROM cerood_shop_replacements WHERE id=$1 FOR UPDATE',[id]))[0];
   if(row.status===body.status){if(shipping&&(row.courier_name!==shipping.courier||row.tracking_number!==shipping.number||(row.tracking_url||'')!==shipping.url)||explanation&&row.cancellation_note!==explanation)throw fail('The recorded action has different details.');return {replacement:row,idempotent:true};}
   if(body.status==='cancelled'){
    if(!['reserved','accepted','packed'].includes(row.status))throw fail('A dispatched replacement cannot be cancelled or restored here.');
    const restored=row.variant_id?await c.query("UPDATE cerood_product_variants SET stock=stock+$1,updated_at=now() WHERE id=$2 AND marketplace='general' AND product_id=$3 RETURNING id",[row.quantity,row.variant_id,String(row.product_id)]):await c.query('UPDATE cerood_shop_products SET stock=stock+$1,updated_at=now() WHERE id=$2 RETURNING id',[row.quantity,row.product_id]);if(restored.length!==1)throw fail('Purchased option missing; cancellation rolled back.');
    if(row.variant_id)await inventory.syncVariantTotals(c,[row.product_id]);
   }else{
    const previous={accepted:'reserved',packed:'accepted',shipped:'packed',out_for_delivery:'shipped',delivered:'out_for_delivery'};
    if(row.status!==previous[body.status]||request.status!=='received')throw fail('Replacement stage changed or previous stage is incomplete. Refresh first.');
   }
   const saved=(await c.query("UPDATE cerood_shop_replacements SET status=$1::text,courier_name=COALESCE($2,courier_name),tracking_number=COALESCE($3,tracking_number),tracking_url=COALESCE($4,tracking_url),cancellation_note=COALESCE($5,cancellation_note),stock_restored_at=CASE WHEN $1='cancelled' THEN now() ELSE stock_restored_at END,stage_dates=stage_dates||jsonb_build_object($1::text,now()),updated_at=now() WHERE id=$6 RETURNING *",[body.status,shipping?.courier||null,shipping?.number||null,shipping?shipping.url||null:null,explanation,id]))[0];
   if(body.status==='delivered')await c.query("UPDATE cerood_shop_return_requests SET status='replaced',status_timestamps=status_timestamps||jsonb_build_object('replaced',now()),admin_updated_at=now(),updated_at=now() WHERE id=$1",[link.return_request_id]);
   return {replacement:saved,idempotent:false};
  });
 }
 return {q,reserve,change};
}
function register(app,db,customer,seller,admin){const s=createService(db);const handle=fn=>async(req,res)=>{res.set('Cache-Control','no-store');try{res.json({success:true,...await fn(req)})}catch(e){res.status(e.status||503).json({success:false,message:e.status?e.message:'Replacement service unavailable. Check migration 015 and refresh before retrying.'})}};
 const projection='SELECT x.*,i.order_id,r.customer_id FROM cerood_shop_replacements x JOIN cerood_shop_order_items i ON i.id=x.order_item_id JOIN cerood_shop_return_requests r ON r.id=x.return_request_id';
 app.get('/api/admin/shop/replacements',admin,handle(async()=>({replacements:await s.q(projection+' ORDER BY x.created_at DESC LIMIT 300')})));
 app.post('/api/admin/shop/returns/:id/replacement',admin,handle(req=>s.reserve(req.params.id,req.body)));
 app.patch('/api/admin/shop/replacements/:id',admin,handle(req=>s.change(req.params.id,req.body)));
 app.get('/api/sellers/shop/replacements',seller,handle(async(req)=>({replacements:(await s.q(projection+' WHERE x.seller_id=$1 ORDER BY x.created_at DESC LIMIT 200',[req.seller.id])).map(({customer_id,...x})=>x)})));
 app.patch('/api/sellers/shop/replacements/:id',seller,handle(req=>s.change(req.params.id,req.body,req.seller.id)));
 app.get('/api/shop/customer-replacements',customer,handle(async(req)=>({replacements:(await s.q(projection+' WHERE r.customer_id=$1 ORDER BY x.created_at DESC LIMIT 200',[String(req.ceroodCustomerId)])).map(({seller_id,customer_id,delivery_address,reservation_note,cancellation_note,request_key,...x})=>x)})));
 return s;
}
module.exports={register,createService,tracking,note};
