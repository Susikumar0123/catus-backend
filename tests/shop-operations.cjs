'use strict';
const assert=require('node:assert/strict');
const {createService,transferMatches,refundMatches,returnPayload,register}=require('../cerood-shop-operations');
const id='00000000-0000-4000-8000-000000000001',returnId='00000000-0000-4000-8000-000000000004',sellerId='00000000-0000-4000-8000-000000000002';
function fixture({unknown=false,wrong=false,cod=false,hasReturn=false,shipments=false}={}){const operations=[];let stock=5,posts=0,settled=false,providerTransfer,providerRefund;
const order={id,total:'1000.00',status:'delivered',payment_method:cod?'cod':'online',payment_status:cod?'cod_pending':'paid',razorpay_order_id:'order_TEST',razorpay_payment_id:'pay_TEST',customer_id:'customer'};
const settlement={id:'12',order_item_id:'1',seller_id:sellerId,status:'pending',gross_amount:'1000.00',deductions:'100',finance_breakdown:{},release_at:'2020-01-01'};
const query=async(sql,args=[])=>{
if(['BEGIN','COMMIT','ROLLBACK'].includes(sql))return [];
if(sql.includes('to_regclass'))return [{relation:'yes'}];
if(sql.includes('SELECT * FROM cerood_shop_operations WHERE kind='))return operations.filter(o=>o.kind===args[0]&&o.entity_key===String(args[1]));
if(sql.startsWith('INSERT INTO cerood_shop_operations')){const o={id:args[0],kind:args[1],entity_key:args[2],order_id:args[3],payload:JSON.parse(args[4]),state:'initiating'};operations.push(o);return [o];}
if(sql.startsWith('UPDATE cerood_shop_operations')){const o=operations.find(o=>o.id===args[3]);if(o){o.state=args[0];o.provider_id=args[1]||o.provider_id;o.result=JSON.parse(args[2]);}return [];}
if(sql.includes('SELECT * FROM cerood_shop_operations WHERE id='))return operations.filter(o=>o.id===args[0]);
if(sql.includes('SELECT i.order_id FROM cerood_shop_settlements'))return [{order_id:id}];
if(sql.includes('FROM cerood_shop_orders WHERE id='))return [order];
if(sql.startsWith('SELECT * FROM public.cerood_shop_orders'))return [order];
if(sql.includes('FROM cerood_shop_settlements WHERE id::text='))return [settlement];
if(sql.includes('FROM cerood_shop_return_requests WHERE order_item_id='))return hasReturn?[{id:returnId}]:[];
if(sql.includes('FROM cerood_shop_route_accounts'))return [{confirmed:true,account_id:'acc_SELLER',product_id:'acc_prd_ROUTE'}];
if(sql.includes('FROM cerood_shop_cod_receipts'))return [{gross_amount:'1000.00',received_amount:'1000.00'}];
if(sql.includes("UPDATE cerood_shop_settlements SET status='paid'")){settlement.status='paid';return [];}
if(sql.includes('FROM public.cerood_ekart_shipments'))return shipments?[{id:'shipment'}]:[];
if(sql.includes('FROM public.cerood_shop_order_items WHERE order_id='))return [{id:'1',product_id:id,variant_id:null,quantity:2,seller_order_status:'new'}];
if(sql.startsWith('SELECT id FROM public.cerood_shop_products'))return [{id}];
if(sql.startsWith('UPDATE public.cerood_shop_products SET stock=')){stock+=Number(args[0]);return [{id}];}
if(sql.startsWith('UPDATE public.cerood_shop_orders SET status=')){order.status='cancelled';order.cancellation_refund_state='pending';return [order];}
if(sql.startsWith('UPDATE cerood_shop_orders SET cancellation_refund_state=')){order.cancellation_refund_state=args[0];return [];}
return [];
};
const db={query:(s,a,cb)=>query(s,a).then(r=>cb(null,r),cb),getClient:async()=>({query,release(){}})};
const provider={rz:async(path,method,body)=>{if(path.startsWith('v2/accounts/'))return {account_id:'acc_SELLER',id:'acc_prd_ROUTE',product_name:'route',activation_status:'activated'};
if(path==='v1/payments/pay_TEST')return {id:'pay_TEST',status:'captured',currency:'INR',order_id:'order_TEST',amount:100000,amount_refunded:0};
if(path==='v1/transfers'&&method==='POST'){posts++;providerTransfer={id:'trf_TEST',entity:'transfer',recipient:wrong?'acc_OTHER':body.account,source:'acc_PRIMARY',currency:'INR',amount:body.amount,notes:body.notes,status:'processed',amount_reversed:0,settlement_status:'pending'};if(unknown)throw Error('timeout after acceptance');return providerTransfer;}
if(path.startsWith('v1/transfers?'))return {items:providerTransfer?[providerTransfer]:[]};
if(path==='v1/transfers/trf_TEST')return {...providerTransfer,...(settled?{settlement_status:'settled',recipient_settlement_id:'setl_TEST'}:{})};
if(path==='v1/payments/pay_TEST/refund'){posts++;providerRefund={id:'rfnd_TEST',payment_id:'pay_TEST',currency:'INR',amount:body.amount,receipt:body.receipt,status:'pending'};if(unknown)throw Error('timeout after refund acceptance');return providerRefund;}
if(path.startsWith('v1/payments/pay_TEST/refunds'))return {items:providerRefund?[providerRefund]:[]};
if(path==='v1/refunds/rfnd_TEST')return {...providerRefund,status:'processed'};
throw Error('Unexpected provider path '+path);},dl:async()=>{throw Error('not requested')}};
return {db,provider,order,settlement,operations,get posts(){return posts},get stock(){return stock},settle(){settled=true}};}
(async()=>{
process.env.SHOP_ROUTE_PAYOUTS_ENABLED='true';process.env.SHOP_ROUTE_DIRECT_ENABLED='true';process.env.RAZORPAY_ROUTE_SOURCE_ACCOUNT='acc_PRIMARY';process.env.SHOP_REFUNDS_ENABLED='true';
let gate=Promise.resolve();const concurrent=fixture();const baseClient=concurrent.db.getClient;concurrent.db.getClient=async()=>{const client=await baseClient();let unlock;return {release(){unlock?.()},async query(sql,args){if(sql==='BEGIN'){const previous=gate;gate=new Promise(r=>unlock=r);await previous;}return client.query(sql,args);}}};const parallel=createService(concurrent.db,concurrent.provider);await Promise.allSettled([parallel.payout('12',{confirmed:true}),parallel.payout('12',{confirmed:true})]);assert.equal(concurrent.posts,1);
let f=fixture(),s=createService(f.db,f.provider);await s.payout('12',{confirmed:true});assert.equal(f.posts,1);assert.equal(f.settlement.status,'pending');f.settle();await s.reconcilePayout('12');assert.equal(f.settlement.status,'paid');await s.payout('12',{confirmed:true});assert.equal(f.posts,1);
f=fixture({unknown:true});s=createService(f.db,f.provider);await assert.rejects(()=>s.payout('12',{confirmed:true}),/uncertain/);assert.equal(f.operations[0].state,'unknown');await s.payout('12',{confirmed:true});assert.equal(f.posts,1);
f=fixture({wrong:true});s=createService(f.db,f.provider);await assert.rejects(()=>s.payout('12',{confirmed:true}),/uncertain/);assert.equal(f.settlement.status,'pending');
f=fixture({hasReturn:true});s=createService(f.db,f.provider);await assert.rejects(()=>s.payout('12',{confirmed:true}),/return/);assert.equal(f.posts,0);
f=fixture({cod:true});s=createService(f.db,f.provider);await s.payout('12',{confirmed:true});assert.equal(f.posts,1);
f=fixture();s=createService(f.db,f.provider);f.order.status='packed';await s.cancelOnline(id,{confirmed:true,note:'Customer requested cancellation before dispatch.'},'customer');assert.equal(f.order.status,'cancelled');assert.equal(f.order.cancellation_refund_state,'pending');assert.equal(f.stock,7);await s.cancelOnline(id,{confirmed:true,note:'Customer requested cancellation before dispatch.'},'customer');assert.equal(f.stock,7);assert.equal(f.posts,1);assert.equal(f.order.cancellation_refund_state,'processed');
f=fixture({unknown:true});f.order.status='confirmed';s=createService(f.db,f.provider);await assert.rejects(()=>s.cancelOnline(id,{confirmed:true,note:'Customer requested cancellation before dispatch.'},'customer'),/uncertain/);await s.reconcileCancellation(id);assert.equal(f.posts,1);assert.equal(f.stock,7);assert.equal(f.order.cancellation_refund_state,'processed');
f=fixture();f.order.status='shipped';s=createService(f.db,f.provider);await assert.rejects(()=>s.cancelOnline(id,{confirmed:true,note:'Customer requested cancellation before dispatch.'},'customer'),/dispatch/);assert.equal(f.posts,0);
f=fixture({shipments:true});f.order.status='packed';s=createService(f.db,f.provider);await assert.rejects(()=>s.cancelOnline(id,{confirmed:true,note:'Customer requested cancellation before dispatch.'},'customer'),/courier/);assert.equal(f.posts,0);
f=fixture();s=createService(f.db,f.provider);await assert.rejects(()=>s.cancelOnline(id,{confirmed:true,note:'Customer requested cancellation before dispatch.'},'someone-else'),/not found/);assert.equal(f.posts,0);
const row={delivery_address:{name:'Test',phone:'9876543210',pincode:'636701',address:'Test street',city:'Dharmapuri',state:'Tamil Nadu'},line_total:'1000',quantity:1,product_name:'Test product'};const loc={delhivery_warehouse_name:'Test Warehouse',delhivery_warehouse_registered_at:'2026-01-01',is_active:true,seller_status:'approved',pincode:'636701',gst_number:'33ABCDE1234F1Z5',address_line1:'Seller test street',shop_name:'Store',phone:'9876543211',city:'Dharmapuri',state:'Tamil Nadu'};const input={weight_g:'500',length_cm:'10',width_cm:'10',height_cm:'10',hsn_code:'8516'};const payload=returnPayload(row,loc,input,id);assert.equal(payload.shipments[0].payment_mode,'Pickup');assert.equal(payload.shipments[0].cod_amount,'0');assert.equal(payload.shipments[0].return_add,loc.address_line1);assert.throws(()=>returnPayload(row,{...loc,is_active:false},input,id),/warehouse/);assert.throws(()=>returnPayload(row,loc,{...input,hsn_code:''},id),/HSN/);assert.throws(()=>returnPayload({...row,line_total:'50001'},loc,input,id),/waybill/);
assert.equal(refundMatches({id:'op',payload:{payment_id:'pay_TEST',amount:100}},{id:'rfnd_TEST',payment_id:'pay_TEST',currency:'INR',amount:100,receipt:'wrong',status:'processed'}),false);
const routes=[];const a=()=>{},c=()=>{},seller=()=>{};register({get:(path,...h)=>routes.push([path,h[0]]),post:(path,...h)=>routes.push([path,h[0]])},f.db,c,seller,a);for(const [path,guard]of routes)assert.equal(guard,path.startsWith('/api/admin/')?a:path.startsWith('/api/sellers/')?seller:c);
console.log('PASS: payouts pending vs bank-settled, provider identity, COD receipt, return hold, accepted-timeout reconciliation without resend, paid cancellation/refund, once-only stock restoration, dispatch/courier/owner rejection, reverse payload validation and authenticated routes. Mock providers/DB only.');
})().catch(e=>{console.error(e);process.exitCode=1});
