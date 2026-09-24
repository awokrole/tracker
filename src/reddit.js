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
  kills: 'official_kill_player'
};

const PAGE_CACHE_TTL_MS = Number(process.env.REDDIT_PAGE_CACHE_TTL_MS || 60_000);
const DEFAULT_MAX_PAGES = Number(process.env.REDDIT_MAX_PAGES || 500);
const pageCache = new Map();

export function normalizeAuthToken(input) {
  let t = String(input || '').trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) t = t.slice(1, -1).trim();
  t = t.replace(/^authorization\s*:\s*/i, '').trim();
  t = t.replace(/^bearer\s+/i, '').trim();
  return t ? `Bearer ${t}` : '';
}

function extractRows(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.items)) return data.items;
  if (Array.isArray(data?.results)) return data.results;
  if (Array.isArray(data?.wipeStatsMeta?.leaderBoardEntrys)) return data.wipeStatsMeta.leaderBoardEntrys;
  if (Array.isArray(data?.wipeStatsMeta?.leaderboardEntries)) return data.wipeStatsMeta.leaderboardEntries;
  return [];
}

function pageCacheKey(config, statId, pageNumber) {
  return [config.server, config.wipeDate, statId, pageNumber].join('|');
}

export async function getPage(config, statId, pageNumber, { bypassCache = false } = {}) {
  const { server, wipeDate, authToken } = config;
  if (!server || !wipeDate || !authToken) throw new Error('Brak konfiguracji Server/Wipe Date/Auth Token.');

  const key = pageCacheKey(config, statId, pageNumber);
  const cached = pageCache.get(key);
  if (!bypassCache && cached && Date.now() - cached.at < PAGE_CACHE_TTL_MS) return cached.rows;

  const url = `${API}/stats/leaderboard/${encodeURIComponent(server)}/wipe/${encodeURIComponent(wipeDate)}/stat/${encodeURIComponent(statId)}?pageNumber=${pageNumber}`;
  const r = await fetch(url, {
    headers: {
      Authorization: normalizeAuthToken(authToken),
      'X-Tenant-Id': process.env.REDDIT_TENANT_ID || 'reddit_play_rust',
      Accept: 'application/json',
      'User-Agent': 'RustStatsDashboard/0.1.3'
    }
  });
  const raw = await r.text();
  if (r.status === 401 || r.status === 403) throw new Error(`Auth Token odrzucony przez Reddit PlayRust (HTTP ${r.status}).`);
  if (!r.ok) {
    const detail = raw.replace(/\s+/g, ' ').trim().slice(0, 350);
    throw new Error(`Reddit PlayRust API HTTP ${r.status} | stat=${statId} | server=${server} | wipe=${wipeDate}${detail ? ` | ${detail}` : ''}`);
  }
  let data;
  try { data = raw ? JSON.parse(raw) : []; }
  catch { throw new Error(`Reddit PlayRust API zwróciło nieprawidłowy JSON dla stat=${statId}.`); }

  const rows = extractRows(data);
  pageCache.set(key, { at: Date.now(), rows });
  return rows;
}

export async function fetchValuesForMembers(config, statId, memberIds, maxPages = DEFAULT_MAX_PAGES) {
  const wanted = new Set(memberIds.map(String));
  const out = new Map();
  if (!wanted.size) return out;

  let scannedPages = 0;
  let scannedRows = 0;
  let consecutiveEmptyPages = 0;

  for (let page = 0; page < maxPages && out.size < wanted.size; page++) {
    const rows = await getPage(config, statId, page);
    scannedPages++;
    scannedRows += rows.length;

    if (!rows.length) {
      consecutiveEmptyPages++;
      if (consecutiveEmptyPages >= 1) break;
      continue;
    }
    consecutiveEmptyPages = 0;

    for (const row of rows) {
      const id = String(row.userId ?? row.steamId ?? '');
      if (wanted.has(id)) out.set(id, Number(row.value || 0));
    }
  }

  out.scanInfo = { pages: scannedPages, rows: scannedRows, found: out.size, wanted: wanted.size };
  return out;
}

export function clearPageCache() {
  pageCache.clear();
}
