// Shared by the service worker (importScripts) and the extension pages (<script>).

const SLOTS = ['music', 'research', 'work'];
const SLOT_LABELS = { music: 'Music', research: 'Research', work: 'Work' };

const DEFAULT_SETTINGS = {
  musicAllow: [
    'open.spotify.com', 'spotify.com', 'youtube.com', 'soundcloud.com', 'music.apple.com',
    'deezer.com', 'tidal.com', 'bandcamp.com', 'accounts.google.com'
  ],
  blocklist: [
    'youtube.com', 'reddit.com', 'x.com', 'twitter.com', 'instagram.com', 'tiktok.com',
    'facebook.com', 'netflix.com', 'twitch.tv',
    'cnn.com', 'bbc.com', 'nytimes.com', 'theguardian.com', 'foxnews.com', 'news.google.com',
    'amazon.com', 'ebay.com', 'aliexpress.com', 'temu.com', 'shein.com'
  ],
  blockExceptions: ['music.youtube.com'],
  workAllow: [],
  blockedApps: ['steam.exe', 'EpicGamesLauncher.exe', 'WhatsApp.exe'],
  // Rest reminders: after `work` minutes of focus the session pauses itself for `rest` minutes
  // (every `longEvery`-th rest is `longRest` minutes instead; 0 disables the long rest).
  breaks: { enabled: true, work: 50, rest: 10, longRest: 20, longEvery: 4 }
};

// Keep rest settings sane whatever is stored (or typed into the settings form).
function clampBreaks(b) {
  const num = (v, lo, hi, dflt) => {
    // An empty or non-numeric field means "use the default", not 0.
    const n = v === '' || v == null ? NaN : Math.floor(Number(v));
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
  };
  const d = DEFAULT_SETTINGS.breaks;
  return {
    enabled: b.enabled !== false,
    work: num(b.work, 1, 240, d.work),
    rest: num(b.rest, 1, 60, d.rest),
    longRest: num(b.longRest, 1, 120, d.longRest),
    longEvery: num(b.longEvery, 0, 12, d.longEvery)
  };
}

async function getSettings() {
  const { settings = {} } = await chrome.storage.local.get('settings');
  let breaks = { ...DEFAULT_SETTINGS.breaks, ...(settings.breaks || {}) };
  // Earlier versions had an on/off "Pomodoro mode". Carry its timings over only if it was switched on.
  if (!settings.breaks && settings.pomodoro && settings.pomodoro.enabled) {
    breaks = { ...breaks, work: settings.pomodoro.work, rest: settings.pomodoro.rest };
  }
  return { ...DEFAULT_SETTINGS, ...settings, breaks: clampBreaks(breaks) };
}

// ---------- URL rules ----------

function parseUrl(u) {
  try { return new URL(u); } catch { return null; }
}

function hostOf(u) {
  const p = parseUrl(u);
  return p ? p.hostname : '';
}

function hostMatches(host, domains) {
  return domains.some(d => host === d || host.endsWith('.' + d));
}

// What a Work tab is locked to: a web host, or one local file.
function makeLock(url) {
  const u = parseUrl(url);
  if (!u) return null;
  if (u.protocol === 'http:' || u.protocol === 'https:') return { kind: 'host', host: u.hostname };
  if (u.protocol === 'file:') return { kind: 'file', path: u.pathname };
  return null;
}

// Is `url` allowed in the tab that holds `slot`? `state` supplies the Work lock.
function isAllowed(slot, url, state, settings) {
  if (url === 'about:blank') return true;
  const u = parseUrl(url);
  if (!u) return false;
  if (u.protocol === 'chrome-error:') return true;
  if (u.protocol === 'chrome-extension:') return u.host === chrome.runtime.id;
  const web = u.protocol === 'http:' || u.protocol === 'https:';
  const host = u.hostname;
  switch (slot) {
    case 'music': {
      if (!web || !hostMatches(host, settings.musicAllow)) return false;
      // YouTube is fine for playing music, but not its homepage, Shorts or feeds.
      if (hostMatches(host, ['youtube.com']) && !hostMatches(host, ['music.youtube.com'])) {
        const p = u.pathname;
        if (p === '/' || p.startsWith('/shorts') || p.startsWith('/feed')) return false;
      }
      return true;
    }
    case 'research':
      return web && !(hostMatches(host, settings.blocklist) && !hostMatches(host, settings.blockExceptions));
    case 'work': {
      const lock = state && state.workLock;
      if (!lock) return false;
      if (lock.kind === 'file') return u.protocol === 'file:' && u.pathname === lock.path;
      return web && hostMatches(host, [lock.host, ...settings.workAllow]);
    }
    default:
      return false;
  }
}

// ---------- time ----------

