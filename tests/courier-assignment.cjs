'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs');const p=require('../cerood-shop-courier-policy');
assert.equal(p.assignment({}),'delhivery');assert.equal(p.config({}).ready,false);assert.equal(p.config({DELHIVERY_API_TOKEN:'private',DELHIVERY_CLIENT_NAME:'Exact'}).ready,true);assert.equal(p.config({CEROOD_SHOP_COURIER:'ekart'}).ready,false);assert.throws(()=>p.assignment({CEROOD_SHOP_COURIER:'unknown'}));
const old=process.env.CEROOD_SHOP_COURIER;delete process.env.CEROOD_SHOP_COURIER;assert.throws(()=>p.assertAssigned('ekart','shop'),/assigned/);p.assertAssigned('delhivery','shop');p.assertAssigned('ekart','renewed');process.env.CEROOD_SHOP_COURIER='ekart';assert.throws(()=>p.assertAssigned('delhivery','shop'));p.assertAssigned('ekart','shop');if(old===undefined)delete process.env.CEROOD_SHOP_COURIER;else process.env.CEROOD_SHOP_COURIER=old;
assert(!JSON.stringify(p.config({DELHIVERY_API_TOKEN:'private',DELHIVERY_CLIENT_NAME:'Exact'})).includes('private'));
for(const [f,c] of [['cerood-seller-delhivery.js','delhivery'],['cerood-seller-ekart.js','ekart']])assert(fs.readFileSync(require.resolve('../'+f),'utf8').includes("assertAssigned('"+c+"', ref.marketplace)"));
assert(fs.readFileSync(require.resolve('../cerood-seller-delhivery'),'utf8').includes("app.get('/api/sellers/shipping-assignment', requireSellerAuth"));
console.log('PASS: platform default, courier override, readiness without secret exposure, shop-only enforcement and authenticated assignment route. No courier request made.');
