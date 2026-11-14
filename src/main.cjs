const {app,BrowserWindow,ipcMain,safeStorage,Notification,Tray,Menu,nativeImage,screen}=require('electron');
const fs=require('node:fs'),path=require('node:path');const {randomBytes}=require('node:crypto');
const {Gate}=require('./gate.cjs'),{RuleBook}=require('./rules.cjs'),{Jobs}=require('./jobs.cjs');const {MemoryBook}=require('./memory.cjs');
const {createIdentityResolver,identityFromEntity}=require('./identity.cjs');const tg=require('./telegram.cjs'),advanced=require('./advanced.cjs');const {serve}=require('./server.cjs'),{normalizeProxy}=require('./proxy.cjs'),ProxyManager=require('./proxy-manager.cjs');
const approvalSmoke=process.argv.includes('--approval-smoke')&&!app.isPackaged;
if(approvalSmoke)app.setPath('userData',path.join(app.getPath('temp'),'telegate-approval-smoke-'+process.pid));
let win,popup,tray,server,config,file,jobs,memories,proxyState,quitting=false,notificationReady=false,notificationWanted=false;
const {SyncService}=require('./sync-service.cjs'),{TelegramSyncTransport}=require('./sync-telegram.cjs'),SyncCore=require('./sync-core.cjs'),SyncLocal=require('./sync-local.cjs');
let sync, syncData=null, syncTimer, syncSetupBusy=false;const syncNotified=new Set();
const notified=new Set();
const {LoginService}=require('./login.cjs');
const proxyRoutes=new Map(),preferredProxyRoutes=new Map(),proxyHealth=new Map();
const login=new LoginService({connect:account=>connectAccount(account,'',proxyState.defaultPolicy),release:async id=>disconnectAccount(id,true),complete:(account,c,user)=>{if(config.accounts.some(a=>a.telegramId===user.id.toString()))throw Error('This Telegram account is already added.');const added={...account,telegramId:user.id.toString(),apiHash:lock(account.apiHash),session:lock(c.session.save())};config.accounts.push(added);try{save();}catch(e){config.accounts.pop();throw e;}},notify:broadcast});const assets=path.join(__dirname,'assets');
const lock=s=>{if(!safeStorage.isEncryptionAvailable())throw Error('Windows secure storage unavailable');return safeStorage.encryptString(s).toString('base64');};
const unlock=s=>safeStorage.decryptString(Buffer.from(s,'base64'));
function save(){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file+'.tmp',JSON.stringify(config));fs.renameSync(file+'.tmp',file);}
function applyStartupSetting(){if(process.platform==='win32'&&app.isPackaged&&!approvalSmoke)app.setLoginItemSettings({openAtLogin:config.openAtLogin,path:process.env.PORTABLE_EXECUTABLE_FILE||process.execPath});}
function accountProxyPolicy(id){const account=config.accounts.find(a=>a.id===id);return account?.proxyPolicy?JSON.parse(unlock(account.proxyPolicy)):{mode:'inherit'};}
function routeName(id){return id==='direct'?'Direct connection':proxyState.profiles.find(p=>p.id===id)?.name||id;}
async function disconnectAccount(id,clearStatus=false){const c=tg.clients.get(id);tg.clients.delete(id);if(clearStatus)tg.statuses.delete(id);await c?.disconnect().catch(()=>{});proxyRoutes.delete(id);preferredProxyRoutes.delete(id);}
async function connectAccount(account,session,overridePolicy){
 const policy=overridePolicy||accountProxyPolicy(account.id),preferred=preferredProxyRoutes.get(account.id)||proxyRoutes.get(account.id),routes=ProxyManager.candidates(proxyState,policy,preferred);const failures=[];
 for(const route of routes){
  if(proxyRoutes.get(account.id)!==route.id&&tg.clients.has(account.id))await disconnectAccount(account.id);
  const started=Date.now();
  try{const c=await tg.connect({...account,proxy:normalizeProxy(route)},session);proxyRoutes.set(account.id,route.id);preferredProxyRoutes.delete(account.id);proxyHealth.set(account.id+':'+route.id,{ok:true,at:Date.now(),latency:Date.now()-started});return c;}
  catch(error){failures.push(routeName(route.id)+': '+error.message);proxyHealth.set(account.id+':'+route.id,{ok:false,at:Date.now(),error:error.message});await disconnectAccount(account.id);}
 }
 throw Error('Unable to connect through the available routes. '+failures.join(' · '));
}
async function client(id){const a=config.accounts.find(a=>a.id===id);if(!a||!a.session)throw Error('Account is not logged in');return connectAccount({...a,apiHash:unlock(a.apiHash)},unlock(a.session));}
function accountList(){return config.accounts.map(({id,label,telegramId,session,proxyPolicy})=>({id,label,telegramId,loggedIn:!!session,connected:!!tg.clients.get(id)?.connected,status:tg.statuses.get(id),hasOwnProxy:!!proxyPolicy,proxyRoute:proxyRoutes.get(id),proxyRouteName:proxyRoutes.has(id)?routeName(proxyRoutes.get(id)):null}));}
function proxyView(){return {...ProxyManager.publicState(proxyState),accounts:config.accounts.map(a=>({id:a.id,label:a.label,policy:accountProxyPolicy(a.id),activeRoute:proxyRoutes.get(a.id)||null,activeRouteName:proxyRoutes.has(a.id)?routeName(proxyRoutes.get(a.id)):null})),health:Object.fromEntries(proxyHealth)};}
function persistProxyState(){config.proxyStateCipher=lock(JSON.stringify(proxyState));save();}
function loadProxyConfiguration(){
 if(config.proxyStateCipher){proxyState=JSON.parse(unlock(config.proxyStateCipher));return;}
 proxyState=ProxyManager.newState();
 if(config.proxy){const settings=JSON.parse(unlock(config.proxy));if(settings.type&&settings.type!=='none'){const p=ProxyManager.profile({name:'Imported default proxy',...settings});proxyState.profiles.push(p);proxyState.defaultPolicy={mode:'profile',profileId:p.id};}delete config.proxy;}
 for(const account of config.accounts){if(!account.proxy)continue;const settings=JSON.parse(unlock(account.proxy));if(settings.type==='none')account.proxyPolicy=lock(JSON.stringify({mode:'direct'}));else{const p=ProxyManager.profile({name:'Imported · '+account.label,...settings});proxyState.profiles.push(p);account.proxyPolicy=lock(JSON.stringify({mode:'profile',profileId:p.id}));}delete account.proxy;}
 config.proxyStateCipher=lock(JSON.stringify(proxyState));save();
}
function navigate(page='approvals'){win.show();win.focus();win.webContents.send('navigate',page);}
function rebuildTray(){if(!tray||!config)return;tray.setImage(nativeImage.createFromPath(path.join(assets,gate.pending.size?'tray-pending.png':'icon.png')).resize({width:32,height:32}));tray.setToolTip(`TeleGate · ${gate.pending.size} pending${gate.rules.paused?' · AI paused':''}`);tray.setContextMenu(Menu.buildFromTemplate([{label:'Open TeleGate',click:()=>navigate()},{label:`Access requests (${gate.pending.size})`,click:()=>navigate()},{label:'Rules and permissions',click:()=>navigate('permissions')},{label:'Device sync',click:()=>navigate('sync')},{label:gate.rules.paused?'Resume AI access':'Pause all AI access',click:()=>pause('*',!gate.rules.paused)},{type:'separator'},{label:'Quit TeleGate',click:()=>{quitting=true;app.quit();}}]));}
function broadcast(){for(const w of [win,popup])if(w&&!w.isDestroyed())w.webContents.send('changed');rebuildTray();}
function audit(entry){config.audit=[{time:new Date().toISOString(),...entry},...config.audit].slice(0,3000);save();broadcast();}
function pause(account,enabled){gate.rules.pause(account,enabled);if(enabled)gate.cancelAccount(account);broadcast();}
function approvalState(){return {accounts:accountList(),pending:gate.list(),grants:gate.listGrants(),rules:gate.rules.snapshot(),notifications:config.notifications,openAtLogin:config.openAtLogin};}
function positionNotification(w){const area=screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;const width=Math.min(config.notifications.width||460,area.width-36),height=Math.min(720,area.height-36);const corner=config.notifications.corner||'bottom-right';w.setBounds({width,height,x:corner.endsWith('left')?area.x+18:area.x+area.width-width-18,y:corner.startsWith('top')?area.y+18:area.y+area.height-height-18});}
function showNotification(){if(quitting||!config.notifications.enabled||!gate.pending.size||config.notifications.dndUntil>Date.now())return;notificationWanted=true;if(!popup||popup.isDestroyed()){notificationReady=false;popup=window({frame:false,resizable:false,minimizable:false,maximizable:false,skipTaskbar:true,alwaysOnTop:true,roundedCorners:true,hasShadow:true},true);popup.on('closed',()=>{popup=null;notificationReady=false;});}positionNotification(popup);if(notificationReady)popup.showInactive();}
const gate=new Gate(()=>{broadcast();if(quitting)return;let arrived=false;for(const id of gate.pending.keys())if(!notified.has(id)){notified.add(id);arrived=true;}for(const id of notified)if(!gate.pending.has(id))notified.delete(id);if(arrived)showNotification();if(!gate.pending.size){notificationWanted=false;popup?.hide();}},audit,createIdentityResolver(client));
function notificationFailure(){if(quitting||!config.notifications.enabled||!gate.pending.size)return;new Notification({title:'TeleGate · Review pending requests',body:'Open Access requests in TeleGate to review.'}).show();navigate();}
function window(options={},approval=false){const w=new BrowserWindow({width:1240,height:900,show:false,autoHideMenuBar:true,icon:path.join(assets,'icon.ico'),backgroundColor:'#0c1220',...options,webPreferences:{preload:path.join(__dirname,'preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true}});w.setMenu(null);w.webContents.setWindowOpenHandler(()=>({action:'deny'}));w.webContents.on('will-navigate',e=>e.preventDefault());if(!approval)w.once('ready-to-show',()=>w.show());if(approval){const timer=setTimeout(()=>{if(!w.isDestroyed()&&!notificationReady)notificationFailure();},5000);w.once('closed',()=>clearTimeout(timer));w.webContents.on('render-process-gone',()=>{notificationFailure();w.destroy();});}w.loadFile(path.join(__dirname,approval?'notification.html':'index.html')).catch(notificationFailure);return w;}
async function command(event,cmd,a={}){
 if(![win,popup].some(w=>w&&!w.isDestroyed()&&w.webContents===event.sender))throw Error('Untrusted sender');
 switch(cmd){
 case 'state':return {...approvalState(),sync:sync?.status(),login:login.status(),memories:memories.snapshot(),policies:config.policies,audit:config.audit,endpoint:'http://127.0.0.1:19741/mcp',token:unlock(config.token),proxy:proxyView(),jobs:[...jobs.items.values()].map(({args,results,result,...j})=>j)};
 case 'sync-setup':{
  if(event.sender!==win.webContents||a.confirm!==true)throw Error('Confirm sync setup in the main window.');
  if(syncData||sync?.busy||syncSetupBusy)throw Error('A workspace is already configured or connecting.');
  if(!['create','join'].includes(a.mode))throw Error('Choose Create or Join');
  if(typeof a.password!=='string'||a.password.length<16)throw Error('Use a passphrase of at least 16 characters.');
  syncSetupBusy=true;try{const c=await client(a.account);const settings=a.mode==='create'?await TelegramSyncTransport.create(c,a.password):await TelegramSyncTransport.join(c,a.channel,a.password);
  const account=config.accounts.find(x=>x.id===a.account);account.telegramId=settings.owner;
  syncData={...settings,account:a.account,enabled:true,autoPermissions:a.autoPermissions!==false,state:SyncCore.newState()};config.syncCipher=lock(JSON.stringify(syncData));save();broadcast();void sync.run();return true;}finally{syncSetupBusy=false;}
 }
 case 'sync-discover':if(event.sender!==win.webContents)throw Error('Find sync channels from the main window.');return TelegramSyncTransport.discover(await client(a.account));
 case 'sync-permissions':{
  if(event.sender!==win.webContents)throw Error('Change sync settings in the main window.');
  if(!syncData)throw Error('Set up sync first');if(sync.busy)throw Error('Sync is running. Try again shortly.');
  if(typeof a.enabled!=='boolean')throw Error('Choose automatic or manual permission sync');
  syncData.autoPermissions=a.enabled;config.syncCipher=lock(JSON.stringify(syncData));save();broadcast();void sync.run();return true;
 }
 case 'sync-now':if(!syncData)throw Error('Set up sync first');await sync.run();return sync.status();
 case 'sync-toggle':if(sync.busy)throw Error('Sync is running. Try again shortly.');if(syncData){syncData.enabled=!!a.enabled;config.syncCipher=lock(JSON.stringify(syncData));save();broadcast();}return true;
 case 'sync-disconnect':if(sync.busy)throw Error('Sync is running. Try again shortly.');syncData=null;delete config.syncCipher;save();broadcast();return true;
 case 'sync-review':if(event.sender!==win.webContents||a.confirm!==true)throw Error('Review this change in the main window.');return sync.review(a);
 case 'approval-state':return approvalState();
 case 'notification-ready':if(event.sender===popup?.webContents){notificationReady=true;if(config.notifications.enabled&&notificationWanted&&gate.pending.size&&config.notifications.dndUntil<=Date.now())popup.showInactive();}return true;
 case 'dismiss-notification':notificationWanted=false;popup?.hide();return true;
 case 'open-requests':navigate();notificationWanted=false;popup?.hide();return true;
 case 'notifications':{const {z}=require('zod');const settings=z.object({enabled:z.boolean(),openAtLogin:z.boolean(),corner:z.enum(['bottom-right','bottom-left','top-right','top-left']),width:z.number().int().min(400).max(600),privacy:z.boolean(),dndUntil:z.number().min(0)}).strict().parse(a);const {openAtLogin,...notifications}=settings;config.openAtLogin=openAtLogin;config.notifications=notifications;save();applyStartupSetting();if(!notifications.enabled||notifications.dndUntil>Date.now()){notificationWanted=false;popup?.hide();}else showNotification();broadcast();return true;}
 case 'pause':pause(a.account||'*',!!a.enabled);return true;
 case 'memory-identity':return gate.identify(a.account,a.chat);
 case 'memory-preview':return memories.preview(a);
 case 'memory-change':{const preview=memories.preview(a);if(preview.scope.kind==='chat'&&!config.accounts.some(x=>x.id===preview.scope.account))throw Error('Unknown account');const result=memories.apply(preview);audit({operation:'owner_memory_change',allow:true,revision:memories.revision,noteIds:preview.changes.map(c=>c.id)});broadcast();return result;}
 case 'rules-preview':return gate.rules.preview(a);
 case 'rules-change':{if(a.expectedRevision!==undefined&&a.expectedRevision!==gate.rules.revision)throw Error('Rules changed; review again');const {expectedRevision,...change}=a;const result=gate.rules.change(change);audit({operation:'owner_rule_change',allow:true,reason:a.action});await gate.reconcile();broadcast();return result;}
 case 'rules-explain':return gate.explain(a.account,a.chat,a.operation);
 case 'revoke-grant':return gate.revoke(a.key);
 case 'decide':return gate.decide(a.id,a.allow,a.reason,a.duration||a.day);
 case 'decide-batch':{if(!Array.isArray(a.ids)||a.ids.length>100)throw Error('Invalid selection');if(a.ids.some(id=>['rule_change','memory_change'].includes(gate.pending.get(id)?.operation)))throw Error('Review memory and security changes individually');return a.ids.map(id=>({id,result:gate.decide(id,!!a.allow,a.reason||'Batch owner decision')}));}
 case 'accessible-chats':return require('./access.cjs').list(await client(a.account),gate,a.account,a);
 case 'folders':return advanced.run(await client(a.account),'folders',{});
 case 'dialogs':return tg.dialogs(await client(a.account),a.query||'',a.offset||0,100);
 case 'proxy-state':return proxyView();
 case 'proxy-profile-save':{
  if(login.active)throw Error('Finish login before changing proxies');const old=a.id&&proxyState.profiles.find(p=>p.id===a.id),next=ProxyManager.profile({...a,password:a.password===''&&old?.password?old.password:a.password,secret:a.secret===''&&old?.secret?old.secret:a.secret},old?.id);
  if(old)proxyState.profiles[proxyState.profiles.indexOf(old)]=next;else proxyState.profiles.push(next);persistProxyState();for(const id of [...tg.clients.keys()])await disconnectAccount(id);broadcast();return proxyView();
 }
 case 'proxy-profile-delete':{
  if(login.active)throw Error('Finish login before changing proxies');const usedDefault=proxyState.defaultPolicy.mode==='profile'&&proxyState.defaultPolicy.profileId===a.id,usedAccount=config.accounts.some(x=>accountProxyPolicy(x.id).mode==='profile'&&accountProxyPolicy(x.id).profileId===a.id);if(usedDefault||usedAccount)throw Error('Choose a different connection mode before deleting this proxy.');
  proxyState.profiles=proxyState.profiles.filter(p=>p.id!==a.id);if(proxyState.defaultPolicy.mode==='auto')proxyState.defaultPolicy.profileIds=proxyState.defaultPolicy.profileIds.filter(id=>id!==a.id);for(const account of config.accounts){const p=accountProxyPolicy(account.id);if(p.mode==='auto'){p.profileIds=p.profileIds.filter(id=>id!==a.id);if(!p.profileIds.length&&!p.includeDirect)account.proxyPolicy=lock(JSON.stringify({mode:'inherit'}));else account.proxyPolicy=lock(JSON.stringify(p));}}persistProxyState();for(const id of [...tg.clients.keys()])await disconnectAccount(id);broadcast();return proxyView();
 }
 case 'proxy-policy':{
  if(login.active)throw Error('Finish login before changing proxies');const target=a.account&&config.accounts.find(x=>x.id===a.account);if(a.account&&!target)throw Error('Unknown account');const next=ProxyManager.policy(a,proxyState.profiles,{account:!!target});if(target)target.proxyPolicy=next.mode==='inherit'?undefined:lock(JSON.stringify(next));else proxyState.defaultPolicy=next;persistProxyState();const ids=target?[target.id]:config.accounts.filter(x=>!x.proxyPolicy).map(x=>x.id);for(const id of ids)await disconnectAccount(id);broadcast();return proxyView();
 }
 case 'proxy-test':{
  const account=config.accounts.find(x=>x.id===a.account);if(!account?.session)throw Error('Choose a signed-in Telegram account for the test.');const route=a.routeId==='direct'?ProxyManager.direct:proxyState.profiles.find(p=>p.id===a.routeId);if(!route)throw Error('Unknown connection route');const id='proxy-test-'+randomBytes(8).toString('hex'),started=Date.now();
  try{const c=await tg.connect({...account,id,apiHash:unlock(account.apiHash),proxy:normalizeProxy(route)},unlock(account.session));const authorized=await c.checkAuthorization();const result={ok:true,authorized,latency:Date.now()-started,routeId:route.id,routeName:routeName(route.id)};proxyHealth.set(account.id+':'+route.id,{...result,at:Date.now()});return result;}catch(error){proxyHealth.set(account.id+':'+route.id,{ok:false,at:Date.now(),error:error.message});throw error;}finally{const c=tg.clients.get(id);tg.clients.delete(id);tg.statuses.delete(id);await c?.disconnect().catch(()=>{});broadcast();}
 }
 case 'proxy-switch':{
  const account=config.accounts.find(x=>x.id===a.account);if(!account?.session)throw Error('Choose a signed-in Telegram account');const routes=ProxyManager.candidates(proxyState,accountProxyPolicy(account.id)),current=proxyRoutes.get(account.id),index=Math.max(-1,routes.findIndex(r=>r.id===current));if(routes.length<2)throw Error('This account has only one available connection route.');const next=routes[(index+1)%routes.length];await disconnectAccount(account.id);preferredProxyRoutes.set(account.id,next.id);await client(account.id);broadcast();return {routeId:proxyRoutes.get(account.id),routeName:routeName(proxyRoutes.get(account.id))};
 }
 case 'reconnect':await disconnectAccount(a.account);await client(a.account);broadcast();return true;
 case 'login':case 'login-answer':case 'login-resend':case 'login-cancel':{
  if(event.sender!==win.webContents)throw Error('Sign in from the main window.');
  if(cmd==='login')return login.start(a);
  if(cmd==='login-answer')return login.answer(a.id,a.value);
  if(cmd==='login-resend')return login.resend(a.id);
  return login.cancel(a.id);
 }
 case 'remove':await disconnectAccount(a.account,true);config.accounts=config.accounts.filter(x=>x.id!==a.account);delete config.policies[a.account];save();broadcast();return true;
 case 'job-cancel':{const j=jobs.get(a.id);if(j.operation!=='search_all')throw Error('Only search jobs can be cancelled');jobs.cancel(a.id);for(const r of gate.list())if(r.payload.jobId===a.id)gate.cancel(r.id);broadcast();return true;}
 default:throw Error('Unknown command');
 }
}
async function boot(){
 file=path.join(app.getPath('userData'),'vault.json');config=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{accounts:[],policies:{},audit:[],token:lock(randomBytes(32).toString('hex'))};config.notifications={enabled:true,corner:'bottom-right',width:460,privacy:false,dndUntil:0,...config.notifications};config.openAtLogin=config.openAtLogin===true;applyStartupSetting();
 loadProxyConfiguration();
 const migrate=!config.rulesState;gate.rules=new RuleBook(config.rulesState||{},state=>{config.rulesState=state;save();});
 if(migrate){for(const [account,p] of Object.entries(config.policies||{})){if(p.mode==='ask')continue;gate.rules.change({action:'create',rule:{name:'Imported read policy',account,effect:'allow',operations:['read_all'],selector:p.mode==='only'?{chats:p.chats}:{}}});if(p.mode==='only'||p.mode==='except'&&p.chats.length)gate.rules.change({action:'create',rule:{name:'Imported read exclusions',account,effect:'deny',operations:['read_all'],selector:p.mode==='only'?{excludeChats:p.chats}:{chats:p.chats}}});}config.policies={};}gate.policies=config.policies||{};
 gate.grants=new Map((config.grants||[]).map(g=>[g.key,g]));gate.persistGrants=list=>{config.grants=list;save();};
 gate.metadata=async(account,chat)=>{const c=await client(account),e=await c.getEntity(chat),m=identityFromEntity(e);if(gate.rules.rules.some(r=>r.selector.folderIds.length)){const ds=await c.getDialogs({limit:undefined}),d=ds.find(d=>require('telegram/Utils').getPeerId(d.entity).toString()===chat);m.folderIds=d?[d.archived?1:0,...(await advanced.folderData(c)).filter(f=>advanced.matchesFolder(f,d)).map(f=>f.id)]:[];}return m;};
 memories=new MemoryBook(config.memoriesCipher?JSON.parse(unlock(config.memoriesCipher)):{},state=>{const previous=config.memoriesCipher;try{config.memoriesCipher=lock(JSON.stringify(state));save();}catch(e){config.memoriesCipher=previous;throw e;}});
 syncData=config.syncCipher?JSON.parse(unlock(config.syncCipher)):null;
 const local=()=>({rules:gate.rules.rules,memories:memories.entries,grants:[...gate.grants.values()]});
 sync=new SyncService({load:()=>syncData,notify:()=>{broadcast();if(quitting||approvalSmoke||!config.notifications.enabled)return;const pending=syncData?.state.pending||[],fresh=pending.filter(p=>!syncNotified.has(p.fingerprint));for(const p of pending)syncNotified.add(p.fingerprint);if(fresh.length){const notification=new Notification({title:'TeleGate · Sync review',body:'Device sync has changes that need your review. Open Device sync to compare versions.'});notification.on('click',()=>navigate('sync'));notification.show();}},
  mapping:async()=>{for(const a of config.accounts)if(a.session&&!a.telegramId){try{a.telegramId=(await (await client(a.id)).getMe()).id.toString();}catch{}}return SyncLocal.accountMap(config.accounts);},
  current:map=>SyncLocal.collect(local(),map,syncData?.state.base||{}),
  transport:async x=>new TelegramSyncTransport(await client(x.account),x.channel),
  commit:(next,records,map)=>{
   const previous={config:structuredClone(config),sync:syncData,rules:gate.rules.snapshot(),memory:memories.snapshot(),grants:[...gate.grants]};
   try{
    if(records){const data=SyncLocal.materialize(records,map,local());
     if(SyncCore.stable(data.rules)!==SyncCore.stable(gate.rules.rules)){gate.rules.rules=data.rules;gate.rules.revision++;}
     if(SyncCore.stable(data.memories)!==SyncCore.stable(memories.entries)){memories.entries=data.memories;memories.revision++;}
     gate.grants=new Map(data.grants.map(g=>[g.key,g]));config.rulesState=gate.rules.snapshot();config.memoriesCipher=lock(JSON.stringify(memories.snapshot()));config.grants=[...gate.grants.values()];
    }
    syncData=next;config.syncCipher=lock(JSON.stringify(next));save();
   }catch(e){config=previous.config;syncData=previous.sync;gate.rules.rules=previous.rules.rules;gate.rules.revision=previous.rules.revision;memories.entries=previous.memory.entries;memories.revision=previous.memory.revision;gate.grants=new Map(previous.grants);throw e;}
   if(records)void gate.reconcile().catch(()=>{});
  }
 });
 if(!approvalSmoke){syncTimer=setInterval(()=>void sync.run(),30000);syncTimer.unref();}
 jobs=new Jobs(config.jobsCipher?JSON.parse(unlock(config.jobsCipher)):[],items=>{config.jobsCipher=lock(JSON.stringify(items));save();});save();ipcMain.handle('command',command);
 win=window();win.on('close',e=>{if(!quitting){e.preventDefault();win.hide();}});tray=new Tray(nativeImage.createFromPath(path.join(assets,'icon.png')).resize({width:32,height:32}));tray.on('double-click',()=>navigate());tray.on('click',()=>navigate());rebuildTray();
 if(approvalSmoke)win.webContents.once('did-finish-load',()=>require('../test/approval-smoke.cjs')({app,gate,memories,login,win,getPopup:()=>popup,getTray:()=>tray,setAccounts:a=>{config.accounts=a;},finish:()=>{quitting=true;app.quit();}}));
 else try{server=await serve({token:unlock(config.token),gate,accounts:()=>config.accounts,client,jobs,memories,onEvent:audit});}catch(e){audit({operation:'server_error',reason:e.message});}
 const timer=setInterval(()=>{if(config.notifications.dndUntil&&config.notifications.dndUntil<=Date.now()){config.notifications.dndUntil=0;save();showNotification();}},1000);timer.unref();
}
if(!app.requestSingleInstanceLock())app.quit();else app.whenReady().then(boot).catch(e=>{console.error(e);app.quit();});
app.on('second-instance',()=>win?.show());app.on('before-quit',()=>{quitting=true;void login.cancel();clearInterval(syncTimer);gate.close();server?.close();for(const c of tg.clients.values())c.disconnect();});
