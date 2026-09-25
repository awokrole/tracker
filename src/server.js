import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readStore, writeStore } from './store.js';
import { STAT_IDS, fetchSavedPlayers, getPage, normalizeAuthToken, clearPageCache } from './providers/reddit.js';
import { fetchRustoriaPlayers, testRustoria, tryListRustoriaServers, clearRustoriaCache, getRustoriaUser } from './providers/rustoria.js';


const rustoriaActivityState = new Map();
const RUSTORIA_ACTIVE_MS = Math.max(60_000, Number(process.env.RUSTORIA_ACTIVE_MS || 5 * 60_000));
const RUSTORIA_RECENT_MS = Math.max(RUSTORIA_ACTIVE_MS, Number(process.env.RUSTORIA_RECENT_MS || 15 * 60_000));
const rustoriaActivityKeys = ['playTime','wood','metal','hqMetal','sulfur','stones','kills','deaths','rockets','hvRockets','c4','satchels','headshots','wounds','bulletsFired','bulletsHitPlayer','rocketHitOnline','rocketHitOffline'];
function rustoriaActivityKey(server, wipe, rustoriaId) { return `${server}|${wipe || ''}|${rustoriaId}`; }
function activitySnapshot(stats = {}) { return Object.fromEntries(rustoriaActivityKeys.map(k => [k, stats?.[k] == null ? null : Number(stats[k]) || 0])); }
function detectRustoriaActivity(server, wipe, rustoriaId, stats = {}) {
  const key = rustoriaActivityKey(server, wipe, rustoriaId);
  const now = Date.now();
  const current = activitySnapshot(stats);
  const previous = rustoriaActivityState.get(key);
  let changed = false;
  if (previous?.values) {
    for (const stat of rustoriaActivityKeys) {
      const a = previous.values[stat], b = current[stat];
      if (a != null && b != null && b > a) { changed = true; break; }
    }
  }
  const lastActivityAt = changed ? now : (previous?.lastActivityAt || null);
  rustoriaActivityState.set(key, { values: current, lastActivityAt, sampledAt: now });
  if (!previous) return { state: 'warming', lastActivityAt: null, changed: false };
  if (!lastActivityAt) return { state: 'inactive', lastActivityAt: null, changed: false };
  const age = now - lastActivityAt;
  return { state: age <= RUSTORIA_ACTIVE_MS ? 'active' : age <= RUSTORIA_RECENT_MS ? 'recent' : 'inactive', lastActivityAt: new Date(lastActivityAt).toISOString(), changed };
}

const app = express();
const port = Number(process.env.PORT || 3000);
const password = process.env.PANEL_PASSWORD || '';
const sessionSecret = process.env.SESSION_SECRET || '';
if (!password || !sessionSecret) console.warn('[WARN] Ustaw PANEL_PASSWORD i SESSION_SECRET w Railway Variables.');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, '..', 'public');
app.use(express.json({ limit: '128kb' }));
app.use(express.urlencoded({ extended: false }));

function b64url(x) { return Buffer.from(x).toString('base64url'); }
function sign(payload) { return crypto.createHmac('sha256', sessionSecret || 'dev-secret').update(payload).digest('base64url'); }
function makeSession() {
  const payload = b64url(JSON.stringify({ exp: Date.now() + 7 * 86400_000 }));
  return `${payload}.${sign(payload)}`;
}
function validSession(req) {
  const raw = (req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith('rustdash='))?.slice(9);
  if (!raw) return false;
  const [payload, sig] = raw.split('.');
  if (!payload || !sig) return false;
  const expected = sign(payload);
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  try { return JSON.parse(Buffer.from(payload, 'base64url').toString()).exp > Date.now(); } catch { return false; }
}
function auth(req, res, next) {
  if (validSession(req)) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'UNAUTHORIZED' });
  return res.redirect('/login');
}

app.get('/login', (req, res) => res.sendFile(path.join(publicDir, 'login.html')));
app.post('/login', (req, res) => {
  const provided = String(req.body.password || '');
  const a = Buffer.from(provided), b = Buffer.from(password);
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!ok) return res.redirect('/login?error=1');
  res.setHeader('Set-Cookie', `rustdash=${makeSession()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800${process.env.RAILWAY_ENVIRONMENT ? '; Secure' : ''}`);
  res.redirect('/');
});
app.post('/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'rustdash=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
  res.redirect('/login');
});

