const assert=require('node:assert/strict');
const {createHandlers}=require('../local-discovery/local-discovery-auth');
const {createWidgetVerifier}=require('../local-discovery/msg91-widget-client');
(async()=>{
let used=false,queries=[],verified=0;
const db={query:async(sql,args)=>{queries.push({sql,args});if(sql.includes('rate_limits'))return{rows:[{}]};if(sql.includes('widget_tokens')){if(used)return{rows:[]};used=true;return{rows:[{}]}}if(sql.includes('INSERT INTO local_discovery_users'))return{rows:[{id:'u1',mobile_e164:'919000000001',role:'customer'}]};if(sql.includes('SELECT u.id'))return{rows:[{id:'u1',mobile_e164:'919000000001',role:'customer'}]};return{rows:[]}}};
const h=createHandlers({db,env:{LOCAL_DISCOVERY_ORIGIN:'https://directory.test',LOCAL_DISCOVERY_RATE_SECRET:'x'.repeat(32)},widgetVerifier:{verify:async()=>{verified++;return '919000000001'}}});
const req={body:{accessToken:'t'.repeat(40),mobile:'919999999999',role:'admin'},headers:{},get:n=>({'origin':'https://directory.test','x-cerood-local-client':'web'}[n]),ip:'127.0.0.1'};
const res=()=>({code:200,headers:{},status(c){this.code=c;return this},json(d){this.data=d;return this},setHeader(k,v){this.headers[k]=v}});
let r=res();await h.widgetLogin(req,r);assert.equal(r.code,200);assert.equal(r.data.user.role,'customer');assert.equal(r.data.user.mobile,'919000000001');assert.match(r.headers['Set-Cookie'],/HttpOnly; SameSite=Lax; Secure/);assert.ok(!JSON.stringify(queries).includes('919999999999'));
let second=res();await h.widgetLogin(req,second);assert.equal(second.code,409);
let blocked=res();await h.widgetLogin({...req,get:n=>n==='origin'?'https://evil.test':req.get(n)},blocked);assert.equal(blocked.code,403);assert.equal(verified,2);
const session=r.headers['Set-Cookie'].split(';')[0];r=res();await h.me({...req,headers:{cookie:session}},r);assert.equal(r.data.authenticated,true);r=res();await h.logout({...req,headers:{cookie:session}},r);assert.match(r.headers['Set-Cookie'],/Max-Age=0/);
let payload;const v=createWidgetVerifier({authKey:'private-test-key',fetchImpl:async(url,opts)=>{payload=JSON.parse(opts.body);return {ok:true,json:async()=>({type:'success',message:'+91 90000 00001'})}}});assert.equal(await v.verify('verified-token'),'919000000001');assert.deepEqual(payload,{authkey:'private-test-key','access-token':'verified-token'});
const bad=createWidgetVerifier({authKey:'test',fetchImpl:async()=>({ok:true,json:async()=>({type:'error',message:'919000000001'})})});assert.equal(await bad.verify('token'),null);
console.log('PASS: Render handler contract, server-verified identity, role spoof rejection, replay rejection, origin protection, session/logout and MSG91 response validation (mock DB and provider).');
})().catch(e=>{console.error(e);process.exitCode=1});
