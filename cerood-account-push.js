'use strict';
// Account-scoped push. Never uses the marketing/broadcast subscriber audience.
const crypto=require('node:crypto');
const fail=(message,status=400)=>Object.assign(Error(message),{status});
const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
function endpointAllowed(value){try{const u=new URL(value);return value.length<=2048&&u.protocol==='https:'&&!u.username&&!u.password&&(!u.port||u.port==='443')&&['fcm.googleapis.com','updates.push.services.mozilla.com','web.push.apple.com','notify.windows.com'].some(h=>u.hostname===h||(h==='notify.windows.com'&&u.hostname.endsWith('.'+h)));}catch{return false}}
function subscription(value){if(!value||!endpointAllowed(value.endpoint)||!/^[-_A-Za-z0-9]{87}$/.test(value.keys?.p256dh||'')||!/^[-_A-Za-z0-9]{22}$/.test(value.keys?.auth||''))throw fail('A valid browser push subscription is required.');return value;}
function verifyBridge(body,signature,secret,now=Date.now()){
 if(typeof secret!=='string'||secret.length<32)throw fail('Local push bridge is not configured.',503);
 if(!body||!Number.isSafeInteger(body.timestamp)||Math.abs(now-body.timestamp)>60000||!/^[-_A-Za-z0-9]{20,100}$/.test(body.nonce||''))throw fail('Expired bridge request.',403);
 const expected=crypto.createHmac('sha256',secret).update(JSON.stringify(body)).digest('hex');
 if(!/^[a-f0-9]{64}$/.test(signature||'')||!crypto.timingSafeEqual(Buffer.from(expected),Buffer.from(signature)))throw fail('Invalid bridge signature.',403);
 if(!/^render-local:[a-zA-Z0-9_-]{1,100}$/.test(body.recipient||''))throw fail('Verified Local mobile identity required.',403);
 return body.recipient;
}
const SCHEMA=`CREATE TABLE IF NOT EXISTS cerood_account_push_devices (
 scope text NOT NULL CHECK(scope IN ('shop','local')), endpoint text NOT NULL, recipient text NOT NULL,
 p256dh text NOT NULL, auth text NOT NULL, manage_hash text NOT NULL, binding text NOT NULL,
 expires_at timestamptz NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(scope,endpoint));
CREATE INDEX IF NOT EXISTS cerood_account_push_recipient ON cerood_account_push_devices(scope,recipient,expires_at);
CREATE TABLE IF NOT EXISTS cerood_account_push_events (
 id uuid PRIMARY KEY,scope text NOT NULL,recipient text NOT NULL,event_key text NOT NULL,
 title text NOT NULL,body text NOT NULL,url text NOT NULL,state text NOT NULL DEFAULT 'pending',
 accepted integer NOT NULL DEFAULT 0,failed integer NOT NULL DEFAULT 0,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(scope,event_key));
CREATE TABLE IF NOT EXISTS cerood_account_push_snapshot (
 recipient text PRIMARY KEY, records jsonb NOT NULL DEFAULT '{}'::jsonb,updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS cerood_account_push_nonces (nonce text PRIMARY KEY,created_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE cerood_account_push_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE cerood_account_push_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE cerood_account_push_snapshot ENABLE ROW LEVEL SECURITY;
ALTER TABLE cerood_account_push_nonces ENABLE ROW LEVEL SECURITY;`;
function createService(db,webpush){
 const q=(sql,args=[])=>new Promise((resolve,reject)=>db.query(sql,args,(e,r)=>e?reject(e):resolve(r||[])));
 const configured=()=>Boolean(process.env.VAPID_PUBLIC_KEY&&process.env.VAPID_PRIVATE_KEY&&process.env.VAPID_SUBJECT);
 let schema,busy=false;
 function ensure(){return schema||=(q(SCHEMA).catch(e=>{schema=null;throw e}));}
 async function transaction(fn){const c=await db.getClient();let done=false;try{await c.query('BEGIN');const d=await fn(c);await c.query('COMMIT');done=true;return d}finally{try{if(!done)await c.query('ROLLBACK')}finally{c.release()}}}
 function config(){return {enabled:configured()&&process.env.CEROOD_ACCOUNT_PUSH_ENABLED==='true',publicKey:configured()?process.env.VAPID_PUBLIC_KEY:null};}
 async function bind(scope,recipient,body,expiry){
  if(!config().enabled)throw fail('Account push is not enabled.',503);await ensure();const s=subscription(body.subscription),proof=String(body.manageToken||'');
  if(!Number.isFinite(expiry)||expiry<=Date.now())throw fail('Sign in again.',401);
  const result=await transaction(async c=>{
   // Serialize first-bind races as well as account changes for this endpoint.
   await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[scope+':'+s.endpoint]);
   const old=(await c.query('SELECT * FROM cerood_account_push_devices WHERE scope=$1 AND endpoint=$2 FOR UPDATE',[scope,s.endpoint]))[0];
   if(old&&old.manage_hash!==hash(proof))throw fail('Reconnect this browser subscription before changing accounts.',403);
   const same=old?.recipient===recipient,token=same?proof:crypto.randomBytes(32).toString('base64url'),binding=same?old.binding:crypto.randomUUID();
   const count=(await c.query('SELECT count(*)::int AS n FROM cerood_account_push_devices WHERE scope=$1 AND recipient=$2 AND expires_at>now()',[scope,recipient]))[0];
   if(!old&&Number(count?.n)>=10)throw fail('Ten devices are already connected. Disconnect one first.',409);
   await c.query(`INSERT INTO cerood_account_push_devices(scope,endpoint,recipient,p256dh,auth,manage_hash,binding,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(scope,endpoint) DO UPDATE SET recipient=$3,p256dh=$4,auth=$5,manage_hash=$6,binding=$7,expires_at=$8,updated_at=now()`,[scope,s.endpoint,recipient,s.keys.p256dh,s.keys.auth,hash(token),binding,new Date(Math.min(expiry,Date.now()+7*86400000)).toISOString()]);
   return {manageToken:token,binding,expiresAt:new Date(Math.min(expiry,Date.now()+7*86400000)).toISOString()};
  });
  if(scope==='shop')await pollShop(recipient);
  return result;
 }
 async function unlink(scope,body){await ensure();const endpoint=String(body.endpoint||''),token=String(body.manageToken||'');if(!endpointAllowed(endpoint)||!/^[-_A-Za-z0-9]{43}$/.test(token))throw fail('Browser management proof required.');await q('DELETE FROM cerood_account_push_devices WHERE scope=$1 AND endpoint=$2 AND manage_hash=$3',[scope,endpoint,hash(token)]);return {disconnected:true};}
 async function event(scope,recipient,key,title,body,url){
  await ensure();const id=crypto.randomUUID();const rows=await q(`INSERT INTO cerood_account_push_events(id,scope,recipient,event_key,title,body,url) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(scope,event_key) DO NOTHING RETURNING id`,[id,scope,recipient,key,title,body,url]);
  if(rows.length)await deliver(id);return {recorded:true};
 }
 async function deliver(id){
  if(!config().enabled)return;
  // A durable claim prevents parallel workers/relay retries from sending twice.
  const e=(await q("UPDATE cerood_account_push_events SET state='sending' WHERE id=$1 AND state='pending' RETURNING *",[id]))[0];if(!e)return;
  const targets=await q('SELECT * FROM cerood_account_push_devices WHERE scope=$1 AND recipient=$2 AND expires_at>now() ORDER BY updated_at DESC LIMIT 10',[e.scope,e.recipient]);let accepted=0,failed=0;
  for(const t of targets){if(!endpointAllowed(t.endpoint)){failed++;continue}try{
   await webpush.sendNotification({endpoint:t.endpoint,keys:{p256dh:t.p256dh,auth:t.auth}},JSON.stringify({title:e.title,body:e.body,url:e.url,tag:'cerood-account-'+e.id,binding:t.binding,receipt:e.id,scope:e.scope}),{TTL:3600,urgency:'high',timeout:10000});accepted++;
  }catch(error){failed++;if([404,410].includes(Number(error.statusCode)))await q('DELETE FROM cerood_account_push_devices WHERE scope=$1 AND endpoint=$2 AND binding=$3',[e.scope,t.endpoint,t.binding]);}}
  await q('UPDATE cerood_account_push_events SET state=$1,accepted=$2,failed=$3 WHERE id=$4',[accepted?'accepted':targets.length?'failed':'no_device',accepted,failed,id]);
 }
 async function test(scope,recipient,body){await ensure();const d=(await q('SELECT binding FROM cerood_account_push_devices WHERE scope=$1 AND recipient=$2 AND endpoint=$3 AND manage_hash=$4 AND expires_at>now()',[scope,recipient,body.endpoint,hash(String(body.manageToken||''))]))[0];if(!d)throw fail('Connect this signed-in account on this device first.',403);
  const recent=(await q("SELECT id FROM cerood_account_push_events WHERE scope=$1 AND recipient=$2 AND event_key LIKE 'test:%' AND created_at>now()-interval '1 minute'",[scope,recipient]));if(recent.length)throw fail('Wait one minute before sending another test.',429);
  // Limit the test to the verified device, rather than all this account's devices.
  const t=(await q('SELECT * FROM cerood_account_push_devices WHERE scope=$1 AND endpoint=$2 AND binding=$3',[scope,body.endpoint,d.binding]))[0];
  if(!config().enabled)throw fail('Account push is not enabled.',503);
  const id=crypto.randomUUID();await q("INSERT INTO cerood_account_push_events(id,scope,recipient,event_key,title,body,url,state) VALUES($1,$2,$3,$4,'Cerood device test','Test notification','/','sending')",[id,scope,recipient,'test:'+id]);
  try{await webpush.sendNotification({endpoint:t.endpoint,keys:{p256dh:t.p256dh,auth:t.auth}},JSON.stringify({title:'Cerood device test',body:'This test reached your signed-in browser.',url:scope==='shop'?'/cerood-orders.html':'/local/',tag:'cerood-account-'+id,binding:t.binding,receipt:id,scope}),{TTL:300,urgency:'high',timeout:10000});await q("UPDATE cerood_account_push_events SET state='accepted',accepted=1 WHERE id=$1",[id]);return {accepted:true,receipt:id,message:'Accepted by the push provider. Device display is not yet confirmed.'};}catch{await q("UPDATE cerood_account_push_events SET state='failed',failed=1 WHERE id=$1",[id]);throw fail('Push provider rejected the test. Check VAPID configuration or reconnect this device.',502)}
 }
 async function shopSnapshot(c,recipient){
  const orders=await c.query(`SELECT id,status,payment_status,cancellation_refund_state FROM cerood_shop_orders WHERE customer_id=$1 ORDER BY created_at DESC LIMIT 200`,[recipient]);
  const returns=await c.query(`SELECT r.id,r.status,r.online_refund_state FROM cerood_shop_return_requests r WHERE r.customer_id=$1 ORDER BY r.created_at DESC LIMIT 200`,[recipient]);
  const records={};for(const o of orders)records['order:'+o.id]=JSON.stringify([o.status,o.payment_status,o.cancellation_refund_state]);for(const r of returns)records['return:'+r.id]=JSON.stringify([r.status,r.online_refund_state]);return records;
 }
 async function pollShop(recipient){await transaction(async c=>{
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['push-shop:'+recipient]);const old=(await c.query('SELECT records FROM cerood_account_push_snapshot WHERE recipient=$1 FOR UPDATE',[recipient]))[0],records=await shopSnapshot(c,recipient);
  if(old){for(const [key,value] of Object.entries(records)){if(old.records[key]===value)continue;const id=crypto.randomUUID();await c.query(`INSERT INTO cerood_account_push_events(id,scope,recipient,event_key,title,body,url) VALUES($1,'shop',$2,$3,$4,$5,'/cerood-orders.html')`,[id,recipient,'shop:'+id,key.startsWith('order:')?'Order update':'Return or refund update','Your '+(key.startsWith('order:')?'order':'return')+' status changed. Open My orders for details.']);}}
  await c.query(`INSERT INTO cerood_account_push_snapshot(recipient,records) VALUES($1,$2::jsonb) ON CONFLICT(recipient) DO UPDATE SET records=$2::jsonb,updated_at=now()`,[recipient,JSON.stringify(records)]);
 });}
 async function tick(){if(busy||!config().enabled)return;busy=true;try{await ensure();const recipients=await q("SELECT d.recipient FROM cerood_account_push_devices d LEFT JOIN cerood_account_push_snapshot s ON s.recipient=d.recipient WHERE d.scope='shop' AND d.expires_at>now() GROUP BY d.recipient,s.updated_at ORDER BY s.updated_at NULLS FIRST LIMIT 100");for(const r of recipients)await pollShop(r.recipient);const pending=await q("SELECT id FROM cerood_account_push_events WHERE state='pending' ORDER BY created_at LIMIT 50");for(const e of pending)await deliver(e.id);await q("DELETE FROM cerood_account_push_nonces WHERE created_at<now()-interval '5 minutes'");}finally{busy=false}}
 async function bridge(body,signature){const recipient=verifyBridge(body,signature,process.env.LOCAL_PUSH_BRIDGE_SECRET);await ensure();const fresh=await q('INSERT INTO cerood_account_push_nonces(nonce) VALUES($1) ON CONFLICT DO NOTHING RETURNING nonce',[body.nonce]);if(!fresh.length)throw fail('Bridge replay rejected.',409);
  if(body.action==='config')return config();
  if(body.action==='subscribe')return bind('local',recipient,body.data,Date.now()+86400000*7);
  if(body.action==='unlink')return unlink('local',body.data);
  if(body.action==='test')return test('local',recipient,body.data);
  if(body.action==='event'){if(!/^[a-zA-Z0-9_-]{10,100}$/.test(body.data?.id||''))throw fail('Invalid notification identifier.');return event('local',recipient,'local:'+body.data.id,'Cerood Local update','You have a new business or enquiry update. Open Cerood Local for details.','/local/');}
  throw fail('Invalid bridge action.');
 }
 return {config,bind,unlink,test,event,tick,bridge,ensure,q};
}
function register(app,db,customer,admin,options={}){
 const webpush=options.webpush||require('web-push');if(process.env.VAPID_PUBLIC_KEY&&process.env.VAPID_PRIVATE_KEY&&process.env.VAPID_SUBJECT)webpush.setVapidDetails(process.env.VAPID_SUBJECT,process.env.VAPID_PUBLIC_KEY,process.env.VAPID_PRIVATE_KEY);
 const s=createService(db,webpush),route=fn=>async(req,res)=>{res.set('Cache-Control','no-store');try{res.json({success:true,...await fn(req)})}catch(e){res.status(e.status||503).json({success:false,message:e.status?e.message:'Account push unavailable. Check backend configuration.'})}};
 app.get('/api/shop/push/config',route(()=>s.config()));
 app.post('/api/shop/push/subscribe',customer,route(req=>{const p=JSON.parse(Buffer.from(req.headers.authorization.slice(7).split('.')[1],'base64url'));return s.bind('shop',String(req.ceroodCustomerId),req.body,Number(p.exp)*1000)}));
 app.post('/api/shop/push/unlink',route(req=>s.unlink('shop',req.body)));
 app.post('/api/shop/push/test',customer,route(req=>s.test('shop',String(req.ceroodCustomerId),req.body)));
 app.post('/api/local/push/bridge',route(req=>s.bridge(req.body,req.get('x-cerood-push-signature'))));
 app.get('/api/admin/shop/push-status',admin,route(async()=>{await s.ensure();return {config:s.config(),events:await s.q('SELECT id,scope,state,accepted,failed,created_at FROM cerood_account_push_events ORDER BY created_at DESC LIMIT 100')}}));
 if(!options.noWorker){const timer=setInterval(()=>s.tick().catch(()=>console.warn('Account push worker unavailable; inspect configuration.')),60000);timer.unref?.();}
 return s;
}
module.exports={register,createService,verifyBridge,endpointAllowed,subscription,SCHEMA};