app.use('/assets', express.static(path.join(publicDir, 'assets')));
app.get('/', auth, (req, res) => res.sendFile(path.join(publicDir, 'index.html')));
app.get('/app.js', auth, (req, res) => res.sendFile(path.join(publicDir, 'app.js')));
app.get('/style.css', auth, (req, res) => res.sendFile(path.join(publicDir, 'style.css')));

function providerOf(team) { return team?.provider === 'rustoria' ? 'rustoria' : 'reddit'; }
function normalizeTeam(team, config) {
  const provider = providerOf(team);
  const server = String(team?.server || (provider === 'rustoria' ? config.rustoriaServer : config.server) || '').trim();
  const wipe = String(team?.wipe ?? (provider === 'rustoria' ? config.rustoriaWipe : config.wipeDate) ?? '').trim();
  const members = Array.isArray(team?.members) ? team.members.map(m => provider === 'rustoria'
    ? { rustoriaId: String(m.rustoriaId || m.playerId || '').trim(), name: String(m.name || '').trim().slice(0, 60) }
    : { steamId: String(m.steamId || m.playerId || '').trim(), name: String(m.name || '').trim().slice(0, 60) }) : [];
  return { ...team, provider, server, wipe, members };
}
function validMember(provider, m) {
  return provider === 'rustoria' ? /^[a-f0-9]{24}$/i.test(m.rustoriaId || '') : /^7656\d{13}$/.test(m.steamId || '');
}
function normalizeMembers(provider, input) {
  const arr = Array.isArray(input) ? input : [];
  return arr.map(m => provider === 'rustoria'
    ? { rustoriaId: String(m.rustoriaId || m.playerId || m.id || '').trim(), name: String(m.name || '').trim().slice(0, 60) }
    : { steamId: String(m.steamId || m.playerId || m.id || '').trim(), name: String(m.name || '').trim().slice(0, 60) })
    .filter(m => validMember(provider, m));
}

app.get('/api/config', auth, (req, res) => {
  const { config } = readStore();
  res.json({
    provider: config.provider || 'reddit',
    server: config.server,
    wipeDate: config.wipeDate,
    battlemetricsServerId: config.battlemetricsServerId,
    hasAuthToken: Boolean(config.authToken),
    rustoriaServer: config.rustoriaServer || '',
    rustoriaWipe: config.rustoriaWipe || '',
    hasRustoriaAuthorization: Boolean(config.rustoriaAuthorization),
    hasRustoriaCookie: Boolean(config.rustoriaCookie),
    hasRustoriaApiKey: Boolean(config.rustoriaApiKey)
  });
});
app.put('/api/config', auth, (req, res) => {
  const db = readStore();
  if (req.body.provider != null) db.config.provider = req.body.provider === 'rustoria' ? 'rustoria' : 'reddit';
  if (req.body.server != null) db.config.server = String(req.body.server || '').trim();
  if (req.body.wipeDate != null) db.config.wipeDate = String(req.body.wipeDate || '').trim();
  if (req.body.battlemetricsServerId != null) db.config.battlemetricsServerId = String(req.body.battlemetricsServerId || '').trim();
  if (String(req.body.authToken || '').trim()) db.config.authToken = String(req.body.authToken).trim();
  if (req.body.rustoriaServer != null) db.config.rustoriaServer = String(req.body.rustoriaServer || '').trim();
  if (req.body.rustoriaWipe != null) db.config.rustoriaWipe = String(req.body.rustoriaWipe || '').trim();
  if (String(req.body.rustoriaAuthorization || '').trim()) db.config.rustoriaAuthorization = String(req.body.rustoriaAuthorization).trim();
  if (String(req.body.rustoriaCookie || '').trim()) db.config.rustoriaCookie = String(req.body.rustoriaCookie).trim();
  if (String(req.body.rustoriaApiKey || '').trim()) db.config.rustoriaApiKey = String(req.body.rustoriaApiKey).trim();
  writeStore(db);
  clearPageCache(); clearRustoriaCache();
  res.json({ ok: true });
});

