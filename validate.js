const fs=require('fs'),vm=require('vm');
const base=__dirname;
const backend=fs.readFileSync(base+'/server.js','utf8');
const sql=fs.readFileSync(base+'/migration.sql','utf8');
let failed=0;
function check(name,ok){console.log((ok?'PASS':'FAIL')+' '+name);if(!ok)failed++;}
try{new vm.Script(backend,{filename:'server.js'});check('Backend parses',true);}catch(e){check('Backend parses',false);console.error(e.message);}
for(const file of ['checkout.html','admin.html','customer-approval.html']){
 const html=fs.readFileSync(base+'/'+file,'utf8');
 const scripts=[...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)].filter(m=>!(/\bsrc\s*=/.test(m[1])));
 let valid=true;
 for(const [i,m] of scripts.entries()){
   try{new vm.Script(m[2],{filename:file+' inline '+i});}catch(e){valid=false;console.error(file+' script '+i+': '+e.message);}
 }
 check(file+' inline scripts parse ('+scripts.length+')',valid);
}
check('Free booking route exists',backend.includes("'/api/home-services/free-bookings'"));
check('Customer inspection consent route exists',backend.includes("'/api/home-services/inspection-response'"));
check('Customer quote consent route exists',backend.includes("'/api/home-services/quotation-response'"));
check('Admin fee route requires authentication',/app\.patch\('\/api\/admin\/home-services\/free-bookings\/:orderId\/inspection',requireAdminAuth/.test(backend));
check('Booking request uniqueness migration',sql.includes('orders_booking_request_id_unique'));
check('Approval key hash migration',sql.includes('customer_approval_key_hash'));
console.log('\nStatic validation '+(failed?'FAILED':'PASSED')+'. Does not test database, browser or live API.');
process.exitCode=failed?1:0;
