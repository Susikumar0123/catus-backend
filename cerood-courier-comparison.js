'use strict';
function weight(body,divisor){const keys=['weight_g','length_cm','width_cm','height_cm'];const v=Object.fromEntries(keys.map(k=>[k,Number(body[k])]));for(const k of keys)if(!Number.isSafeInteger(v[k])||v[k]<1||v[k]>(k==='weight_g'?100000:500))throw Object.assign(Error('Enter packed weight (1–100000 g) and dimensions (1–500 cm).'),{status:400});const d=Number(divisor);return {...v,chargeable_g:Number.isFinite(d)&&d>=1000&&d<=10000?Math.max(v.weight_g,Math.ceil(v.length_cm*v.width_cm*v.height_cm*1000/d)):null};}
function total(data){const row=Array.isArray(data)&&data.length===1?data[0]:!Array.isArray(data)?data:null;const n=Number(row?.total_amount??row?.Total_amount);return Number.isFinite(n)&&n>0&&n<=100000?Math.round(n*100)/100:null;}
module.exports={weight,total};
