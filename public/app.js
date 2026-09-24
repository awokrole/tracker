const $ = s => document.querySelector(s);
const fmt = n => new Intl.NumberFormat('pl-PL').format(Number(n||0));
const statDefs = [
  ['wood','🪵','Wood'],['metal','🪨','Metal'],['hqMetal','⚙️','HQ Metal'],['sulfur','🟡','Sulfur'],['stones','🪨','Stones'],['rockets','🚀','Rockets']
];
let teamsMeta = [];
let lastSnapshot = { timestamp:null, teams:[] };
let detailTeamId = null;
function ago(iso){ if(!iso)return 'Waiting for data'; const s=Math.max(0,Math.floor((Date.now()-new Date(iso))/1000)); return s<10?'Updated just now':s<60?`Updated ${s}s ago`:`Updated ${Math.floor(s/60)}m ago`; }
function esc(s=''){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function avatar(m, large=false){return m.profilePicture?`<img class="avatar-img ${large?'avatar-lg':''}" src="${esc(m.profilePicture)}" alt="">`:`<span class="avatar ${large?'avatar-lg':''}">${esc((m.name||'?').slice(0,1).toUpperCase())}</span>`;}
function fmtTime(sec){sec=Number(sec||0);const h=Math.floor(sec/3600),m=Math.floor((sec%3600)/60);return h?`${h}h ${m}m`:`${m}m`;}
function kd(k,d){k=Number(k||0);d=Number(d||0);return (k/Math.max(1,d)).toFixed(2);}
function snapshotTeam(id){return (lastSnapshot.teams||[]).find(t=>t.id===id) || null;}
function render(snapshot){
  lastSnapshot=snapshot||lastSnapshot;
  const root=$('#teams');
  if(snapshot.error) {
    $('#toast').textContent=snapshot.error;
  } else if (snapshot.source && snapshot.source.requestedPlayers > 0 && snapshot.source.returnedPlayers === 0) {
    $('#toast').textContent=`API działa, ale /saved nie zwrócił żadnego z ${snapshot.source.requestedPlayers} SteamID dla tego serwera/wipe.`;
  } else if (snapshot.source && snapshot.source.missingIds?.length) {
    $('#toast').textContent=`Dane znalezione dla ${snapshot.source.returnedPlayers}/${snapshot.source.requestedPlayers} graczy. Brak: ${snapshot.source.missingIds.join(', ')}`;
  } else if($('#toast').textContent.startsWith('Reddit') || $('#toast').textContent.startsWith('API działa') || $('#toast').textContent.startsWith('Dane znalezione')) {
    $('#toast').textContent='';
  }
  const byId=new Map((snapshot.teams||[]).map(t=>[t.id,t]));
  root.innerHTML=teamsMeta.map(meta=>{
    const t=byId.get(meta.id)||{...meta,stats:{},members:meta.members};
    return `<section class="team-card" data-team-id="${esc(t.id)}" tabindex="0" aria-label="Otwórz team ${esc(t.name)}">
      <div class="team-title"><h2>${esc(t.name)}</h2><span>${ago(snapshot.timestamp)}</span></div>
      <div class="muted">Created ${new Date(t.createdAt).toLocaleDateString('pl-PL')}</div>
      <div class="status-row"><span class="tracked">Tracked</span><span title="Stats">▥</span><button class="icon-btn team-edit" data-team-id="${esc(t.id)}" title="Team details">⚙</button></div>
      <div class="stats">${statDefs.map(([k,i,l])=>`<div class="stat"><div class="stat-label"><span>${i}</span>${l}</div><strong>${fmt(t.stats?.[k])}</strong></div>`).join('')}</div>
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
  if(detailTeamId && $('#teamDetail').open) renderTeamDetail(detailTeamId);
}

function memberCard(m){
  const s=m.stats||{};
  return `<article class="member-detail-card">
    <div class="member-detail-head">
      <div class="member-identity"><span class="dot ${m.isOnline?'online':'offline'}"></span>${avatar(m,true)}<div><strong>${esc(m.name||m.steamId)}</strong><small>${esc(m.steamId)}</small></div></div>
      <button class="remove-member" data-steam-id="${esc(m.steamId)}">♙ Remove</button>
    </div>
    <div class="member-columns">
      <div><div class="section-kicker">🪵 FARM</div><div class="mini-grid">
        <span>Wood<b>${fmt(s.wood)}</b></span><span>Metal<b>${fmt(s.metal)}</b></span>
        <span>HQ Metal<b>${fmt(s.hqMetal)}</b></span><span>Sulfur<b>${fmt(s.sulfur)}</b></span>
        <span>Stones<b>${fmt(s.stones)}</b></span><span>Play Time<b>${fmtTime(s.playTime)}</b></span>
      </div></div>
      <div class="member-divider"><div class="section-kicker">💀 PVP</div><div class="mini-grid pvp-grid">
        <span>Kills<b>${fmt(s.kills)}</b></span><span>Deaths<b>${fmt(s.deaths)}</b></span><span>K/D<b>${kd(s.kills,s.deaths)}</b></span>
      </div><div class="section-kicker raid-kicker">🔪 RAIDING</div><div class="mini-grid">
        <span>Rockets<b>${fmt(s.rockets)}</b></span><span>HV Rockets<b>${fmt(s.hvRockets)}</b></span>
        <span>C4<b>${fmt(s.c4)}</b></span><span>Explosive Ammo<b>${fmt(s.explosiveAmmo)}</b></span>
      </div></div>
    </div>
  </article>`;
}
function renderTeamDetail(id){
  const t=snapshotTeam(id); if(!t)return;
  $('#detailTitle').textContent=t.name;
  $('#detailUpdated').textContent=ago(lastSnapshot.timestamp);
  $('#detailTotals').innerHTML=statDefs.map(([k,i,l])=>`<div class="detail-total"><span>${i}</span><small>${l}</small><strong>${fmt(t.stats?.[k])}</strong></div>`).join('');
  $('#detailMemberCount').textContent=`${t.members.length} members · ${t.members.filter(m=>m.isOnline).length} online`;
  $('#detailMembers').innerHTML=t.members.map(memberCard).join('') || '<div class="empty-detail">Brak członków.</div>';
  document.querySelectorAll('.remove-member').forEach(b=>b.onclick=async()=>removeMember(id,b.dataset.steamId));
}
function openTeamDetail(id){ detailTeamId=id; renderTeamDetail(id); $('#newMemberId').value=''; $('#teamDetail').showModal(); }
async function removeMember(teamId,steamId){
  const meta=teamsMeta.find(t=>t.id===teamId); if(!meta)return;
  const member=meta.members.find(m=>m.steamId===steamId);
  if(!confirm(`Usunąć ${member?.name||steamId} z teamu?`))return;
  await updateTeam(teamId,{members:meta.members.filter(m=>m.steamId!==steamId)});
  $('#toast').textContent='Gracz usunięty z teamu.';
}
async function updateTeam(id,patch){
  const meta=teamsMeta.find(t=>t.id===id); if(!meta)return;
  await json(`/api/teams/${encodeURIComponent(id)}`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:patch.name??meta.name,members:patch.members??meta.members})});
  await json('/api/stats/refresh',{method:'POST'}); await load();
}
async function json(url,opt){const r=await fetch(url,opt);if(r.status===401){location='/login';return;}const j=await r.json();if(!r.ok)throw new Error(j.error||'Błąd');return j;}
async function load(){teamsMeta=await json('/api/teams');render(await json('/api/stats'));}
function parseMembers(text){return text.split(/\r?\n/).map(x=>x.trim()).filter(Boolean).map(line=>{const [steamId,...rest]=line.split(',');return {steamId:steamId.trim(),name:rest.join(',').trim()};});}

$('#settingsBtn').onclick=async()=>{const c=await json('/api/config');$('#server').value=c.server||'';$('#wipeDate').value=c.wipeDate||'';$('#bmId').value=c.battlemetricsServerId||'';$('#authToken').value='';$('#tokenState').textContent=c.hasAuthToken?'Auth token is configured. Enter a new token to replace it.':'Auth token is not configured.';$('#settings').showModal();};
$('#testApi').onclick=async()=>{ $('#toast').textContent='Testuję Reddit PlayRust API…'; try { const j=await json('/api/config/test',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({server:$('#server').value,wipeDate:$('#wipeDate').value,authToken:$('#authToken').value})}); $('#toast').textContent=`API OK — pobrano ${j.rows} rekordów z pierwszej strony Wood.`; } catch(e) { $('#toast').textContent=e.message; } };
$('#saveSettings').onclick=async()=>{await json('/api/config',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({server:$('#server').value,wipeDate:$('#wipeDate').value,battlemetricsServerId:$('#bmId').value,authToken:$('#authToken').value})});$('#settings').close();$('#toast').textContent='Ustawienia zapisane. Odświeżam dane…';await json('/api/stats/refresh',{method:'POST'});await load();};
$('#createBtn').onclick=()=>$('#create').showModal();
$('#saveTeam').onclick=async()=>{await json('/api/teams',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:$('#teamName').value,members:parseMembers($('#members').value)})});$('#create').close();$('#teamName').value='';$('#members').value='';await load();$('#toast').textContent='Team utworzony. Pobieram statystyki…';await json('/api/stats/refresh',{method:'POST'});await load();};
$('#detailRename').onclick=async()=>{const t=teamsMeta.find(x=>x.id===detailTeamId);if(!t)return;const name=prompt('Nowa nazwa teamu:',t.name);if(name&&name.trim()&&name.trim()!==t.name){await updateTeam(t.id,{name:name.trim()});$('#toast').textContent='Nazwa teamu zmieniona.';}};
$('#detailDelete').onclick=async()=>{const t=teamsMeta.find(x=>x.id===detailTeamId);if(!t||!confirm(`Usunąć team "${t.name}"?`))return;await json(`/api/teams/${encodeURIComponent(t.id)}`,{method:'DELETE'});$('#teamDetail').close();detailTeamId=null;$('#toast').textContent='Team usunięty.';await json('/api/stats/refresh',{method:'POST'});await load();};
$('#addMemberBtn').onclick=async()=>{const steamId=$('#newMemberId').value.trim();if(!/^7656\d{13}$/.test(steamId)){alert('Wpisz prawidłowy SteamID64.');return;}const t=teamsMeta.find(x=>x.id===detailTeamId);if(!t)return;if(t.members.some(m=>m.steamId===steamId)){alert('Ten gracz już jest w teamie.');return;}await updateTeam(t.id,{members:[...t.members,{steamId,name:''}]});$('#newMemberId').value='';$('#toast').textContent='Dodano gracza. Pobieram jego dane…';};
$('#refreshDetail').onclick=async()=>{$('#toast').textContent='Odświeżam statystyki…';await json('/api/stats/refresh',{method:'POST'});await load();$('#toast').textContent='Statystyki odświeżone.';};
load().catch(e=>$('#toast').textContent=e.message);
const es=new EventSource('/api/stats/live');es.onmessage=e=>{try{render(JSON.parse(e.data))}catch{}};
