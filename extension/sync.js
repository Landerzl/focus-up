// Cloud sync through a Supabase project (email login). Loaded into the service worker with importScripts.
//
// What syncs: finished sessions and the project tree. Settings and the running session stay on each device.
// How: every record gets an "updated at" time; the newest edit wins. Deletions travel as tombstones.
// Changes are found by comparing each record with a hash saved at the last sync, so the rest of the
// extension never has to know that sync exists.
//
// storage keys:  syncConfig {url, anonKey}   syncAuth {email, userId, accessToken, refreshToken, expiresAt}
//                syncMeta {userId, email, deviceId, deviceName, cursor, lastSync, lastError, sessions:{}, projects:{}}
//   meta[kind][id] = { h: content hash, u: updated-at ms, p: pushed-at ms (0 = not yet), d: deleted?, pa: parent, mi: merged-into }

const SYNC_KINDS = ['session', 'project'];
const SYNC_BATCH = 200;
const SYNC_PAGE = 500;

// ---------- pure helpers (no I/O, unit tested) ----------

function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  return '{' + Object.keys(v).filter(k => v[k] !== undefined).sort().map(k => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
}

// Two independent 32-bit hashes side by side: change detection, not security.
function recordHash(obj) {
  const s = stableStringify(obj);
  let a = 0x811c9dc5;
  let b = 5381;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = (Math.imul(b, 33) + c) >>> 0;
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0') + s.length.toString(16);
}

const nonNegInt = v => Math.max(0, Math.floor(Number(v) || 0));
const idOrNull = v => (typeof v === 'string' && v.length > 0 && v.length <= 64 ? v : null);

// Remote data is untrusted: rebuild only the fields we know, with limits.
function sanitizeSession(d, id) {
  if (!d || typeof d !== 'object' || !idOrNull(id)) return null;
  const start = Date.parse(d.start);
  const end = Date.parse(d.end);
  const secs = Number(d.activeSeconds);
  if (!Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(secs) || secs < 0 || secs > 7 * 86400) return null;
  const slots = {};
  for (const k of ['music', 'research', 'work']) if (d.slots && typeof d.slots[k] === 'string') slots[k] = d.slots[k].slice(0, 300);
  const out = {
    id,
    name: String(d.name || 'Focus session').slice(0, 120),
    start: new Date(start).toISOString(),
    end: new Date(end).toISOString(),
    activeSeconds: Math.floor(secs),
    pauses: Array.isArray(d.pauses)
      ? d.pauses.slice(0, 500).filter(p => p && Number.isFinite(Date.parse(p.start)) && Number.isFinite(Date.parse(p.end)))
          .map(p => ({ start: new Date(p.start).toISOString(), end: new Date(p.end).toISOString() }))
      : [],
    endedEarly: !!d.endedEarly,
    blockedAttempts: nonNegInt(d.blockedAttempts),
    plannedMinutes: nonNegInt(d.plannedMinutes),
    projectId: idOrNull(d.projectId),
    breaks: nonNegInt(d.breaks),
    skippedBreaks: nonNegInt(d.skippedBreaks),
    slots
  };
  if (typeof d.device === 'string' && d.device) out.device = d.device.slice(0, 40);
  return out;
}

function sanitizeProject(d, id) {
  if (!d || typeof d !== 'object' || !idOrNull(id)) return null;
  const name = cleanProjectName(d.name);
  if (!name) return null;
  return { id, name, parentId: idOrNull(d.parentId), createdAt: Number.isFinite(Number(d.createdAt)) ? Number(d.createdAt) : 0 };
}

const SANITIZERS = { session: sanitizeSession, project: sanitizeProject };

// A row from the server must look like a row before we even try to read its data.
function validRemoteRow(r) {
  return !!r && typeof r === 'object' && SYNC_KINDS.includes(r.kind) && !!idOrNull(r.id)
    && Number.isFinite(Number(r.updated_at)) && typeof r.deleted === 'boolean'
    && (r.data == null || (typeof r.data === 'object' && JSON.stringify(r.data).length < 20000));
}

