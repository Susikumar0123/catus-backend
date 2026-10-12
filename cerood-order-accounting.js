'use strict';
// Fixed, internal source names only. Never interpolate request values into SQL.
const renewed=source=>source==='renewed'||source==='Renewed';
function delivery(source){return renewed(source)?"COALESCE(NULLIF(to_jsonb(o)->>'delivery_status',''),to_jsonb(o)->>'status','')":"COALESCE(to_jsonb(o)->>'status','')";}
function eligible(source){
 const payment=renewed(source)?"(to_jsonb(o)->>'payment_method'='cod' OR (to_jsonb(o)->>'status' IN ('paid','processing','shipped','delivered') AND NULLIF(to_jsonb(o)->>'paid_at','') IS NOT NULL))":"(to_jsonb(o)->>'payment_method'='cod' OR to_jsonb(o)->>'payment_status' IN ('paid','captured','success'))";
 return `COALESCE(to_jsonb(o)->>'status','') NOT IN ('creating_order','pending_payment','pending','payment_review','cancelled','canceled','failed','refunded','refund_pending','expired')
 AND ${payment} AND COALESCE(to_jsonb(i)->>'seller_order_status','new') NOT IN ('rejected','cancelled')`;
}
function itemValue(){return "COALESCE(NULLIF(to_jsonb(i)->>'discounted_line_total','')::numeric,NULLIF(to_jsonb(i)->>'line_total','')::numeric,NULLIF(to_jsonb(i)->>'total_price','')::numeric)";}
function eventEligible(source){
 const payment=renewed(source)?"(to_jsonb(o)->>'payment_method'='cod' OR (to_jsonb(o)->>'status' IN ('paid','processing','shipped','delivered','cancelled','refund_pending','refunded') AND NULLIF(to_jsonb(o)->>'paid_at','') IS NOT NULL))":"(to_jsonb(o)->>'payment_method'='cod' OR to_jsonb(o)->>'payment_status' IN ('paid','captured','success','refunded'))";
 return `COALESCE(to_jsonb(o)->>'status','') NOT IN ('creating_order','pending_payment','pending','payment_review','failed','expired') AND ${payment}`;
}
module.exports={delivery,eligible,itemValue,eventEligible};
