'use strict';
const crypto=require('node:crypto'),bcrypt=require('bcryptjs');
function validBody(body={}){const phone=String(body.phone||'').replace(/\D/g,'').replace(/^91(?=[6-9]\d{9}$)/,'');const password=String(body.password||''),confirm=String(body.confirm_password||''),token=String(body.accessToken||'').trim();if(!/^[6-9]\d{9}$/.test(phone)||password.length<8||Buffer.byteLength(password)>72||password!==confirm||!token||token.length>8192)throw Object.assign(Error('Enter the registered mobile, verified OTP and matching passwords of 8–72 bytes.'),{status:400});return {phone,password,token};}
function register(app,db,verify,extract){
 const query=(sql,args=[])=>new Promise((resolve,reject)=>db.query(sql,args,(err,rows)=>err?reject(err):resolve(rows||[])));
 let schema;const ensure=()=>schema||(schema=query('CREATE TABLE IF NOT EXISTS public.cerood_seller_reset_tokens (token_hash text PRIMARY KEY, seller_id uuid NOT NULL, used_at timestamptz NOT NULL DEFAULT now())').then(()=>query('ALTER TABLE public.cerood_seller_reset_tokens ENABLE ROW LEVEL SECURITY')).catch(e=>{schema=null;throw e;}));
 const limits=new Map();
 app.post('/api/sellers/reset-password',async(req,res)=>{
  res.set('Cache-Control','no-store');
  try{
   const key=String(req.ip||req.socket?.remoteAddress||'unknown'),now=Date.now();
   for(const [k,v]of limits)if(now-v.at>=900000)limits.delete(k);
   const entry=limits.get(key)||{at:now,n:0};if(entry.n>=10||(!limits.has(key)&&limits.size>=5000))return res.status(429).json({success:false,message:'Too many attempts. Please try again in 15 minutes.'});entry.n++;limits.set(key,entry);
   const x=validBody(req.body);let verified;
   try{verified=await verify(x.token);}catch{throw Object.assign(Error('OTP verification failed. Please request a new code.'),{status:401});}
   if(!verified||String(verified.type||'').toLowerCase()!=='success'||extract(verified,'')!==x.phone)throw Object.assign(Error('Verified mobile number does not match. Please request a new OTP.'),{status:401});
   const hash=await bcrypt.hash(x.password,12);await ensure();const client=await db.getClient();let done=false;
   try{
    await client.query('BEGIN');const sellers=await client.query('SELECT id FROM public.cerood_sellers WHERE phone=$1 FOR UPDATE',[x.phone]);
    if(!sellers.length)throw Object.assign(Error('No seller account is available for this verified number. Register your business first.'),{status:404});
    const used=await client.query('INSERT INTO public.cerood_seller_reset_tokens(token_hash,seller_id) VALUES($1,$2) ON CONFLICT(token_hash) DO NOTHING RETURNING token_hash',[crypto.createHash('sha256').update(x.token).digest('hex'),sellers[0].id]);
    if(!used.length)throw Object.assign(Error('This OTP verification has already been used. Request a new OTP.'),{status:409});
    await client.query('UPDATE public.cerood_sellers SET password_hash=$1,updated_at=now() WHERE id=$2',[hash,sellers[0].id]);
    await client.query('COMMIT');done=true;return res.json({success:true,message:'Password updated. Sign in with your new password. Account approval requirements still apply.'});
   }finally{try{if(!done)await client.query('ROLLBACK');}finally{client.release();}}
  }catch(e){return res.status(e.status||503).json({success:false,message:e.status?e.message:'Password reset is temporarily unavailable. Please try again.'});}
 });
}
module.exports={register,validBody};