// Compare local records with what we remembered at the last sync. New or edited records get
// updated-at = now; records that disappeared become tombstones.
function detectLocalChanges(list, meta, now, mergedInto = {}) {
  const seen = new Set();
  for (const rec of list) {
    seen.add(rec.id);
    const h = recordHash(rec);
    const m = meta[rec.id];
    if (!m || m.d || m.h !== h) meta[rec.id] = { h, u: now, p: m ? m.p : 0, d: false, pa: rec.parentId || null };
    else if ('parentId' in rec) m.pa = rec.parentId || null; // remembered so a later delete knows where children go
  }
  for (const id of Object.keys(meta)) {
    if (seen.has(id) || meta[id].d) continue;
    const mi = id in mergedInto ? mergedInto[id] : (meta[id].pa || null);
    meta[id] = { h: '', u: now, p: meta[id].p, d: true, mi };
  }
}

// Point everything that referred to `from` at `to` (or at nothing when to is null).
function remapProject(projects, sessions, from, to) {
  for (const p of projects) if (p.parentId === from) p.parentId = to;
  for (const s of sessions) if (s.projectId === from) s.projectId = to;
}

// Merge remote rows into local data. Mutates `state` ({sessions, projects, meta:{session, project}}).
// Rule: a remote row wins only if it is newer than our copy.
function applyRemote(state, rows) {
  const lists = { session: state.sessions, project: state.projects };
  const ordered = [...rows.filter(r => r.kind === 'project'), ...rows.filter(r => r.kind === 'session')];
  for (const r of ordered) {
    const meta = state.meta[r.kind];
    const m = meta[r.id];
    const at = Number(r.updated_at);
    if (m && at <= m.u) continue;
    if (r.deleted) {
      lists[r.kind] = lists[r.kind].filter(x => x.id !== r.id);
      if (r.kind === 'project') {
        const to = idOrNull(r.data && r.data.mergedInto);
        remapProject(lists.project, lists.session, r.id, to === r.id ? null : to);
      }
      meta[r.id] = { h: '', u: at, p: at, d: true };
    } else {
      const clean = SANITIZERS[r.kind](r.data, r.id);
      if (!clean) continue;
      lists[r.kind] = [...lists[r.kind].filter(x => x.id !== r.id), clean];
      meta[r.id] = { h: recordHash(clean), u: at, p: at, d: false, pa: clean.parentId || null };
    }
  }
  state.sessions = lists.session;
  state.projects = lists.project;
}

