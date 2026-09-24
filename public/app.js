const $ = s => document.querySelector(s);
const fmt = n => new Intl.NumberFormat('pl-PL').format(Number(n||0));
const statDefs = [
  ['wood','/assets/icons/wood.png','Wood'],
  ['metal','/assets/icons/metal.png','Metal Ore'],
  ['hqMetal','/assets/icons/hq-metal.png','HQ Metal'],
  ['sulfur','/assets/icons/sulfur.png','Sulfur Ore'],
  ['stones','/assets/icons/stones.png','Stones'],
  ['rockets','/assets/icons/rocket.png','Rockets']
];
const icon = (src,label='',cls='rust-icon') => `<img class=\"${cls}\" src=\"${src}\" alt=\"${esc(label)}\" loading=\"lazy\">`;
let teamsMeta = [];
let lastSnapshot = { timestamp:null, teams:[] };
let detailTeamId = null;
let statsTeamId = null;
let statsHistory = [];
let dismissedToast = '';
let toastTimer = null;
function ago(iso){ if(!iso)return 'Waiting for data'; const s=Math.max(0,Math.floor((Date.now()-new Date(iso))/1000)); return s<10?'Updated just now':s<60?`Updated ${s}s ago`:`Updated ${Math.floor(s/60)}m ago`; }
function esc(s=''){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function avatar(m, large=false){return m.profilePicture?`<img class="avatar-img ${large?'avatar-lg':''}" src="${esc(m.profilePicture)}" alt="">`:`<span class="avatar ${large?'avatar-lg':''}">${esc((m.name||'?').slice(0,1).toUpperCase())}</span>`;}
function fmtTime(sec){sec=Number(sec||0);const h=Math.floor(sec/3600),m=Math.floor((sec%3600)/60);return h?`${h}h ${m}m`:`${m}m`;}
function kd(k,d){k=Number(k||0);d=Number(d||0);return (k/Math.max(1,d)).toFixed(2);}
function snapshotTeam(id){return (lastSnapshot.teams||[]).find(t=>t.id===id) || null;}
function showToast(message,{autoHide=false}={}){
  const msg=String(message||'').trim();
  if(!msg){ $('#toast').hidden=true; $('#toastText').textContent=''; return; }
  if(msg===dismissedToast) return;
  clearTimeout(toastTimer); $('#toastText').textContent=msg; $('#toast').hidden=false;
  if(autoHide) toastTimer=setTimeout(()=>{if($('#toastText').textContent===msg) $('#toast').hidden=true;},6000);
}
$('#toastClose').onclick=()=>{dismissedToast=$('#toastText').textContent;$('#toast').hidden=true;};
function render(snapshot){
  lastSnapshot=snapshot||lastSnapshot;
  const root=$('#teams');
  if(snapshot.error) showToast(snapshot.error);
  else if(snapshot.source && snapshot.source.requestedPlayers > 0 && snapshot.source.returnedPlayers === 0) showToast(`API działa, ale /saved nie zwrócił żadnego z ${snapshot.source.requestedPlayers} SteamID dla tego serwera/wipe.`);
  else if(snapshot.source && snapshot.source.missingIds?.length) showToast(`Dane znalezione dla ${snapshot.source.returnedPlayers}/${snapshot.source.requestedPlayers} graczy. Brak: ${snapshot.source.missingIds.join(', ')}`);
  const byId=new Map((snapshot.teams||[]).map(t=>[t.id,t]));
  root.innerHTML=teamsMeta.map(meta=>{
    const t=byId.get(meta.id)||{...meta,stats:{},members:meta.members};
    return `<section class="team-card" data-team-id="${esc(t.id)}" tabindex="0" aria-label="Otwórz team ${esc(t.name)}">
      <div class="team-title"><h2>${esc(t.name)}</h2><span>${ago(snapshot.timestamp)}</span></div>
      <div class="muted">Created ${new Date(t.createdAt).toLocaleDateString('pl-PL')}</div>
      <div class="status-row"><span class="tracked">Tracked</span><button class="icon-btn team-stats" data-team-id="${esc(t.id)}" title="View Statistics">▥</button><button class="icon-btn team-edit" data-team-id="${esc(t.id)}" title="Team details">⚙</button></div>
      <div class="stats">${statDefs.map(([k,i,l])=>`<div class="stat"><div class="stat-label">${icon(i,l)}<span>${l}</span></div><strong>${fmt(t.stats?.[k])}</strong></div>`).join('')}</div>
      <div class="separator"></div>
      <div class="members-head"><span>MEMBERS</span><b>${t.members.filter(m=>m.isOnline).length}/${t.members.length} online</b></div>
      <div class="members">${t.members.map(m=>`<div class="member"><span class="dot ${m.isOnline?'online':'offline'}" title="${m.isOnline?'Online':'Offline'}"></span>${avatar(m)}<span class="${m.isOnline?'member-online':''}" title="${esc(m.steamId)} · ${m.isOnline?'ONLINE':'offline'}">${esc(m.name||m.steamId)}</span></div>`).join('')}</div>
      <details onclick="event.stopPropagation()"><summary>Raid stats</summary><div class="raid">HV: ${fmt(t.stats?.hvRockets)} · C4: ${fmt(t.stats?.c4)} · Explo: ${fmt(t.stats?.explosiveAmmo)} · Satchels: ${fmt(t.stats?.satchels)} · Kills: ${fmt(t.stats?.kills)}</div></details>
    </section>`;
  }).join('') || '<div class="empty">Brak teamów. Kliknij <b>Create Team</b>.</div>';
  document.querySelectorAll('.team-card').forEach(card=>{
    card.onclick=e=>{ if(e.target.closest('button,details,summary')) return; openTeamDetail(card.dataset.teamId); };
    card.onkeydown=e=>{ if(e.key==='Enter'||e.key===' '){e.preventDefault();openTeamDetail(card.dataset.teamId);} };
  });
  document.querySelectorAll('.team-edit').forEach(btn=>btn.onclick=e=>{e.stopPropagation();openTeamDetail(btn.dataset.teamId);});
  document.querySelectorAll('.team-stats').forEach(btn=>btn.onclick=e=>{e.stopPropagation();openStatistics(btn.dataset.teamId);});
  if(detailTeamId && $('#teamDetail').open) renderTeamDetail(detailTeamId);
}
function memberCard(m){
  const s=m.stats||{};
  const r=(src,label)=>icon(src,label,'mini-rust-icon');
  return `<article class="member-detail-card"><div class="member-detail-head"><div class="member-identity"><span class="dot ${m.isOnline?'online':'offline'}"></span>${avatar(m,true)}<div><strong>${esc(m.name||m.steamId)}</strong><small>${esc(m.steamId)}</small></div></div><button class="remove-member" data-steam-id="${esc(m.steamId)}">Remove</button></div><div class="member-columns"><div><div class="section-kicker kicker-with-icon">${r('/assets/icons/wood.png','Farm')} FARM</div><div class="mini-grid"><span>Wood<b>${fmt(s.wood)}</b></span><span>Metal<b>${fmt(s.metal)}</b></span><span>HQ Metal<b>${fmt(s.hqMetal)}</b></span><span>Sulfur<b>${fmt(s.sulfur)}</b></span><span>Stones<b>${fmt(s.stones)}</b></span><span>Play Time<b>${fmtTime(s.playTime)}</b></span></div></div><div class="member-divider"><div class="section-kicker">PVP</div><div class="mini-grid pvp-grid"><span>Kills<b>${fmt(s.kills)}</b></span><span>Deaths<b>${fmt(s.deaths)}</b></span><span>K/D<b>${kd(s.kills,s.deaths)}</b></span></div><div class="section-kicker raid-kicker kicker-with-icon">${r('/assets/icons/rocket.png','Raiding')} RAIDING</div><div class="mini-grid"><span>Rockets<b>${fmt(s.rockets)}</b></span><span>HV Rockets<b>${fmt(s.hvRockets)}</b></span><span>C4<b>${fmt(s.c4)}</b></span><span>Explosive Ammo<b>${fmt(s.explosiveAmmo)}</b></span></div></div></div></article>`;
}
function renderTeamDetail(id){const t=snapshotTeam(id);if(!t)return;$('#detailTitle').textContent=t.name;$('#detailUpdated').textContent=ago(lastSnapshot.timestamp);$('#detailTotals').innerHTML=statDefs.map(([k,i,l])=>`<div class="detail-total">${icon(i,l,'rust-icon rust-icon-lg')}<small>${l}</small><strong>${fmt(t.stats?.[k])}</strong></div>`).join('');$('#detailMemberCount').textContent=`${t.members.length} members · ${t.members.filter(m=>m.isOnline).length} online`;$('#detailMembers').innerHTML=t.members.map(memberCard).join('')||'<div class="empty-detail">Brak członków.</div>';document.querySelectorAll('.remove-member').forEach(b=>b.onclick=async()=>removeMember(id,b.dataset.steamId));}
function openTeamDetail(id){detailTeamId=id;renderTeamDetail(id);$('#newMemberId').value='';$('#teamDetail').showModal();}
async function removeMember(teamId,steamId){const meta=teamsMeta.find(t=>t.id===teamId);if(!meta)return;const member=meta.members.find(m=>m.steamId===steamId);if(!confirm(`Usunąć ${member?.name||steamId} z teamu?`))return;await updateTeam(teamId,{members:meta.members.filter(m=>m.steamId!==steamId)});showToast('Gracz usunięty z teamu.',{autoHide:true});}
async function updateTeam(id,patch){const meta=teamsMeta.find(t=>t.id===id);if(!meta)return;await json(`/api/teams/${encodeURIComponent(id)}`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:patch.name??meta.name,members:patch.members??meta.members})});await json('/api/stats/refresh',{method:'POST'});await load();}
async function json(url,opt){const r=await fetch(url,opt);if(r.status===401){location='/login';return;}const j=await r.json();if(!r.ok)throw new Error(j.error||'Błąd');return j;}
async function load(){teamsMeta=await json('/api/teams');render(await json('/api/stats'));}
function parseMembers(text){return text.split(/\r?\n/).map(x=>x.trim()).filter(Boolean).map(line=>{const [steamId,...rest]=line.split(',');return {steamId:steamId.trim(),name:rest.join(',').trim()};});}

