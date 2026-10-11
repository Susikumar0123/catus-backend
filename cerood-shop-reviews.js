'use strict';
const uuid=v=>/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(String(v||''));
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
function validate(body){
 const {order_id,product_id,rating,comment}=body||{};
 if(!uuid(order_id)||!uuid(product_id))throw fail('Valid order and product required.');
 if(!['string','number'].includes(typeof rating)||!Number.isInteger(Number(rating))||Number(rating)<1||Number(rating)>5)throw fail('Choose a rating from 1 to 5.');
 if(typeof comment!=='string'||comment.trim().length<10||comment.trim().length>1000)throw fail('Write a review of 10 to 1000 characters.');
 return {order_id,product_id,rating:Number(rating),comment:comment.trim()};
}
async function submit(db,customerId,phone,body){
 const review=validate(body),client=await db.getClient();let begun=false;
 try{
  await client.query('BEGIN');begun=true;
  const eligible=await client.query(`SELECT o.id,o.customer_name FROM public.cerood_shop_orders o
    WHERE o.id=$1 AND o.status='delivered' AND (o.payment_method='cod' OR o.payment_status='paid')
      AND (o.customer_id=$2 OR (o.customer_id IS NULL AND o.customer_phone=$3))
      AND EXISTS(SELECT 1 FROM public.cerood_shop_order_items i WHERE i.order_id=o.id AND i.product_id=$4)
    FOR SHARE OF o`,[review.order_id,String(customerId),phone,review.product_id]);
  if(!eligible.length)throw fail('Only your delivered order products can be reviewed.',403);
  let rows=await client.query(`INSERT INTO public.cerood_shop_reviews(order_id,product_id,customer_id,customer_name,rating,comment)
    VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(order_id,product_id) DO NOTHING RETURNING id,order_id,product_id,rating,comment,status,created_at`,
    [review.order_id,review.product_id,String(customerId),eligible[0].customer_name,review.rating,review.comment]);
  let idempotent=false;
  if(!rows.length){
   rows=await client.query('SELECT id,order_id,product_id,rating,comment,status,created_at FROM public.cerood_shop_reviews WHERE order_id=$1 AND product_id=$2 AND customer_id=$3',[review.order_id,review.product_id,String(customerId)]);
   if(!rows.length||rows[0].rating!==review.rating||rows[0].comment!==review.comment)throw fail('A review already exists for this order product.',409);
   idempotent=true;
  }
  await client.query('COMMIT');begun=false;return {review:rows[0],idempotent};
 }finally{if(begun)await client.query('ROLLBACK').catch(()=>{});client.release();}
}
function register(app,db,adminAuth,customerAuth){
 const query=(sql,args=[])=>new Promise((resolve,reject)=>db.query(sql,args,(e,r)=>e?reject(e):resolve(r||[])));
 const error=(res,e)=>{console.error('Main Store review:',e.message);return res.status(e.status||503).json({success:false,message:e.status?e.message:'Reviews temporarily unavailable.'});};
 app.post('/api/shop/reviews',customerAuth,async(req,res)=>{
  res.set('Cache-Control','no-store');try{return res.json({success:true,...await submit(db,req.ceroodCustomerId,req.ceroodCustomerPhone,req.body)});}catch(e){return error(res,e);}
 });
 app.get('/api/shop/my-reviews',customerAuth,async(req,res)=>{
  res.set('Cache-Control','no-store');try{const reviews=await query('SELECT id,order_id,product_id,rating,comment,status,created_at FROM public.cerood_shop_reviews WHERE customer_id=$1 ORDER BY created_at DESC LIMIT 200',[String(req.ceroodCustomerId)]);return res.json({success:true,reviews});}catch(e){return error(res,e);}
 });
 app.get('/api/shop/products/:id/reviews',async(req,res)=>{
  res.set('Cache-Control','no-store');if(!uuid(req.params.id))return error(res,fail('Invalid product.'));
  try{const reviews=await query(`SELECT r.id,r.product_id,split_part(btrim(r.customer_name),' ',1) AS customer_name,r.rating,r.comment,r.status,r.created_at,true AS verified_purchase
    FROM public.cerood_shop_reviews r JOIN public.cerood_shop_products p ON p.id=r.product_id
    WHERE r.product_id=$1 AND r.status='approved' AND p.status='published' AND p.approval_status='approved' ORDER BY r.created_at DESC LIMIT 50`,[req.params.id]);return res.json({success:true,reviews});}catch(e){return error(res,e);}
 });
 app.get('/api/admin/shop/reviews',adminAuth,async(req,res)=>{
  res.set('Cache-Control','no-store');const status=req.query.status||'pending';if(!['pending','approved','rejected'].includes(status))return error(res,fail('Invalid review status.'));
  try{const reviews=await query(`SELECT r.id,r.order_id,r.product_id,r.customer_name,r.rating,r.comment,r.status,r.created_at,p.name AS product_name
    FROM public.cerood_shop_reviews r LEFT JOIN public.cerood_shop_products p ON p.id=r.product_id WHERE r.status=$1 ORDER BY r.created_at DESC LIMIT 200`,[status]);return res.json({success:true,reviews});}catch(e){return error(res,e);}
 });
 app.patch('/api/admin/shop/reviews/:id',adminAuth,async(req,res)=>{
  const status=req.body?.status;res.set('Cache-Control','no-store');if(!uuid(req.params.id)||!['approved','rejected'].includes(status))return error(res,fail('Choose Approve or Reject.'));
  try{const rows=await query(`UPDATE public.cerood_shop_reviews SET status=$1,moderated_at=COALESCE(moderated_at,now()) WHERE id=$2 AND status IN ('pending',$1) RETURNING id,status`,[status,req.params.id]);if(!rows.length)throw fail('Review already moderated. Refresh the list.',409);return res.json({success:true,review:rows[0]});}catch(e){return error(res,e);}
 });
}
module.exports={register,submit,validate};
