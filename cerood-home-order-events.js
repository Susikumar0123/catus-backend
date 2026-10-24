'use strict';
const crypto=require('node:crypto');
const normal=x=>String(x||'').trim().toLowerCase();
function imageURL(value){if(!String(value||'').trim())return null;try{const u=new URL(value,'https://www.cerood.com');return u.protocol==='https:'&&!u.username&&!u.password&&u.href.length<=2048?u.href:null;}catch{return null;}}
function describe(order,event='status'){
 const status=normal(order.status),service=String(order.service_name||'Service').trim().slice(0,90);
 if(status==='trash')return null;
 let label,detail,revision='';
 if(event==='status'){
  const states={pending:['Booked','booking has been received.'],assigned:['Technician assigned','booking has a technician assigned.'],'on the way':['On the way','technician is on the way.'],'in service':['Service started','service has started.'],completed:['Completed','service has been marked completed.'],rejected:['Rejected','booking was rejected.'],cancelled:['Cancelled','booking was cancelled.'],'re-service requested':['Re-service requested','re-service request has been recorded.']};
  if(!states[status])return null;[label,detail]=states[status];
  revision=status==='assigned'?String(order.technician_id||'')+'|'+String(order.assigned_at||''):status==='on the way'?String(order.on_the_way_at||''):status==='in service'?String(order.service_started_at||''):status==='completed'?String(order.completed_at||''):'';
 }else{
  if(['rejected','cancelled','completed'].includes(status))return null;
  if(event==='inspection'&&normal(order.inspection_fee_status)==='awaiting customer confirmation'){label='Approval needed';detail='inspection / visiting fee is ready for your approval.';revision=String(order.inspection_fee);}
  else if(event==='inspection-response'&&['confirmed','declined'].includes(normal(order.inspection_fee_status))){label=normal(order.inspection_fee_status)==='confirmed'?'Inspection approved':'Inspection declined';detail='inspection fee decision has been saved.';revision=String(order.inspection_fee_status)+'|'+String(order.inspection_fee_confirmed_at||'');}
  else if(event==='appointment'&&normal(order.appointment_status)==='confirmed'){label='Appointment confirmed';detail='service appointment has been confirmed.';revision=[order.appointment_date,order.appointment_window,order.appointment_confirmed_at].join('|');}
  else if(event==='inspection-completed'&&order.inspection_completed_at){label='Inspection completed';detail='inspection has been marked completed.';revision=String(order.inspection_completed_at);}
  else if(event==='send-quotation'&&normal(order.repair_quote_status)==='sent'){label='Repair approval needed';detail='repair quotation is ready for your approval.';revision=String(order.repair_quote_sent_at||'')+'|'+String(order.repair_quote_amount);}
  else if(event==='quotation-response'&&['accepted','rejected'].includes(normal(order.repair_quote_status))){label='Quotation decision saved';detail='repair quotation decision has been recorded.';revision=String(order.repair_quote_status)+'|'+String(order.repair_quote_responded_at||'');}
  else return null;
 }
 const key=status==='rejected'?'rejected:'+order.order_id:'order-event:'+crypto.createHash('sha256').update([order.order_id,event,status,revision].join('|')).digest('hex');
 return {title:(service.slice(0,45)+' · '+label).slice(0,75),body:('Your '+service+' '+detail+' Open My Bookings for details.').slice(0,180),orderId:order.order_id,key,image:imageURL(order.service_image_url)};
}
module.exports={describe,imageURL};
