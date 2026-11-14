let state,page=new URLSearchParams(location.search).has('approval')?'approvals':'approvals',selected=new Set(),rows=[],offset=0;const $=id=>document.getElementById(id);const esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));async function call(cmd,args){try{$('error').textContent='';return await tele.call(cmd,args);}catch(e){$('error').textContent=e.message;throw e;}}
const options=()=>state.accounts.map(a=>`<option value="${esc(a.id)}">${esc(a.label)}</option>`).join('');
let renderRevision=0;
async function render(){const revision=++renderRevision,requestedPage=page,nextState=await call('state');if(revision!==renderRevision||requestedPage!==page)return;state=nextState;if(page!=='accounts')AccountsUI.unmount();const c=$('content');$('title').textContent={approvals:'Access requests',accounts:'Telegram accounts',permissions:'Read permissions',memories:'Memory',sync:'Device sync',connection:'Connect your assistant',proxy:'Telegram proxy',audit:'Decision history',notifications:'App preferences',jobs:'Background activity'}[page];
if(page==='approvals')Approvals.render(c,state);
if(page==='accounts')AccountsUI.render(c,state);
if(page==='permissions'){Workspace.ruleManager(c,state,window.ruleSeed);window.ruleSeed=null;}
if(page==='memories')MemoryUI.render(c,state);
if(page==='sync')SyncUI.render(c,state,render);
if(page==='notifications')Workspace.notifications(c,state);
if(page==='jobs')Workspace.jobList(c,state);
if(page==='proxy')ProxyUI.render(c,state,render);
if(page==='connection')c.innerHTML=`<article><h3>Streamable HTTP</h3><p>Keep TeleGate running. Closing the window minimizes it to the system tray.</p><label>Endpoint<input readonly value="${esc(state.endpoint)}" dir="ltr"></label><label>Authorization header<input readonly type="password" id="token" value="Bearer ${esc(state.token)}" dir="ltr"></label><button id="reveal">Show / hide token</button><p>This token authorizes the connection. Access decisions are still made in TeleGate.</p></article>`;
if(page==='connection')$('reveal').onclick=()=>{$('token').type=$('token').type==='password'?'text':'password';};if(page==='audit')Workspace.history(c,state);
}
document.querySelectorAll('[data-page]').forEach(b=>b.onclick=()=>{page=b.dataset.page;$('content').innerHTML='';render().catch(()=>{});});tele.onNavigate(next=>{page=next;$('content').innerHTML='';render().catch(()=>{});});tele.onChange(()=>{if(page==='approvals'||page==='audit'||page==='accounts'||page==='jobs'||page==='sync')render().catch(()=>{});});render().catch(()=>{});

window.addEventListener('rule-from-audit',event=>{window.ruleSeed=event.detail;page='permissions';$('content').innerHTML='';render().catch(()=>{});});