app.post('/api/config/test', auth, async (req, res) => {
  const db = readStore();
  const provider = req.body.provider === 'rustoria' ? 'rustoria' : 'reddit';
  try {
    if (provider === 'rustoria') {
      const temp = {
        ...db.config,
        rustoriaAuthorization: String(req.body.rustoriaAuthorization || '').trim() || db.config.rustoriaAuthorization,
        rustoriaCookie: String(req.body.rustoriaCookie || '').trim() || db.config.rustoriaCookie,
        rustoriaApiKey: String(req.body.rustoriaApiKey || '').trim() || db.config.rustoriaApiKey
      };
      const out = await testRustoria(temp, String(req.body.rustoriaServer || db.config.rustoriaServer || '').trim(), String(req.body.rustoriaWipe ?? db.config.rustoriaWipe ?? '').trim());
      return res.json({ ok: true, provider, ...out });
    }
    const temp = {
      ...db.config,
      server: String(req.body.server || db.config.server || '').trim(),
      wipeDate: String(req.body.wipeDate || db.config.wipeDate || '').trim(),
      authToken: String(req.body.authToken || '').trim() || db.config.authToken
    };
    const rows = await getPage(temp, STAT_IDS.wood, 0);
    res.json({ ok: true, provider, rows: rows.length, authHeaderConfigured: Boolean(normalizeAuthToken(temp.authToken)) });
  } catch (e) {
    res.status(400).json({ error: e.message || String(e) });
  }
});

app.get('/api/providers/rustoria/servers', auth, async (req, res) => {
  try { res.json(await tryListRustoriaServers(readStore().config)); }
  catch (e) { res.status(400).json({ error: e.message || String(e) }); }
});

app.get('/api/teams', auth, (req, res) => {
  const db = readStore();
  res.json(db.teams.map(t => normalizeTeam(t, db.config)));
});
app.post('/api/teams', auth, (req, res) => {
  const db = readStore();
  const provider = req.body.provider === 'rustoria' ? 'rustoria' : 'reddit';
  const team = {
    id: crypto.randomUUID(),
    name: String(req.body.name || 'Team').trim().slice(0, 60),
    createdAt: new Date().toISOString(),
    tracked: true,
    provider,
    server: String(req.body.server || (provider === 'rustoria' ? db.config.rustoriaServer : db.config.server) || '').trim(),
    wipe: String(req.body.wipe ?? (provider === 'rustoria' ? db.config.rustoriaWipe : db.config.wipeDate) ?? '').trim(),
    members: normalizeMembers(provider, req.body.members)
  };
  db.teams.push(team); writeStore(db); res.json(team);
});
app.put('/api/teams/:id', auth, (req, res) => {
  const db = readStore();
  const t = db.teams.find(x => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: 'NOT_FOUND' });
  const current = normalizeTeam(t, db.config);
  const provider = req.body.provider != null ? (req.body.provider === 'rustoria' ? 'rustoria' : 'reddit') : current.provider;
  if (req.body.name != null) t.name = String(req.body.name).trim().slice(0, 60);
  if (req.body.tracked != null) t.tracked = Boolean(req.body.tracked);
  t.provider = provider;
  if (req.body.server != null) t.server = String(req.body.server || '').trim(); else if (!t.server) t.server = current.server;
  if (req.body.wipe != null) t.wipe = String(req.body.wipe || '').trim(); else if (t.wipe == null) t.wipe = current.wipe;
  if (Array.isArray(req.body.members)) t.members = normalizeMembers(provider, req.body.members);
  writeStore(db); res.json(normalizeTeam(t, db.config));
});
app.delete('/api/teams/:id', auth, (req,res) => {
  const db=readStore();
  db.teams=db.teams.filter(x=>x.id!==req.params.id);
  db.history=(db.history||[]).map(h=>{ if(h.teams) delete h.teams[req.params.id]; return h; });
  writeStore(db); res.json({ok:true});
});

const HISTORY_SAMPLE_MS = Math.max(60_000, Number(process.env.HISTORY_SAMPLE_MS || 300_000));
const HISTORY_MAX_DAYS = Math.max(1, Number(process.env.HISTORY_MAX_DAYS || 14));
let lastSnapshot = { timestamp: null, teams: [], error: null, sources: [] };
const clients = new Set();
const allStats = ['wood','metal','hqMetal','sulfur','stones','rockets','hvRockets','c4','explosiveAmmo','satchels','kills','deaths','playTime','headshots','accuracy','rocketHitOnline','rocketHitOffline'];

