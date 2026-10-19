'use strict';
// Mobile-web Truecaller verification. Existing Home Service auth owns sessions.
const crypto = require('crypto');
module.exports = function mountTruecaller(app, h) {
 const {query,ensureSchema,sessionSecret,createSession,publicCustomer,bcrypt}=h;
 const profileEndpoint='https://profile4-noneu.truecaller.com/v1/default';
 const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
 const enabled=()=>Boolean(process.env.TRUECALLER_APP_KEY);
 const allowedOrigin=req=>['https://cerood.com','https://www.cerood.com'].includes(req.get('Origin'));
 const wrap=fn=>async(req,res)=>{res.set('Cache-Control','no-store');try{await fn(req,res)}catch(e){console.error('Truecaller flow:',e.code||e.name);res.status(e.status||503).json({success:false,message:e.status===400?e.message:'Truecaller login unavailable. Please use existing login.'});}};
 const bad=(message,status=400)=>{throw Object.assign(new Error(message),{status})};
 let schema;
 function prepare(){if(!schema)schema=query(`CREATE TABLE IF NOT EXISTS public.cerood_truecaller_requests (
 request_id TEXT PRIMARY KEY, verifier_hash TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
 token_box TEXT, expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW()+INTERVAL '5 minutes'), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`).catch(e=>{schema=null;throw e});return schema;}
 const key=()=>crypto.createHash('sha256').update('cerood-truecaller-v1:'+sessionSecret()).digest();
 function seal(token){const iv=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',key(),iv);const data=Buffer.concat([c.update(token,'utf8'),c.final()]);return Buffer.concat([iv,c.getAuthTag(),data]).toString('base64');}
 function unseal(box){const b=Buffer.from(box,'base64'),d=crypto.createDecipheriv('aes-256-gcm',key(),b.subarray(0,12));d.setAuthTag(b.subarray(12,28));return Buffer.concat([d.update(b.subarray(28)),d.final()]).toString('utf8');}
 const limits=new Map();
 function limit(req,res){const now=Date.now(),id=hash(String(req.ip||req.socket?.remoteAddress||'unknown'));for(const [k,v] of limits)if(v.until<now)limits.delete(k);let v=limits.get(id);if(!v){if(limits.size>=10000){res.status(429).json({success:false,message:'Please try later.'});return false;}v={n:0,until:now+600000};limits.set(id,v);}if(++v.n>10){res.status(429).json({success:false,message:'Too many attempts. Try again later.'});return false;}return true;}
 app.get('/api/auth/truecaller/config',wrap(async(req,res)=>res.json({success:true,enabled:enabled(),appKey:enabled()?process.env.TRUECALLER_APP_KEY:null,appName:'Cerood'})));
 // Optional GET health endpoint for portal setup; this does not verify a customer.
 app.get('/api/auth/truecaller/callback',wrap(async(req,res)=>res.json({success:true,callback:'ready',verificationEnabled:enabled()})));
 app.post('/api/auth/truecaller/start',wrap(async(req,res)=>{
  if(!allowedOrigin(req))return res.status(403).json({success:false,message:'Unsupported website origin.'});
  if(!enabled())return res.status(503).json({success:false,message:'Truecaller app key is not configured.'});
  if(!limit(req,res))return;sessionSecret();await prepare();
  await query('DELETE FROM public.cerood_truecaller_requests WHERE expires_at<NOW()');
  const requestId=crypto.randomBytes(32).toString('base64url'),verifier=crypto.randomBytes(32).toString('base64url');
  await query('INSERT INTO public.cerood_truecaller_requests(request_id,verifier_hash) VALUES (?,?)',[requestId,hash(verifier)]);
  res.json({success:true,requestId,verifier,expiresIn:300});
 }));
 app.post('/api/auth/truecaller/callback',wrap(async(req,res)=>{
  if(!enabled())return res.status(503).json({success:false,message:'Truecaller is not configured.'});
  const id=String(req.body?.requestId||'');if(!/^[A-Za-z0-9_-]{43}$/.test(id))bad('Invalid request ID.');
  await prepare();
  // Truecaller handshake has no access token. Acknowledge without completing login.
  if(req.body?.status==='flow_invoked')return res.json({success:true});
  if(req.body?.status==='user_rejected'){
   await query("UPDATE public.cerood_truecaller_requests SET status='rejected',token_box=NULL WHERE request_id=? AND status='pending' AND expires_at>NOW()",[id]);return res.json({success:true});
  }
  const token=String(req.body?.accessToken||'');
  // Never fetch arbitrary callback endpoints: reject unknown URLs, including redirects.
  if(req.body?.endpoint!==profileEndpoint||!token||token.length>2048||/[\r\n]/.test(token))bad('Invalid Truecaller callback.');
  await query("UPDATE public.cerood_truecaller_requests SET status='ready',token_box=? WHERE request_id=? AND status='pending' AND expires_at>NOW()",[seal(token),id]);
  // No profile API call here: acknowledge callback promptly, verify during completion.
  res.json({success:true});
 }));
 app.post('/api/auth/truecaller/complete',wrap(async(req,res)=>{
  if(!allowedOrigin(req))return res.status(403).json({success:false,message:'Unsupported website origin.'});
  if(!enabled())return res.status(503).json({success:false,message:'Truecaller is not configured.'});
  const id=String(req.body?.requestId||''),verifier=String(req.body?.verifier||'');
  if(!/^[A-Za-z0-9_-]{43}$/.test(id)||!/^[A-Za-z0-9_-]{43}$/.test(verifier))bad('Invalid verification request.');
  sessionSecret();await prepare();
  const rows=await query('SELECT status FROM public.cerood_truecaller_requests WHERE request_id=? AND verifier_hash=? AND expires_at>NOW()',[id,hash(verifier)]);
  if(!rows.length)return res.status(410).json({success:false,message:'Verification expired or unavailable. Start again.'});
  if(rows[0].status==='pending')return res.json({success:true,status:'pending'});
  if(rows[0].status==='rejected')return res.json({success:true,status:'rejected'});
  const claimed=await query("DELETE FROM public.cerood_truecaller_requests WHERE request_id=? AND verifier_hash=? AND status='ready' AND expires_at>NOW() RETURNING token_box",[id,hash(verifier)]);
  // Atomic consumption prevents replay and concurrent session redemption.
  if(!claimed.length)return res.status(409).json({success:false,message:'Request already used. Start again.'});
  const token=unseal(claimed[0].token_box);
  const response=await fetch(profileEndpoint,{headers:{Authorization:'Bearer '+token,'Cache-Control':'no-cache'},redirect:'error',signal:AbortSignal.timeout(8000)});
  if(!response.ok)bad('Profile verification failed.',401);
  const profile=await response.json();
  const phones=Array.isArray(profile.phoneNumbers)?profile.phoneNumbers:[];
  const match=phones.map(x=>String(x).replace(/^\+/, '')).find(x=>/^91[6-9]\d{9}$/.test(x));
  if(!match)bad('A verified Indian mobile number is required.',401);
  const phone=match.slice(2),name=[profile.name?.first,profile.name?.last].filter(x=>typeof x==='string').join(' ').replace(/[\u0000-\u001f\u007f]/g,' ').trim().slice(0,160)||'Cerood customer';
  await ensureSchema();
  const password=await bcrypt.hash(crypto.randomBytes(32).toString('base64url'),12);
  // Existing accounts/passwords are preserved. New users can set a password using OTP reset.
  const customers=await query(`INSERT INTO public.cerood_home_service_customers(id,name,phone,password,address)
   VALUES (?,?,?,?,'No address saved') ON CONFLICT(phone) DO UPDATE SET phone=EXCLUDED.phone RETURNING *`,[crypto.randomUUID(),name,phone,password]);
  const user=customers[0],session=createSession(user);
  res.json({success:true,status:'verified',user:publicCustomer(user),home_service_session:session,session});
 }));
};
