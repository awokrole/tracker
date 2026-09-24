import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readStore, writeStore } from './store.js';
import { STAT_IDS, fetchSavedPlayers, getPage, normalizeAuthToken, clearPageCache } from './reddit.js';

const app = express();
const port = Number(process.env.PORT || 3000);
const password = process.env.PANEL_PASSWORD || '';
const sessionSecret = process.env.SESSION_SECRET || '';
if (!password || !sessionSecret) console.warn('[WARN] Ustaw PANEL_PASSWORD i SESSION_SECRET w Railway Variables.');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, '..', 'public');
app.use(express.json({ limit: '64kb' }));
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

app.get('/api/config', auth, (req, res) => {
  const { config } = readStore();
  res.json({ server: config.server, wipeDate: config.wipeDate, battlemetricsServerId: config.battlemetricsServerId, hasAuthToken: Boolean(config.authToken) });
});
app.put('/api/config', auth, (req, res) => {
  const db = readStore();
  db.config.server = String(req.body.server || '').trim();
  db.config.wipeDate = String(req.body.wipeDate || '').trim();
  db.config.battlemetricsServerId = String(req.body.battlemetricsServerId || '').trim();
  if (String(req.body.authToken || '').trim()) db.config.authToken = String(req.body.authToken).trim();
  writeStore(db);
  clearPageCache();
  res.json({ ok: true });
});


app.post('/api/config/test', auth, async (req, res) => {
  const db = readStore();
  const temp = {
    ...db.config,
    server: String(req.body.server || db.config.server || '').trim(),
    wipeDate: String(req.body.wipeDate || db.config.wipeDate || '').trim(),
    authToken: String(req.body.authToken || '').trim() || db.config.authToken
  };
  try {
    const rows = await getPage(temp, STAT_IDS.wood, 0);
    res.json({ ok: true, rows: rows.length, authHeaderConfigured: Boolean(normalizeAuthToken(temp.authToken)) });
  } catch (e) {
    res.status(400).json({ error: e.message || String(e) });
  }
});

app.get('/api/teams', auth, (req, res) => res.json(readStore().teams));
app.post('/api/teams', auth, (req, res) => {
  const db = readStore();
  const team = {
    id: crypto.randomUUID(),
    name: String(req.body.name || 'Team').trim().slice(0, 60),
    createdAt: new Date().toISOString(),
    tracked: true,
    members: Array.isArray(req.body.members) ? req.body.members.map(m => ({ steamId: String(m.steamId || '').trim(), name: String(m.name || '').trim().slice(0, 60) })).filter(m => /^7656\d{13}$/.test(m.steamId)) : []
  };
  db.teams.push(team); writeStore(db); res.json(team);
});
app.put('/api/teams/:id', auth, (req, res) => {
  const db = readStore(); const t = db.teams.find(x => x.id === req.params.id); if (!t) return res.status(404).json({ error: 'NOT_FOUND' });
  if (req.body.name != null) t.name = String(req.body.name).trim().slice(0,60);
  if (req.body.tracked != null) t.tracked = Boolean(req.body.tracked);
  if (Array.isArray(req.body.members)) t.members = req.body.members.map(m => ({ steamId: String(m.steamId || '').trim(), name: String(m.name || '').trim().slice(0,60) })).filter(m => /^7656\d{13}$/.test(m.steamId));
  writeStore(db); res.json(t);
});
app.delete('/api/teams/:id', auth, (req,res) => { const db=readStore(); db.teams=db.teams.filter(x=>x.id!==req.params.id); writeStore(db); res.json({ok:true}); });

let lastSnapshot = { timestamp: null, teams: [], error: null };
const clients = new Set();

async function buildSnapshot() {
  const db = readStore();
  const teams = db.teams.filter(t => t.tracked);
  const ids = [...new Set(teams.flatMap(t => t.members.map(m => m.steamId)))];
  const allStats = ['wood','metal','hqMetal','sulfur','stones','rockets','hvRockets','c4','explosiveAmmo','satchels','kills','deaths','playTime'];
  const players = await fetchSavedPlayers(db.config, ids);

  const value = (player, key) => Number(player?.stats?.[STAT_IDS[key]] || 0);

  return {
    timestamp: new Date().toISOString(),
    teams: teams.map(t => ({
      ...t,
      stats: Object.fromEntries(allStats.map(k => [k, t.members.reduce((sum, m) => sum + value(players.get(m.steamId), k), 0)])),
      members: t.members.map(m => {
        const p = players.get(m.steamId);
        const currentServerId = p?.recentActivity?.currentServerId || null;
        const isOnline = Boolean(currentServerId && currentServerId === db.config.server);
        return {
          ...m,
          name: m.name || p?.displayName || m.steamId,
          profilePicture: p?.profilePicture || '',
          isOnline,
          currentServerId,
          lastPing: p?.recentActivity?.lastPing || null,
          stats: Object.fromEntries(allStats.map(k => [k, value(p, k)]))
        };
      })
    })),
    error: null,
    source: { endpoint: 'saved', requestedPlayers: ids.length, returnedPlayers: players.size, matchedIds: [...players.keys()], missingIds: ids.filter(id => !players.has(id)) }
  };
}
async function refresh() {
  try { lastSnapshot = await buildSnapshot(); }
  catch (e) { lastSnapshot = { ...lastSnapshot, timestamp: new Date().toISOString(), error: e.message || String(e) }; }
  const msg = `data: ${JSON.stringify(lastSnapshot)}\n\n`;
  for (const res of clients) res.write(msg);
}
setInterval(refresh, 30_000).unref();

app.get('/api/stats', auth, async (req,res) => { if (!lastSnapshot.timestamp) await refresh(); res.json(lastSnapshot); });
app.post('/api/stats/refresh', auth, async (req,res) => { clearPageCache(); await refresh(); res.json(lastSnapshot); });
app.get('/api/debug/player/:steamId', auth, async (req, res) => {
  const steamId = String(req.params.steamId || '').trim();
  if (!/^7656\d{13}$/.test(steamId)) return res.status(400).json({ error: 'Nieprawidłowy SteamID64.' });
  try {
    const db = readStore();
    const players = await fetchSavedPlayers(db.config, [steamId], { bypassCache: true });
    const p = players.get(steamId);
    res.json({ found: Boolean(p), steamId, player: p || null });
  } catch (e) {
    res.status(400).json({ error: e.message || String(e) });
  }
});

app.get('/api/stats/live', auth, (req,res) => {
  res.setHeader('Content-Type','text/event-stream'); res.setHeader('Cache-Control','no-cache'); res.setHeader('Connection','keep-alive');
  res.flushHeaders?.(); clients.add(res); res.write(`data: ${JSON.stringify(lastSnapshot)}\n\n`); req.on('close',()=>clients.delete(res));
});

app.listen(port, '0.0.0.0', () => console.log(`Rust Stats Dashboard listening on :${port}`));
