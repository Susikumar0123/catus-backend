'use strict';
const DEFAULT_ORIGIN='https://cerood-local-discovery.susikumar.chatgpt.site';
function exactOrigin(value){
 const clean=String(value||'').trim().replace(/\/$/,'');
 let parsed;try{parsed=new URL(clean)}catch{throw new Error('Local Discovery origins must be exact HTTPS origins')}
 if(parsed.origin!==clean||parsed.username||parsed.password||!(parsed.protocol==='https:'||(parsed.protocol==='http:'&&parsed.hostname==='localhost')))throw new Error('Local Discovery origins must be exact HTTPS origins');
 return clean;
}
function createOriginPolicy(env=process.env,{requirePrimary=false}={}){
 if(requirePrimary&&!env.LOCAL_DISCOVERY_ORIGIN)throw new Error('Exact LOCAL_DISCOVERY_ORIGIN is required');
 const primary=exactOrigin(env.LOCAL_DISCOVERY_ORIGIN||DEFAULT_ORIGIN);
 const extra=String(env.LOCAL_DISCOVERY_ALLOWED_ORIGINS||'').split(',').map(x=>x.trim()).filter(Boolean);
 if(extra.length>10)throw new Error('Use at most ten additional Local Discovery origins');
 const allowed=new Set([primary,...extra.map(exactOrigin)]);
 return {primary,secure:primary.startsWith('https:'),allows(origin){return typeof origin==='string'&&allowed.has(origin)}};
}
module.exports={createOriginPolicy};
