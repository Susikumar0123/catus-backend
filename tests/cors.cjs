const vm=require('node:vm'),fs=require('node:fs'),assert=require('node:assert/strict');
const source=fs.readFileSync(require('node:path').join(__dirname,'../server.js'),'utf8');
const code=source.slice(source.indexOf('const localDiscoveryOrigin'),source.indexOf("if (process.env.LOCAL_DISCOVERY_OTP_ENABLED === 'true')"));
let middleware;const env={LOCAL_DISCOVERY_OTP_ENABLED:'false'};
vm.runInNewContext(code,{process:{env},app:{use:(p,f)=>{middleware=f}}});
function run(origin,method='GET',extra={}){let next=false;const headers={origin,...extra};const req={method,get:n=>headers[n]};const res={headers:{},status(n){this.code=n;return this},json(d){this.body=d;return this},set(k,v){this.headers[k]=v},vary(){},sendStatus(n){this.code=n;return this}};middleware(req,res,()=>{next=true});return{res,next}}
const origin='https://cerood-local-discovery.susikumar.chatgpt.site';
assert.equal(run(origin).res.code,503);assert.equal(run('https://evil.test').res.code,403);
let r=run(origin,'OPTIONS',{'access-control-request-method':'POST','access-control-request-headers':'content-type,x-cerood-local-client'});assert.equal(r.res.code,204);assert.equal(r.res.headers['Access-Control-Allow-Origin'],origin);
assert.equal(run(origin,'OPTIONS',{'access-control-request-method':'DELETE'}).res.code,403);
assert.equal(run(origin,'OPTIONS',{'access-control-request-method':'POST','access-control-request-headers':'x-untrusted'}).res.code,403);
env.LOCAL_DISCOVERY_OTP_ENABLED='true';assert.equal(run(origin).next,true);assert.equal(run(undefined).next,true);
console.log('PASS: scoped CORS exact origin, preflight headers/methods, disabled JSON response and enabled routing.');
