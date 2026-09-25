const $ = s => document.querySelector(s);
const fmt = n => n == null ? 'N/A' : new Intl.NumberFormat('pl-PL').format(Number(n || 0));
const statDefs = [
  ['wood','/assets/icons/wood.png','Wood'],
  ['metal','/assets/icons/metal.png','Metal Ore'],
  ['hqMetal','/assets/icons/hq-metal.png','HQ Metal'],
  ['sulfur','/assets/icons/sulfur.png','Sulfur Ore'],
  ['stones','/assets/icons/stones.png','Stones'],
  ['rockets','/assets/icons/rocket.png','Rockets']
];
const icon = (src,label='',cls='rust-icon') => `<img class="${cls}" src="${src}" alt="${esc(label)}" loading="lazy">`;

let teamsMeta = [];
let lastSnapshot = { timestamp:null, teams:[], sources:[] };
let detailTeamId = null;
let statsTeamId = null;
let statsHistory = [];
let dismissedToast = '';
let toastTimer = null;
let searchTerm = '';
let activeProvider = localStorage.getItem('rustdash.provider') || 'reddit';
const legacyServer = localStorage.getItem('rustdash.server') || '';
let activeServer = localStorage.getItem(`rustdash.server.${activeProvider}`) || legacyServer || '';
let appConfig = null;
let rustoriaServers = [];
let currentView = 'home';
let rustPlusPairing = null;
let rustPlusSessionInfo = null;

