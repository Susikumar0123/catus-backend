'use strict';
const uuid=v=>/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(String(v||''));
const fail=(message,status=409)=>Object.assign(Error(message),{status});
async function processReturn(db,id,body={}){
 const action=body.action,note=String(body.note||'').trim(),reference=String(body.reference||'').trim();
 if(!uuid(id)||!['pickup_scheduled','picked_up','received','inspect','record_cod_refund'].includes(action)||note.length<10||note.length>1500)throw fail('Choose an action and enter a note of 10–1500 characters.',400);
 if(action==='pickup_scheduled'&&(reference.length<5||reference.length>120))throw fail('Enter the actual pickup reference, 5–120 characters.',400);
 if(action==='inspect'&&!['restock','quarantine'].includes(body.disposition))throw fail('Choose restock or quarantine.',400);
 if(action==='record_cod_refund'&&(body.transfer_confirmed!==true||reference.length<5||reference.length>120))throw fail('Confirm the completed refund transfer and enter its reference.',400);
 const c=await db.getClient();let done=false;try{await c.query('BEGIN');
 const links=await c.query('SELECT i.order_id,i.id FROM cerood_shop_return_requests r JOIN cerood_shop_order_items i ON i.id=r.order_item_id WHERE r.id=$1',[id]);if(!links.length)throw fail('Return request not found.',404);
 const order=(await c.query('SELECT * FROM cerood_shop_orders WHERE id=$1 FOR UPDATE',[links[0].order_id]))[0];
 const item=(await c.query('SELECT * FROM cerood_shop_order_items WHERE id=$1 FOR UPDATE',[links[0].id]))[0];
 const r=(await c.query('SELECT * FROM cerood_shop_return_requests WHERE id=$1 FOR UPDATE',[id]))[0];
 if(!order||!item||order.status!=='delivered'||['rejected','cancelled'].includes(item.seller_order_status))throw fail('Only delivered purchased items can proceed.');
 const forward={pickup_scheduled:'approved',picked_up:'pickup_scheduled',received:'picked_up'};
 if(forward[action]){
  if(r.status===action){if(action==='pickup_scheduled'&&r.pickup_reference!==reference)throw fail('Pickup reference differs from the recorded pickup.');await c.query('COMMIT');done=true;return {request:r,idempotent:true};}
  if(r.status!==forward[action])throw fail('Return stage changed or the previous stage is incomplete. Refresh the request.');
  const rows=await c.query(`UPDATE cerood_shop_return_requests SET status=$1,admin_note=$2,pickup_reference=CASE WHEN $1='pickup_scheduled' THEN $3 ELSE pickup_reference END,status_timestamps=status_timestamps||jsonb_build_object($1::text,now()),admin_updated_at=now(),updated_at=now() WHERE id=$4 RETURNING *`,[action,note,reference||null,id]);
  await c.query('COMMIT');done=true;return {request:rows[0],idempotent:false};
 }
 if(action==='inspect'){
  if(r.inspected_at){if(r.inspection_result!==body.disposition)throw fail('Inspection already recorded with a different disposition.');await c.query('COMMIT');done=true;return {request:r,idempotent:true};}
  if(r.status!=='received')throw fail('Record receipt of the returned item before inspection.');
  if(body.disposition==='restock'){
   const quantity=Number(item.quantity);if(!Number.isSafeInteger(quantity)||quantity<1)throw fail('Purchased quantity needs review.');
   const products=await c.query('SELECT id FROM cerood_shop_products WHERE id=$1 FOR UPDATE',[item.product_id]);if(!products.length)throw fail('Product missing. Inventory recovery needs review.');
   const updated=item.variant_id?await c.query("UPDATE cerood_product_variants SET stock=stock+$1,updated_at=now() WHERE id=$2 AND product_id=$3 AND marketplace='general' RETURNING id",[quantity,item.variant_id,String(item.product_id)]):await c.query('UPDATE cerood_shop_products SET stock=stock+$1,updated_at=now() WHERE id=$2 RETURNING id',[quantity,item.product_id]);
   if(updated.length!==1)throw fail('Purchased option is missing. Stock restoration rolled back.');
   if(item.variant_id)await require('./cerood-shop-inventory').syncVariantTotals(c,[item.product_id]);
  }
  const rows=await c.query(`UPDATE cerood_shop_return_requests SET inspection_result=$1,inspected_at=now(),stock_restored_at=CASE WHEN $1='restock' THEN now() ELSE NULL END,admin_note=$2,status_timestamps=status_timestamps||jsonb_build_object('inspected',now()),admin_updated_at=now(),updated_at=now() WHERE id=$3 RETURNING *`,[body.disposition,note,id]);await c.query('COMMIT');done=true;return {request:rows[0],idempotent:false};
 }
 if(r.request_type!=='return'||order.payment_method!=='cod')throw fail('This action records completed COD return refunds only. Online refunds/exchanges use separate processing.');
 if(r.status==='refunded'){if(r.refund_reference!==reference)throw fail('A different completed refund reference is already recorded.');await c.query('COMMIT');done=true;return {request:r,idempotent:true};}
 if(r.status!=='received'||!r.inspected_at)throw fail('Receive and inspect the item before recording its refund.');
 const settlements=await require('./cerood-shop-finance-reconciliation').refundBlockers(c,item.id);if(settlements.length)throw fail('A seller settlement exists. Reconcile it before recording this refund.');
 if(!Number.isFinite(Number(item.line_total))||Number(item.line_total)<=0)throw fail('Item refund amount requires review.');
 const rows=await c.query(`UPDATE cerood_shop_return_requests SET status='refunded',refund_amount=$1,refund_reference=$2,refunded_at=now(),admin_note=$3,status_timestamps=status_timestamps||jsonb_build_object('refunded',now()),admin_updated_at=now(),updated_at=now() WHERE id=$4 RETURNING *`,[item.line_total,reference,note,id]);
 await c.query('COMMIT');done=true;return {request:rows[0],idempotent:false};
 }finally{try{if(!done)await c.query('ROLLBACK')}finally{c.release()}}
}
function register(app,db,admin){app.post('/api/admin/shop/returns/:id/fulfilment',admin,async(req,res)=>{res.set('Cache-Control','no-store');try{res.json({success:true,...await processReturn(db,req.params.id,req.body)})}catch(e){res.status(e.status||503).json({success:false,message:e.status?e.message:'Unable to record return processing. Refresh before retrying.'})}});}
module.exports={register,processReturn};
