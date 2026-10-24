'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=process.cwd();
const serverPath=path.join(root,'server.js'),authPath=path.join(root,'local-discovery','local-discovery-auth.js');
function once(source,from,to,label){if(source.split(from).length!==2)throw new Error('Unrecognised '+label+'; no files changed. Share the current file for a matching patch.');return source.replace(from,to)}
function prepare(server,auth){
 const serverMarker="const localDiscoveryOriginPolicy = require('./local-discovery/origin-policy').createOriginPolicy(process.env);";
 const authMarker="const originPolicy = require('./origin-policy').createOriginPolicy(env,{requirePrimary:true});";
 if(server.includes(serverMarker)&&auth.includes(authMarker))return {server,auth,changed:false};
 if(server.includes(serverMarker)||auth.includes(authMarker))throw new Error('Only part of the patch is present. No files changed.');
 const oldServer="const localDiscoveryOrigin = String(process.env.LOCAL_DISCOVERY_ORIGIN ||\n    'https://cerood-local-discovery.susikumar.chatgpt.site').replace(/\\/$/, '');";
 const oldAuth="  const origin = String(env.LOCAL_DISCOVERY_ORIGIN || '').replace(/\\/$/, '');\n  if (!/^https:\\/\\/[^/]+$/.test(origin) && !/^http:\\/\\/localhost(?::\\d+)?$/.test(origin)) {\n    throw new Error('Exact LOCAL_DISCOVERY_ORIGIN is required');\n  }";
 server=once(server,oldServer,serverMarker,'server origin declaration');
 server=once(server,'origin && origin !== localDiscoveryOrigin','origin && !localDiscoveryOriginPolicy.allows(origin)','server origin guard');
 server=once(server,"res.set('Access-Control-Allow-Origin', localDiscoveryOrigin);","res.set('Access-Control-Allow-Origin', origin);",'server CORS response');
 auth=once(auth,oldAuth,'  '+authMarker,'auth origin declaration');
 auth=once(auth,"const secure = origin.startsWith('https:');",'const secure = originPolicy.secure;','auth secure cookie setting');
 auth=once(auth,'requestOrigin && requestOrigin !== origin','requestOrigin && !originPolicy.allows(requestOrigin)','auth origin guard');
 new vm.Script(server,{filename:'server.js'});new vm.Script(auth,{filename:'local-discovery-auth.js'});
 return {server,auth,changed:true};
}
if(require.main===module){try{
 if(!fs.existsSync(path.join(root,'local-discovery','origin-policy.js')))throw new Error('Copy local-discovery/origin-policy.js into this backend folder first.');
 const server=fs.readFileSync(serverPath,'utf8'),auth=fs.readFileSync(authPath,'utf8');
 const normal=value=>value.replace(/\r\n/g,'\n');const result=prepare(normal(server),normal(auth));
 if(!result.changed){console.log('Local origin patch already applied.');process.exit(0)}
 const stamp=new Date().toISOString().replace(/[:.]/g,'-');
 fs.writeFileSync(serverPath+'.before-local-origin-'+stamp+'.bak',server,{flag:'wx'});
 fs.writeFileSync(authPath+'.before-local-origin-'+stamp+'.bak',auth,{flag:'wx'});
 fs.writeFileSync(serverPath,result.server);fs.writeFileSync(authPath,result.auth);
 console.log('Patched Local auth origins. Existing global CORS, Home Service and ecommerce routes were preserved.');
 console.log('Set LOCAL_DISCOVERY_ALLOWED_ORIGINS to the exact additional domains in Render; no environment variables were changed.');
}catch(error){console.error(error.message);process.exitCode=1}}
module.exports={prepare};
