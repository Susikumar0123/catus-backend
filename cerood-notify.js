/* Shared customer-side opt-in. Call CeroodNotify.enable() ONLY from a user click. */
(function(){'use strict';
 const API='https://catus-backend-d2js.onrender.com';
 const key='cerood_push_manage_v1';
 const decode=s=>{const x=atob(s.replace(/-/g,'+').replace(/_/g,'/'));return Uint8Array.from(x,c=>c.charCodeAt(0))};
 async function enable(division='all'){
  if(!('serviceWorker'in navigator)||!('PushManager'in window)||!('Notification'in window))throw Error('Push notifications not supported on this browser.');
  const config=await(await fetch(API+'/api/notify/config')).json();if(!config.enabled)throw Error('Notifications are not configured yet.');
  const permission=await Notification.requestPermission();if(permission!=='granted')throw Error('Notifications were not enabled.');
  const reg=await navigator.serviceWorker.register('/service-worker.js',{scope:'/'});
  const ready=await navigator.serviceWorker.ready;
  const sub=await ready.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:decode(config.publicKey)});
  const r=await fetch(API+'/api/notify/subscribe',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({subscription:sub.toJSON(),division})});
  const data=await r.json();if(!r.ok||!data.success)throw Error(data.message||'Subscription failed.');
  localStorage.setItem(key,JSON.stringify({endpoint:sub.endpoint,manageToken:data.manageToken}));return true;
 }
 async function disable(){const saved=JSON.parse(localStorage.getItem(key)||'null');const reg=await navigator.serviceWorker.getRegistration('/service-worker.js');const sub=await reg?.pushManager.getSubscription();
  if(saved?.manageToken&&saved?.endpoint)await fetch(API+'/api/notify/unsubscribe',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(saved)});
  if(sub)await sub.unsubscribe();localStorage.removeItem(key);return true;
 }
 window.CeroodNotify={enable,disable};
})();