// Active (unpaused) seconds. Always derived from timestamps, never from a counter.
function activeSeconds(s, now = Date.now()) {
  if (!s) return 0;
  const end = s.pausedAt != null ? s.pausedAt : now;
  const paused = s.pauses.reduce((sum, p) => sum + (p.end - p.start), 0);
  return Math.max(0, Math.floor((end - s.startedAt - paused) / 1000));
}

// Where the session is in its work/rest cycle.
//   inRest: true  -> restLeft seconds of rest remain
//   inRest: false -> the next rest (restMin minutes, isLong?) starts in dueIn seconds
// A "stretch" is the focus time since the last rest ended; it is stored as state.stretchStartSec.
function breakPlan(state, breaks, now = Date.now()) {
  if (state.rest) {
    return { enabled: breaks.enabled, inRest: true, restLeft: Math.max(0, Math.ceil((state.rest.until - now) / 1000)),
             dueIn: null, restMin: state.rest.minutes, isLong: !!state.rest.long };
  }
  const n = (state.breaksTaken || 0) + 1;
  const isLong = breaks.longEvery > 0 && n % breaks.longEvery === 0;
  const sinceRest = activeSeconds(state, now) - (state.stretchStartSec || 0);
  return { enabled: breaks.enabled, inRest: false, restLeft: 0, dueIn: Math.max(0, breaks.work * 60 - sinceRest),
           restMin: isLong ? breaks.longRest : breaks.rest, isLong };
}

function pad2(n) { return String(n).padStart(2, '0'); }

function fmtClock(sec) {
  return `${pad2(Math.floor(sec / 3600))}:${pad2(Math.floor((sec % 3600) / 60))}:${pad2(sec % 60)}`;
}

// mm:ss, for countdowns under an hour
function fmtMS(sec) {
  sec = Math.max(0, sec);
  return `${pad2(Math.floor(sec / 60))}:${pad2(sec % 60)}`;
}

function fmtDuration(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h) return `${h}h ${pad2(m)}m`;
  return `${m}m`;
}

function dateKey(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

// ---------- projects ----------
// A project is { id, name, parentId|null }. A session's time counts for its project and for
// every ancestor, so working on Y (inside X) also grows X.

function cleanProjectName(s) {
  return String(s || '').replace(/\s+/g, ' ').trim().slice(0, 80);
}

function projectMapOf(projects) {
  return new Map(projects.map(p => [p.id, p]));
}

// Children grouped by parent. A parent that doesn't exist is treated as "top level".
function childrenMapOf(projects) {
  const byId = projectMapOf(projects);
  const out = new Map();
  for (const p of projects) {
    const key = p.parentId && byId.has(p.parentId) ? p.parentId : null;
    if (!out.has(key)) out.set(key, []);
    out.get(key).push(p);
  }
  for (const list of out.values()) list.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

// The project plus everything beneath it.
function descendantIds(projects, id) {
  const ch = childrenMapOf(projects);
  const out = new Set([id]);
  const stack = [id];
  while (stack.length) {
    for (const c of ch.get(stack.pop()) || []) {
      if (!out.has(c.id)) { out.add(c.id); stack.push(c.id); }
    }
  }
  return out;
}

function projectPath(projects, id) {
  const byId = projectMapOf(projects);
  const names = [];
  const seen = new Set();
  let p = byId.get(id);
  while (p && !seen.has(p.id)) {
    seen.add(p.id);
    names.unshift(p.name);
    p = byId.get(p.parentId);
  }
  return names.join(' › ');
}

// Depth-first list for drop-downs and trees: [{ project, depth }].
function flattenProjects(projects) {
  const ch = childrenMapOf(projects);
  const out = [];
  const seen = new Set();
  (function walk(parent, depth) {
    for (const p of ch.get(parent) || []) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      out.push({ project: p, depth });
      walk(p.id, depth + 1);
    }
  })(null, 0);
  for (const p of projects) if (!seen.has(p.id)) out.push({ project: p, depth: 0 }); // only reachable via a cycle
  return out;
}

// Map id -> { own, total, count } in seconds. `keep` filters sessions (e.g. "this week").
function projectTotals(projects, sessions, keep = () => true) {
  const byId = projectMapOf(projects);
  const totals = new Map(projects.map(p => [p.id, { own: 0, total: 0, count: 0 }]));
  for (const s of sessions) {
    if (!keep(s) || !byId.has(s.projectId)) continue;
    const secs = s.activeSeconds || 0;
    totals.get(s.projectId).own += secs;
    totals.get(s.projectId).count++;
    const seen = new Set();
    let p = byId.get(s.projectId);
    while (p && !seen.has(p.id)) {
      seen.add(p.id);
      totals.get(p.id).total += secs;
      p = byId.get(p.parentId);
    }
  }
  return totals;
}

// Does a session belong to `projectId` or anything beneath it?
function inProject(projects, session, projectId) {
  return !!session.projectId && descendantIds(projects, projectId).has(session.projectId);
}
