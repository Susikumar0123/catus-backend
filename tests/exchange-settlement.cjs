'use strict';
const assert=require('node:assert/strict');
const {project,assertPrepared}=require('../cerood-shop-exchange-settlement');
const commission=require('../cerood-shop-commission');
function fixture(target=120000){
 const item={id:'1',order_id:'order-db',seller_id:'seller',quantity:1,line_total:'1000.00',commission_bps:1000,settlement_hold_days:7};
 const x={id:'exchange',order_item_id:'1',order_id:'order-db',seller_id:'seller',customer_id:'customer',return_request_id:'return',replacement_id:'replacement',original_paise:100000,target_paise:target,pay_paise:Math.max(0,target-100000),refund_paise:Math.max(0,100000-target),state:'replacement_reserved',target:{product_id:'new',variant_id:'v',quantity:1},razorpay_payment_id:'pay_Delta',razorpay_order_id:'order_Delta',refund_payment_id:'pay_Original',refund_id:'rfnd_Delta'};
 const order={id:'order-db',customer_id:'customer',status:'delivered',payment_status:'paid',payment_method:'online',razorpay_payment_id:'pay_Original',razorpay_order_id:'order_Original',total:'1050.00'};
 const replacement={id:'replacement',return_request_id:'return',order_item_id:'1',seller_id:'seller',product_id:'new',variant_id:'v',quantity:1,status:'delivered',stage_dates:{delivered:'2026-01-10T00:00:00Z'}};
 const request={id:'return',order_item_id:'1',status:'replaced',inspected_at:'2026-01-08T00:00:00Z'};
 const data={item,x,order,replacement,request,siblings:[],refunds:[],calls:[]};
 data.c={query:async(sql)=>{if(sql.includes('to_regclass'))return [{relation:'yes'}];if(sql.includes('direct_exchanges WHERE order_item_id'))return [x];if(sql.includes('direct_exchanges WHERE order_id'))return data.siblings;if(sql.includes('FROM cerood_shop_refunds'))return data.refunds;if(sql.includes('FROM cerood_shop_orders'))return [order];if(sql.includes('FROM cerood_shop_replacements'))return [replacement];if(sql.includes('FROM cerood_shop_return_requests'))return [request];throw Error('Unexpected query '+sql)}};
 data.provider={rz:async(path,...args)=>{assert.equal(args.length,0,'Provider must be read only');data.calls.push(path);if(path==='v1/payments/pay_Original')return {id:'pay_Original',order_id:'order_Original',currency:'INR',status:'captured',amount:105000,amount_refunded:x.refund_paise,...data.originalOverride};if(path==='v1/payments/pay_Delta')return {id:'pay_Delta',order_id:'order_Delta',currency:'INR',status:'captured',amount:x.pay_paise,amount_refunded:0,...data.deltaOverride};if(path==='v1/orders/order_Delta')return {id:'order_Delta',currency:'INR',amount:x.pay_paise,receipt:x.id,notes:{cerood_direct_exchange:x.id}};if(path==='v1/refunds/rfnd_Delta')return {id:'rfnd_Delta',payment_id:'pay_Original',currency:'INR',status:'processed',amount:x.refund_paise,receipt:x.id,...data.refundOverride};throw Error(path)}};
 return data;
}
(async()=>{
 for(const target of [120000,80000,100000]){
  const f=fixture(target),p=await project(f.c,f.item,f.provider);
  assert.equal(p.line_total,(target/100).toFixed(2));assert.equal(f.item.line_total,'1000.00');
  const b=commission.quote(p,{commission_confirmed:true,charges:{}});assert.equal(b.release_at,'2026-01-17T00:00:00.000Z');assert.equal(b.commission_amount,(target/1000).toFixed(2));
  const settlement={gross_amount:p.line_total,deductions:b.deductions,release_at:b.release_at,finance_breakdown:JSON.parse(JSON.stringify(b))};
  settlement.finance_breakdown.exchange=Object.fromEntries(Object.entries(b.exchange).reverse());assertPrepared(settlement,p);
  assert.throws(()=>assertPrepared({...settlement,gross_amount:'999'},p),/does not match/);
  assert.throws(()=>assertPrepared({...settlement,release_at:'2026-01-08'},p),/hold changed/);
  assert.throws(()=>assertPrepared({...settlement,deductions:'0'},p),/commission/);
 }
 const integrated=fixture(120000);let ledger=null;const base=integrated.c.query;
 const query=async(sql,args=[])=>{if(['BEGIN','COMMIT','ROLLBACK'].includes(sql))return [];if(sql.startsWith('SELECT id FROM public.cerood_shop_orders'))return [{id:integrated.item.order_id}];if(sql.startsWith('SELECT order_id FROM public.'))return [{order_id:integrated.item.order_id}];if(sql.startsWith('SELECT i.id,i.seller_id'))return [{...integrated.item,status:'delivered',payment_method:'online',payment_status:'paid',seller_order_status:'delivered'}];if(sql.includes('FROM public.cerood_shop_settlements'))return ledger?[ledger]:[];if(sql.includes('FROM public.cerood_shop_return_requests'))return [];if(sql.startsWith('INSERT INTO public.cerood_shop_settlements')){ledger={id:'ledger',status:'pending',gross_amount:args[2],deductions:args[3],deduction_note:args[4],finance_breakdown:JSON.parse(args[5]),release_at:args[6]};return [ledger]}return base(sql,args)};
 const db={getClient:async()=>({query,release(){}})};
 const body={order_item_id:'1',action:'prepare',commission_confirmed:true,charges:{},deduction_note:'Agreed exchange commission verified.'};
 const result=await require('../cerood-shop-settlements').record(db,body,integrated.provider);
 assert.equal(result.settlement.gross_amount,'1200.00');assert.equal(result.settlement.deductions,'120.00');assert.equal(result.settlement.release_at,'2026-01-17T00:00:00.000Z');
 assert.equal((await require('../cerood-shop-settlements').record(db,body,integrated.provider)).idempotent,true);
 const mutations=[f=>f.replacement.status='shipped',f=>f.request.inspected_at=null,f=>f.x.seller_id='another',f=>f.x.pay_paise=1,f=>f.replacement.variant_id='wrong',f=>f.replacement.stage_dates={},f=>f.siblings.push({id:'other'}),f=>f.refunds.push({id:'other'}),f=>f.originalOverride={amount_refunded:1},f=>f.deltaOverride={status:'authorized'},f=>f.deltaOverride={amount_refunded:1},f=>f.x.state='payment_unknown',f=>f.replacement.stock_restored_at='2026-01-01'];
 for(const mutate of mutations){const f=fixture();mutate(f);await assert.rejects(()=>project(f.c,f.item,f.provider));}
 const lower=fixture(80000);lower.refundOverride={status:'pending'};await assert.rejects(()=>project(lower.c,lower.item,lower.provider),/processed/);
 const unavailable=fixture();unavailable.provider.rz=async()=>{throw Error('Unavailable')};await assert.rejects(()=>project(unavailable.c,unavailable.item,unavailable.provider),/Unavailable/);
 const plain=fixture();plain.c.query=async sql=>sql.includes('to_regclass')?[{relation:null}]:[];assert.equal(await project(plain.c,plain.item,plain.provider),plain.item);assert.equal(plain.calls.length,0);
 console.log('PASS: higher/lower/equal exchange settlement, provider identity and funding checks, replacement delivery hold, immutable original gross, JSONB key ordering, prepared ledger mismatch, refund/ownership/unknown-state rejection. Mock providers/DB; no money moved.');
})().catch(e=>{console.error(e);process.exitCode=1});
