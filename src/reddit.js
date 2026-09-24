const API = 'https://dash-api.redditplayrust.com';

export const STAT_IDS = {
  wood: 'official_harvest.wood',
  metal: 'official_harvest.metal.ore',
  hqMetal: 'official_harvest.hq.metal.ore',
  sulfur: 'official_harvest.sulfur.ore',
  stones: 'official_harvest.stones',
  rockets: 'explosive_launched_rocket_basic',
  hvRockets: 'explosive_launched_rocket_hv',
  c4: 'user_held_item_explosive.timed',
  explosiveAmmo: 'ammo_used_ammo.rifle.explosive',
  satchels: 'user_held_item_explosive.satchel',
  kills: 'official_kill_player',
  deaths: 'official_deaths',
  playTime: 'official_time'
};

const SAVED_CACHE_TTL_MS = Number(process.env.REDDIT_SAVED_CACHE_TTL_MS || 30_000);
const BATCH_SIZE = Math.max(1, Math.min(50, Number(process.env.REDDIT_SAVED_BATCH_SIZE || 25)));
const savedCache = new Map();

export function normalizeAuthToken(input) {
  let t = String(input || '').trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) t = t.slice(1, -1).trim();
  t = t.replace(/^authorization\s*:\s*/i, '').trim();
  t = t.replace(/^bearer\s+/i, '').trim();
  return t ? `Bearer ${t}` : '';
}

function headers(config) {
  return {
    Authorization: normalizeAuthToken(config.authToken),
    'X-Tenant-Id': process.env.REDDIT_TENANT_ID || 'reddit_play_rust',
    Accept: 'application/json',
    'User-Agent': 'RustStatsDashboard/0.1.8'
  };
}

function requireConfig(config) {
  if (!config?.server || !config?.wipeDate || !config?.authToken) {
    throw new Error('Brak konfiguracji Server/Wipe Date/Auth Token.');
  }
}

function savedCacheKey(config, ids) {
  return [config.server, config.wipeDate, [...ids].sort().join(',')].join('|');
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function extractSavedRows(data) {
  // Endpoint /saved has changed shape between frontend versions.
  // Instead of assuming one wrapper key, walk the JSON and collect
  // objects that look like player records (identity + a stats object).
  const rows = [];
  const seen = new Set();

  function walk(v, depth = 0) {
    if (depth > 8 || v == null) return;
    if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1);
      return;
    }
    if (typeof v !== 'object') return;

    const id = userIdOf(v);
    const stats = statsOf(v);
    if (id && stats && typeof stats === 'object' && !Array.isArray(stats)) {
      const key = `${id}:${Object.keys(stats).length}`;
      if (!seen.has(key)) {
        seen.add(key);
        rows.push(v);
      }
    }

    for (const child of Object.values(v)) walk(child, depth + 1);
  }

  walk(data);
  return rows;
}

function userIdOf(row) {
  return String(
    row?.userId ??
    row?.steamId ??
    row?.user?.userId ??
    row?.user?.steamId ??
    row?.user?.authProviders?.steam?.userId ??
    row?.authProviders?.steam?.userId ??
    ''
  );
}

function looksLikeStats(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  const keys = Object.keys(obj);
  return keys.some(k => k.startsWith('official_') || k.startsWith('explosive_') || k.startsWith('ammo_') || k.startsWith('user_held_item_') || k === 'item_gather_scrap');
}

function statsOf(row) {
  const direct = [row?.stats, row?.statistics, row?.playerStats, row?.values, row?.wipeStats, row?.wipeStats?.stats];
  for (const x of direct) if (looksLikeStats(x)) return x;

  // Fallback for nested API wrappers.
  let found = null;
  function walk(v, depth = 0) {
    if (found || depth > 6 || v == null || typeof v !== 'object') return;
    if (looksLikeStats(v)) { found = v; return; }
    for (const child of Object.values(v)) walk(child, depth + 1);
  }
  walk(row);
  return found;
}

function steamProfileOf(row) {
  return row?.user?.authProviders?.steam || row?.authProviders?.steam || row?.steam || {};
}