function svgChart(rows, series, valueFn, {empty='Za mało danych historycznych. Poczekaj aż tracker zbierze kilka próbek.'}={}){
  if(!rows.length) return `<div class="chart-empty">${esc(empty)}</div>`;
  const W=920,H=300,p={l:64,r:20,t:22,b:44};
  const all=series.flatMap(s=>rows.map(r=>Number(valueFn(r,s.key)||0))); const max=Math.max(1,...all); const minT=new Date(rows[0].at).getTime(), maxT=new Date(rows.at(-1).at).getTime();
  const x=t=>p.l+((new Date(t).getTime()-minT)/Math.max(1,maxT-minT))*(W-p.l-p.r); const y=v=>p.t+(1-v/max)*(H-p.t-p.b);
  let grid='';for(let i=0;i<=4;i++){const yy=p.t+i*(H-p.t-p.b)/4;const val=Math.round(max*(1-i/4));grid+=`<line x1="${p.l}" y1="${yy}" x2="${W-p.r}" y2="${yy}" class="grid-line"/><text x="${p.l-10}" y="${yy+4}" text-anchor="end" class="axis-text">${fmt(val)}</text>`;}
  const ticks=Math.min(8,rows.length);let xlabels='';for(let i=0;i<ticks;i++){const idx=Math.round(i*(rows.length-1)/Math.max(1,ticks-1));const r=rows[idx],xx=x(r.at);const d=new Date(r.at);xlabels+=`<text x="${xx}" y="${H-14}" text-anchor="middle" class="axis-text">${d.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}</text>`;}
  const lines=series.map(s=>{const pts=rows.map(r=>`${x(r.at)},${y(valueFn(r,s.key))}`).join(' ');return `<polyline points="${pts}" class="chart-line ${s.cls}"/>`;}).join('');
  const legend=series.map(s=>`<span class="legend-item"><i class="legend-swatch ${s.cls}"></i>${esc(s.label)}</span>`).join('');
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="chart-svg">${grid}<line x1="${p.l}" y1="${H-p.b}" x2="${W-p.r}" y2="${H-p.b}" class="axis-line"/><line x1="${p.l}" y1="${p.t}" x2="${p.l}" y2="${H-p.b}" class="axis-line"/>${lines}${xlabels}</svg><div class="chart-legend">${legend}</div>`;
}
function deltaRows(rows){if(!rows.length)return [];const first=rows[0].stats||{};return rows.map(r=>({...r,delta:Object.fromEntries(['wood','metal','hqMetal','sulfur','stones','rockets'].map(k=>[k,Math.max(0,Number(r.stats?.[k]||0)-Number(first[k]||0))]))}));}
function renderFarmStatistics(){const rows=deltaRows(statsHistory);const series=[{key:'hqMetal',label:'HQ Metal',cls:'c-hqm'},{key:'metal',label:'Metal',cls:'c-metal'},{key:'stones',label:'Stones',cls:'c-stone'},{key:'sulfur',label:'Sulfur',cls:'c-sulfur'}];$('#farmChart').innerHTML=svgChart(rows,series,(r,k)=>r.delta?.[k]||0);$('#onlineLineChart').innerHTML=svgChart(statsHistory,[{key:'online',label:'Online',cls:'c-online'}],r=>r.online||0,{empty:'Brak historii online. Dane będą zbierane automatycznie.'});}
function hourlyAverages(){const slots=Array.from({length:24},()=>({sum:0,count:0,total:0}));for(const r of statsHistory){const h=new Date(r.at).getHours();slots[h].sum+=Number(r.online||0);slots[h].total+=Number(r.total||0);slots[h].count++;}return slots.map((s,h)=>({hour:h,avg:s.count?s.sum/s.count:null,total:s.count?s.total/s.count:null,count:s.count}));}
function renderHourly(){const arr=hourlyAverages();const valid=arr.filter(x=>x.avg!=null);if(!valid.length){$('#hourlyChart').innerHTML='<div class="chart-empty">Brak historii online. Dane będą zbierane automatycznie.</div>';return;}const max=Math.max(1,...valid.map(x=>x.avg));$('#hourlyChart').innerHTML=`<div class="bar-chart">${arr.map(x=>`<div class="bar-col"><div class="bar-track"><div class="bar ${x.avg!=null&&x.total&&x.avg>=x.total*.5?'peak':'normal'}" style="height:${x.avg==null?0:Math.max(3,x.avg/max*100)}%" title="${x.avg==null?'Brak danych':`${x.avg.toFixed(1)} online`}"></div></div><span>${String(x.hour).padStart(2,'0')}</span></div>`).join('')}</div>`;}
function renderRaidWindows(){const valid=hourlyAverages().filter(x=>x.avg!=null).sort((a,b)=>a.avg-b.avg).slice(0,5);if(!valid.length){$('#raidWindows').innerHTML='<div class="chart-empty">Brak historii online. Raid windows pojawią się po zebraniu danych.</div>';return;}const max=Math.max(1,...valid.map(x=>x.avg));$('#raidWindows').innerHTML=valid.map((x,i)=>`<div class="raid-window ${i===0?'best':''}"><strong>#${i+1}</strong><div><b>${String(x.hour).padStart(2,'0')}:00</b><small>${x.avg.toFixed(1)} średnio online${x.total?` / ${Math.round(x.total)} w teamie`:''}</small></div><div class="raid-meter"><i style="width:${Math.max(4,x.avg/max*100)}%"></i></div></div>`).join('');}
async function loadStatsHistory(){if(!statsTeamId)return;const hours=Number($('#statsRange').value||24);const data=await json(`/api/teams/${encodeURIComponent(statsTeamId)}/history?hours=${hours}`);statsHistory=data.rows||[];renderFarmStatistics();renderHourly();renderRaidWindows();}
async function openStatistics(id){statsTeamId=id;const t=snapshotTeam(id)||teamsMeta.find(x=>x.id===id);$('#statisticsTitle').textContent=`${t?.name||'Team'} - Statistics`;$('#statisticsDialog').showModal();document.querySelectorAll('.statistics-tab').forEach(x=>x.classList.toggle('active',x.dataset.tab==='farm'));document.querySelectorAll('.statistics-pane').forEach(x=>x.classList.toggle('active',x.id==='statsFarm'));try{await loadStatsHistory();}catch(e){showToast(e.message);}}

$('#settingsBtn').onclick=async()=>{const c=await json('/api/config');$('#server').value=c.server||'';$('#wipeDate').value=c.wipeDate||'';$('#bmId').value=c.battlemetricsServerId||'';$('#authToken').value='';$('#tokenState').textContent=c.hasAuthToken?'Auth token is configured. Enter a new token to replace it.':'Auth token is not configured.';$('#settings').showModal();};
$('#testApi').onclick=async()=>{showToast('Testuję Reddit PlayRust API…');try{const j=await json('/api/config/test',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({server:$('#server').value,wipeDate:$('#wipeDate').value,authToken:$('#authToken').value})});showToast(`API OK — pobrano ${j.rows} rekordów z pierwszej strony Wood.`,{autoHide:true});}catch(e){showToast(e.message);}};
$('#saveSettings').onclick=async()=>{await json('/api/config',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({server:$('#server').value,wipeDate:$('#wipeDate').value,battlemetricsServerId:$('#bmId').value,authToken:$('#authToken').value})});$('#settings').close();showToast('Ustawienia zapisane. Odświeżam dane…',{autoHide:true});await json('/api/stats/refresh',{method:'POST'});await load();};
$('#createBtn').onclick=()=>$('#create').showModal();
$('#saveTeam').onclick=async()=>{await json('/api/teams',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:$('#teamName').value,members:parseMembers($('#members').value)})});$('#create').close();$('#teamName').value='';$('#members').value='';await load();showToast('Team utworzony. Pobieram statystyki…',{autoHide:true});await json('/api/stats/refresh',{method:'POST'});await load();};
$('#detailRename').onclick=async()=>{const t=teamsMeta.find(x=>x.id===detailTeamId);if(!t)return;const name=prompt('Nowa nazwa teamu:',t.name);if(name&&name.trim()&&name.trim()!==t.name){await updateTeam(t.id,{name:name.trim()});showToast('Nazwa teamu zmieniona.',{autoHide:true});}};
$('#detailDelete').onclick=async()=>{const t=teamsMeta.find(x=>x.id===detailTeamId);if(!t||!confirm(`Usunąć team "${t.name}"?`))return;await json(`/api/teams/${encodeURIComponent(t.id)}`,{method:'DELETE'});$('#teamDetail').close();detailTeamId=null;showToast('Team usunięty.',{autoHide:true});await json('/api/stats/refresh',{method:'POST'});await load();};
$('#addMemberBtn').onclick=async()=>{const steamId=$('#newMemberId').value.trim();if(!/^7656\d{13}$/.test(steamId)){alert('Wpisz prawidłowy SteamID64.');return;}const t=teamsMeta.find(x=>x.id===detailTeamId);if(!t)return;if(t.members.some(m=>m.steamId===steamId)){alert('Ten gracz już jest w teamie.');return;}await updateTeam(t.id,{members:[...t.members,{steamId,name:''}]});$('#newMemberId').value='';showToast('Dodano gracza. Pobieram jego dane…',{autoHide:true});};
$('#refreshDetail').onclick=async()=>{showToast('Odświeżam statystyki…');await json('/api/stats/refresh',{method:'POST'});await load();showToast('Statystyki odświeżone.',{autoHide:true});};
$('#statisticsClose').onclick=()=>$('#statisticsDialog').close();
$('#statsRange').onchange=()=>loadStatsHistory().catch(e=>showToast(e.message));
document.querySelectorAll('.statistics-tab').forEach(btn=>btn.onclick=()=>{document.querySelectorAll('.statistics-tab').forEach(x=>x.classList.toggle('active',x===btn));const id={farm:'statsFarm',online:'statsOnline',raid:'statsRaid'}[btn.dataset.tab];document.querySelectorAll('.statistics-pane').forEach(x=>x.classList.toggle('active',x.id===id));if(btn.dataset.tab==='online')renderHourly();if(btn.dataset.tab==='raid')renderRaidWindows();});
load().catch(e=>showToast(e.message));
const es=new EventSource('/api/stats/live');es.onmessage=e=>{try{render(JSON.parse(e.data))}catch{}};
