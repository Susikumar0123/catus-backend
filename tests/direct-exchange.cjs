'use strict';
const assert=require('node:assert/strict'),crypto=require('node:crypto');
const X=require('../cerood-shop-direct-exchange');
const RID='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',OID='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',SID='cccccccc-cccc-4ccc-8ccc-cccccccccccc',PID='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
function fixture({price='120.00',customer='7',received=true}={}){
 let x=null,replacement=null,stock=5,posts=0,unknown=false,providerOrder=null,payment=null,refund=null,otherSeller=false;
 const item={id:1,order_id:OID,product_id:'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',seller_id:SID,line_total:'100.00',quantity:1},order={id:OID,customer_id:'7',status:'delivered',payment_method:'online',payment_status:'paid',total:'110.00',razorpay_payment_id:'pay_original',razorpay_order_id:'order_original',delivery_address:{name:'Test'}},request={id:RID,customer_id:customer,request_type:'exchange',status:received?'received':'approved',inspected_at:received?'2026-10-27':null};
 async function query(sql,a=[]){
  if(/^(BEGIN|COMMIT|ROLLBACK)/.test(sql))return [];
  if(sql.startsWith('SELECT i.order_id'))return [{order_id:OID,item_id:1}];
  if(sql.startsWith('SELECT * FROM cerood_shop_orders'))return [order];
  if(sql.startsWith('SELECT id FROM cerood_shop_orders'))return [{id:OID}];
  if(sql.startsWith('SELECT * FROM cerood_shop_order_items'))return [item];
  if(sql.startsWith('SELECT * FROM cerood_shop_return_requests'))return [request];
  if(sql.includes('SELECT status FROM cerood_sellers'))return [{status:'approved'}];
  if(sql.startsWith('SELECT id FROM cerood_shop_settlements')||sql.startsWith('SELECT id FROM cerood_shop_refunds')||sql.startsWith('SELECT return_request_id FROM cerood_shop_exchange_links'))return [];
  if(sql.startsWith('SELECT id FROM cerood_shop_replacements'))return replacement?[replacement]:[];
  if(sql.startsWith('SELECT * FROM cerood_shop_direct_exchanges'))return x&&(!sql.includes('customer_id=$2')||String(a[1])===x.customer_id)?[structuredClone(x)]:[];
  if(sql.startsWith('UPDATE cerood_shop_products SET stock=stock-')){if(stock<a[0])return [];stock-=a[0];return [{id:PID}]}
  if(sql.startsWith('INSERT INTO cerood_shop_direct_exchanges')){x={id:a[0],return_request_id:a[1],order_item_id:a[2],order_id:a[3],customer_id:a[4],seller_id:a[5],quote_hash:a[6],target:JSON.parse(a[7]),original_paise:a[8],target_paise:a[9],pay_paise:a[10],refund_paise:a[11],state:a[12]};return [structuredClone(x)]}
  if(sql.startsWith('SELECT id FROM cerood_shop_direct_exchanges'))return [];
  if(sql.startsWith('UPDATE cerood_shop_direct_exchanges')){
   if(sql.includes("state='payment_initiating'"))x.state='payment_initiating';
   else if(sql.includes("state='payment_unknown'")){if(x.state==='payment_initiating')x.state='payment_unknown';}
   else if(sql.includes('SET razorpay_order_id=')){x.razorpay_order_id=a[0];if(x.state!=='funded')x.state='payment_pending'}
   else if(sql.includes('SET razorpay_payment_id=')){x.razorpay_payment_id=a[0];if(x.state!=='replacement_reserved')x.state='funded'}
   else if(sql.includes("state='refund_unknown'")){if(x.state==='refund_initiating')x.state='refund_unknown'}
   else if(sql.includes("state='refund_initiating'")){x.state='refund_initiating';x.refund_payment_id=a[0]}
   else if(sql.includes('SET refund_id=')){x.refund_id=a[0];x.state=a[1]}
   else if(sql.includes("state='replacement_reserved'")){x.replacement_id=a[0];x.state='replacement_reserved'}
   else throw Error('Unhandled update '+sql);return [structuredClone(x)];
  }
  if(sql.startsWith('INSERT INTO cerood_shop_replacements')){assert.equal(replacement,null,'only one replacement');replacement={id:'ffffffff-ffff-4fff-8fff-ffffffffffff'};return [replacement]}
  if(sql.includes('to_regclass'))return [{relation:'cerood_shop_direct_exchanges'}];
  throw Error('Unhandled SQL: '+sql);
 }
 const db={getClient:async()=>({query,release(){}}),query:(s,a,cb)=>query(s,a).then(r=>cb(null,r),cb)};
 const h={items:x=>x,resolve:async(q,items)=>({lines:[{p:{id:PID,name:'New product',seller_id:otherSeller?'other':SID},line_total:price,variant_id:null,variant_values:{},quantity:items[0].quantity}]})};
 const provider={async rz(path,method='GET',body){if(method==='POST'){posts++;if(path==='v1/orders'){providerOrder={id:'order_difference',currency:'INR',amount:body.amount,receipt:body.receipt,notes:body.notes};if(unknown)throw Error('accepted then disconnected');return providerOrder}if(path.endsWith('/refund')){refund={id:'rfnd_difference',payment_id:'pay_original',currency:'INR',amount:body.amount,receipt:body.receipt,status:'processed'};if(unknown)throw Error('accepted then disconnected');return refund}}
   if(path.startsWith('v1/orders?'))return {items:providerOrder?[providerOrder]:[]};
   if(path.endsWith('/payments'))return {items:payment?[payment]:[]};
   if(path==='v1/payments/pay_original')return {id:'pay_original',order_id:'order_original',currency:'INR',amount:11000,amount_refunded:refund?.status==='processed'?refund.amount:0,status:'captured'};
   if(path.endsWith('/refunds?count=100'))return {items:refund?[refund]:[]};
   if(path==='v1/refunds/rfnd_difference')return refund;
   if(path==='v1/payments/pay_difference')return payment;
   throw Error('Unhandled provider '+path);
 }};
 return {s:X.createService(db,h,provider),get row(){return x},get stock(){return stock},get posts(){return posts},set unknown(v){unknown=v},set otherSeller(v){otherSeller=v},capture(amount=2000){payment={id:'pay_difference',order_id:'order_difference',currency:'INR',amount,status:'captured',amount_refunded:0}}};
}
(async()=>{
 process.env.SHOP_DIRECT_EXCHANGE_ENABLED='true';process.env.SHOP_REFUNDS_ENABLED='true';process.env.RAZORPAY_KEY_SECRET='server-test-secret';
 assert.deepEqual(X.difference('100.00','125.25'),{original_paise:10000,target_paise:12525,pay_paise:2525,refund_paise:0,currency:'INR'});assert.equal(X.difference('100','80').refund_paise,2000);assert.throws(()=>X.difference('100','100.01'));
 await assert.rejects(fixture({customer:'8'}).s.quote(RID,{product_id:PID},'7'),/not found/);
 await assert.rejects(fixture({received:false}).s.quote(RID,{product_id:PID},'7'),/inspected/);
 const wrong=fixture();wrong.otherSeller=true;await assert.rejects(wrong.s.quote(RID,{product_id:PID},'7'),/original seller/);
 const f=fixture(),q=(await f.s.quote(RID,{product_id:PID},'7')).quote;
 await assert.rejects(f.s.prepare(RID,{product_id:PID,confirmed:true,quote_hash:'0'.repeat(64)},'7'),/changed/);assert.equal(f.stock,5);
 const row=(await f.s.prepare(RID,{product_id:PID,confirmed:true,quote_hash:q.quote_hash},'7')).exchange;assert.equal(f.stock,4);await f.s.prepare(RID,{product_id:PID,confirmed:true,quote_hash:q.quote_hash},'7');assert.equal(f.stock,4);
 f.unknown=true;await assert.rejects(f.s.paymentOrder(row.id,'7'),/uncertain/);assert.equal(f.posts,1);await assert.rejects(f.s.paymentOrder(row.id,'7'),/already exists/);assert.equal(f.posts,1);
 await f.s.reconcile(row.id,'7');assert.equal(f.row.razorpay_order_id,'order_difference');f.capture(1);await assert.rejects(f.s.reconcile(row.id,'7'),/matching captured/);assert.equal(f.row.replacement_id,undefined);
 f.capture();const done=await f.s.reconcile(row.id,'7');assert.equal(done.exchange.state,'replacement_reserved');assert.ok(done.exchange.replacement_id);assert.equal(f.posts,1);assert.equal((await f.s.reconcile(row.id,'7')).exchange.state,'replacement_reserved');
 await assert.rejects(f.s.reconcile(row.id,'8'),/not found/);
 const cheap=fixture({price:'80.00'}),cq=(await cheap.s.quote(RID,{product_id:PID},'7')).quote,cx=(await cheap.s.prepare(RID,{product_id:PID,confirmed:true,quote_hash:cq.quote_hash},'7')).exchange;cheap.unknown=true;await assert.rejects(cheap.s.refund(cx.id,{confirmed:true}),/uncertain/);assert.equal(cheap.posts,1);const cr=await cheap.s.refund(cx.id,{confirmed:true});assert.equal(cr.exchange.state,'replacement_reserved');assert.equal(cr.exchange.refund_paise,2000);assert.equal(cheap.posts,1);
 const zero=fixture({price:'100.00'}),zq=(await zero.s.quote(RID,{product_id:PID},'7')).quote,zx=(await zero.s.prepare(RID,{product_id:PID,confirmed:true,quote_hash:zq.quote_hash},'7')).exchange;assert.equal((await zero.s.finish(zx.id,'7')).exchange.state,'replacement_reserved');assert.equal(zero.posts,0);
 const secret='secret',sig=crypto.createHmac('sha256',secret).update('order_test|pay_test').digest('hex');assert.equal(X.signature('order_test','pay_test',sig,secret),true);assert.equal(X.signature('order_changed','pay_test',sig,secret),false);
 await assert.rejects(X.settlementHold({query:async sql=>sql.includes('to_regclass')?[{relation:'yes'}]:[{id:'hold'}]},1),/separate funds ledger/);
 console.log('PASS: inspected/owned/same-seller guards, authoritative quote, stock reservation once, accepted-timeout recovery without resend, captured delta validation, lower-price refund once, equal-price exchange and monotonic completion. Mock DB/provider; no money moved.');
})().catch(e=>{console.error(e);process.exitCode=1});