function ago(iso){ if(!iso)return 'Waiting for data'; const s=Math.max(0,Math.floor((Date.now()-new Date(iso))/1000)); return s<10?'Updated just now':s<60?`Updated ${s}s ago`:`Updated ${Math.floor(s/60)}m ago`; }
function createdAgo(iso){ if(!iso)return 'Created recently'; const d=Math.max(0,Math.floor((Date.now()-new Date(iso))/86400000)); return d===0?'Created today':d===1?'Created 1 day ago':`Created ${d} days ago`; }
function esc(s=''){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function memberId(m, provider){return provider==='rustoria' ? (m.rustoriaId||m.playerId||'') : (m.steamId||m.playerId||'');}
function avatar(m, large=false){return m.profilePicture?`<img class="avatar-img ${large?'avatar-lg':''}" src="${esc(m.profilePicture)}" alt="">`:`<span class="avatar ${large?'avatar-lg':''}">${esc((m.name||'?').slice(0,1).toUpperCase())}</span>`;}
function fmtTime(sec){if(sec==null)return 'N/A';sec=Number(sec||0);const h=Math.floor(sec/3600),m=Math.floor((sec%3600)/60);return h?`${h}h ${m}m`:`${m}m`;}
function kd(k,d,explicit){if(explicit!=null)return Number(explicit).toFixed(2);k=Number(k||0);d=Number(d||0);return (k/Math.max(1,d)).toFixed(2);}
function snapshotTeam(id){return (lastSnapshot.teams||[]).find(t=>t.id===id)||null;}
function providerLabel(p){return p==='rustoria'?'Rustoria':'Reddit PlayRust';}
function activityLabel(state){return state==='active'?'Active now':state==='recent'?'Recently active':state==='warming'?'Learning activity':'No recent activity';}
function activityClass(state){return ['active','recent','warming','inactive'].includes(state)?state:'inactive';}
function activityAgo(iso){if(!iso)return '';const s=Math.max(0,Math.floor((Date.now()-new Date(iso))/1000));if(s<60)return 'just now';const m=Math.floor(s/60);return m<60?`${m}m ago`:`${Math.floor(m/60)}h ago`;}
function showToast(message,{autoHide=false}={}){const msg=String(message||'').trim();if(!msg){$('#toast').hidden=true;$('#toastText').textContent='';return;}if(msg===dismissedToast)return;clearTimeout(toastTimer);$('#toastText').textContent=msg;$('#toast').hidden=false;if(autoHide)toastTimer=setTimeout(()=>{if($('#toastText').textContent===msg)$('#toast').hidden=true;},6000);}
$('#toastClose').onclick=()=>{dismissedToast=$('#toastText').textContent;$('#toast').hidden=true;};

function renderProviderHomeCounts(){
  const counts = provider => ({
    teams: teamsMeta.filter(t=>t.provider===provider).length,
    servers: new Set(availableServers(provider).map(x=>x.value).filter(Boolean)).size
  });
  const reddit=counts('reddit'), rustoria=counts('rustoria');
  if($('#redditTeamCount')) $('#redditTeamCount').textContent=`${reddit.teams} ${reddit.teams===1?'team':'teams'}`;
  if($('#redditServerCount')) $('#redditServerCount').textContent=`${reddit.servers} ${reddit.servers===1?'server':'servers'}`;
  if($('#rustoriaTeamCount')) $('#rustoriaTeamCount').textContent=`${rustoria.teams} ${rustoria.teams===1?'team':'teams'}`;
  if($('#rustoriaServerCount')) $('#rustoriaServerCount').textContent=`${rustoria.servers} ${rustoria.servers===1?'server':'servers'}`;
}
function updateProviderScopedUi(){
  const label=providerLabel(activeProvider);
  if($('#activeNetworkKicker')) $('#activeNetworkKicker').textContent=label;
  if($('#pageTitle')) $('#pageTitle').textContent=`${label} Teams`;
  if($('#pageSubtitle')) $('#pageSubtitle').textContent=`Track teams and stats only for ${label}.`;
  const redditBlock=document.querySelector('.reddit-settings');
  const rustoriaBlock=document.querySelector('.rustoria-settings');
  if(redditBlock) redditBlock.hidden=activeProvider!=='reddit';
  if(rustoriaBlock) rustoriaBlock.hidden=activeProvider!=='rustoria';
}
function showHome(){
  currentView='home';
  $('#providerHome').hidden=false;
  $('#teamsView').hidden=true;
  searchTerm='';
  if($('#teamSearch')) $('#teamSearch').value='';
  renderProviderHomeCounts();
  if($('#rustPlusPanel'))$('#rustPlusPanel').hidden=true;
}
function openProvider(provider){
  currentView='teams';
  const p=provider==='rustoria'?'rustoria':'reddit';
  const remembered=localStorage.getItem(serverStorageKey(p))||'';
  setActiveSource(p,remembered);
  updateProviderScopedUi();
  $('#providerHome').hidden=true;
  $('#teamsView').hidden=false;
  render(lastSnapshot);
  loadRustPlusPairing().catch(()=>{});
}

function matchesSearch(team){if(!searchTerm)return true;const q=searchTerm.toLowerCase();if((team.name||'').toLowerCase().includes(q))return true;return (team.members||[]).some(m=>(m.name||'').toLowerCase().includes(q)||String(memberId(m,team.provider)||'').toLowerCase().includes(q));}
function matchesSource(team){return team.provider===activeProvider && (!activeServer || team.server===activeServer);}

function sourceWarnings(snapshot){
  if(currentView==='home')return;
  if(snapshot.error){showToast(snapshot.error);return;}
  const relevant=(snapshot.sources||[]).filter(s=>s.provider===activeProvider&&(!activeServer||s.server===activeServer));
  const issue=relevant.find(s=>s.requestedPlayers>0&&s.returnedPlayers===0)||relevant.find(s=>s.missingIds?.length);
  if(!issue)return;
  if(issue.provider==='rustoria'){
    if(issue.returnedPlayers===0)showToast(`Rustoria: nie znaleziono danych leaderboardu dla ${issue.requestedPlayers} graczy na ${issue.server}.`);
    else showToast(`Rustoria: dane znalezione dla ${issue.returnedPlayers}/${issue.requestedPlayers}. Brak: ${issue.missingIds.join(', ')}`);
  } else {
    if(issue.returnedPlayers===0)showToast(`Reddit: /saved nie zwrócił żadnego z ${issue.requestedPlayers} SteamID dla tego serwera/wipe.`);
    else showToast(`Reddit: dane znalezione dla ${issue.returnedPlayers}/${issue.requestedPlayers}. Brak: ${issue.missingIds.join(', ')}`);
  }
}

function render(snapshot){
  lastSnapshot=snapshot||lastSnapshot;
  renderProviderHomeCounts();
  sourceWarnings(lastSnapshot);
  const root=$('#teams');
  const byId=new Map((lastSnapshot.teams||[]).map(t=>[t.id,t]));
  const visible=teamsMeta.map(meta=>byId.get(meta.id)||{...meta,stats:{},members:meta.members||[]}).filter(matchesSource).filter(matchesSearch);

  root.innerHTML=visible.map(t=>{
    const onlineSupported=t.onlineSupported!==false;
    const activitySupported=t.activitySupported===true;
    const online=(t.members||[]).filter(m=>m.isOnline===true);
    const activeMembers=(t.members||[]).filter(m=>m.activityState==='active');
    const recentMembers=(t.members||[]).filter(m=>m.activityState==='recent');
    let preview='';
    let previewTitle='Players';
    let previewCount=`${t.members.length} tracked`;
    if(onlineSupported){
      previewTitle='Online now';
      previewCount=`${online.length}/${t.members.length} online`;
      preview=online.length ? online.slice(0,6).map(m=>`<div class="member"><span class="dot online"></span>${avatar(m)}<span class="member-online" title="${esc(memberId(m,t.provider))} · ONLINE">${esc(m.name||memberId(m,t.provider))}</span></div>`).join('')+(online.length>6?`<div class="more-online">+${online.length-6} more online</div>`:'') : '<div class="no-online">No players online</div>';
    } else if(activitySupported){
      const shown=[...activeMembers,...recentMembers.filter(m=>!activeMembers.includes(m))];
      previewTitle='Activity';
      previewCount=`${activeMembers.length} active · ${recentMembers.length} recent`;
      preview=shown.length ? shown.slice(0,6).map(m=>`<div class="member"><span class="dot ${activityClass(m.activityState)}"></span>${avatar(m)}<span class="${m.activityState==='active'?'member-online':''}" title="${esc(memberId(m,t.provider))} · ${activityLabel(m.activityState)}">${esc(m.name||memberId(m,t.provider))}<small class="activity-note">${activityLabel(m.activityState)}</small></span></div>`).join('')+(shown.length>6?`<div class="more-online">+${shown.length-6} more active/recent</div>`:'') : '<div class="no-online">No recent activity detected yet</div>';
    } else {
      preview='<div class="no-online">Online status unavailable</div>';
    }
    return `<section class="team-card" data-team-id="${esc(t.id)}" tabindex="0" aria-label="Otwórz team ${esc(t.name)}">
      <div class="team-title"><div><h2>${esc(t.name)}</h2><div class="muted">${createdAgo(t.createdAt)}</div><div class="source-badges"><span class="provider-badge ${t.provider}">${providerLabel(t.provider)}</span><span class="server-badge">${esc(t.server||'No server')}</span></div></div><span>${ago(lastSnapshot.timestamp)}</span></div>
      <div class="status-row"><span class="tracked">Tracked</span><button class="icon-btn team-stats" data-team-id="${esc(t.id)}" title="View Statistics">▥</button><button class="icon-btn team-edit" data-team-id="${esc(t.id)}" title="Team settings">⚙</button></div>
      <div class="stats">${statDefs.map(([k,i,l])=>`<div class="stat stat-watermark-card"><img class="stat-watermark-img" src="${i}" alt="" loading="lazy"><div class="stat-label">${icon(i,l)}<span>${l}</span></div><strong>${fmt(t.stats?.[k])}</strong></div>`).join('')}</div>
      <div class="separator"></div>
      <div class="members-head"><span>${previewTitle}</span><b>${previewCount}</b></div>
      <div class="members online-preview">${preview}</div>
      <div class="card-hint">Click team to view all players and detailed stats</div>
    </section>`;
  }).join('')||`<div class="empty">No teams for <b>${providerLabel(activeProvider)}</b>${activeServer?` / <b>${esc(activeServer)}</b>`:''}. Select another source or click <b>Create Team</b>.</div>`;

  document.querySelectorAll('.team-card').forEach(card=>{card.onclick=e=>{if(e.target.closest('button,details,summary'))return;openTeamDetail(card.dataset.teamId);};card.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();openTeamDetail(card.dataset.teamId);}};});
  document.querySelectorAll('.team-edit').forEach(btn=>btn.onclick=e=>{e.stopPropagation();openTeamDetail(btn.dataset.teamId);});
  document.querySelectorAll('.team-stats').forEach(btn=>btn.onclick=e=>{e.stopPropagation();openStatistics(btn.dataset.teamId);});
  if(detailTeamId&&$('#teamDetail').open)renderTeamDetail(detailTeamId);
}

