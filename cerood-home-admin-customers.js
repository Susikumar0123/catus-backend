'use strict';
// Home Services only. Never joins shopping users or returns password/session fields.
module.exports=function registerHomeCustomerAdmin(app,db,requireAdminAuth,homeAuth){
 if(typeof homeAuth?.requireHomeAuth!=='function'||typeof homeAuth?.ensureSchema!=='function')throw Error('Home customer auth helpers are required.');
 const query=(sql,args=[])=>new Promise((resolve,reject)=>db.query(sql,args,(err,rows)=>err?reject(err):resolve(rows||[])));
 const phoneSQL=column=>`RIGHT(regexp_replace(COALESCE(${column}::text,''),'[^0-9]','','g'),10)`;
 const link=`(o.customer_id::text=c.id::text OR (NULLIF(BTRIM(o.customer_id::text),'') IS NULL AND ${phoneSQL('o.phone')}=c.phone))`;
 const safeError=(res,error)=>{console.error('Home customer admin:',error.code||error.message);return res.status(500).json({success:false,message:'Unable to load Home Service customer data.'});};
 // Enforce the existing Home Service JWT before the original booking handler.
 // Address/contact fields may differ; account ownership always comes from the server.
 app.post('/api/home-services/free-bookings',homeAuth.requireHomeAuth,(req,res,next)=>{
  req.body={...(req.body||{}),customer_id:String(req.homeServiceCustomer.id)};next();
 });
 app.get('/api/admin/home-services/orders',requireAdminAuth,async(req,res)=>{
  try{await homeAuth.ensureSchema();const orders=await query(`SELECT o.*,
   c.id AS registered_customer_id,c.name AS registered_customer_name,
   c.phone AS registered_customer_phone,c.email AS registered_customer_email
   FROM public.orders o LEFT JOIN public.cerood_home_service_customers c ON ${link}
   ORDER BY o.id DESC`);res.set('Cache-Control','private, no-store');res.json({success:true,orders});}
  catch(error){safeError(res,error);}
 });
 app.get('/api/admin/home-services/customers',requireAdminAuth,async(req,res)=>{
  try{await homeAuth.ensureSchema();
   const customers=await query(`SELECT c.id::text AS id,c.name,c.email,c.phone,c.address,c.pincode,
     'registered'::text AS source,'Registered'::text AS status,COUNT(o.order_id)::int AS total_orders
    FROM public.cerood_home_service_customers c LEFT JOIN public.orders o ON ${link}
    GROUP BY c.id
    UNION ALL
    SELECT 'booking:'||${phoneSQL('o.phone')} AS id,
     (array_agg(o.customer_name ORDER BY o.id DESC))[1] AS name,
     NULL::text AS email,${phoneSQL('o.phone')} AS phone,
     (array_agg(COALESCE(o.service_address,o.address) ORDER BY o.id DESC))[1] AS address,
     (array_agg(o.pincode ORDER BY o.id DESC))[1] AS pincode,
     'booking_contact'::text AS source,'Booking contact'::text AS status,COUNT(*)::int AS total_orders
    FROM public.orders o
    WHERE NOT EXISTS(SELECT 1 FROM public.cerood_home_service_customers c WHERE ${link})
      AND ${phoneSQL('o.phone')} ~ '^[6-9][0-9]{9}$'
    GROUP BY ${phoneSQL('o.phone')}
    ORDER BY name,id`);
   res.set('Cache-Control','private, no-store');res.json({success:true,customers});
  }catch(error){safeError(res,error);}
 });
 // Authenticated customer list uses account ID, not an arbitrary phone URL.
 app.get('/api/home-services/customer/orders',homeAuth.requireHomeAuth,async(req,res)=>{
  try{const rows=await query(`SELECT * FROM public.orders o
    WHERE o.customer_id::text=? OR (NULLIF(BTRIM(o.customer_id::text),'') IS NULL AND ${phoneSQL('o.phone')}=?)
    ORDER BY o.id DESC`,[String(req.homeServiceCustomer.id),req.homeServiceCustomer.phone]);
   const orders=rows.map(row=>{const clean={...row};for(const key of ['technician_phone','customer_approval_key_hash','customer_approval_key','booking_request_id'])delete clean[key];return clean;});
   res.set('Cache-Control','private, no-store');res.json({success:true,orders});
  }catch(error){safeError(res,error);}
 });
 app.patch('/api/admin/home-services/orders/:orderId/reject',requireAdminAuth,async(req,res)=>{
  try{const id=String(req.params.orderId||'').trim();if(!id||id.length>150)return res.status(400).json({success:false,message:'Valid booking ID is required.'});
   // No delete, refund or payment mutation. Completed work requires separate review.
   const rows=await query(`UPDATE public.orders SET status='Rejected'
    WHERE order_id=? AND LOWER(COALESCE(status,'')) NOT IN ('completed') RETURNING order_id,status`,[id]);
   if(!rows.length)return res.status(409).json({success:false,message:'Booking not found or already completed. Completed work requires separate review.'});
   res.json({success:true,order:rows[0]});
  }catch(error){safeError(res,error);}
 });
};
