'use strict';
const fail=(message,status=409)=>Object.assign(new Error(message),{status});
const uuid=v=>/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(String(v||''));
async function cancel(db,id,reason,options={}){
 const client=await db.getClient();let begun=false;
 try{
  await client.query('BEGIN');begun=true;
  const rows=await client.query('SELECT * FROM public.cerood_shop_orders WHERE id=$1 FOR UPDATE',[id]);
  const order=rows[0];if(!order)throw fail('Order not found.',404);
  if(order.status==='cancelled'){
   await client.query('COMMIT');begun=false;return {order,idempotent:true};
  }
  const online=options.allow_online===true&&order.payment_method==='online'&&order.payment_status==='paid';
  if(!online&&(order.payment_method!=='cod'||order.payment_status!=='cod_pending'))throw fail('Only unpaid COD or verified paid-online cancellation is allowed.');
  if(!['confirmed','processing','packed'].includes(order.status))throw fail('Order has already shipped or cannot be cancelled.');
  const shipments=await client.query(`SELECT id FROM public.cerood_ekart_shipments WHERE marketplace='shop' AND order_id=$1 AND cancelled_at IS NULL
    UNION ALL SELECT id FROM public.cerood_delhivery_shipments WHERE marketplace='shop' AND order_id=$1 AND cancelled_at IS NULL`,[String(id)]);
  if(shipments.length)throw fail('Cancel or reconcile the courier booking before cancelling this order.');
  const items=await client.query(`SELECT id,product_id,variant_id,quantity,COALESCE(seller_order_status,'new') AS seller_order_status
    FROM public.cerood_shop_order_items WHERE order_id=$1 ORDER BY id FOR UPDATE`,[id]);
  if(!items.length)throw fail('Order items are missing. Check inventory before cancelling.');
  if(items.some(i=>['shipped','out_for_delivery','delivered'].includes(i.seller_order_status)))throw fail('A seller has already shipped this order.');
  const restore=items.filter(i=>i.seller_order_status!=='rejected');
  if(restore.some(i=>!Number.isSafeInteger(Number(i.quantity))||Number(i.quantity)<1||!uuid(i.product_id)||i.variant_id&&!uuid(i.variant_id)))throw fail('Order inventory information is invalid.');
  // Product -> variant lock order matches checkout. Seller-rejected lines were already restored.
  const productIds=[...new Set(restore.map(i=>String(i.product_id)))].sort();
  if(productIds.length){
   const products=await client.query('SELECT id FROM public.cerood_shop_products WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE',[productIds]);
   if(products.length!==productIds.length)throw fail('A product is missing. Inventory recovery is required.');
  }
  const variantIds=[...new Set(restore.map(i=>i.variant_id).filter(Boolean))].sort();
  if(variantIds.length)await client.query('SELECT id FROM public.cerood_product_variants WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE',[variantIds]);
  for(const item of restore){
   const updated=item.variant_id
    ?await client.query(`UPDATE public.cerood_product_variants SET stock=stock+$1,updated_at=now()
       WHERE id=$2 AND marketplace='general' AND product_id=$3 RETURNING id`,[item.quantity,item.variant_id,String(item.product_id)])
    :await client.query('UPDATE public.cerood_shop_products SET stock=stock+$1,updated_at=now() WHERE id=$2 RETURNING id',[item.quantity,item.product_id]);
   if(updated.length!==1)throw fail('Inventory option is missing. Cancellation was rolled back.');
  }
  await require('./cerood-shop-inventory').syncVariantTotals(client,restore.filter(x=>x.variant_id).map(x=>x.product_id));
  if(online){if(typeof options.reserve!=='function')throw fail('A durable refund reservation is required.');await options.reserve(client,order);}
  const cancelled=await client.query(`UPDATE public.cerood_shop_orders SET status='cancelled',updated_at=now(),cancelled_at=now(),
    cancellation_reason=$1,stock_restored_at=now(),cancellation_refund_state=CASE WHEN payment_method='online' THEN 'pending' ELSE cancellation_refund_state END WHERE id=$2 RETURNING *`,[reason,id]);
  await client.query('COMMIT');begun=false;return {order:cancelled[0],idempotent:false};
 }finally{if(begun)await client.query('ROLLBACK').catch(()=>{});client.release();}
}
function register(app,db,requireAdminAuth){
 app.post('/api/admin/shop/orders/:id/cancel',requireAdminAuth,async(req,res)=>{
  res.set('Cache-Control','no-store');
  const reason=typeof req.body?.reason==='string'?req.body.reason.trim():'';
  if(!uuid(req.params.id)||!reason||reason.length>500)return res.status(400).json({success:false,message:'Valid order and cancellation reason required (up to 500 characters).'});
  try{return res.json({success:true,...await cancel(db,req.params.id,reason)});}
  catch(error){console.error('Main Store cancellation:',error.message);return res.status(error.status||503).json({success:false,message:error.status?error.message:'Unable to cancel. Refresh orders before retrying.'});}
 });
}
module.exports={cancel,register};