function nullableSum(values) {
  const supported = values.filter(v => v != null);
  if (!supported.length) return null;
  return supported.reduce((a, b) => a + Number(b || 0), 0);
}
function recordHistory(snapshot) {
  if (!snapshot?.timestamp || snapshot?.error) return;
  const db = readStore();
  const at = new Date(snapshot.timestamp).getTime();
  const last = db.history.at(-1);
  if (last && at - new Date(last.at).getTime() < HISTORY_SAMPLE_MS) return;
  const teams = Object.fromEntries((snapshot.teams || []).map(t => [t.id, {
    stats: {
      wood: t.stats?.wood ?? null, metal: t.stats?.metal ?? null, hqMetal: t.stats?.hqMetal ?? null,
      sulfur: t.stats?.sulfur ?? null, stones: t.stats?.stones ?? null, rockets: t.stats?.rockets ?? null,
      hvRockets: t.stats?.hvRockets ?? null, c4: t.stats?.c4 ?? null, explosiveAmmo: t.stats?.explosiveAmmo ?? null
    },
    online: t.onlineSupported === false ? null : (t.members || []).filter(m => m.isOnline === true).length,
    total: (t.members || []).length
  }]));
  db.history.push({ at: snapshot.timestamp, teams });
  const cutoff = Date.now() - HISTORY_MAX_DAYS * 86400_000;
  db.history = db.history.filter(x => new Date(x.at).getTime() >= cutoff);
  writeStore(db);
}

async function buildRedditGroup(db, groupTeams) {
  const ids = [...new Set(groupTeams.flatMap(t => t.members.map(m => m.steamId).filter(Boolean)))];
  const sample = groupTeams[0];
  const cfg = { ...db.config, server: sample.server, wipeDate: sample.wipe };
  const players = await fetchSavedPlayers(cfg, ids);
  const value = (p, key) => Number(p?.stats?.[STAT_IDS[key]] || 0);
  const built = groupTeams.map(t => ({
    ...t,
    onlineSupported: true,
    stats: Object.fromEntries(allStats.map(k => [k, t.members.reduce((sum, m) => sum + value(players.get(m.steamId), k), 0)])),
    members: t.members.map(m => {
      const p = players.get(m.steamId);
      const currentServerId = p?.recentActivity?.currentServerId || null;
      return {
        ...m,
        playerId: m.steamId,
        name: m.name || p?.displayName || m.steamId,
        profilePicture: p?.profilePicture || '',
        isOnline: Boolean(currentServerId && currentServerId === t.server),
        currentServerId,
        lastPing: p?.recentActivity?.lastPing || null,
        stats: Object.fromEntries(allStats.map(k => [k, value(p, k)]))
      };
    })
  }));
  return { teams: built, source: { provider: 'reddit', server: sample.server, wipe: sample.wipe, requestedPlayers: ids.length, returnedPlayers: players.size, missingIds: ids.filter(id => !players.has(id)) } };
}

async function buildRustoriaGroup(db, groupTeams) {
  const sample = groupTeams[0];
  const unique = new Map();
  for (const t of groupTeams) for (const m of t.members) if (m.rustoriaId) unique.set(m.rustoriaId, m);
  const members = [...unique.values()];
  const players = await fetchRustoriaPlayers(db.config, sample.server, sample.wipe, members);
  const built = groupTeams.map(t => ({
    ...t,
    onlineSupported: false,
    activitySupported: true,
    stats: Object.fromEntries(allStats.map(k => [k, nullableSum(t.members.map(m => players.get(m.rustoriaId)?.stats?.[k] ?? null))])),
    members: t.members.map(m => {
      const p = players.get(m.rustoriaId);
      const stats = p?.stats || Object.fromEntries(allStats.map(k => [k, ['explosiveAmmo','playTime','accuracy'].includes(k) ? null : 0]));
      const activity = detectRustoriaActivity(sample.server, sample.wipe, m.rustoriaId, stats);
      return {
        ...m,
        playerId: m.rustoriaId,
        name: m.name || p?.username || m.rustoriaId,
        profilePicture: p?.avatar || '',
        isOnline: null,
        activityState: activity.state,
        activityChanged: activity.changed,
        lastActivityAt: activity.lastActivityAt,
        statsHidden: Boolean(p?.statsHidden),
        found: Boolean(p?.found),
        stats
      };
    })
  }));
  return { teams: built, source: { provider: 'rustoria', server: sample.server, wipe: sample.wipe || null, requestedPlayers: members.length, returnedPlayers: [...players.values()].filter(p => p.found).length, missingIds: members.filter(m => !players.get(m.rustoriaId)?.found).map(m => m.rustoriaId), onlineSupported: false, activitySupported: true } };
}