function memberCard(m, provider){
  const s=m.stats||{}; const r=(src,label)=>icon(src,label,'mini-rust-icon'); const id=memberId(m,provider);
  const status=provider==='rustoria'?`<span class="dot ${activityClass(m.activityState)}" title="${activityLabel(m.activityState)}"></span>`:`<span class="dot ${m.isOnline?'online':'offline'}"></span>`;
  const activityMeta=provider==='rustoria'?` · ${activityLabel(m.activityState)}${m.lastActivityAt?` (${activityAgo(m.lastActivityAt)})`:''}`:'';
  return `<article class="member-detail-card"><div class="member-detail-head"><div class="member-identity">${status}${avatar(m,true)}<div><strong>${esc(m.name||id)}</strong><small>${esc(id)}${m.statsHidden?' · profile hidden':''}${activityMeta}</small></div></div><button class="remove-member" data-player-id="${esc(id)}">Remove</button></div><div class="member-columns"><div><div class="section-kicker kicker-with-icon">${r('/assets/icons/wood.png','Farm')} FARM</div><div class="mini-grid"><span>Wood<b>${fmt(s.wood)}</b></span><span>Metal<b>${fmt(s.metal)}</b></span><span>HQ Metal<b>${fmt(s.hqMetal)}</b></span><span>Sulfur<b>${fmt(s.sulfur)}</b></span><span>Stones<b>${fmt(s.stones)}</b></span><span>Play Time<b>${fmtTime(s.playTime)}</b></span></div></div><div class="member-divider"><div class="section-kicker">PVP</div><div class="mini-grid pvp-grid"><span>Kills<b>${fmt(s.kills)}</b></span><span>Deaths<b>${fmt(s.deaths)}</b></span><span>K/D<b>${kd(s.kills,s.deaths,s.kdr)}</b></span></div>${provider==='rustoria'?`<div class="mini-grid extra-pvp"><span>Headshots<b>${fmt(s.headshots)}</b></span><span>Accuracy<b>${s.accuracy==null?'N/A':`${s.accuracy}%`}</b></span></div>`:''}<div class="section-kicker raid-kicker kicker-with-icon">${r('/assets/icons/rocket.png','Raiding')} RAIDING</div><div class="mini-grid"><span>Rockets<b>${fmt(s.rockets)}</b></span><span>HV Rockets<b>${fmt(s.hvRockets)}</b></span><span>C4<b>${fmt(s.c4)}</b></span><span>Explosive Ammo<b>${fmt(s.explosiveAmmo)}</b></span><span>Satchels<b>${fmt(s.satchels)}</b></span>${provider==='rustoria'?`<span>Online raid hits<b>${fmt(s.rocketHitOnline)}</b></span><span>Offline raid hits<b>${fmt(s.rocketHitOffline)}</b></span>`:''}</div></div></div></article>`;
}
function renderTeamDetail(id){const t=snapshotTeam(id)||teamsMeta.find(x=>x.id===id);if(!t)return;$('#detailTitle').textContent=`${t.name} · ${providerLabel(t.provider)} · ${t.server}`;$('#detailUpdated').textContent=ago(lastSnapshot.timestamp);$('#detailTotals').innerHTML=statDefs.map(([k,i,l])=>`<div class="detail-total detail-watermark-card"><img class="detail-watermark-img" src="${i}" alt="" loading="lazy"><small>${l}</small><strong>${fmt(t.stats?.[k])}</strong></div>`).join('');$('#detailMemberCount').textContent=t.onlineSupported===false?(t.activitySupported?`${t.members.length} members · ${t.members.filter(m=>m.activityState==='active').length} active now · ${t.members.filter(m=>m.activityState==='recent').length} recent`:`${t.members.length} members · online N/A`):`${t.members.length} members · ${t.members.filter(m=>m.isOnline===true).length} online`;$('#detailMemberIdLabel').textContent=t.provider==='rustoria'?'Rustoria ID':'Steam64 ID';$('#newMemberId').placeholder=t.provider==='rustoria'?'24-char Rustoria ID':'7656119...';$('#detailMembers').innerHTML=(t.members||[]).map(m=>memberCard(m,t.provider)).join('')||'<div class="empty-detail">Brak członków.</div>';document.querySelectorAll('.remove-member').forEach(b=>b.onclick=async()=>removeMember(id,b.dataset.playerId));}
function openTeamDetail(id){detailTeamId=id;renderTeamDetail(id);$('#newMemberId').value='';$('#teamDetail').showModal();}
async function removeMember(teamId,id){const meta=teamsMeta.find(t=>t.id===teamId);if(!meta)return;const member=meta.members.find(m=>memberId(m,meta.provider)===id);if(!confirm(`Usunąć ${member?.name||id} z teamu?`))return;await updateTeam(teamId,{members:meta.members.filter(m=>memberId(m,meta.provider)!==id)});showToast('Gracz usunięty z teamu.',{autoHide:true});}
async function updateTeam(id,patch){const meta=teamsMeta.find(t=>t.id===id);if(!meta)return;await json(`/api/teams/${encodeURIComponent(id)}`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:patch.name??meta.name,provider:meta.provider,server:meta.server,wipe:meta.wipe,members:patch.members??meta.members})});await json('/api/stats/refresh',{method:'POST'});await load();}
async function json(url,opt){const r=await fetch(url,opt);if(r.status===401){location='/login';return;}const j=await r.json();if(!r.ok)throw new Error(j.error||'Błąd');return j;}