// Two devices can each create "Thesis" before they ever meet. Keep the oldest one and fold the
// others into it. The rule is deterministic, so every device reaches the same answer.
// Returns { mergedInto: { droppedId: keptId } }.
function dedupeProjects(state) {
  const mergedInto = {};
  for (let pass = 0; pass < 20; pass++) {
    const groups = new Map();
    const ids = new Set(state.projects.map(p => p.id));
    for (const p of state.projects) {
      const key = `${p.parentId && ids.has(p.parentId) ? p.parentId : ''}|${p.name.toLowerCase()}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(p);
    }
    let changed = false;
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      group.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0) || (a.id < b.id ? -1 : 1));
      const keep = group[0];
      for (const dup of group.slice(1)) {
        remapProject(state.projects, state.sessions, dup.id, keep.id);
        state.projects = state.projects.filter(p => p.id !== dup.id);
        mergedInto[dup.id] = keep.id;
        changed = true;
      }
    }
    if (!changed) break;
  }
  return { mergedInto };
}

// Break parent loops that a bad merge could create (a moved to inside b on one device, b inside a on another).
function breakProjectCycles(projects) {
  const parent = new Map(projects.map(p => [p.id, p.parentId]));
  for (const p of projects) {
    const seen = new Set([p.id]);
    for (let cur = parent.get(p.id); cur; cur = parent.get(cur)) {
      if (seen.has(cur)) { p.parentId = null; parent.set(p.id, null); break; }
      seen.add(cur);
    }
  }
  const ids = new Set(projects.map(p => p.id));
  for (const p of projects) if (p.parentId && !ids.has(p.parentId)) p.parentId = null;
}

// The whole local-side merge. Returns the records that still need uploading.
function mergeLocal(state, remoteRows, now) {
  const rows = remoteRows.filter(validRemoteRow);
  detectLocalChanges(state.sessions, state.meta.session, now);
  detectLocalChanges(state.projects, state.meta.project, now);
  applyRemote(state, rows);
  const { mergedInto } = dedupeProjects(state);
  breakProjectCycles(state.projects);
  detectLocalChanges(state.projects, state.meta.project, now, mergedInto);
  detectLocalChanges(state.sessions, state.meta.session, now);
  const dirty = [];
  for (const kind of SYNC_KINDS) {
    const list = kind === 'session' ? state.sessions : state.projects;
    const byId = new Map(list.map(r => [r.id, r]));
    for (const [id, m] of Object.entries(state.meta[kind])) {
      if (m.p === m.u) continue;
      if (m.d) dirty.push({ kind, id, data: kind === 'project' ? { mergedInto: m.mi || null } : {}, updated_at: m.u, deleted: true });
      else {
        const clean = byId.has(id) ? SANITIZERS[kind](byId.get(id), id) : null;
        if (clean) dirty.push({ kind, id, data: clean, updated_at: m.u, deleted: false });
      }
    }
  }
  return dirty;
}

// ---------- configuration and tokens ----------

function decodeJwtRole(token) {
  try {
    const part = String(token).split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(part)).role || null;
  } catch (e) {
    return null;
  }
}

// Returns { url, anonKey } or { error }.
function validateSyncConfig(urlRaw, keyRaw) {
  let u;
  try { u = new URL(String(urlRaw).trim()); } catch (e) { return { error: 'The project URL is not a valid web address.' }; }
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  if (u.protocol !== 'https:' && !(local && u.protocol === 'http:')) return { error: 'The project URL must start with https://' };
  const key = String(keyRaw || '').trim();
  if (key.length < 20) return { error: 'Paste the "anon public" (or "publishable") API key from Supabase (Project Settings -> API).' };
  // Secret keys bypass every security rule. They must never be put in a browser extension.
  if (decodeJwtRole(key) === 'service_role' || /^sb_secret_/i.test(key)) {
    return { error: 'That is a secret key (service_role / sb_secret_), which bypasses all security. Use the "anon public" or "publishable" key instead.' };
  }
  return { url: u.origin, anonKey: key };
}

class SyncError extends Error {
  constructor(message, status) { super(message); this.status = status || 0; }
}

function friendlyAuthError(status, body) {
  const text = String((body && (body.error_description || body.msg || body.message || body.error)) || '').trim();
  const t = text.toLowerCase();
  if (t.includes('not confirmed')) return 'Confirm your email first (check your inbox), then sign in.';
  if (t.includes('invalid login')) return 'Wrong email or password.';
  if (t.includes('already registered') || t.includes('already exists')) return 'That email already has an account. Sign in instead.';
  if (t.includes('password') && t.includes('at least')) return text;
  if (t.includes('rate limit') || status === 429) return 'Too many attempts. Wait a minute and try again.';
  return text || `Sign-in failed (HTTP ${status}).`;
}

// ---------- storage ----------

const syncStore = chrome.storage.local;

async function getSyncConfig() { return (await syncStore.get('syncConfig')).syncConfig || null; }
async function getSyncAuth() { return (await syncStore.get('syncAuth')).syncAuth || null; }
async function getSyncMeta() {
  const m = (await syncStore.get('syncMeta')).syncMeta || {};
  return { sessions: {}, projects: {}, cursor: null, lastSync: 0, lastError: null, ...m, deviceId: m.deviceId || crypto.randomUUID() };
}
async function saveSyncMeta(meta) { await syncStore.set({ syncMeta: meta }); }

async function getDeviceName() {
  const m = await getSyncMeta();
  if (!m.deviceName) { // remember the generated name so it stays stable
    m.deviceName = `Device ${m.deviceId.slice(0, 4)}`;
    await saveSyncMeta(m);
  }
  return m.deviceName;
}

// ---------- network ----------

async function sbFetch(path, { method = 'GET', body, token, headers = {} } = {}) {
  const cfg = await getSyncConfig();
  if (!cfg) throw new SyncError('Cloud sync is not set up yet.');
  let res;
  try {
    res = await fetch(cfg.url + path, {
      method,
      headers: { apikey: cfg.anonKey, 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  } catch (e) {
    throw new SyncError('Cannot reach the server. Check your internet connection.');
  }
  let json = null;
  const text = await res.text();
  if (text) { try { json = JSON.parse(text); } catch (e) { /* not JSON */ } }
  if (!res.ok) throw Object.assign(new SyncError(friendlyAuthError(res.status, json), res.status), { body: json });
  return json;
}

function authFromResponse(j, fallbackEmail) {
  return {
    email: (j.user && j.user.email) || fallbackEmail,
    userId: j.user && j.user.id,
    accessToken: j.access_token,
    refreshToken: j.refresh_token,
    expiresAt: Date.now() + (Number(j.expires_in) || 3600) * 1000
  };
}

// Returns a valid access token, refreshing it when it is about to expire.
async function ensureToken(force = false) {
  const auth = await getSyncAuth();
  if (!auth) throw new SyncError('Not signed in.', 401);
  if (!force && auth.expiresAt - Date.now() > 60000) return auth.accessToken;
  try {
    const j = await sbFetch('/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: { refresh_token: auth.refreshToken } });
    const next = authFromResponse(j, auth.email);
    next.userId = next.userId || auth.userId;
    await syncStore.set({ syncAuth: next });
    return next.accessToken;
  } catch (e) {
    if (e.status >= 400 && e.status < 500) { // refresh token rejected: the login is no longer valid
      await syncStore.remove('syncAuth');
      throw new SyncError('Your sign-in expired. Please sign in again.', 401);
    }
    throw e;
  }
}

async function authedFetch(path, opts = {}) {
  let token = await ensureToken();
  try {
    return await sbFetch(path, { ...opts, token });
  } catch (e) {
    if (e.status !== 401) throw e;
    token = await ensureToken(true); // the server said the token is stale: refresh once and retry
    return sbFetch(path, { ...opts, token });
  }
}

async function pullRows(cursor) {
  const rows = [];
  for (let offset = 0; offset < 100000; offset += SYNC_PAGE) {
    let q = `/rest/v1/focus_records?select=kind,id,data,updated_at,deleted,server_ts&order=server_ts.asc,kind.asc,id.asc&limit=${SYNC_PAGE}&offset=${offset}`;
    if (cursor) q += `&server_ts=gte.${encodeURIComponent(cursor)}`;
    const page = await authedFetch(q);
    if (!Array.isArray(page)) throw new SyncError('The server sent an unexpected reply.');
    rows.push(...page);
    if (page.length < SYNC_PAGE) break;
  }
  return rows;
}

async function pushRows(records) {
  for (let i = 0; i < records.length; i += SYNC_BATCH) {
    await authedFetch('/rest/v1/rpc/focus_upsert', { method: 'POST', body: { records: records.slice(i, i + SYNC_BATCH) } });
  }
}

// ---------- account actions ----------

async function syncSetConfig(url, anonKey) {
  const v = validateSyncConfig(url, anonKey);
  if (v.error) return { ok: false, error: v.error };
  await syncStore.set({ syncConfig: { url: v.url, anonKey: v.anonKey } });
  return { ok: true };
}

// Sign in (or create the account first). If this device already holds another account's data,
// uploading it needs the caller's explicit OK (confirmSwitch).
async function syncSignIn(email, password, { create = false, confirmSwitch = false } = {}) {
  const cfg = await getSyncConfig();
  if (!cfg) return { ok: false, error: 'Set up your Supabase project first.' };
  email = String(email || '').trim().toLowerCase();
  if (!email || !password) return { ok: false, error: 'Enter your email and password.' };
  let j;
  try {
    if (create) {
      j = await sbFetch('/auth/v1/signup', { method: 'POST', body: { email, password } });
      if (!j || !j.access_token) {
        return { ok: true, needsConfirmation: true, message: 'Account created. Check your email and click the confirmation link, then sign in here.' };
      }
    } else {
      j = await sbFetch('/auth/v1/token?grant_type=password', { method: 'POST', body: { email, password } });
    }
  } catch (e) {
    return { ok: false, error: e.message };
  }
  const auth = authFromResponse(j, email);
  if (!auth.userId || !auth.accessToken) return { ok: false, error: 'The server sent an unexpected reply.' };

  const meta = await getSyncMeta();
  if (meta.userId && meta.userId !== auth.userId) {
    const { sessions = [], projects = [] } = await syncStore.get(['sessions', 'projects']);
    if ((sessions.length || projects.length) && !confirmSwitch) {
      return { ok: false, needsSwitchConfirm: true, error: `This device already has data from ${meta.email || 'another account'}. Signing in as ${email} will upload it to that account.` };
    }
    meta.sessions = {}; meta.projects = {}; meta.cursor = null; // a different account has seen none of it
  }
  meta.userId = auth.userId;
  meta.email = auth.email;
  meta.lastError = null;
  await syncStore.set({ syncAuth: auth });
  await saveSyncMeta(meta);
  return { ok: true };
}

async function syncSignOut() {
  const auth = await getSyncAuth();
  await syncStore.remove('syncAuth'); // local data and settings stay
  if (auth) { try { await sbFetch('/auth/v1/logout', { method: 'POST', token: auth.accessToken }); } catch (e) { /* best effort */ } }
  return { ok: true };
}

async function syncSetDevice(name) {
  const clean = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 40);
  if (!clean) return { ok: false, error: 'Give this device a name.' };
  const meta = await getSyncMeta();
  meta.deviceName = clean;
  await saveSyncMeta(meta);
  return { ok: true };
}

// ---------- the sync run ----------

let syncChain = Promise.resolve();
let syncMerging = false;

// Runs one sync at a time. Returns { ok, pulled, pushed } or { ok:false, error }.
function syncNow() {
  const run = syncChain.then(doSync);
  syncChain = run.catch(() => {});
  return run;
}

async function doSync() {
  const cfg = await getSyncConfig();
  const auth = await getSyncAuth();
  if (!cfg || !auth) return { ok: false, error: 'Not signed in.' };
  try {
    const before = await getSyncMeta();
    const rows = await pullRows(before.cursor);

    let dirty = [];
    syncMerging = true;
    try {
      // Same queue as every other edit, so a session finishing mid-sync can't be lost.
      await mutate(async () => {
        const { sessions = [], projects = [] } = await syncStore.get(['sessions', 'projects']);
        const meta = await getSyncMeta();
        const state = { sessions: clone(sessions), projects: clone(projects), meta: { session: meta.sessions, project: meta.projects } };
        dirty = mergeLocal(state, rows, Date.now());
        const newCursor = rows.reduce((c, r) => (r.server_ts && (!c || r.server_ts > c) ? r.server_ts : c), meta.cursor);
        meta.cursor = newCursor || null;
        await syncStore.set({ sessions: state.sessions, projects: state.projects });
        await saveSyncMeta(meta);
      });
    } finally {
      syncMerging = false;
    }

    await pushRows(dirty);

    await mutate(async () => { // remember what the server now has
      const meta = await getSyncMeta();
      for (const rec of dirty) {
        const m = (rec.kind === 'session' ? meta.sessions : meta.projects)[rec.id];
        if (m && m.u === rec.updated_at) m.p = rec.updated_at;
      }
      meta.lastSync = Date.now();
      meta.lastError = null;
      await saveSyncMeta(meta);
    });
    return { ok: true, pulled: rows.length, pushed: dirty.length };
  } catch (e) {
    const meta = await getSyncMeta();
    meta.lastError = e.message || String(e);
    await saveSyncMeta(meta);
    return { ok: false, error: meta.lastError };
  }
}

const clone = v => JSON.parse(JSON.stringify(v));
