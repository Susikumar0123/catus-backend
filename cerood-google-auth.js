'use strict';
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
module.exports = function(app, {query, ensureSchema, sessionSecret, createSession, publicCustomer, requireHomeAuth}) {
 const clientId = String(process.env.GOOGLE_CLIENT_ID || '').trim();
 const origins = new Set(['https://cerood.com', 'https://www.cerood.com']);
 let schema;
 const ready = () => schema || (schema = ensureSchema().then(() => query(`CREATE TABLE IF NOT EXISTS public.cerood_home_google_identities (google_sub VARCHAR(255) PRIMARY KEY, customer_id UUID NOT NULL UNIQUE REFERENCES public.cerood_home_service_customers(id) ON DELETE CASCADE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`)).catch(e => {schema=null;throw e;}));
 function origin(req,res,next) {res.set('Cache-Control','no-store');if(!origins.has(req.get('Origin')))return res.status(403).json({success:false,message:'Open login from Cerood.'});next();}
 function verifier() {if(!clientId)throw Error('Google login is not configured.');const {OAuth2Client}=require('google-auth-library');return new OAuth2Client(clientId);}
 app.get('/api/home-services/auth/google/config', (req,res) => {
  res.set('Cache-Control','no-store');
  try {verifier(); const nonce=crypto.randomBytes(32).toString('hex');const challenge=jwt.sign({nonce,purpose:'google-login'},sessionSecret(),{algorithm:'HS256',expiresIn:'10m',issuer:'cerood-google-challenge'});res.json({success:true,enabled:true,clientId,nonce,challenge});}
  catch(_) {res.json({success:true,enabled:false});}
 });
 async function profile(req) {
  const credential=req.body?.credential, challenge=req.body?.challenge;
  if(typeof credential!=='string'||credential.length>12000||typeof challenge!=='string'||challenge.length>2000)throw Error('Invalid Google login.');
  const state=jwt.verify(challenge,sessionSecret(),{algorithms:['HS256'],issuer:'cerood-google-challenge'});
  if(state.purpose!=='google-login')throw Error('Invalid challenge.');
  const ticket=await verifier().verifyIdToken({idToken:credential,audience:clientId});
  const p=ticket.getPayload();
  if(!p?.sub||p.nonce!==state.nonce||p.email_verified!==true)throw Error('Google identity could not be verified.');
  return p;
 }
 app.post('/api/home-services/auth/google/login', origin, async(req,res)=>{
  try {const p=await profile(req);await ready();const rows=await query(`SELECT c.* FROM public.cerood_home_service_customers c JOIN public.cerood_home_google_identities g ON g.customer_id=c.id WHERE g.google_sub=? LIMIT 1`,[p.sub]);
   if(!rows.length)return res.json({success:true,requires_phone_login:true,name:String(p.name||'').slice(0,160)});
   const session=createSession(rows[0]);res.json({success:true,user:publicCustomer(rows[0]),home_service_session:session,session});
  } catch(_) {res.status(401).json({success:false,message:'Google login failed or expired. Try again, or use mobile login.'});}
 });
 app.post('/api/home-services/auth/google/link', origin, requireHomeAuth, async(req,res)=>{
  try {const p=await profile(req);await ready();
   // Never merge accounts using an email address. Link only to an authenticated Home Service account.
   await query(`INSERT INTO public.cerood_home_google_identities (google_sub,customer_id) VALUES (?,?) ON CONFLICT DO NOTHING`,[p.sub,req.homeServiceCustomer.id]);
   const rows=await query(`SELECT customer_id FROM public.cerood_home_google_identities WHERE google_sub=?`,[p.sub]);
   if(!rows.length||String(rows[0].customer_id)!==String(req.homeServiceCustomer.id))return res.status(409).json({success:false,message:'This Google account or mobile account is already linked. Use mobile login.'});
   res.json({success:true,message:'Google login linked. Next time, continue with Google.'});
  } catch(_) {res.status(401).json({success:false,message:'Could not link Google. Mobile login is still available.'});}
 });
};
