'use strict';
const crypto=require('node:crypto');
const bad=(message,status=400)=>Object.assign(Error(message),{status});
const uuid=v=>/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(String(v||''));
const enabled=()=>process.env.SHOP_ONLINE_ENABLED==='true'&&!!process.env.SHOP_RAZORPAY_WEBHOOK_SECRET&&!!process.env.RAZORPAY_KEY_ID&&!!process.env.RAZORPAY_KEY_SECRET;
function validSignature(data,signature,secret){if(!secret||!/^[0-9a-f]{64}$/i.test(String(signature||'')))return false;return crypto.timingSafeEqual(crypto.createHmac('sha256',secret).update(data).digest(),Buffer.from(signature,'hex'));}
const queryFor=c=>(sql,args=[])=>{let n=0;return c.query(sql.replace(/\?/g,()=>'$'+(++n)),args);};
function createService(db,provider,h){
 const query=(sql,args=[])=>new Promise((resolve,reject)=>db.query(sql,args,(e,r)=>e?reject(e):resolve(r)));
 async function prepare(req){
  const requestId=String(req.body?.request_id||'');if(!uuid(requestId))throw bad('Valid checkout request required.');
  const address=h.address(req.body?.address),items=h.items(req.body?.items);
  if(!req.ceroodCustomerId||address.phone!==req.ceroodCustomerPhone)throw bad('Sign in with the delivery mobile number before online payment.',401);
  const c=await db.getClient();let done=false;
  try{await c.query('BEGIN');const q=queryFor(c);await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',[requestId]);
   const prior=(await c.query('SELECT * FROM cerood_shop_orders WHERE request_id=$1 FOR UPDATE',[requestId]))[0];
   if(prior){const saved=await c.query('SELECT * FROM cerood_shop_order_items WHERE order_id=$1 ORDER BY id',[prior.id]);
    if(prior.payment_method!=='online'||String(prior.customer_id)!==String(req.ceroodCustomerId)||!h.matches(prior,saved,address,items))throw bad('This checkout request belongs to a different cart or address.',409);
    if(prior.payment_status==='paid'){await c.query('COMMIT');done=true;return {already_paid:true,order_id:prior.id};}
    if(prior.status!=='pending'||prior.stock_restored_at||new Date(prior.payment_expires_at).getTime()<=Date.now())throw bad('Payment attempt closed. Check My Orders before starting another checkout.',409);
    await c.query('COMMIT');done=true;return response(prior);
   }
   const totals=await h.resolve(q,items,true);const amount=Math.round(totals.total*100);
   if(!Number.isSafeInteger(amount)||amount<100)throw bad('Invalid payment amount.');
   if(req.body.expected_total==null||!Number.isFinite(Number(req.body.expected_total))||Math.abs(Number(req.body.expected_total)-totals.total)>0.005)throw bad('Price changed. Check the final total again.',409);
   const id=crypto.randomUUID();
   const rz=await provider.orders.create({amount,currency:'INR',receipt:id,notes:{store:'cerood_main',shop_order_id:id}});
   if(!/^order_[A-Za-z0-9]+$/.test(String(rz?.id||''))||Number(rz.amount)!==amount||rz.currency!=='INR')throw bad('Payment provider returned invalid order details.',503);
   const order=(await c.query(`INSERT INTO cerood_shop_orders(id,request_id,customer_id,customer_name,customer_phone,customer_email,delivery_address,subtotal,delivery_fee,total,currency,status,payment_method,payment_status,razorpay_order_id,payment_expires_at)
    VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,'INR','pending','online','pending',$11,now()+interval '24 hours') RETURNING *`,[id,requestId,req.ceroodCustomerId,address.name,address.phone,null,JSON.stringify(address),totals.subtotal,totals.delivery_fee,totals.total,rz.id]))[0];
   for(const line of totals.lines){const changed=line.variant_id
    ?await c.query("UPDATE cerood_product_variants SET stock=stock-$1,updated_at=now() WHERE id=$2 AND marketplace='general' AND product_id=$3 AND is_active=true AND stock>=$1 RETURNING id",[line.quantity,line.variant_id,String(line.p.id)])
    :await c.query('UPDATE cerood_shop_products SET stock=stock-$1,updated_at=now() WHERE id=$2 AND stock>=$1 RETURNING id',[line.quantity,line.p.id]);
    if(changed.length!==1)throw bad('Stock changed. Refresh the checkout.',409);
    await c.query(`INSERT INTO cerood_shop_order_items(order_id,product_id,seller_id,product_name,unit_price,quantity,line_total,variant_id,variant_sku,variant_values) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,[id,line.p.id,line.p.seller_id,line.p.name,line.unit_price,line.quantity,line.line_total,line.variant_id,line.variant_sku,JSON.stringify(line.variant_values)]);
   }
   await c.query('COMMIT');done=true;return response(order);
  }finally{try{if(!done)await c.query('ROLLBACK')}finally{c.release()}}
 }
 function response(o){return {order_id:o.id,razorpay_order_id:o.razorpay_order_id,key_id:process.env.RAZORPAY_KEY_ID,amount:Math.round(Number(o.total)*100),currency:'INR',total:Number(o.total)};}
 async function finalize(orderId,paymentId){
  if(!/^order_[A-Za-z0-9]+$/.test(String(orderId))||!/^pay_[A-Za-z0-9]+$/.test(String(paymentId)))throw bad('Invalid payment reference.');
  const rows=await query("SELECT * FROM cerood_shop_orders WHERE razorpay_order_id=$1 AND payment_method='online'",[orderId]);
  if(!rows.length)return {state:'not_found'};
  const p=await provider.payments.fetch(paymentId);
  if(p.order_id!==orderId||p.currency!=='INR'||Number(p.amount)!==Math.round(Number(rows[0].total)*100))throw bad('Payment amount or order does not match.',409);
  if(p.status!=='captured')return {state:'not_captured',order_id:rows[0].id};
  const c=await db.getClient();let done=false;try{await c.query('BEGIN');const o=(await c.query('SELECT * FROM cerood_shop_orders WHERE id=$1 FOR UPDATE',[rows[0].id]))[0];
   if(o.payment_status==='paid'){await c.query('COMMIT');done=true;return {state:o.razorpay_payment_id===paymentId?'paid':'payment_review',order_id:o.id};}
   if(o.razorpay_payment_id&&o.razorpay_payment_id!==paymentId)throw bad('Payment reference requires reconciliation.',409);
   const review=o.status!=='pending'||!!o.stock_restored_at;
   await c.query(`UPDATE cerood_shop_orders SET payment_status=$1,status=$2,razorpay_payment_id=$3,paid_at=now(),updated_at=now(),status_timestamps=CASE WHEN $1='paid' THEN COALESCE(status_timestamps,'{}'::jsonb)||jsonb_build_object('confirmed',now()) ELSE status_timestamps END WHERE id=$4`,[review?'payment_review':'paid',review?'payment_review':'confirmed',paymentId,o.id]);
   await c.query('COMMIT');done=true;return {state:review?'payment_review':'paid',order_id:o.id};
  }finally{try{if(!done)await c.query('ROLLBACK')}finally{c.release()}}
 }
 async function recover(order){
  const payments=await provider.orders.fetchPayments(order.razorpay_order_id);
  if(!Array.isArray(payments?.items))throw bad('Payment provider response unavailable.',503);
  if(Number(payments.count)>payments.items.length)throw bad('Incomplete payment history. Reservation remains held for review.',503);
  const captured=payments.items.find(p=>p.status==='captured'&&p.order_id===order.razorpay_order_id);
  if(captured)return finalize(order.razorpay_order_id,captured.id);
  return {state:order.payment_status,order_id:order.id,authorized:payments.items.some(p=>p.status==='authorized')};
 }
 async function expire(id){
  const initial=(await query("SELECT * FROM cerood_shop_orders WHERE id=$1 AND payment_method='online'",[id]))[0];
  if(!initial||initial.payment_status!=='pending'||new Date(initial.payment_expires_at).getTime()>Date.now())return {state:'unchanged'};
  const state=await recover(initial);if(state.state==='paid'||state.state==='payment_review'||state.authorized)return state;
  const c=await db.getClient();let done=false;try{await c.query('BEGIN');const o=(await c.query('SELECT * FROM cerood_shop_orders WHERE id=$1 FOR UPDATE',[id]))[0];
   if(o.payment_status!=='pending'||o.status!=='pending'||o.stock_restored_at){await c.query('COMMIT');done=true;return {state:o.payment_status};}
   const items=await c.query('SELECT product_id,variant_id,quantity FROM cerood_shop_order_items WHERE order_id=$1 ORDER BY product_id,variant_id',[id]);
   const ids=[...new Set(items.map(i=>i.product_id))].sort();
   if(ids.length)await c.query('SELECT id FROM cerood_shop_products WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE',[ids]);
   const variantIds=items.map(i=>i.variant_id).filter(Boolean).sort();if(variantIds.length)await c.query('SELECT id FROM cerood_product_variants WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE',[variantIds]);
   for(const item of items){const restored=item.variant_id?await c.query("UPDATE cerood_product_variants SET stock=stock+$1,updated_at=now() WHERE id=$2 AND product_id=$3 AND marketplace='general' RETURNING id",[item.quantity,item.variant_id,String(item.product_id)]):await c.query('UPDATE cerood_shop_products SET stock=stock+$1,updated_at=now() WHERE id=$2 RETURNING id',[item.quantity,item.product_id]);if(restored.length!==1)throw bad('Inventory recovery needs support review.',409);}
   await c.query("UPDATE cerood_shop_orders SET status='cancelled',payment_status='expired',stock_restored_at=now(),cancelled_at=now(),cancellation_reason='Unpaid online reservation expired',updated_at=now() WHERE id=$1",[id]);
   await c.query('COMMIT');done=true;return {state:'expired'};
  }finally{try{if(!done)await c.query('ROLLBACK')}finally{c.release()}}
 }
 async function sweep(){const rows=await query("SELECT id FROM cerood_shop_orders WHERE payment_method='online' AND payment_status='pending' AND payment_expires_at<now() ORDER BY payment_expires_at LIMIT 20");for(const o of rows)await expire(o.id);return rows.length;}
 return {prepare,finalize,recover,expire,sweep,query};
}
function register(app,db,provider,h,customer,admin){const service=createService(db,provider,h);const handle=fn=>async(req,res)=>{res.set('Cache-Control','no-store');try{await fn(req,res)}catch(e){res.status(e.status||503).json({success:false,message:e.status?e.message:'Payment service temporarily unavailable. Check My Orders before paying again.'})}};
 app.post('/api/shop/create-razorpay-order',customer,handle(async(req,res)=>{if(!enabled())throw bad('Main Store online payment is not enabled.',503);res.json({success:true,...await service.prepare(req)});}));
 app.post('/api/shop/verify-razorpay-payment',customer,handle(async(req,res)=>{const b=req.body||{};if(!validSignature(String(b.razorpay_order_id)+'|'+String(b.razorpay_payment_id),b.razorpay_signature,process.env.RAZORPAY_KEY_SECRET))throw bad('Payment signature verification failed.',401);
  const orders=await service.query('SELECT customer_id FROM cerood_shop_orders WHERE razorpay_order_id=$1',[b.razorpay_order_id]);if(!orders.length||String(orders[0].customer_id)!==String(req.ceroodCustomerId))throw bad('Order not found.',404);
  const result=await service.finalize(b.razorpay_order_id,b.razorpay_payment_id);res.status(result.state==='paid'?200:409).json({success:result.state==='paid',order_id:result.order_id,payment_state:result.state,message:result.state==='paid'?'Payment verified.':'Payment awaits capture or support review. Check My Orders before paying again.'});}));
 app.post('/api/shop/recover-razorpay-payment',customer,handle(async(req,res)=>{if(!uuid(req.body?.order_id))throw bad('Invalid order.');const rows=await service.query("SELECT * FROM cerood_shop_orders WHERE id=$1 AND customer_id=$2 AND payment_method='online'",[req.body.order_id,req.ceroodCustomerId]);if(!rows.length)throw bad('Order not found.',404);const result=await service.recover(rows[0]);res.json({success:true,paid:result.state==='paid',payment_state:result.state,order_id:result.order_id});}));
 app.post('/api/shop/razorpay-webhook',handle(async(req,res)=>{if(!Buffer.isBuffer(req.body)||!validSignature(req.body,req.get('x-razorpay-signature'),process.env.SHOP_RAZORPAY_WEBHOOK_SECRET))throw bad('Invalid webhook signature.',401);const event=JSON.parse(req.body.toString());if(['payment.captured','order.paid'].includes(event.event)){const p=event.payload?.payment?.entity;if(p?.id&&p?.order_id)await service.finalize(p.order_id,p.id);}if(['refund.created','refund.processed','refund.failed'].includes(event.event)&&h.refunds)await h.refunds.webhook(event.payload?.refund?.entity);res.json({success:true});}));
 app.post('/api/admin/shop/reconcile-payments',admin,handle(async(req,res)=>res.json({success:true,checked:await service.sweep()})));
 let sweeping=false;const timer=setInterval(async()=>{if(!enabled()||sweeping)return;sweeping=true;try{await service.sweep()}catch(e){console.error('Main Store payment reconciliation:',e.message)}finally{sweeping=false}},15*60*1000);timer.unref();
 return service;
}
module.exports={register,createService,enabled,validSignature};
