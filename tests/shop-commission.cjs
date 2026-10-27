'use strict';
const assert=require('node:assert/strict');
const model=require('../cerood-shop-commission');
const settlement=require('../cerood-shop-settlements');
const p={id:'1',seller_id:'00000000-0000-4000-8000-000000000001',line_total:'1000.00',commission_bps:1000,settlement_hold_days:7,order_id:'00000000-0000-4000-8000-000000000002',status:'delivered',payment_method:'online',payment_status:'paid',seller_order_status:'delivered',delivered_at:'2026-01-01T00:00:00Z'};
const body={action:'prepare',order_item_id:'1',commission_confirmed:true,charges:{forward_shipping:'50',handling:'10',gateway_fee:'20'},deduction_note:'Agreed commission and actual costs verified.'};
function dbFor(overrides={}){let saved=overrides.saved||null;const events=[];const db={get saved(){return saved},events,async getClient(){return {release(){events.push('release')},async query(sql,args=[]){events.push(sql);if(sql==='BEGIN'||sql==='COMMIT'||sql==='ROLLBACK')return [];if(sql.startsWith('SELECT order_id FROM'))return [{order_id:p.order_id}];if(sql.includes('SELECT i.id,i.seller_id'))return [{...p,...overrides.item}];if(sql.startsWith('SELECT * FROM public.cerood_shop_settlements'))return saved?[saved]:[];if(sql.includes('FROM public.cerood_shop_return_requests'))return overrides.hasReturn?[{id:'return'}]:[];if(sql.startsWith('INSERT INTO public.cerood_shop_settlements')){saved={id:'settlement',status:'pending',order_item_id:'1',seller_id:p.seller_id,gross_amount:args[2],deductions:args[3],deduction_note:args[4],finance_breakdown:JSON.parse(args[5]),release_at:args[6]};return [saved];}if(sql.includes("SET status='paid'")){saved={...saved,status:'paid',transfer_reference:args[0]};return [saved];}return [{id:p.order_id}];}}}};return db;}
(async()=>{
assert.deepEqual(model.calculate('1000',1000,{forward_shipping:'50',handling:'10',gateway_fee:'20'}),{version:1,gross_amount:'1000.00',commission_percent:'10.00',commission_amount:'100.00',charges:{forward_shipping:'50.00',return_shipping:'0.00',exchange_shipping:'0.00',handling:'10.00',gateway_fee:'20.00',commission_tax:'0.00',other:'0.00'},deductions:'180.00',payable_amount:'820.00',currency:'INR'});
assert.equal(model.calculate('0.05',1000).commission_amount,'0.01');
assert.equal(model.calculate('9999999999.99',10000).payable_amount,'0.00');
for(const rate of ['-1','100.01','5.001','1e1','NaN',''])assert.throws(()=>model.bps(rate));
for(const charges of [{other:'-1'},{other:'1.001'},{unknown:'1'},{other:'1001'}])assert.throws(()=>model.calculate('1000',0,charges));
assert.throws(()=>model.quote({...p,commission_bps:null},body),/historical/);
assert.throws(()=>model.quote(p,{...body,commission_confirmed:false}),/Confirm/);
assert.equal(model.quote(p,{...body,legacy_commission_percent:'99'}).commission_percent,'10.00');
assert.equal(model.quote(p,body).release_at,'2026-01-08T00:00:00.000Z');
assert.throws(()=>model.releaseDate({},0),/timestamp/);
const db=dbFor();const created=await settlement.record(db,body);assert.equal(created.settlement.deductions,'180.00');assert.equal(created.settlement.finance_breakdown.payable_amount,'820.00');
// PostgreSQL jsonb may return keys in a different order; identical retries remain idempotent.
db.saved.finance_breakdown=Object.fromEntries(Object.entries(db.saved.finance_breakdown).reverse());
assert.equal((await settlement.record(db,body)).idempotent,true);
await assert.rejects(()=>settlement.record(db,{...body,charges:{forward_shipping:'60'}}),/different deductions/);
const pay={action:'record_paid',order_item_id:'1',transfer_confirmed:true,transfer_reference:'UTR-TEST-001'};
assert.equal((await settlement.record(db,pay)).settlement.status,'paid');
assert.equal((await settlement.record(db,pay)).idempotent,true);
await assert.rejects(()=>settlement.record(db,{...pay,transfer_reference:'DIFFERENT'}),/immutable/);
const hold=dbFor({saved:{...created.settlement,release_at:'2999-01-01T00:00:00Z'}});await assert.rejects(()=>settlement.record(hold,pay),/on hold/);assert(hold.events.includes('ROLLBACK'));
const returned=dbFor({hasReturn:true});await assert.rejects(()=>settlement.record(returned,body),/return request/);assert(!returned.events.some(x=>x.startsWith('INSERT INTO')));
const unpaid=dbFor({item:{payment_status:'pending'}});await assert.rejects(()=>settlement.record(unpaid,body),/eligible/);
const historical=dbFor({item:{commission_bps:null,settlement_hold_days:null}});const legacy=await settlement.record(historical,{...body,legacy_terms_confirmed:true,legacy_commission_percent:'15',legacy_hold_days:'0'});assert.equal(legacy.settlement.finance_breakdown.commission_amount,'150.00');
let snap;await model.snapshot({query:async(sql,args)=>{snap={sql,args};return []}},'1',p.seller_id);assert(snap.sql.includes('commission_terms_revision=t.revision'));assert.deepEqual(snap.args,['1',p.seller_id]);
const routes=[];const admin=()=>{},seller=()=>{};const app={get:(path,...handlers)=>routes.push({path,handlers}),post:(path,...handlers)=>routes.push({path,handlers})};model.register(app,{},admin,seller);for(const route of routes)assert.equal(route.handlers[0],route.path.startsWith('/api/admin/')?admin:seller);
console.log('PASS: exact commission rounding, fee limits, immutable order terms, historical agreement, delivery hold, refund/return and unpaid blockers, idempotent settlements, transfer evidence and scoped routes. Mock DB; no money moved.');
})().catch(e=>{console.error(e);process.exitCode=1});
