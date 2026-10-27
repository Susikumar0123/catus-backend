'use strict';
const assert=require('node:assert/strict'),crypto=require('node:crypto'),P=require('../cerood-account-push');
const secret='bridge-test-secret-with-more-than-32-characters';
const body={recipient:'render-local:abc',action:'test',data:{},timestamp:Date.now(),nonce:crypto.randomUUID()},sign=x=>crypto.createHmac('sha256',secret).update(JSON.stringify(x)).digest('hex');
assert.equal(P.verifyBridge(body,sign(body),secret),body.recipient);assert.throws(()=>P.verifyBridge({...body,recipient:'render-local:other'},sign(body),secret),/signature/);assert.throws(()=>P.verifyBridge(body,sign(body),secret,Date.now()+61000),/Expired/);assert.throws(()=>P.verifyBridge({...body,recipient:'admin'},sign({...body,recipient:'admin'}),secret),/identity/);
assert.equal(P.endpointAllowed('https://fcm.googleapis.com/fcm/send/test'),true);for(const u of ['http://fcm.googleapis.com/x','https://fcm.googleapis.com.evil.test/x','https://user@fcm.googleapis.com/x','https://127.0.0.1/x','https://fcm.googleapis.com:444/x'])assert.equal(P.endpointAllowed(u),false);
process.env.CEROOD_ACCOUNT_PUSH_ENABLED='true';process.env.VAPID_PUBLIC_KEY='public';process.env.VAPID_PRIVATE_KEY='private';process.env.VAPID_SUBJECT='mailto:test@example.test';process.env.LOCAL_PUSH_BRIDGE_SECRET=secret;
const devices=[],events=[],nonces=new Set(),sent=[];
async function query(sql,a=[]){
 if(sql.startsWith('CREATE TABLE')||sql==='BEGIN'||sql==='COMMIT'||sql==='ROLLBACK'||sql.includes('pg_advisory_xact_lock'))return [];
 if(sql.startsWith('SELECT * FROM cerood_account_push_devices WHERE scope=$1 AND endpoint=$2'))return devices.filter(d=>d.scope===a[0]&&d.endpoint===a[1]&&(!sql.includes('binding=$3')||d.binding===a[2]));
 if(sql.startsWith('SELECT count(*)'))return [{n:devices.filter(d=>d.scope===a[0]&&d.recipient===a[1]).length}];
 if(sql.startsWith('INSERT INTO cerood_account_push_devices')){let d=devices.find(d=>d.scope===a[0]&&d.endpoint===a[1]);if(!d){d={};devices.push(d)}Object.assign(d,{scope:a[0],endpoint:a[1],recipient:a[2],p256dh:a[3],auth:a[4],manage_hash:a[5],binding:a[6],expires_at:a[7]});return []}
 if(sql.startsWith('SELECT * FROM cerood_account_push_devices WHERE scope=$1 AND recipient=$2'))return devices.filter(d=>d.scope===a[0]&&d.recipient===a[1]);
 if(sql.startsWith('INSERT INTO cerood_account_push_events')){if(events.some(e=>e.scope===a[1]&&e.event_key===a[3]))return [];const e={id:a[0],scope:a[1],recipient:a[2],event_key:a[3],title:a[4],body:a[5],url:a[6],state:'pending'};events.push(e);return [{id:e.id}]}
 if(sql.startsWith("UPDATE cerood_account_push_events SET state='sending'")){const e=events.find(e=>e.id===a[0]&&e.state==='pending');if(!e)return [];e.state='sending';return [e]}
 if(sql.startsWith('UPDATE cerood_account_push_events SET state=$1')){Object.assign(events.find(e=>e.id===a[3]),{state:a[0],accepted:a[1],failed:a[2]});return []}
 if(sql.startsWith('INSERT INTO cerood_account_push_nonces')){if(nonces.has(a[0]))return [];nonces.add(a[0]);return [{nonce:a[0]}]}
 if(sql.startsWith('DELETE FROM cerood_account_push_devices')){for(let i=devices.length-1;i>=0;i--){const d=devices[i];if(d.scope===a[0]&&d.endpoint===a[1]&&(sql.includes('manage_hash')?d.manage_hash===a[2]:d.binding===a[2]))devices.splice(i,1)}return []}
 throw Error('Unhandled query '+sql);
}
const db={query:(s,a,cb)=>query(s,a).then(r=>cb(null,r),cb),getClient:async()=>({query,release(){}})};
const webpush={async sendNotification(s,p){sent.push({endpoint:s.endpoint,...JSON.parse(p)});return {statusCode:201}}};
(async()=>{const svc=P.createService(db,webpush),sub=n=>({endpoint:'https://fcm.googleapis.com/fcm/send/'+n,keys:{p256dh:'a'.repeat(87),auth:'b'.repeat(22)}});
 const a=await svc.bind('local','render-local:a',{subscription:sub('a')},Date.now()+60000),b=await svc.bind('local','render-local:b',{subscription:sub('b')},Date.now()+60000);
 await svc.event('local','render-local:a','event-a','Update','Message','/local/');assert.equal(sent.length,1);assert.equal(sent[0].binding,a.binding);assert.equal(sent[0].endpoint,sub('a').endpoint);await svc.event('local','render-local:a','event-a','Update','Message','/local/');assert.equal(sent.length,1,'relay retries must not send twice');
 await assert.rejects(svc.bind('local','render-local:b',{subscription:sub('a')},Date.now()+60000),/Reconnect/);
 const switched=await svc.bind('local','render-local:b',{subscription:sub('a'),manageToken:a.manageToken},Date.now()+60000);assert.notEqual(switched.binding,a.binding);await svc.event('local','render-local:a','event-a2','Update','Message','/local/');assert.equal(sent.length,1,'old account has no linked device');
 await svc.unlink('local',{endpoint:sub('a').endpoint,manageToken:a.manageToken});assert.equal(devices.length,2,'old proof cannot unlink new account');await svc.unlink('local',{endpoint:sub('a').endpoint,manageToken:switched.manageToken});assert.equal(devices.length,1);
 const valid={...body,action:'config'},sig=sign(valid);await svc.bridge(valid,sig);await assert.rejects(svc.bridge(valid,sig),/replay/);
 await assert.rejects(svc.bind('local','render-local:b',{subscription:sub('c')},Date.now()-1),/Sign in/);
 console.log('PASS: signed Local bridge identity/expiry/replay rejection, trusted push hosts, per-account recipient isolation, durable event deduplication, proven device rebinding, old-token rejection and expired session rejection. Mock push/DB only.');
})().catch(e=>{console.error(e);process.exitCode=1});
