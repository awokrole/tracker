const $ = s => document.querySelector(s);
const fmt = n => new Intl.NumberFormat('pl-PL').format(Number(n||0));
const statDefs = [
  ['wood','🪵','Wood'],['metal','🪨','Metal'],['hqMetal','⚙️','HQ Metal'],['sulfur','🟡','Sulfur'],['stones','🪨','Stones'],['rockets','🚀','Rockets']
];
let teamsMeta = [];
let lastSnapshot = { timestamp:null, teams:[] };
function ago(iso){ if(!iso)return 'Waiting for data'; const s=Math.max(0,Math.floor((Date.now()-new Date(iso))/1000)); return s<10?'Updated just now':s<60?`Updated ${s}s ago`:`Updated ${Math.floor(s/60)}m ago`; }
function esc(s=''){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function avatar(m){return m.profilePicture?`<img class="avatar-img" src="${esc(m.profilePicture)}" alt="">`:`<span class="avatar">${esc((m.name||'?').slice(0,1).toUpperCase())}</span>`;}
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
    return `<section class="team-card"><div class="team-title"><h2>${esc(t.name)}</h2><span>${ago(snapshot.timestamp)}</span></div><div class="muted">Created ${new Date(t.createdAt).toLocaleDateString('pl-PL')}</div><div class="status-row"><span class="tracked">Tracked</span><span title="Stats">▥</span><button class="icon-btn team-edit" data-team-id="${esc(t.id)}" title="Team settings">⚙</button></div><div class="stats">${statDefs.map(([k,i,l])=>`<div class="stat"><div class="stat-label"><span>${i}</span>${l}</div><strong>${fmt(t.stats?.[k])}</strong></div>`).join('')}</div><div class="separator"></div><div class="members-head"><span>MEMBERS</span><b>${t.members.length}/12</b></div><div class="members">${t.members.map(m=>`<div class="member"><span class="dot"></span>${avatar(m)}<span title="${esc(m.steamId)}">${esc(m.name||m.steamId)}</span></div>`).join('')}</div><details><summary>Raid stats</summary><div class="raid">HV: ${fmt(t.stats?.hvRockets)} · C4: ${fmt(t.stats?.c4)} · Explo: ${fmt(t.stats?.explosiveAmmo)} · Satchels: ${fmt(t.stats?.satchels)} · Kills: ${fmt(t.stats?.kills)}</div></details></section>`;
  }).join('') || '<div class="empty">Brak teamów. Kliknij <b>Create Team</b>.</div>';
  document.querySelectorAll('.team-edit').forEach(btn=>btn.onclick=()=>openTeamEdit(btn.dataset.teamId));
}
async function json(url,opt){const r=await fetch(url,opt);if(r.status===401){location='/login';return;}const j=await r.json();if(!r.ok)throw new Error(j.error||'Błąd');return j;}
async function load(){teamsMeta=await json('/api/teams');render(await json('/api/stats'));}
function parseMembers(text){return text.split(/\r?\n/).map(x=>x.trim()).filter(Boolean).map(line=>{const [steamId,...rest]=line.split(',');return {steamId:steamId.trim(),name:rest.join(',').trim()};});}
function membersText(members){return (members||[]).map(m=>`${m.steamId}${m.name?`, ${m.name}`:''}`).join('\n');}
function openTeamEdit(id){const t=teamsMeta.find(x=>x.id===id);if(!t)return;$('#editTeamId').value=t.id;$('#editTeamName').value=t.name||'';$('#editMembers').value=membersText(t.members);$('#editTeam').showModal();}

$('#settingsBtn').onclick=async()=>{const c=await json('/api/config');$('#server').value=c.server||'';$('#wipeDate').value=c.wipeDate||'';$('#bmId').value=c.battlemetricsServerId||'';$('#authToken').value='';$('#tokenState').textContent=c.hasAuthToken?'Auth token is configured. Enter a new token to replace it.':'Auth token is not configured.';$('#settings').showModal();};
$('#testApi').onclick=async()=>{ $('#toast').textContent='Testuję Reddit PlayRust API…'; try { const j=await json('/api/config/test',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({server:$('#server').value,wipeDate:$('#wipeDate').value,authToken:$('#authToken').value})}); $('#toast').textContent=`API OK — pobrano ${j.rows} rekordów z pierwszej strony Wood.`; } catch(e) { $('#toast').textContent=e.message; } };
$('#saveSettings').onclick=async()=>{await json('/api/config',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({server:$('#server').value,wipeDate:$('#wipeDate').value,battlemetricsServerId:$('#bmId').value,authToken:$('#authToken').value})});$('#settings').close();$('#toast').textContent='Ustawienia zapisane. Odświeżam dane…';await json('/api/stats/refresh',{method:'POST'});await load();};
$('#createBtn').onclick=()=>$('#create').showModal();
$('#saveTeam').onclick=async()=>{await json('/api/teams',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:$('#teamName').value,members:parseMembers($('#members').value)})});$('#create').close();$('#teamName').value='';$('#members').value='';await load();$('#toast').textContent='Team utworzony. Pobieram statystyki…';await json('/api/stats/refresh',{method:'POST'});await load();};
$('#saveEditTeam').onclick=async()=>{const id=$('#editTeamId').value;await json(`/api/teams/${encodeURIComponent(id)}`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:$('#editTeamName').value,members:parseMembers($('#editMembers').value)})});$('#editTeam').close();await load();$('#toast').textContent='Team zapisany. Odświeżam statystyki…';await json('/api/stats/refresh',{method:'POST'});await load();};
$('#deleteTeam').onclick=async()=>{const id=$('#editTeamId').value;const name=$('#editTeamName').value||'team';if(!confirm(`Usunąć team "${name}"?`))return;await json(`/api/teams/${encodeURIComponent(id)}`,{method:'DELETE'});$('#editTeam').close();$('#toast').textContent='Team usunięty.';await load();await json('/api/stats/refresh',{method:'POST'});};
load().catch(e=>$('#toast').textContent=e.message);
const es=new EventSource('/api/stats/live');es.onmessage=e=>{try{render(JSON.parse(e.data))}catch{}};
