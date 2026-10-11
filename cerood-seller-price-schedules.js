'use strict';
const uuid=x=>/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(String(x||''));
const fail=(message,status=409)=>Object.assign(Error(message),{status});
const paise=x=>Math.round(Number(x)*100);
function validate(body,now=Date.now()){
 const discount=Number(body.discount_percent),start=new Date(body.starts_at).getTime(),end=new Date(body.ends_at).getTime();
 if(!uuid(body.product_id)||!Number.isInteger(discount)||discount<1||discount>90||!Number.isFinite(start)||!Number.isFinite(end)||start<now+300000||start>now+90*86400000||end<=start||end-start>30*86400000)throw fail('Choose a product, 1–90% discount, start at least 5 minutes ahead within 90 days, and an end within 30 days of start.',400);
 return {discount,start:new Date(start).toISOString(),end:new Date(end).toISOString()};
}
function snapshot(p,variants){return {product:{id:String(p.id),price:paise(p.price),compare_price:p.compare_price==null?null:paise(p.compare_price)},variants:variants.map(v=>({id:String(v.id),price:paise(v.price),compare_price:v.compare_price==null?null:paise(v.compare_price)})).sort((a,b)=>a.id.localeCompare(b.id))};}
const canonical=x=>Array.isArray(x)?x.map(canonical):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
const same=(a,b)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
async function transaction(db,fn){const c=await db.getClient();let done=false;try{await c.query('BEGIN');const result=await fn(c);await c.query('COMMIT');done=true;return result;}finally{try{if(!done)await c.query('ROLLBACK')}finally{c.release()}}}
async function inventory(c,product,seller){
 const submissions=await c.query("SELECT id,approval_status FROM cerood_seller_catalog_submissions WHERE published_product_id=$1 AND seller_id=$2 ORDER BY id FOR UPDATE",[product,seller]);
 const p=(await c.query("SELECT p.* FROM cerood_shop_products p JOIN cerood_sellers s ON s.id=p.seller_id WHERE p.id=$1 AND p.seller_id=$2 AND s.status='approved' FOR UPDATE OF p",[product,seller]))[0];
 if(!p)throw fail('Owned product or approved seller account not found.',404);
 const variants=await c.query("SELECT id,price,compare_price FROM cerood_product_variants WHERE marketplace='general' AND product_id=$1 AND is_active=true ORDER BY id FOR UPDATE",[String(product)]);
 return {p,variants,ready:p.status==='published'&&p.approval_status==='approved'&&!submissions.some(s=>s.approval_status==='pending')};
}
async function writePrices(c,values){
 await c.query('UPDATE cerood_shop_products SET price=$1,compare_price=$2,updated_at=now() WHERE id=$3',[values.product.price/100,values.product.compare_price==null?null:values.product.compare_price/100,values.product.id]);
 for(const v of values.variants)await c.query('UPDATE cerood_product_variants SET price=$1,compare_price=$2,updated_at=now() WHERE id=$3',[v.price/100,v.compare_price==null?null:v.compare_price/100,v.id]);
 // Stock and approval state are deliberately untouched. Current prices are loaded from live inventory by the schedule UI.
}
function createService(db,clock=()=>Date.now()){
 const q=(sql,args=[])=>new Promise((resolve,reject)=>db.query(sql,args,(e,r)=>e?reject(e):resolve(r)));
 async function create(seller,body){const v=validate(body,clock());return transaction(db,async c=>{
  const {p,variants,ready}=await inventory(c,body.product_id,seller);if(!ready)throw fail('Resolve catalog approval before scheduling a discount.');
  const baseline=snapshot(p,variants);const discounted=JSON.parse(JSON.stringify(baseline));for(const row of [discounted.product,...discounted.variants])row.price=Math.max(1,Math.round(row.price*(100-v.discount)/100));
  try{return (await c.query('INSERT INTO cerood_shop_price_schedules(seller_id,product_id,discount_percent,starts_at,ends_at,baseline,discounted) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb) RETURNING *',[seller,p.id,v.discount,v.start,v.end,JSON.stringify(baseline),JSON.stringify(discounted)]))[0];}catch(e){if(e.code==='23505')throw fail('This product already has an open schedule.');throw e;}
 });}
 async function change(id,seller,action,note=''){
  if(!uuid(id)||!['approve','reject','cancel'].includes(action))throw fail('Invalid schedule action.',400);
  note=String(note).trim();if(note.length>1500||action==='reject'&&note.length<10)throw fail('Enter a rejection reason of 10–1500 characters.',400);
  const link=(await q('SELECT * FROM cerood_shop_price_schedules WHERE id=$1'+(seller?' AND seller_id=$2':''),seller?[id,seller]:[id]))[0];if(!link)throw fail('Schedule not found.',404);
  return transaction(db,async c=>{
   const inv=await inventory(c,link.product_id,link.seller_id);const row=(await c.query('SELECT * FROM cerood_shop_price_schedules WHERE id=$1 FOR UPDATE',[id]))[0];
   const status=action==='approve'?'approved':action==='reject'?'rejected':'cancelled';if(row.status===status)return row;
   if(!['pending','approved'].includes(row.status)||action!=='cancel'&&row.status!=='pending')throw fail('Only pending/approved schedules can be cancelled; active prices end at the scheduled time.');
   if(action==='approve'&&(!inv.ready||clock()>=new Date(row.starts_at).getTime()||!same(snapshot(inv.p,inv.variants),row.baseline)))throw fail('Product prices/approval changed or start time passed. Reject and create a new schedule.');
   return (await c.query('UPDATE cerood_shop_price_schedules SET status=$1,note=$2,reviewed_at=now(),finished_at=CASE WHEN $1 IN (\'cancelled\',\'rejected\') THEN now() ELSE NULL END WHERE id=$3 RETURNING *',[status,note||null,id]))[0];
  });
 }
 async function process(id,now=clock()){
  const link=(await q('SELECT * FROM cerood_shop_price_schedules WHERE id=$1',[id]))[0];if(!link)return;
  return transaction(db,async c=>{
   let inv;try{inv=await inventory(c,link.product_id,link.seller_id);}catch(e){if(e.status!==404)throw e;}
   const r=(await c.query('SELECT * FROM cerood_shop_price_schedules WHERE id=$1 FOR UPDATE',[id]))[0];
   if(!['approved','active'].includes(r.status))return;
   const ending=r.status==='active'&&now>=new Date(r.ends_at).getTime(),starting=r.status==='approved'&&now>=new Date(r.starts_at).getTime();if(!ending&&!starting)return;
   if(starting&&now>=new Date(r.ends_at).getTime())return (await c.query("UPDATE cerood_shop_price_schedules SET status='cancelled',note='Approved window elapsed before activation',finished_at=now() WHERE id=$1 RETURNING *",[id]))[0];
   if(!inv||starting&&!inv.ready||!same(snapshot(inv.p,inv.variants),ending?r.discounted:r.baseline))return (await c.query("UPDATE cerood_shop_price_schedules SET status='conflict',note='Current product price/options or approval require reconciliation; no price overwritten',finished_at=now() WHERE id=$1 RETURNING *",[id]))[0];
   await writePrices(c,ending?r.baseline:r.discounted);
   return (await c.query("UPDATE cerood_shop_price_schedules SET status=$1,applied_at=COALESCE(applied_at,now()),finished_at=CASE WHEN $1='completed' THEN now() ELSE NULL END WHERE id=$2 RETURNING *",[ending?'completed':'active',id]))[0];
  });
 }
 let running=false;async function tick(){if(running)return;running=true;try{const rows=await q("SELECT id FROM cerood_shop_price_schedules WHERE (status='approved' AND starts_at<=now()) OR (status='active' AND ends_at<=now()) ORDER BY starts_at LIMIT 30");for(const r of rows)try{await process(r.id)}catch(e){console.error('Price schedule held for retry:',e.message)}}finally{running=false}}
 return {q,create,change,process,tick};
}
function register(app,db,sellerAuth,adminAuth){const s=createService(db);const handle=fn=>async(req,res)=>{res.set('Cache-Control','no-store');try{await fn(req,res)}catch(e){res.status(e.status||503).json({success:false,message:e.status?e.message:'Price schedules unavailable. Check migration 013 and retry.'})}};
 app.get('/api/sellers/shop/price-schedules',sellerAuth,handle(async(req,res)=>res.json({success:true,schedules:await s.q('SELECT x.*,p.name FROM cerood_shop_price_schedules x JOIN cerood_shop_products p ON p.id=x.product_id WHERE x.seller_id=$1 ORDER BY x.created_at DESC LIMIT 200',[req.seller.id])})));
 app.post('/api/sellers/shop/price-schedules',sellerAuth,handle(async(req,res)=>res.status(201).json({success:true,schedule:await s.create(req.seller.id,req.body)})));
 app.post('/api/sellers/shop/price-schedules/:id/cancel',sellerAuth,handle(async(req,res)=>res.json({success:true,schedule:await s.change(req.params.id,req.seller.id,'cancel')})));
 app.get('/api/admin/shop/price-schedules',adminAuth,handle(async(req,res)=>res.json({success:true,schedules:await s.q('SELECT x.*,p.name FROM cerood_shop_price_schedules x JOIN cerood_shop_products p ON p.id=x.product_id ORDER BY x.created_at DESC LIMIT 300')})));
 app.post('/api/admin/shop/price-schedules/:id/review',adminAuth,handle(async(req,res)=>res.json({success:true,schedule:await s.change(req.params.id,null,req.body.action,req.body.note)})));
 return s;
}
module.exports={register,createService,validate,snapshot};
