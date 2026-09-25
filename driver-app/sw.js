const CACHE='smart-chat-shell-v320';
const ASSETS=['./','./index.html','./app.css?v=510','./messenger.css?v=510','./polish.css?v=520','./app.js?v=520','./config.js?v=511','./push-config.js?v=520','../js/checklist-media.js?v=510','./manifest.webmanifest','./icons/smart-risk.png','./icons/icon-192.png','./icons/icon-512.png'];
const paths=new Set(ASSETS.map(p=>new URL(p,self.location).href));
self.addEventListener('install',e=>e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS))));
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>(k.startsWith('smart-chat-shell-')&&k!==CACHE)||k.startsWith('checklist-shell-')||k.startsWith('central-smart-risk-checklist-')).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',e=>{
 if(e.request.method!=='GET'||new URL(e.request.url).origin!==self.location.origin)return;
 if(e.request.mode==='navigate'){e.respondWith(fetch(e.request).catch(()=>caches.match('./index.html')));return;}
 if(!paths.has(e.request.url))return;
 e.respondWith(fetch(e.request).then(r=>{if(r.ok){const copy=r.clone();caches.open(CACHE).then(c=>c.put(e.request,copy));}return r;}).catch(()=>caches.match(e.request)));
});
self.addEventListener('notificationclick',e=>{e.notification.close();e.waitUntil(clients.matchAll({type:'window'}).then(async pages=>{const page=pages.find(p=>p.url.startsWith(self.registration.scope));if(page)return page.focus();return clients.openWindow(self.registration.scope);}));});
self.addEventListener('push',e=>{let data={};try{data=e.data?.json()||{};}catch{data={body:e.data?.text()||'Você recebeu uma nova mensagem.'};}e.waitUntil(self.registration.showNotification(data.title||'Smart Chat',{body:data.body||'Seu atendimento foi atualizado.',icon:'icons/icon-192.png',badge:'icons/icon-192.png',tag:data.tag||'smart-chat-message',renotify:true,data:{url:data.url||self.registration.scope}}));});
