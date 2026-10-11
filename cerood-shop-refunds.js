'use strict';
const uuid=v=>/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(String(v||''));
const bad=(message,status=409)=>Object.assign(Error(message),{status});
const enabled=()=>process.env.SHOP_REFUNDS_ENABLED==='true'&&!!process.env.RAZORPAY_KEY_ID&&!!process.env.RAZORPAY_KEY_SECRET&&!!process.env.SHOP_RAZORPAY_WEBHOOK_SECRET;
function createService(db,provider){
 const query=(sql,args=[])=>new Promise((resolve,reject)=>db.query(sql,args,(e,r)=>e?reject(e):resolve(r)));
 async function apply(refund,entity){
  if(entity.payment_id!==refund.payment_id||entity.currency!=='INR'||Number(entity.amount)!==Number(refund.amount_paise)||!/^rfnd_[A-Za-z0-9]+$/.test(String(entity.id||'')))throw bad('Refund provider details do not match. Keep this refund held for reconciliation.');
  if(!['pending','processed','failed'].includes(entity.status))throw bad('Unknown refund status. Keep it held for review.');
  const c=await db.getClient();let done=false;try{await c.query('BEGIN');await c.query('SELECT id FROM cerood_shop_orders WHERE id=$1 FOR UPDATE',[refund.order_id]);
   const saved=(await c.query('SELECT * FROM cerood_shop_refunds WHERE id=$1 FOR UPDATE',[refund.id]))[0];
   if(saved.provider_refund_id&&saved.provider_refund_id!==entity.id)throw bad('Multiple refund references require support review.');
   const state=saved.state==='processed'?'processed':entity.status;
   await c.query('UPDATE cerood_shop_refunds SET state=$1,provider_refund_id=$2,processed_at=CASE WHEN $1=\'processed\' THEN COALESCE(processed_at,now()) ELSE processed_at END,updated_at=now() WHERE id=$3',[state,entity.id,saved.id]);
   await c.query(`UPDATE cerood_shop_return_requests SET online_refund_state=$1,online_refund_id=$2,refund_amount=$3,refund_reference=$2,status=CASE WHEN $1='processed' THEN 'refunded' ELSE status END,refunded_at=CASE WHEN $1='processed' THEN COALESCE(refunded_at,now()) ELSE refunded_at END,status_timestamps=CASE WHEN $1='processed' THEN status_timestamps||jsonb_build_object('refunded',COALESCE(refunded_at,now())) ELSE status_timestamps END,updated_at=now() WHERE id=$4`,[state,entity.id,Number(saved.amount_paise)/100,saved.return_request_id]);
   await c.query('COMMIT');done=true;return {state,refund_id:entity.id};
  }finally{try{if(!done)await c.query('ROLLBACK')}finally{c.release()}}
 }
 async function reconcile(id){
  const saved=(await query('SELECT * FROM cerood_shop_refunds WHERE return_request_id=$1',[id]))[0];if(!saved)throw bad('Refund record not found.',404);
  if(saved.provider_refund_id)return apply(saved,await provider.refunds.fetch(saved.provider_refund_id));
  // Receipt is a correlation reference, not a provider idempotency guarantee.
  const found=[];let complete=false;
  for(let skip=0;skip<1000;skip+=100){const page=await provider.payments.fetchMultipleRefund(saved.payment_id,{count:100,skip});if(!Array.isArray(page?.items))throw bad('Refund history unavailable.',503);found.push(...page.items.filter(r=>r.receipt===saved.id));if(page.items.length<100){complete=true;break;}}
  if(!complete)throw bad('Refund history too large. Reconcile in Razorpay before proceeding.');
  if(found.length>1)throw bad('Multiple matching refunds require review.');
  if(found.length===1)return apply(saved,await provider.refunds.fetch(found[0].id));
  // NEVER send another refund after an unknown/possibly accepted request.
  return {state:saved.state,refund_id:null,message:'No matching refund yet. Do not retry from Razorpay without reconciling this held record.'};
 }
 async function initiate(id,body={}){
  const note=String(body.note||'').trim();if(!uuid(id)||body.confirm_refund!==true||note.length<10||note.length>1500)throw bad('Confirm the item refund and enter a note of 10–1500 characters.',400);
  const link=(await query(`SELECT r.*,i.order_id,i.id AS item_id,i.line_total,o.payment_method,o.payment_status,o.razorpay_order_id,o.razorpay_payment_id,o.total FROM cerood_shop_return_requests r JOIN cerood_shop_order_items i ON i.id=r.order_item_id JOIN cerood_shop_orders o ON o.id=i.order_id WHERE r.id=$1`,[id]))[0];
  if(!link)throw bad('Return request not found.',404);
  const old=(await query('SELECT id FROM cerood_shop_refunds WHERE return_request_id=$1',[id]))[0];if(old)return reconcile(id);
  if(link.request_type!=='return'||link.status!=='received'||!link.inspected_at||link.payment_method!=='online'||link.payment_status!=='paid'||!/^pay_[A-Za-z0-9]+$/.test(String(link.razorpay_payment_id||'')))throw bad('Receive and inspect an eligible paid online return first.');
  const payment=await provider.payments.fetch(link.razorpay_payment_id);
  if(payment.status!=='captured'||payment.currency!=='INR'||payment.order_id!==link.razorpay_order_id||Number(payment.amount)!==Math.round(Number(link.total)*100))throw bad('Captured payment does not match this order.');
  const amount=Math.round(Number(link.line_total)*100);if(!Number.isSafeInteger(amount)||amount<1)throw bad('Item refund amount requires review.');
  const c=await db.getClient();let done=false,created;
  try{await c.query('BEGIN');const order=(await c.query('SELECT * FROM cerood_shop_orders WHERE id=$1 FOR UPDATE',[link.order_id]))[0];await c.query('SELECT id FROM cerood_shop_order_items WHERE id=$1 FOR UPDATE',[link.item_id]);
   const r=(await c.query('SELECT * FROM cerood_shop_return_requests WHERE id=$1 FOR UPDATE',[id]))[0];
   const existing=(await c.query('SELECT * FROM cerood_shop_refunds WHERE return_request_id=$1',[id]))[0];
   if(existing){await c.query('COMMIT');done=true;return reconcile(id);}
   if(order.payment_status!=='paid'||order.status!=='delivered'||r.status!=='received'||!r.inspected_at)throw bad('Return or payment changed. Refresh before refunding.');
   const settlements=await require('./cerood-shop-finance-reconciliation').refundBlockers(c,link.item_id);if(settlements.length)throw bad('Seller settlement exists. Reconcile it before issuing this refund.');
   const budgets=await c.query("SELECT amount_paise,state FROM cerood_shop_refunds WHERE order_id=$1 AND state<>'failed'",[link.order_id]);
   const reserved=budgets.reduce((n,r)=>n+Number(r.amount_paise),0),inflight=budgets.filter(r=>r.state!=='processed').reduce((n,r)=>n+Number(r.amount_paise),0);
   const external=Number(payment.amount_refunded||0);if(!Number.isSafeInteger(external)||external<0||amount+reserved>Number(payment.amount)||amount+external+inflight>Number(payment.amount))throw bad('Refundable balance is insufficient or held for reconciliation.');
   created=(await c.query('INSERT INTO cerood_shop_refunds(return_request_id,order_id,payment_id,amount_paise,admin_note) VALUES($1,$2,$3,$4,$5) RETURNING *',[id,link.order_id,link.razorpay_payment_id,amount,note]))[0];
   await c.query("UPDATE cerood_shop_return_requests SET online_refund_state='initiating',admin_note=$1,updated_at=now() WHERE id=$2",[note,id]);await c.query('COMMIT');done=true;
  }finally{try{if(!done)await c.query('ROLLBACK')}finally{c.release()}}
  try{const result=await provider.payments.refund(created.payment_id,{amount:Number(created.amount_paise),speed:'normal',receipt:created.id,notes:{cerood_return_id:id}});return await apply(created,result);}catch(error){
   await query("UPDATE cerood_shop_refunds SET state='unknown',updated_at=now() WHERE id=$1 AND state='initiating'",[created.id]);
   await query("UPDATE cerood_shop_return_requests SET online_refund_state='unknown',updated_at=now() WHERE id=$1 AND online_refund_state='initiating'",[id]);
   throw bad('Refund response is uncertain. Use Check refund status; do not send a second refund.',503);
  }
 }
 async function webhook(entity){if(!entity?.id)return;const saved=(await query('SELECT * FROM cerood_shop_refunds WHERE provider_refund_id=$1 OR id::text=$2',[entity.id,String(entity.receipt||'')]))[0];if(saved)await apply(saved,await provider.refunds.fetch(entity.id));}
 return {initiate,reconcile,webhook};
}
function register(app,db,provider,admin){const service=createService(db,provider);const route=fn=>async(req,res)=>{res.set('Cache-Control','no-store');try{res.json({success:true,...await fn(req)})}catch(e){res.status(e.status||503).json({success:false,message:e.status?e.message:'Unable to process refund. Check its status before retrying.'})}};
 app.post('/api/admin/shop/returns/:id/online-refund',admin,route(req=>{if(!enabled())throw bad('Online refund execution is not enabled.',503);return service.initiate(req.params.id,req.body)}));
 app.post('/api/admin/shop/returns/:id/reconcile-refund',admin,route(req=>{if(!uuid(req.params.id))throw bad('Invalid return request.',400);return service.reconcile(req.params.id)}));return service;
}
module.exports={register,createService,enabled};
