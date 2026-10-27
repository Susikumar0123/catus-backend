'use strict';
// Platform-controlled default. Sellers cannot override the courier in request bodies.
function assignment(env=process.env){const courier=String(env.CEROOD_SHOP_COURIER||'delhivery').trim().toLowerCase();if(!['delhivery','ekart'].includes(courier))throw Object.assign(Error('Cerood delivery assignment needs administrator configuration.'),{status:503,code:'COURIER_ASSIGNMENT'});return courier;}
function assertAssigned(courier,marketplace){if(marketplace!=='shop')return;if(!['delhivery','ekart'].includes(courier))throw Object.assign(Error('Choose an available delivery partner.'),{status:409,code:'COURIER_ASSIGNMENT'});}
function config(env=process.env){return {success:true,courier:assignment(env),assignment:'seller_choice',comparison:true,ready:true,message:'Compare available couriers for this order and pickup location before booking.'};}
module.exports={assignment,assertAssigned,config};
