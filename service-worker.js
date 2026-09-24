/* Cerood Notify service worker — no fetch interception, no cache deletion. */
self.addEventListener('push', event => {
  let data={};try{data=event.data?event.data.json():{}}catch{data={body:event.data?event.data.text():''}}
  const title=String(data.title||'Cerood').slice(0,75);
  const url=(()=>{try{const u=new URL(data.url||'/',self.location.origin);return u.origin===self.location.origin?u.href:self.location.origin+'/'}catch{return self.location.origin+'/'}})();
  event.waitUntil(self.registration.showNotification(title,{
    body:String(data.body||'Your Cerood update is here.').slice(0,180),
    icon:'/fevicon.png',badge:'/fevicon.png',tag:String(data.tag||'cerood-update').slice(0,100),
    data:{url},timestamp:Date.now()
  }));
});
self.addEventListener('notificationclick',event=>{
  event.notification.close();
  event.waitUntil((async()=>{
    const url=event.notification.data?.url||self.location.origin+'/';
    const windows=await clients.matchAll({type:'window',includeUncontrolled:true});
    for(const w of windows){if(new URL(w.url).origin===self.location.origin){await w.navigate(url);return w.focus()}}
    return clients.openWindow(url);
  })());
});
