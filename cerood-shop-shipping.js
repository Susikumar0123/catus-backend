'use strict';
const fail=message=>Object.assign(Error(message),{status:409});
const cents=v=>{const n=Math.round(Number(v)*100);if(!Number.isSafeInteger(n)||n<0)throw fail('Stored shipping amount requires review.');return n;};
function allocation(allItems,groupIds,total){
 const group=new Set(groupIds.map(String));const active=allItems.filter(i=>i.seller_id&&!['rejected','cancelled'].includes(String(i.seller_order_status||'new'))).sort((a,b)=>BigInt(a.id)<BigInt(b.id)?-1:BigInt(a.id)>BigInt(b.id)?1:0);
 const original=allItems.reduce((n,i)=>n+cents(i.line_total),0),subtotal=allItems.filter(i=>group.has(String(i.id))).reduce((n,i)=>n+cents(i.line_total),0);
 const adjustment=cents(total)-original,allocated=active.length&&group.has(String(active[0].id))?adjustment:0;
 const value=subtotal+allocated;if(!Number.isSafeInteger(value)||value<100)throw fail('Shipment value is invalid after order adjustments.');
 return {sellerSubtotal:subtotal/100,allocatedAdjustment:allocated/100,shipmentValue:value/100};
}
async function guardBooking(client,parcel,otherTable){
 const order=(await client.query('SELECT status,payment_method,payment_status,total FROM cerood_shop_orders WHERE id=$1 FOR UPDATE',[parcel.orderId]))[0];
 if(!order||!['confirmed','processing','packed','shipped'].includes(order.status)||(order.payment_method!=='cod'&&order.payment_status!=='paid'))throw fail('Main Store order is not ready for shipping.');
 const rows=await client.query('SELECT id,seller_id,line_total,quantity,fulfilment_location_id,seller_order_status FROM cerood_shop_order_items WHERE order_id=$1 ORDER BY id FOR UPDATE',[parcel.orderId]);
 const ids=parcel.items.map(i=>String(i.id));const current=rows.filter(i=>ids.includes(String(i.id)));
 if(current.length!==ids.length||current.some(i=>String(i.seller_id)!==parcel.sellerId||String(i.fulfilment_location_id)!==parcel.fulfilmentLocationId||!['packed','shipped'].includes(i.seller_order_status)))throw fail('Parcel items changed. Refresh orders before booking.');
 Object.assign(parcel,allocation(rows,ids,order.total));parcel.codAmount=order.payment_method==='cod'?parcel.shipmentValue:0;
 if(!['cerood_ekart_shipments','cerood_delhivery_shipments'].includes(otherTable))throw fail('Invalid courier reference.');
 const exists=await client.query('SELECT to_regclass($1) AS relation',['public.'+otherTable]);
 if(exists[0]?.relation){const other=await client.query(`SELECT id FROM public.${otherTable} WHERE marketplace='shop' AND order_id=$1 AND seller_id=$2 AND fulfilment_location_id=$3 AND cancelled_at IS NULL AND booking_state NOT IN ('failed','cancelled') LIMIT 1`,[parcel.orderId,parcel.sellerId,parcel.fulfilmentLocationId]);if(other.length)throw fail('Another courier booking exists or is uncertain. Verify it before creating a second parcel.');}
}
async function customerParcels(query,orderId){
 const result=[];
 for(const [table,courier,awb] of [['cerood_ekart_shipments','Ekart','tracking_id'],['cerood_delhivery_shipments','Delhivery','waybill']]){
  const exists=await query('SELECT to_regclass(?) AS relation',['public.'+table]);if(!exists[0]?.relation)continue;
  const rows=await query(`SELECT ${awb} AS awb,booking_state,last_tracking_status,last_tracking_at,booked_at,order_item_refs FROM public.${table} WHERE marketplace='shop' AND order_id=? AND cancelled_at IS NULL AND ${awb} IS NOT NULL AND booking_state NOT IN ('failed','cancelled') ORDER BY booked_at`,[String(orderId)]);
  for(const row of rows)result.push({courier,awb:row.awb,status:row.last_tracking_status||row.booking_state,updated_at:row.last_tracking_at||row.booked_at,order_item_refs:Array.isArray(row.order_item_refs)?row.order_item_refs:[]});
 }
 return result;
}
module.exports={allocation,guardBooking,customerParcels};