function serverStorageKey(provider){return `rustdash.server.${provider==='rustoria'?'rustoria':'reddit'}`;}
async function loadRustPlusPairing(){
  const panel=$('#rustPlusPanel');
  if(!panel)return;
  if(currentView!=='teams'||!activeServer){panel.hidden=true;rustPlusPairing=null;return;}
  panel.hidden=false;
  try{
    const data=await json(`/api/rustplus/pairings?provider=${encodeURIComponent(activeProvider)}&server=${encodeURIComponent(activeServer)}`);
    rustPlusPairing=data.pairing||null;
  }catch(e){rustPlusPairing=null;showToast(e.message);}
  renderRustPlusPanel();
}
function renderRustPlusPanel(){
  const panel=$('#rustPlusPanel');if(!panel)return;
  if(!activeServer){panel.hidden=true;return;}
  panel.hidden=false;
  const p=rustPlusPairing;
  const status=p?.status||'disconnected';
  $('#rustPlusTitle').textContent=p?`Rust+ · ${activeServer}`:`Rust+ · ${activeServer}`;
  $('#rustPlusStatus').textContent=status==='paired'?'Connected':status==='awaiting_pair'?'Waiting for pairing':'Disconnected';
  $('#rustPlusStatus').className=`rustplus-status ${status==='paired'?'paired':status==='awaiting_pair'?'waiting':'disconnected'}`;
  const parts=[providerLabel(activeProvider),activeServer];
  if(p?.deviceName)parts.push(p.deviceName);
  if(p?.pairedAt)parts.push(`paired ${ago(p.pairedAt).replace('Updated ','')}`);
  $('#rustPlusMeta').textContent=parts.join(' · ');
  $('#rustPlusPairBtn').textContent=status==='paired'?'Re-pair Rust+':'Pair Rust+';
  $('#rustPlusUnpairBtn').hidden=!p;
  $('#rustPlusCopyBtn').hidden=!rustPlusSessionInfo;
  $('#rustPlusSession').hidden=!rustPlusSessionInfo;
  if(rustPlusSessionInfo){$('#rustPlusToken').textContent=rustPlusSessionInfo.token;$('#rustPlusCallback').textContent=rustPlusSessionInfo.completeUrl;}
}
async function startRustPlusPairing(){
  if(!activeServer){showToast('Najpierw wybierz konkretny server.');return;}
  try{
    rustPlusSessionInfo=await json('/api/rustplus/pairings/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({provider:activeProvider,server:activeServer})});
    rustPlusPairing=rustPlusSessionInfo.pairing;
    renderRustPlusPanel();
    showToast('Sesja Rust+ utworzona. Token jest ważny 10 minut.',{autoHide:true});
  }catch(e){showToast(e.message);}
}
async function unpairRustPlus(){
  if(!rustPlusPairing?.id)return;
  if(!confirm(`Usunąć parowanie Rust+ dla ${activeServer}?`))return;
  try{await json(`/api/rustplus/pairings/${encodeURIComponent(rustPlusPairing.id)}`,{method:'DELETE'});rustPlusPairing=null;rustPlusSessionInfo=null;renderRustPlusPanel();showToast('Parowanie Rust+ usunięte.',{autoHide:true});}catch(e){showToast(e.message);}
}
async function copyRustPlusSession(){
  if(!rustPlusSessionInfo)return;
  const text=`TOKEN=${rustPlusSessionInfo.token}\nCALLBACK=${rustPlusSessionInfo.completeUrl}\nPROVIDER=${activeProvider}\nSERVER=${activeServer}`;
  try{await navigator.clipboard.writeText(text);showToast('Dane sesji skopiowane.',{autoHide:true});}catch{prompt('Skopiuj dane sesji:',text);}
}

function availableServers(provider){
  if(provider==='rustoria'){
    return [...new Map([
      ...rustoriaServers.map(x=>[x.slug,{value:x.slug,label:x.name||x.slug}]),
      ...teamsMeta.filter(t=>t.provider==='rustoria'&&t.server).map(t=>[t.server,{value:t.server,label:t.server}]),
      ...(appConfig?.rustoriaServer?[[appConfig.rustoriaServer,{value:appConfig.rustoriaServer,label:appConfig.rustoriaServer}]]:[])
    ]).values()];
  }
  return [...new Set([appConfig?.server,...teamsMeta.filter(t=>t.provider==='reddit').map(t=>t.server)].filter(Boolean))].map(x=>({value:x,label:x}));
}
function fillServerOptions(){
  const select=$('#serverFilter'); const rdl=$('#rustoriaServerOptions');
  const rust=availableServers('rustoria');
  if(rdl)rdl.innerHTML=rust.map(x=>`<option value="${esc(x.value)}">${esc(x.label)}</option>`).join('');
  const src=availableServers(activeProvider);
  const allLabel=activeProvider==='rustoria'?'All Rustoria servers':'All Reddit servers';
  select.innerHTML=`<option value="">${allLabel}</option>`+src.map(x=>`<option value="${esc(x.value)}">${esc(x.label)}</option>`).join('');
  if(activeServer&&!src.some(x=>x.value===activeServer)) activeServer='';
  select.value=activeServer;
  updateSourceUi();
}
function updateSourceUi(){
  const btn=$('#createBtn');
  if(btn){
    btn.disabled=!activeServer;
    btn.title=activeServer?'Create team for selected network/server':'Select a specific server before creating a team';
  }
}
function setActiveSource(provider,server,{persist=true}={}){
  activeProvider=provider==='rustoria'?'rustoria':'reddit';
  activeServer=String(server||'').trim();
  fillServerOptions();
  $('#serverFilter').value=activeServer;
  if(persist){
    localStorage.setItem('rustdash.provider',activeProvider);
    localStorage.setItem(serverStorageKey(activeProvider),activeServer);
  }
  updateSourceUi();
  render(lastSnapshot);
  rustPlusSessionInfo=null;
  loadRustPlusPairing().catch(()=>{});
}
async function load(){
  appConfig=await json('/api/config');
  try{rustoriaServers=await json('/api/providers/rustoria/servers');}catch{rustoriaServers=[];}
  teamsMeta=await json('/api/teams');
  const remembered=localStorage.getItem(serverStorageKey(activeProvider));
  if(remembered!==null) activeServer=remembered;
  fillServerOptions();
  $('#serverFilter').value=activeServer;
  updateSourceUi();
  updateProviderScopedUi();
  render(await json('/api/stats'));
  showHome();
}
function parseMembers(text,provider){return text.split(/\r?\n/).map(x=>x.trim()).filter(Boolean).map(line=>{const [id,...rest]=line.split(',');return provider==='rustoria'?{rustoriaId:id.trim(),name:rest.join(',').trim()}:{steamId:id.trim(),name:rest.join(',').trim()};});}

function svgChart(rows,series,valueFn,{empty='Za mało danych historycznych. Poczekaj aż tracker zbierze kilka próbek.'}={}){if(!rows.length)return`<div class="chart-empty">${esc(empty)}</div>`;const W=920,H=300,p={l:64,r:20,t:22,b:44};const all=series.flatMap(s=>rows.map(r=>Number(valueFn(r,s.key)||0)));const max=Math.max(1,...all);const minT=new Date(rows[0].at).getTime(),maxT=new Date(rows.at(-1).at).getTime();const x=t=>p.l+((new Date(t).getTime()-minT)/Math.max(1,maxT-minT))*(W-p.l-p.r);const y=v=>p.t+(1-v/max)*(H-p.t-p.b);let grid='';for(let i=0;i<=4;i++){const yy=p.t+i*(H-p.t-p.b)/4;const val=Math.round(max*(1-i/4));grid+=`<line x1="${p.l}" y1="${yy}" x2="${W-p.r}" y2="${yy}" class="grid-line"/><text x="${p.l-10}" y="${yy+4}" text-anchor="end" class="axis-text">${fmt(val)}</text>`;}const ticks=Math.min(8,rows.length);let xlabels='';for(let i=0;i<ticks;i++){const idx=Math.round(i*(rows.length-1)/Math.max(1,ticks-1));const r=rows[idx],xx=x(r.at),d=new Date(r.at);xlabels+=`<text x="${xx}" y="${H-14}" text-anchor="middle" class="axis-text">${d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</text>`;}const lines=series.map(s=>{const pts=rows.map(r=>`${x(r.at)},${y(valueFn(r,s.key))}`).join(' ');return`<polyline points="${pts}" class="chart-line ${s.cls}"/>`;}).join('');const legend=series.map(s=>`<span class="legend-item"><i class="legend-swatch ${s.cls}"></i>${esc(s.label)}</span>`).join('');return`<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="chart-svg">${grid}<line x1="${p.l}" y1="${H-p.b}" x2="${W-p.r}" y2="${H-p.b}" class="axis-line"/><line x1="${p.l}" y1="${p.t}" x2="${p.l}" y2="${H-p.b}" class="axis-line"/>${lines}${xlabels}</svg><div class="chart-legend">${legend}</div>`;}
function deltaRows(rows){if(!rows.length)return[];const first=rows[0].stats||{};return rows.map(r=>({...r,delta:Object.fromEntries(['wood','metal','hqMetal','sulfur','stones','rockets'].map(k=>[k,Math.max(0,Number(r.stats?.[k]||0)-Number(first[k]||0))]))}));}
function renderFarmStatistics(){const rows=deltaRows(statsHistory);const series=[{key:'hqMetal',label:'HQ Metal',cls:'c-hqm'},{key:'metal',label:'Metal',cls:'c-metal'},{key:'stones',label:'Stones',cls:'c-stone'},{key:'sulfur',label:'Sulfur',cls:'c-sulfur'}];$('#farmChart').innerHTML=svgChart(rows,series,(r,k)=>r.delta?.[k]||0);const hasOnline=statsHistory.some(r=>r.online!=null);$('#onlineLineChart').innerHTML=hasOnline?svgChart(statsHistory,[{key:'online',label:'Online',cls:'c-online'}],r=>r.online||0):'<div class="chart-empty">Online history is unavailable for this provider.</div>';}
function hourlyAverages(){const slots=Array.from({length:24},()=>({sum:0,count:0,total:0}));for(const r of statsHistory){if(r.online==null)continue;const h=new Date(r.at).getHours();slots[h].sum+=Number(r.online||0);slots[h].total+=Number(r.total||0);slots[h].count++;}return slots.map((s,h)=>({hour:h,avg:s.count?s.sum/s.count:null,total:s.count?s.total/s.count:null,count:s.count}));}
function renderHourly(){const arr=hourlyAverages();const valid=arr.filter(x=>x.avg!=null);if(!valid.length){$('#hourlyChart').innerHTML='<div class="chart-empty">Online history unavailable for this provider.</div>';return;}const max=Math.max(1,...valid.map(x=>x.avg));$('#hourlyChart').innerHTML=`<div class="bar-chart">${arr.map(x=>`<div class="bar-col"><div class="bar-track"><div class="bar ${x.avg!=null&&x.total&&x.avg>=x.total*.5?'peak':'normal'}" style="height:${x.avg==null?0:Math.max(3,x.avg/max*100)}%"></div></div><span>${String(x.hour).padStart(2,'0')}</span></div>`).join('')}</div>`;}
function renderRaidWindows(){const valid=hourlyAverages().filter(x=>x.avg!=null).sort((a,b)=>a.avg-b.avg).slice(0,5);if(!valid.length){$('#raidWindows').innerHTML='<div class="chart-empty">Raid windows require online-history data and are unavailable for this provider.</div>';return;}const max=Math.max(1,...valid.map(x=>x.avg));$('#raidWindows').innerHTML=valid.map((x,i)=>`<div class="raid-window ${i===0?'best':''}"><strong>#${i+1}</strong><div><b>${String(x.hour).padStart(2,'0')}:00</b><small>${x.avg.toFixed(1)} średnio online${x.total?` / ${Math.round(x.total)} w teamie`:''}</small></div><div class="raid-meter"><i style="width:${Math.max(4,x.avg/max*100)}%"></i></div></div>`).join('');}
async function loadStatsHistory(){if(!statsTeamId)return;const hours=Number($('#statsRange').value||24);const data=await json(`/api/teams/${encodeURIComponent(statsTeamId)}/history?hours=${hours}`);statsHistory=data.rows||[];renderFarmStatistics();renderHourly();renderRaidWindows();}
async function openStatistics(id){statsTeamId=id;const t=snapshotTeam(id)||teamsMeta.find(x=>x.id===id);$('#statisticsTitle').textContent=`${t?.name||'Team'} - Statistics`;$('#statisticsDialog').showModal();document.querySelectorAll('.statistics-tab').forEach(x=>x.classList.toggle('active',x.dataset.tab==='farm'));document.querySelectorAll('.statistics-pane').forEach(x=>x.classList.toggle('active',x.id==='statsFarm'));try{await loadStatsHistory();}catch(e){showToast(e.message);}}

$('#settingsBtn').onclick=async()=>{const c=await json('/api/config');appConfig=c;updateProviderScopedUi();$('#server').value=c.server||'';$('#wipeDate').value=c.wipeDate||'';$('#bmId').value=c.battlemetricsServerId||'';$('#authToken').value='';$('#tokenState').textContent=c.hasAuthToken?'Reddit token configured. Enter a new token to replace it.':'Reddit token is not configured.';$('#rustoriaServer').value=c.rustoriaServer||'';$('#rustoriaWipe').value=c.rustoriaWipe||'';$('#rustoriaAuthorization').value='';$('#rustoriaCookie').value='';$('#rustoriaApiKey').value='';$('#rustoriaAuthState').textContent=c.hasRustoriaAuthorization?'Rustoria Authorization configured.':'Rustoria Authorization not configured.';$('#rustoriaCookieState').textContent=c.hasRustoriaCookie?'Rustoria Cookie configured.':'Rustoria Cookie not configured.';$('#rustoriaApiKeyState').textContent=c.hasRustoriaApiKey?'Rustoria x-api-key configured.':'Rustoria x-api-key not configured.';fillServerOptions();$('#settings').showModal();};
$('#testApi').onclick=async()=>{const provider=activeProvider;showToast(`Testuję ${providerLabel(provider)} API…`);try{const j=await json('/api/config/test',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({provider,server:$('#server').value,wipeDate:$('#wipeDate').value,authToken:$('#authToken').value,rustoriaServer:$('#rustoriaServer').value,rustoriaWipe:$('#rustoriaWipe').value,rustoriaAuthorization:$('#rustoriaAuthorization').value,rustoriaCookie:$('#rustoriaCookie').value,rustoriaApiKey:$('#rustoriaApiKey').value})});showToast(`${providerLabel(provider)} API OK — ${j.rows} rekordów.`,{autoHide:true});}catch(e){showToast(e.message);}};
$('#saveSettings').onclick=async()=>{await json('/api/config',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({provider:activeProvider,server:$('#server').value,wipeDate:$('#wipeDate').value,battlemetricsServerId:$('#bmId').value,authToken:$('#authToken').value,rustoriaServer:$('#rustoriaServer').value,rustoriaWipe:$('#rustoriaWipe').value,rustoriaAuthorization:$('#rustoriaAuthorization').value,rustoriaCookie:$('#rustoriaCookie').value,rustoriaApiKey:$('#rustoriaApiKey').value})});$('#settings').close();showToast('Ustawienia zapisane. Odświeżam dane…',{autoHide:true});await json('/api/stats/refresh',{method:'POST'});await load();};
function configureCreateDialog(){const p=activeProvider;const server=activeServer||(p==='rustoria'?appConfig?.rustoriaServer:appConfig?.server)||'';$('#createSource').innerHTML=`<b>${providerLabel(p)}</b><span>${esc(server||'No server selected')}</span>`;$('#membersLabel').textContent=p==='rustoria'?'Members — Rustoria ID':'Members — SteamID64';$('#members').placeholder=p==='rustoria'?'6149a6f5a718593b330e5299, Awok\n655dafd6a6df6c41103..., Player 2':'76561198014687798, Awok\n7656119..., Player 2';$('#membersHelp').textContent=p==='rustoria'?'Jedna osoba na linię: 24-znakowy Rustoria ID, opcjonalna nazwa po przecinku.':'Jedna osoba na linię: SteamID64, opcjonalna nazwa po przecinku.';}
$('#createBtn').onclick=()=>{configureCreateDialog();$('#create').showModal();};
$('#saveTeam').onclick=async()=>{const provider=activeProvider;const server=activeServer||(provider==='rustoria'?appConfig?.rustoriaServer:appConfig?.server)||'';if(!server){showToast('Najpierw wybierz server.');return;}await json('/api/teams',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:$('#teamName').value,provider,server,wipe:provider==='rustoria'?(appConfig?.rustoriaWipe||''):(appConfig?.wipeDate||''),members:parseMembers($('#members').value,provider)})});$('#create').close();$('#teamName').value='';$('#members').value='';await load();showToast('Team utworzony. Pobieram statystyki…',{autoHide:true});await json('/api/stats/refresh',{method:'POST'});await load();};
$('#detailRename').onclick=async()=>{const t=teamsMeta.find(x=>x.id===detailTeamId);if(!t)return;const name=prompt('Nowa nazwa teamu:',t.name);if(name&&name.trim()&&name.trim()!==t.name){await updateTeam(t.id,{name:name.trim()});showToast('Nazwa teamu zmieniona.',{autoHide:true});}};
$('#detailDelete').onclick=async()=>{const t=teamsMeta.find(x=>x.id===detailTeamId);if(!t||!confirm(`Usunąć team "${t.name}"?`))return;await json(`/api/teams/${encodeURIComponent(t.id)}`,{method:'DELETE'});$('#teamDetail').close();detailTeamId=null;showToast('Team usunięty.',{autoHide:true});await json('/api/stats/refresh',{method:'POST'});await load();};
$('#addMemberBtn').onclick=async()=>{const id=$('#newMemberId').value.trim();const t=teamsMeta.find(x=>x.id===detailTeamId);if(!t)return;const valid=t.provider==='rustoria'?/^[a-f0-9]{24}$/i.test(id):/^7656\d{13}$/.test(id);if(!valid){alert(t.provider==='rustoria'?'Wpisz prawidłowy 24-znakowy Rustoria ID.':'Wpisz prawidłowy SteamID64.');return;}if(t.members.some(m=>memberId(m,t.provider)===id)){alert('Ten gracz już jest w teamie.');return;}const added=t.provider==='rustoria'?{rustoriaId:id,name:''}:{steamId:id,name:''};await updateTeam(detailTeamId,{members:[...t.members,added]});$('#newMemberId').value='';showToast('Dodano gracza. Pobieram jego dane…',{autoHide:true});};
$('#refreshDetail').onclick=async()=>{showToast('Odświeżam statystyki…');await json('/api/stats/refresh',{method:'POST'});await load();showToast('Statystyki odświeżone.',{autoHide:true});};
$('#statisticsClose').onclick=()=>$('#statisticsDialog').close();
$('#statsRange').onchange=()=>loadStatsHistory().catch(e=>showToast(e.message));
document.querySelectorAll('.statistics-tab').forEach(btn=>btn.onclick=()=>{document.querySelectorAll('.statistics-tab').forEach(x=>x.classList.toggle('active',x===btn));const id={farm:'statsFarm',online:'statsOnline',raid:'statsRaid'}[btn.dataset.tab];document.querySelectorAll('.statistics-pane').forEach(x=>x.classList.toggle('active',x.id===id));if(btn.dataset.tab==='online')renderHourly();if(btn.dataset.tab==='raid')renderRaidWindows();});
$('#teamSearch').oninput=e=>{searchTerm=e.target.value.trim();render(lastSnapshot);};
document.querySelectorAll('.provider-card').forEach(card=>card.onclick=()=>openProvider(card.dataset.provider));
$('#backToNetworks').onclick=()=>showHome();
$('#rustPlusPairBtn').onclick=()=>startRustPlusPairing();
$('#rustPlusUnpairBtn').onclick=()=>unpairRustPlus();
$('#rustPlusCopyBtn').onclick=()=>copyRustPlusSession();
$('#serverFilter').onchange=e=>setActiveSource(activeProvider,e.target.value);

load().catch(e=>showToast(e.message));
const es=new EventSource('/api/stats/live');es.onmessage=e=>{try{render(JSON.parse(e.data))}catch{}};
