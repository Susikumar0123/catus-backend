'use strict';
// Cerood Notify: mount AFTER requireAdminAuth is declared; tables created using notify-schema.sql.
module.exports = function mountCeroodNotify(app, db, requireAdminAuth) {
  const webpush = require('web-push');
  const crypto = require('crypto');
  const origin = 'https://cerood.com';
  const configured = Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY && process.env.VAPID_SUBJECT);
  if (configured) webpush.setVapidDetails(process.env.VAPID_SUBJECT, process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
  const query = (sql, params=[]) => new Promise((resolve,reject)=>db.query(sql,params,(e,rows)=>e?reject(e):resolve(rows)));
  const fail = (res,e) => {console.error('Cerood Notify:',e.message);return res.status(500).json({success:false,message:'Notification service unavailable. Check server configuration and database migration.'});};
  const tokenHash = t => crypto.createHash('sha256').update(t).digest('hex');
  const validUrl = value => {try{const u=new URL(value,origin);return u.protocol==='https:'&&['cerood.com','www.cerood.com'].includes(u.hostname)?u.href:null;}catch{return null;}};
  const validImage = value => {try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&u.href.length<=2048?u.href:null;}catch{return null;}};
  const validSub = s => s && typeof s.endpoint==='string' && s.endpoint.startsWith('https://') && s.endpoint.length<2048 && s.keys && typeof s.keys.p256dh==='string' && typeof s.keys.auth==='string' && s.keys.p256dh.length<500 && s.keys.auth.length<200;
  const division = x => ['all','services','renewed','beauty','fashion'].includes(x)?x:'all';
  app.get('/api/notify/config',(req,res)=>res.json({success:true,enabled:configured,publicKey:configured?process.env.VAPID_PUBLIC_KEY:null}));
  app.post('/api/notify/subscribe',async(req,res)=>{try{
    if(!configured)return res.status(503).json({success:false,message:'Push not configured.'});
    const s=req.body?.subscription, d=division(req.body?.division);
    if(!validSub(s))return res.status(400).json({success:false,message:'Invalid push subscription.'});
    const secret=crypto.randomBytes(32).toString('base64url');
    await query(`INSERT INTO public.cerood_push_subscriptions(endpoint,p256dh,auth,division,manage_token_hash,active,updated_at) VALUES (?,?,?,?,?,true,NOW()) ON CONFLICT (endpoint) DO UPDATE SET p256dh=EXCLUDED.p256dh,auth=EXCLUDED.auth,division=EXCLUDED.division,manage_token_hash=EXCLUDED.manage_token_hash,active=true,updated_at=NOW()`,[s.endpoint,s.keys.p256dh,s.keys.auth,d,tokenHash(secret)]);
    return res.json({success:true,manageToken:secret});
  }catch(e){return fail(res,e)}});
  app.post('/api/notify/unsubscribe',async(req,res)=>{try{
    const endpoint=String(req.body?.endpoint||''), secret=String(req.body?.manageToken||'');
    if(!endpoint||secret.length<32)return res.status(400).json({success:false,message:'Invalid unsubscribe request.'});
    await query('UPDATE public.cerood_push_subscriptions SET active=false,updated_at=NOW() WHERE endpoint=? AND manage_token_hash=?',[endpoint,tokenHash(secret)]);
    res.json({success:true});
  }catch(e){return fail(res,e)}});
  // A test may target only the endpoint whose subscription-management token is supplied.
  // No customer login needed; never accepts a caller-provided notification or broadcast audience.
  const testTimes = new Map();
  const pushHostAllowed = endpoint => {try {
    const u = new URL(endpoint);
    return u.protocol === 'https:' && !u.username && !u.password && (!u.port || u.port === '443') &&
      (u.hostname === 'fcm.googleapis.com' || u.hostname === 'updates.push.services.mozilla.com' ||
       u.hostname === 'web.push.apple.com' || u.hostname === 'notify.windows.com' || u.hostname.endsWith('.notify.windows.com'));
  } catch (_) {return false;}};
  function pushFailure(error) {
    const status = Number(error.statusCode) || null;
    const reason = [404,410].includes(status) ? 'expired_subscription' : [401,403].includes(status) ? 'push_authentication_failed' : status === 429 ? 'push_service_rate_limited' : !status ? 'network_or_send_error' : 'push_service_rejected';
    return {status,reason};
  }
  app.post('/api/notify/test-device',async(req,res)=>{try {
    res.set('Cache-Control','no-store');
    if(!configured)return res.status(503).json({success:false,message:'Push is not configured.'});
    const endpoint = String(req.body?.endpoint || ''), secret = String(req.body?.manageToken || '');
    if(!pushHostAllowed(endpoint) || endpoint.length > 2048 || !/^[A-Za-z0-9_-]{43}$/.test(secret))return res.status(400).json({success:false,message:'A supported browser push subscription and its management token are required.'});
    const rows = await query('SELECT endpoint,p256dh,auth FROM public.cerood_push_subscriptions WHERE endpoint=? AND manage_token_hash=? AND active=true LIMIT 1',[endpoint,tokenHash(secret)]);
    if(!rows.length)return res.status(403).json({success:false,message:'This browser subscription is not active or its management token changed. Reconnect this device first.'});
    const rateKey=tokenHash(endpoint),now=Date.now();
    if(now-(testTimes.get(rateKey)||0)<60000)return res.status(429).json({success:false,message:'Wait one minute before testing this device again.'});
    if(testTimes.size>=2000)testTimes.delete(testTimes.keys().next().value);
    testTimes.set(rateKey,now);
    const t=rows[0],testId=crypto.randomBytes(8).toString('hex');
    try {
      const sent=await webpush.sendNotification({endpoint:t.endpoint,keys:{p256dh:t.p256dh,auth:t.auth}},JSON.stringify({title:'Cerood device test',body:'Push reached this browser. Test '+testId,url:'https://www.cerood.com/push-check.html',tag:'cerood-device-test-'+testId}),{TTL:300,urgency:'high',timeout:15000});
      res.json({success:true,accepted:true,pushStatus:Number(sent?.statusCode)||null,testId,message:'Push service accepted the test for this subscription only. This does not confirm device display.'});
    } catch(error) {
      const info=pushFailure(error);
      if([404,410].includes(info.status))await query('UPDATE public.cerood_push_subscriptions SET active=false,updated_at=NOW() WHERE endpoint=?',[endpoint]);
      res.status(502).json({success:false,...info,message:'Device test failed: '+info.reason+'. Reconnect if the subscription expired; authentication failures require checking the server VAPID configuration.'});
    }
  }catch(e){return fail(res,e)}});
  app.get('/api/admin/notify/stats',requireAdminAuth,async(req,res)=>{try{
    const rows=await query('SELECT division,COUNT(*)::int AS total FROM public.cerood_push_subscriptions WHERE active=true GROUP BY division');
    const campaigns=await query('SELECT id,division,title,delivered,failed,created_at FROM public.cerood_push_campaigns ORDER BY id DESC LIMIT 12');
    res.json({success:true,subscribers:rows,campaigns});
  }catch(e){return fail(res,e)}});
  app.post('/api/admin/notify/send',requireAdminAuth,async(req,res)=>{try{
    if(!configured)return res.status(503).json({success:false,message:'Configure VAPID keys on Render first.'});
    const title=String(req.body?.title||'').trim(),body=String(req.body?.body||'').trim(),d=division(req.body?.division),url=validUrl(req.body?.url);
    if(!title||title.length>75||!body||body.length>180||!url||!['all','services','renewed','beauty','fashion'].includes(req.body?.division))return res.status(400).json({success:false,message:'Title (1–75), message (1–180), division and cerood.com HTTPS link required.'});
    const imageInput=String(req.body?.image||'').trim(),image=imageInput?validImage(imageInput):null;
    const actionTitle=String(req.body?.actionTitle||'View details').trim();
    if((imageInput&&!image)||!actionTitle||actionTitle.length>30)return res.status(400).json({success:false,message:'Use an HTTPS banner image URL (max 2048 characters) and button text (1–30 characters).'});
    const targets=await query(`SELECT endpoint,p256dh,auth FROM public.cerood_push_subscriptions WHERE active=true AND (?='all' OR division=? OR division='all') ORDER BY updated_at DESC LIMIT 501`,[d,d]);
    if(targets.length>500)return res.status(409).json({success:false,message:'Campaign exceeds 500 subscribers. Batch delivery not enabled yet.'});
    const result=await query('INSERT INTO public.cerood_push_campaigns(division,title,body,url,delivered,failed) VALUES (?,?,?,?,0,0) RETURNING id',[d,title,body,url]);
    const campaignId=result[0].id;let delivered=0,failed=0;const failureSummary={};
    for(const t of targets){try{
      await webpush.sendNotification({endpoint:t.endpoint,keys:{p256dh:t.p256dh,auth:t.auth}},JSON.stringify({title,body,url,...(image?{image}:{}),actions:[{action:'open',title:actionTitle}],tag:'cerood-campaign-'+campaignId}),{TTL:86400,urgency:'high'});
      delivered++;
    }catch(e){failed++;const info=pushFailure(e);failureSummary[info.reason]=(failureSummary[info.reason]||0)+1;if([404,410].includes(e.statusCode))await query('UPDATE public.cerood_push_subscriptions SET active=false WHERE endpoint=?',[t.endpoint]);}}
    await query('UPDATE public.cerood_push_campaigns SET delivered=?,failed=? WHERE id=?',[delivered,failed,campaignId]);
    res.json({success:true,campaignId,accepted:delivered,failed,failureSummary,note:'Accepted by push service; device display is not guaranteed.'});
  }catch(e){return fail(res,e)}});
};
