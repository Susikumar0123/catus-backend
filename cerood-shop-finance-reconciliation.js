'use strict';
const uuid=x=>/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(String(x||''));
const fail=(message,status=409)=>Object.assign(Error(message),{status});
function cents(x){if(!/^\d{1,10}(\.\d{1,2})?$/.test(String(x??'')))throw fail('Enter a non-negative amount with at most two decimal places.',400);const n=Math.round(Number(x)*100);if(!Number.isSafeInteger(n))throw fail('Amount requires review.',400);return n;}
function evidence(body,flag,field){const reference=String(body[field]||'').trim(),note=String(body.note||'').trim();if(body[flag]!==true||reference.length<5||reference.length>120||note.length<10||note.length>1500)throw fail('Confirm the actual completed receipt and enter its reference (5–120 characters) and explanation (10–1500 characters).',400);return {reference,note};}
async function transaction(db,fn){const c=await db.getClient();let done=false;try{await c.query('BEGIN');const result=await fn(c);await c.query('COMMIT');done=true;return result;}finally{try{if(!done)await c.query('ROLLBACK')}finally{c.release()}}}
async function hasTable(q,name){return !!(await q('SELECT to_regclass($1) AS relation',['public.'+name]))[0]?.relation;}
async function codReceipt(c,order){if(!await hasTable(c.query.bind(c),'cerood_shop_cod_receipts'))throw fail('Run migration 014 before reconciling COD settlements.',503);const row=(await c.query('SELECT * FROM cerood_shop_cod_receipts WHERE order_id=$1',[order.id]))[0];if(!row||cents(row.gross_amount)!==cents(order.total))throw fail('Reconcile the completed COD collection/remittance before preparing or paying this seller item.');return row;}
async function refundBlockers(c,item){
 const rows=await c.query("SELECT id,status,gross_amount,deductions FROM cerood_shop_settlements WHERE order_item_id=$1 AND status<>'void' FOR UPDATE",[item]);
 if(!rows.length)return [];
 if(!await hasTable(c.query.bind(c),'cerood_shop_settlement_recoveries'))return rows;
 const blockers=[];for(const s of rows){const r=(await c.query('SELECT recovered_amount FROM cerood_shop_settlement_recoveries WHERE settlement_id=$1',[s.id]))[0];if(s.status!=='paid'||!r||cents(r.recovered_amount)!==cents(s.gross_amount)-cents(s.deductions))blockers.push(s);}return blockers;
}
async function recordCod(db,id,body={}){
 if(!uuid(id))throw fail('Invalid COD order.',400);const {reference,note}=evidence(body,'receipt_confirmed','receipt_reference'),received=cents(body.received_amount),deductions=cents(body.courier_deductions??0);
 return transaction(db,async c=>{
  const order=(await c.query('SELECT * FROM cerood_shop_orders WHERE id=$1 FOR UPDATE',[id]))[0];if(!order)throw fail('Order not found.',404);
  if(order.payment_method!=='cod'||order.status!=='delivered')throw fail('Only a delivered COD order can have a completed receipt recorded.');
  const gross=cents(order.total);if(gross<1||received+deductions!==gross)throw fail('Received money plus reconciled courier deductions must equal the complete order total.',400);
  const old=(await c.query('SELECT * FROM cerood_shop_cod_receipts WHERE order_id=$1',[id]))[0];if(old){if(cents(old.received_amount)!==received||cents(old.courier_deductions)!==deductions||old.receipt_reference!==reference||old.note!==note)throw fail('A different COD receipt is already recorded; it cannot be overwritten.');return {receipt:old,idempotent:true};}
  const reserved=(await c.query("SELECT COALESCE(sum(s.gross_amount-s.deductions),0) AS amount FROM cerood_shop_settlements s JOIN cerood_shop_order_items i ON i.id=s.order_item_id WHERE i.order_id=$1 AND s.status<>'void'",[id]))[0];if(cents(reserved.amount)>received)throw fail('Existing seller commitments exceed this remittance. Reconcile those records before recording the receipt.');
  const row=(await c.query('INSERT INTO cerood_shop_cod_receipts(order_id,gross_amount,received_amount,courier_deductions,receipt_reference,note) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',[id,gross/100,received/100,deductions/100,reference,note]))[0];return {receipt:row,idempotent:false};
 });
}
async function recordRecovery(db,id,body={}){
 if(!uuid(id))throw fail('Invalid settlement.',400);const {reference,note}=evidence(body,'recovery_confirmed','recovery_reference'),received=cents(body.recovered_amount);
 return transaction(db,async c=>{
  const link=(await c.query('SELECT i.order_id,i.id AS item_id FROM cerood_shop_settlements s JOIN cerood_shop_order_items i ON i.id=s.order_item_id WHERE s.id=$1',[id]))[0];if(!link)throw fail('Settlement not found.',404);
  await c.query('SELECT id FROM cerood_shop_orders WHERE id=$1 FOR UPDATE',[link.order_id]);await c.query('SELECT id FROM cerood_shop_order_items WHERE id=$1 FOR UPDATE',[link.item_id]);
  const s=(await c.query('SELECT * FROM cerood_shop_settlements WHERE id=$1 FOR UPDATE',[id]))[0];const due=cents(s.gross_amount)-cents(s.deductions);if(s.status!=='paid'||due<1||received!==due)throw fail('Record only the fully recovered amount of this paid seller transfer.',400);
  const old=(await c.query('SELECT * FROM cerood_shop_settlement_recoveries WHERE settlement_id=$1',[id]))[0];if(old){if(cents(old.recovered_amount)!==received||old.recovery_reference!==reference||old.note!==note)throw fail('A different recovery is already recorded; it cannot be overwritten.');return {recovery:old,idempotent:true};}
  const active=await c.query("SELECT id FROM cerood_shop_return_requests WHERE order_item_id=$1 AND request_type='return' AND status IN ('approved','pickup_scheduled','picked_up','received')",[link.item_id]);if(!active.length)throw fail('An approved active item return is required to reconcile this recovery.');
  const row=(await c.query('INSERT INTO cerood_shop_settlement_recoveries(settlement_id,recovered_amount,recovery_reference,note) VALUES($1,$2,$3,$4) RETURNING *',[id,received/100,reference,note]))[0];return {recovery:row,idempotent:false};
 });
}
function register(app,db,admin){const q=(sql,args=[])=>new Promise((resolve,reject)=>db.query(sql,args,(e,r)=>e?reject(e):resolve(r||[])));const handle=fn=>async(req,res)=>{res.set('Cache-Control','no-store');try{res.json({success:true,...await fn(req)})}catch(e){res.status(e.status||503).json({success:false,message:e.status?e.message:'Financial reconciliation unavailable. Check migration 014 and refresh.'})}};
 app.get('/api/admin/shop/cod-reconciliation',admin,handle(async()=>({
  pending:await q("SELECT o.id,o.total,o.created_at FROM cerood_shop_orders o WHERE o.status='delivered' AND o.payment_method='cod' AND NOT EXISTS(SELECT 1 FROM cerood_shop_cod_receipts r WHERE r.order_id=o.id) ORDER BY o.created_at DESC LIMIT 100"),
  receipts:await q('SELECT * FROM cerood_shop_cod_receipts ORDER BY recorded_at DESC LIMIT 300'),scope:'Completed COD remittance verified manually by admin; no bank or courier API reconciliation is performed.'
 })));
 app.post('/api/admin/shop/orders/:id/cod-receipt',admin,handle(req=>recordCod(db,req.params.id,req.body)));
 app.post('/api/admin/shop/settlements/:id/recovery',admin,handle(req=>recordRecovery(db,req.params.id,req.body)));
}
module.exports={register,recordCod,recordRecovery,refundBlockers,codReceipt,hasTable,cents,evidence};
