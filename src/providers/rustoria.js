const API = 'https://api.rustoria.co';

const CACHE_TTL_MS = Math.max(10_000, Number(process.env.RUSTORIA_CACHE_TTL_MS || 45_000));
const cache = new Map();

const resourceMap = {
  wood: 'farming_resource_wood_harvested',
  metal: 'farming_resource_metal_harvested',
  hqMetal: 'farming_resource_hqm_harvested',
  sulfur: 'farming_resource_sulfur_harvested',
  stones: 'farming_resource_stone_harvested'
};
const pvpMap = {
  kills: 'pvp_player_kills_total',
  deaths: 'pvp_player_deaths_total',
  headshots: 'pvp_player_headshot',
  wounds: 'pvp_player_wounds_total',
  bulletsFired: 'weapon_bullet_fired_total',
  bulletsHitPlayer: 'weapon_bullet_hit_player'
};
const miscMap = {
  playTime: 'player_time_played'
};
const raidingMap = {
  rockets: 'weapon_rocket_launched_basic',
  hvRockets: 'weapon_rocket_launched_hv',
  c4: 'item_thrown_c4',
  satchels: 'item_thrown_satchel',
  rocketHitOnline: 'weapon_rocket_hit_online_base',
  rocketHitOffline: 'weapon_rocket_hit_offline_base'
};

function authHeaders(config = {}) {
  const h = {
    Accept: 'application/json',
    'User-Agent': 'RustStatsDashboard/0.4.3'
  };
  const auth = String(config.rustoriaAuthorization || '').trim();
  const cookie = String(config.rustoriaCookie || '').trim();
  const apiKey = String(config.rustoriaApiKey || '').trim();
  if (auth) h.Authorization = auth;
  if (cookie) h.Cookie = cookie;
  if (apiKey) h['x-api-key'] = apiKey;
  return h;
}

