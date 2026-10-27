"use strict";
// Read-only provider reconciliation. Never initiates a payment, refund or transfer.
const finance=require('./cerood-shop-finance-reconciliation');
const cents=require('./cerood-shop-commission').cents;
const stable=x=>JSON.stringify(x,(k,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
const fail=message=>Object.assign(Error(message),{status:409});
async function project(c,item,provider){
 if(!await finance.hasTable(c.query.bind(c),'cerood_shop_direct_exchanges'))return item;
 const rows=await c.query("SELECT * FROM cerood_shop_direct_exchanges WHERE order_item_id=$1 AND state<>'cancelled'",[item.id]);
 if(!rows.length)return item;
 if(rows.length!==1)throw fail('Multiple exchange ledgers require reconciliation.');
 const x=rows[0];
 const order=(await c.query('SELECT * FROM cerood_shop_orders WHERE id=$1',[item.order_id]))[0];
 const replacement=(await c.query('SELECT * FROM cerood_shop_replacements WHERE id=$1',[x.replacement_id]))[0];
 const request=(await c.query('SELECT * FROM cerood_shop_return_requests WHERE id=$1',[x.return_request_id]))[0];
 // Bounded initial rollout: other exchanges/refunds on the same payment need explicit allocation.
 const siblings=await c.query("SELECT id FROM cerood_shop_direct_exchanges WHERE order_id=$1 AND id<>$2 AND state<>'cancelled'",[item.order_id,x.id]);
 const refunds=await c.query('SELECT id FROM cerood_shop_refunds WHERE order_id=$1',[item.order_id]);
 if(siblings.length||refunds.length)throw fail('Multiple exchanges or another refund on this order require reconciliation before seller payout.');
 const a=Number(x.original_paise),b=Number(x.target_paise),pay=Number(x.pay_paise),refund=Number(x.refund_paise);
 if(![a,b,pay,refund].every(Number.isSafeInteger)||a<1||b<1||a!==cents(item.line_total)||pay!==Math.max(b-a,0)||refund!==Math.max(a-b,0))throw fail('Exchange amounts do not balance.');
 if(!order||String(x.order_id)!==String(item.order_id)||String(x.order_item_id)!==String(item.id)||String(x.seller_id)!==String(item.seller_id)||String(x.customer_id)!==String(order.customer_id)||order.payment_method!=='online'||order.payment_status!=='paid'||order.status!=='delivered')throw fail('Exchange ownership or original payment status needs reconciliation.');
 const t=x.target;
 if(x.state!=='replacement_reserved'||!replacement||String(replacement.return_request_id)!==String(x.return_request_id)||String(replacement.order_item_id)!==String(item.id)||String(replacement.seller_id)!==String(item.seller_id)||replacement.status!=='delivered'||replacement.stock_restored_at||!t||String(replacement.product_id)!==String(t.product_id)||String(replacement.variant_id||'')!==String(t.variant_id||'')||Number(replacement.quantity)!==Number(t.quantity)||Number(t.quantity)!==Number(item.quantity)||!request||String(request.order_item_id)!==String(item.id)||request.status!=='replaced'||!request.inspected_at)throw fail('Complete the inspected exchange and replacement delivery before settlement.');
 const delivered=new Date(replacement.stage_dates?.delivered||'');
 if(!Number.isFinite(delivered.getTime())||delivered.getTime()>Date.now())throw fail('Replacement delivery timestamp needs reconciliation.');
 provider=provider||require('./cerood-shop-operations').providers();
 const original=await provider.rz('v1/payments/'+order.razorpay_payment_id);
 if(original.id!==order.razorpay_payment_id||original.order_id!==order.razorpay_order_id||original.currency!=='INR'||original.status!=='captured'||Number(original.amount)!==cents(order.total)||Number(original.amount_refunded||0)!==refund)throw fail('Original payment credit or refund total needs reconciliation.');
 if(pay){
  if(!/^pay_[A-Za-z0-9]+$/.test(x.razorpay_payment_id||'')||!/^order_[A-Za-z0-9]+$/.test(x.razorpay_order_id||''))throw fail('Difference payment references are missing.');
  const payment=await provider.rz('v1/payments/'+x.razorpay_payment_id);
  const intent=await provider.rz('v1/orders/'+x.razorpay_order_id);
  if(payment.id!==x.razorpay_payment_id||payment.order_id!==x.razorpay_order_id||payment.currency!=='INR'||payment.status!=='captured'||Number(payment.amount)!==pay||Number(payment.amount_refunded||0)!==0||intent.id!==x.razorpay_order_id||intent.currency!=='INR'||Number(intent.amount)!==pay||intent.receipt!==x.id||intent.notes?.cerood_direct_exchange!==x.id)throw fail('Difference payment needs provider reconciliation.');
 }
 if(refund){
  if(x.refund_payment_id!==order.razorpay_payment_id||!/^rfnd_[A-Za-z0-9]+$/.test(x.refund_id||''))throw fail('Difference refund references are missing.');
  const evidence=await provider.rz('v1/refunds/'+x.refund_id);
  if(evidence.id!==x.refund_id||evidence.payment_id!==order.razorpay_payment_id||evidence.currency!=='INR'||evidence.status!=='processed'||Number(evidence.amount)!==refund||evidence.receipt!==x.id)throw fail('Difference refund has not been verified as processed.');
 }
 const exchange={version:1,id:x.id,product_id:t.product_id,variant_id:t.variant_id||null,quantity:Number(t.quantity),product_name:t.product_name||null,replacement_id:x.replacement_id,original_amount:(a/100).toFixed(2),target_amount:(b/100).toFixed(2),difference_payment:(pay/100).toFixed(2),difference_refund:(refund/100).toFixed(2),payment_id:pay?x.razorpay_payment_id:null,refund_id:refund?x.refund_id:null,replacement_delivered_at:delivered.toISOString()};
 return {...item,line_total:exchange.target_amount,delivered_at:exchange.replacement_delivered_at,exchange};
}
function assertPrepared(settlement,item){
 if(!item.exchange)return;
 const saved=settlement.finance_breakdown;
 if(cents(settlement.gross_amount)!==cents(item.line_total)||stable(saved?.exchange)!==stable(item.exchange))throw fail('Prepared settlement does not match the reconciled exchange. Do not transfer funds.');
 const commission=require('./cerood-shop-commission');
 const expected=commission.quote(item,{commission_confirmed:true,charges:saved.charges,legacy_terms_confirmed:true,legacy_commission_percent:saved.commission_percent,legacy_hold_days:saved.hold_days});
 if(cents(settlement.deductions)!==cents(expected.deductions)||new Date(settlement.release_at).toISOString()!==expected.release_at)throw fail('Exchange commission or delivery hold changed. Reconcile before payout.');
}
module.exports={project,assertPrepared};