export async function fetchSavedPlayers(config, memberIds, { bypassCache = false } = {}) {
  requireConfig(config);
  const ids = [...new Set((memberIds || []).map(String).filter(Boolean))];
  const result = new Map();
  if (!ids.length) return result;

  for (const batch of chunk(ids, BATCH_SIZE)) {
    const key = savedCacheKey(config, batch);
    const cached = savedCache.get(key);
    let rows;
    if (!bypassCache && cached && Date.now() - cached.at < SAVED_CACHE_TTL_MS) {
      rows = cached.rows;
    } else {
      const qs = batch.map(id => `userIds=${encodeURIComponent(id)}`).join('&');
      const url = `${API}/stats/players/stats/${encodeURIComponent(config.server)}/wipe/${encodeURIComponent(config.wipeDate)}/saved?${qs}`;
      const r = await fetch(url, { headers: headers(config) });
      const raw = await r.text();
      if (r.status === 401 || r.status === 403) throw new Error(`Auth Token odrzucony przez Reddit PlayRust (HTTP ${r.status}).`);
      if (!r.ok) {
        const detail = raw.replace(/\s+/g, ' ').trim().slice(0, 450);
        throw new Error(`Reddit PlayRust API HTTP ${r.status} | endpoint=saved | server=${config.server} | wipe=${config.wipeDate}${detail ? ` | ${detail}` : ''}`);
      }
      let data;
      try { data = raw ? JSON.parse(raw) : []; }
      catch { throw new Error('Reddit PlayRust API zwróciło nieprawidłowy JSON z endpointu saved.'); }
      rows = extractSavedRows(data);
      savedCache.set(key, { at: Date.now(), rows });
    }

    for (const row of rows) {
      const userId = userIdOf(row);
      if (!userId) continue;
      const steam = steamProfileOf(row);
      const stats = statsOf(row) || {};
      const recentActivity = row?.user?.recentActivity || row?.recentActivity || {};
      const candidate = {
        userId,
        stats,
        displayName: String(steam.displayName || row?.displayName || row?.user?.displayName || '').trim(),
        profilePicture: String(steam.profilePicture || row?.profilePicture || row?.user?.profilePicture || '').trim(),
        recentActivity: {
          currentServerId: recentActivity?.currentServerId == null ? null : String(recentActivity.currentServerId),
          lastPing: recentActivity?.lastPing || null,
          lastSeenServer: recentActivity?.lastSeenServer || null
        },
        raw: row
      };
      // /saved contains nested user objects as well as the outer player+stats record.
      // Never let a metadata-only nested object overwrite the richer outer row.
      const prev = result.get(userId);
      const prevCount = prev ? Object.keys(prev.stats || {}).length : -1;
      const nextCount = Object.keys(stats).length;
      if (!prev || nextCount > prevCount) result.set(userId, candidate);
    }
  }

  return result;
}

// Zostawione do Test API, bo dobrze potwierdza konfigurację server/wipe/token.
function extractLeaderboardRows(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.items)) return data.items;
  if (Array.isArray(data?.results)) return data.results;
  if (Array.isArray(data?.wipeStatsMeta?.leaderBoardEntrys)) return data.wipeStatsMeta.leaderBoardEntrys;
  if (Array.isArray(data?.wipeStatsMeta?.leaderboardEntries)) return data.wipeStatsMeta.leaderboardEntries;
  return [];
}

export async function getPage(config, statId, pageNumber) {
  requireConfig(config);
  const url = `${API}/stats/leaderboard/${encodeURIComponent(config.server)}/wipe/${encodeURIComponent(config.wipeDate)}/stat/${encodeURIComponent(statId)}?pageNumber=${pageNumber}`;
  const r = await fetch(url, { headers: headers(config) });
  const raw = await r.text();
  if (r.status === 401 || r.status === 403) throw new Error(`Auth Token odrzucony przez Reddit PlayRust (HTTP ${r.status}).`);
  if (!r.ok) {
    const detail = raw.replace(/\s+/g, ' ').trim().slice(0, 350);
    throw new Error(`Reddit PlayRust API HTTP ${r.status} | stat=${statId} | server=${config.server} | wipe=${config.wipeDate}${detail ? ` | ${detail}` : ''}`);
  }
  let data;
  try { data = raw ? JSON.parse(raw) : []; }
  catch { throw new Error(`Reddit PlayRust API zwróciło nieprawidłowy JSON dla stat=${statId}.`); }
  return extractLeaderboardRows(data);
}

export function clearPageCache() {
  savedCache.clear();
}