async function getJson(url, config = {}, { bypassCache = false } = {}) {
  const key = url;
  const hit = cache.get(key);
  if (!bypassCache && hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data;

  const r = await fetch(url, { headers: authHeaders(config) });
  const raw = await r.text();
  if (r.status === 401 || r.status === 403) {
    throw new Error(`Rustoria API wymaga autoryzacji (HTTP ${r.status}). Uzupełnij dane Rustoria w Settings.`);
  }
  if (!r.ok) {
    const detail = raw.replace(/\s+/g, ' ').trim().slice(0, 350);
    throw new Error(`Rustoria API HTTP ${r.status}${detail ? ` | ${detail}` : ''}`);
  }
  let data;
  try { data = raw ? JSON.parse(raw) : null; }
  catch { throw new Error('Rustoria API zwróciło nieprawidłowy JSON.'); }
  cache.set(key, { at: Date.now(), data });
  return data;
}

function arrayFrom(data) {
  if (Array.isArray(data)) return data;
  for (const key of ['data', 'items', 'results', 'rows', 'leaderboard', 'leaderboards', 'entries']) {
    if (Array.isArray(data?.[key])) return data[key];
  }
  if (data && typeof data === 'object') {
    for (const v of Object.values(data)) if (Array.isArray(v)) return v;
  }
  return [];
}

function normalizeUser(row = {}) {
  return {
    rustoriaId: String(row.rustoriaId || row._id || row.id || '').trim(),
    username: String(row.username || row.name || '').trim(),
    avatar: String(row.avatar || '').trim(),
    private: Boolean(row.private),
    visibility: row.visibility ?? null,
    raw: row
  };
}

export async function getRustoriaUser(config, rustoriaId, opts = {}) {
  const id = String(rustoriaId || '').trim();
  if (!id) return null;
  const data = await getJson(`${API}/users/${encodeURIComponent(id)}`, config, opts);
  const u = normalizeUser(data || {});
  return u.rustoriaId ? u : null;
}

async function leaderboard(config, server, category, username, wipe = '', opts = {}) {
  const params = new URLSearchParams({
    from: '0',
    sortBy: 'total',
    orderBy: 'desc',
    username: username || '',
    wipe: wipe || ''
  });
  const url = `${API}/statistics/leaderboards/${encodeURIComponent(server)}/${encodeURIComponent(category)}?${params}`;
  return arrayFrom(await getJson(url, config, opts));
}

function exactRow(rows, rustoriaId, username) {
  const id = String(rustoriaId || '');
  const uname = String(username || '').toLowerCase();
  return rows.find(r => String(r?.rustoriaId || '') === id)
    || rows.find(r => uname && String(r?.username || '').toLowerCase() === uname)
    || null;
}

function mapStats(row, mapping) {
  const data = row?.data && typeof row.data === 'object' ? row.data : {};
  const out = {};
  for (const [key, source] of Object.entries(mapping)) out[key] = Number(data[source] || 0);
  return out;
}

export async function fetchRustoriaPlayers(config, server, wipe, members, { bypassCache = false } = {}) {
  const result = new Map();
  if (!server) throw new Error('Brak Rustoria server slug.');

  for (const member of members || []) {
    const rustoriaId = String(member.rustoriaId || member.playerId || '').trim();
    if (!rustoriaId) continue;

    let user = null;
    try { user = await getRustoriaUser(config, rustoriaId, { bypassCache }); }
    catch (e) {
      // Profile lookup can fail for some accounts; if a name is saved, leaderboard lookup may still work.
      if (!member.name) throw e;
    }
    const username = String(member.name || user?.username || '').trim();
    if (!username) {
      result.set(rustoriaId, {
        rustoriaId,
        username: rustoriaId,
        avatar: user?.avatar || '',
        stats: emptyStats(),
        statsHidden: Boolean(user?.private),
        found: false
      });
      continue;
    }

    const [resourcesRows, pvpRows, raidingRows, miscRows] = await Promise.all([
      leaderboard(config, server, 'resources', username, wipe, { bypassCache }),
      leaderboard(config, server, 'pvp', username, wipe, { bypassCache }),
      leaderboard(config, server, 'explosives', username, wipe, { bypassCache }),
      leaderboard(config, server, 'misc', username, wipe, { bypassCache })
    ]);

    const resources = exactRow(resourcesRows, rustoriaId, username);
    const pvp = exactRow(pvpRows, rustoriaId, username);
    const raiding = exactRow(raidingRows, rustoriaId, username);
    const misc = exactRow(miscRows, rustoriaId, username);

    const stats = {
      ...emptyStats(),
      ...(resources ? mapStats(resources, resourceMap) : {}),
      ...(pvp ? mapStats(pvp, pvpMap) : {}),
      ...(raiding ? mapStats(raiding, raidingMap) : {}),
      ...(misc ? mapStats(misc, miscMap) : {})
    };

    // Rustoria currently does not expose explosive ammo in the leaderboard data we found.
    stats.explosiveAmmo = null;
    stats.playTime = misc ? Number(misc?.data?.player_time_played || 0) : null;
    stats.kdr = pvp?.data?.kdr == null ? null : Number(pvp.data.kdr);
    stats.accuracy = pvp?.data?.accuracy == null ? null : Number(pvp.data.accuracy);

    const row = resources || pvp || raiding || misc;
    result.set(rustoriaId, {
      rustoriaId,
      username: String(row?.username || user?.username || username),
      avatar: String(row?.avatar || user?.avatar || ''),
      private: Boolean(row?.private ?? user?.private),
      statsHidden: Boolean(user?.private) && !row,
      found: Boolean(row),
      stats,
      raw: { resources, pvp, raiding, misc, user }
    });
  }

  return result;
}

function emptyStats() {
  return {
    wood: 0,
    metal: 0,
    hqMetal: 0,
    sulfur: 0,
    stones: 0,
    rockets: 0,
    hvRockets: 0,
    c4: 0,
    explosiveAmmo: null,
    satchels: 0,
    kills: 0,
    deaths: 0,
    playTime: null,
    headshots: 0,
    wounds: 0,
    bulletsFired: 0,
    bulletsHitPlayer: 0,
    rocketHitOnline: 0,
    rocketHitOffline: 0,
    kdr: null,
    accuracy: null
  };
}

export async function testRustoria(config, server, wipe = '') {
  if (!server) throw new Error('Wpisz Rustoria server slug.');
  const rows = await leaderboard(config, server, 'resources', '', wipe, { bypassCache: true });
  return { rows: rows.length, server, wipe: wipe || null };
}

export async function tryListRustoriaServers(config) {
  // Some Rustoria frontend versions expose a server list, others only /servers/find/:slug.
  // Try common list endpoints and gracefully fall back to known slugs captured from the live site.
  for (const path of ['/servers', '/servers/list']) {
    try {
      const data = await getJson(`${API}${path}`, config, {});
      const rows = arrayFrom(data);
      if (rows.length) {
        return rows.map(x => ({
          slug: String(x.slug || x.id || x.serverId || x.name || '').trim(),
          name: String(x.displayName || x.name || x.slug || x.id || '').trim()
        })).filter(x => x.slug);
      }
    } catch {}
  }
  return [
    { slug: 'vanilla_long_eueast', name: 'EU East Long' },
    { slug: 'vanilla_low_pop_us', name: 'US Low Pop' }
  ];
}

export function clearRustoriaCache() {
  cache.clear();
}
