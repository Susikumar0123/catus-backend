'use strict';
const uuid=v=>/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(String(v||''));
const fail=(message,status=400)=>Object.assign(Error(message),{status});
function quantity(v){if(typeof v!=='number'||!Number.isSafeInteger(v)||v<0||v>1000000)throw fail('Stock must be a whole number between 0 and 1000000.');return v;}
async function update(db,seller,id,body={}){
 if(!uuid(id)||body.variant_id&&!uuid(body.variant_id))throw fail('Invalid product or variant.');
 const stock=quantity(body.stock),expected=quantity(body.expected_stock),c=await db.getClient();let done=false;
 try{await c.query('BEGIN');
 const submissions=await c.query('SELECT id,approval_status,product_data FROM cerood_seller_catalog_submissions WHERE seller_id=$1 AND published_product_id=$2 ORDER BY id FOR UPDATE',[seller,id]);
 if(submissions.some(s=>s.approval_status==='pending'))throw fail('A catalog edit awaits approval. Resolve it before updating live stock.',409);
 const products=await c.query("SELECT id,stock FROM cerood_shop_products WHERE id=$1 AND seller_id=$2 AND status='published' AND approval_status='approved' FOR UPDATE",[id,seller]);
 if(!products.length)throw fail('Published product not found.',404);
 const variants=await c.query("SELECT id,stock,variant_values FROM cerood_product_variants WHERE marketplace='general' AND product_id=$1 AND is_active=true ORDER BY id FOR UPDATE",[id]);
 const target=body.variant_id?variants.find(v=>String(v.id)===String(body.variant_id)):variants.length?null:products[0];
 if(!target)throw fail('Choose an active variant for this product.');
 if(Number(target.stock)!==expected)throw fail('Stock changed since loading. Refresh and enter the current available stock.',409);
 if(body.variant_id){await c.query('UPDATE cerood_product_variants SET stock=$1,updated_at=now() WHERE id=$2',[stock,body.variant_id]);target.stock=stock;}
 const total=variants.length?variants.reduce((n,v)=>n+Number(v.stock),0):stock;
 if(total>1000000)throw fail('Combined variant stock cannot exceed 1000000.');
 await c.query('UPDATE cerood_shop_products SET stock=$1,updated_at=now() WHERE id=$2',[total,id]);
 for(const submission of submissions.filter(s=>s.approval_status==='approved')){
 const data={...submission.product_data,stock:total};
 if(Array.isArray(data.product_variants))data.product_variants=data.product_variants.map(v=>{const match=variants.find(x=>String(x.id)===String(v.id)||JSON.stringify(Object.entries(x.variant_values||{}).sort())===JSON.stringify(Object.entries(v.variant_values||{}).sort()));return match?{...v,stock:Number(match.stock)}:v;});
 await c.query('UPDATE cerood_seller_catalog_submissions SET product_data=$1::jsonb WHERE id=$2',[JSON.stringify(data),submission.id]);}
 await c.query('COMMIT');done=true;return {stock,total_stock:total};
 }finally{try{if(!done)await c.query('ROLLBACK')}finally{c.release()}}
}
function register(app,db,auth){const q=(sql,args)=>new Promise((resolve,reject)=>db.query(sql,args,(e,r)=>e?reject(e):resolve(r)));const handle=fn=>async(req,res)=>{res.set('Cache-Control','no-store');try{await fn(req,res)}catch(e){res.status(e.status||500).json({success:false,message:e.status?e.message:'Unable to update inventory. Try again.'})}};
 app.get('/api/sellers/shop/inventory',auth,handle(async(req,res)=>{
 const rows=await q(`SELECT p.id,p.name,p.stock,v.id AS variant_id,v.sku,v.variant_values,v.stock AS variant_stock FROM cerood_shop_products p LEFT JOIN cerood_product_variants v ON v.marketplace='general' AND v.product_id=p.id::text AND v.is_active=true WHERE p.seller_id=$1 AND p.status='published' AND p.approval_status='approved' ORDER BY p.name,p.id,v.id LIMIT 500`,[req.seller.id]);res.json({success:true,items:rows});}));
 app.patch('/api/sellers/shop/inventory/:id',auth,handle(async(req,res)=>res.json({success:true,...await update(db,req.seller.id,req.params.id,req.body)})));
}
module.exports={register,update,quantity};
