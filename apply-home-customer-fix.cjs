'use strict';
const fs=require('node:fs'),path=require('node:path');
const target=path.resolve(process.argv[2]||'server.js');const original=fs.readFileSync(target,'utf8');
const marker="require('./cerood-home-admin-customers')(app, db, requireAdminAuth, ceroodHomeCustomerAuth);";
if(!fs.existsSync(path.join(path.dirname(target),'cerood-home-personal-push.js')))throw Error('Copy cerood-home-personal-push.js beside server.js first.');
if(!fs.existsSync(path.join(path.dirname(target),'cerood-home-admin-customers.js')))throw Error('Copy cerood-home-admin-customers.js beside server.js first.');
if(original.includes(marker)){console.log('Home customer integration already applied.');process.exit(0);}
const pattern=/require\('\.\/cerood-home-auth'\)\(\s*app,\s*db,\s*\{\s*verifyMsg91AccessToken,\s*extractVerifiedPhoneFromMsg91\s*\}\s*\);/g;
const matches=[...original.matchAll(pattern)];if(matches.length!==1)throw Error('Home auth registration differs from the reviewed version. No files changed. Send current server.js for review.');
if(!fs.existsSync(path.join(path.dirname(target),'cerood-home-admin-customers.js')))throw Error('Copy cerood-home-admin-customers.js beside server.js first.');
const updated=original.replace(pattern,match=>'const ceroodHomeCustomerAuth = '+match+'\n'+marker);
const vm=require('node:vm');new vm.Script(updated,{filename:target});
const backup=target+'.before-home-customers-'+Date.now()+'.bak';fs.copyFileSync(target,backup,fs.constants.COPYFILE_EXCL);fs.writeFileSync(target,updated);console.log('Applied Home Service customer integration. Backup: '+path.basename(backup));