async function buildSnapshot() {
  const db = readStore();
  const teams = db.teams.filter(t => t.tracked).map(t => normalizeTeam(t, db.config));
  const groups = new Map();
  for (const t of teams) {
    const key = `${t.provider}|${t.server}|${t.wipe}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }
  const builtTeams = [];
  const sources = [];
  for (const groupTeams of groups.values()) {
    const out = groupTeams[0].provider === 'rustoria' ? await buildRustoriaGroup(db, groupTeams) : await buildRedditGroup(db, groupTeams);
    builtTeams.push(...out.teams); sources.push(out.source);
  }
  return { timestamp: new Date().toISOString(), teams: builtTeams, error: null, sources };
}
async function refresh() {
  try { lastSnapshot = await buildSnapshot(); recordHistory(lastSnapshot); }
  catch (e) { lastSnapshot = { ...lastSnapshot, timestamp: new Date().toISOString(), error: e.message || String(e) }; }
  const msg = `data: ${JSON.stringify(lastSnapshot)}\n\n`;
  for (const res of clients) res.write(msg);
}
setInterval(refresh, 30_000).unref();

app.get('/api/stats', auth, async (req,res) => { if (!lastSnapshot.timestamp) await refresh(); res.json(lastSnapshot); });
app.post('/api/stats/refresh', auth, async (req,res) => { clearPageCache(); clearRustoriaCache(); await refresh(); res.json(lastSnapshot); });
app.get('/api/teams/:id/history', auth, (req, res) => {
  const hours = Math.max(1, Math.min(HISTORY_MAX_DAYS * 24, Number(req.query.hours || 24)));
  const cutoff = Date.now() - hours * 3600_000;
  const db = readStore();
  const team = db.teams.find(t => t.id === req.params.id);
  if (!team) return res.status(404).json({ error: 'NOT_FOUND' });
  const rows = db.history.filter(x => new Date(x.at).getTime() >= cutoff && x.teams?.[req.params.id]).map(x => ({ at: x.at, ...x.teams[req.params.id] }));
  res.json({ teamId: team.id, teamName: team.name, hours, rows });
});

app.get('/api/debug/player/:steamId', auth, async (req, res) => {
  const steamId = String(req.params.steamId || '').trim();
  if (!/^7656\d{13}$/.test(steamId)) return res.status(400).json({ error: 'Nieprawidłowy SteamID64.' });
  try {
    const db = readStore();
    const players = await fetchSavedPlayers(db.config, [steamId], { bypassCache: true });
    res.json({ found: Boolean(players.get(steamId)), steamId, player: players.get(steamId) || null });
  } catch (e) { res.status(400).json({ error: e.message || String(e) }); }
});
app.get('/api/debug/rustoria/:rustoriaId', auth, async (req, res) => {
  const id = String(req.params.rustoriaId || '').trim();
  if (!/^[a-f0-9]{24}$/i.test(id)) return res.status(400).json({ error: 'Nieprawidłowy Rustoria ID.' });
  try {
    const db = readStore();
    const user = await getRustoriaUser(db.config, id, { bypassCache: true });
    const member = { rustoriaId: id, name: user?.username || '' };
    const server = String(req.query.server || db.config.rustoriaServer || '').trim();
    const wipe = String(req.query.wipe || db.config.rustoriaWipe || '').trim();
    const players = await fetchRustoriaPlayers(db.config, server, wipe, [member], { bypassCache: true });
    res.json({ found: Boolean(players.get(id)?.found), rustoriaId: id, server, wipe: wipe || null, player: players.get(id) || user || null });
  } catch (e) { res.status(400).json({ error: e.message || String(e) }); }
});

app.get('/api/stats/live', auth, (req,res) => {
  res.setHeader('Content-Type','text/event-stream');
  res.setHeader('Cache-Control','no-cache');
  res.setHeader('Connection','keep-alive');
  res.flushHeaders?.(); clients.add(res);
  res.write(`data: ${JSON.stringify(lastSnapshot)}\n\n`);
  req.on('close',()=>clients.delete(res));
});

app.listen(port, '0.0.0.0', () => console.log(`Rust Stats Dashboard v0.4.0 listening on :${port}`));
