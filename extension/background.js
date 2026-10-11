importScripts('shared.js', 'sync.js');

const store = chrome.storage.local;
const GOOGLE = 'https://www.google.com';

let queue = Promise.resolve();
let allowCreateUntil = 0; // while in the future, the extension is opening a tab itself

// Serialize every read-modify-write of `state`. fn(state) returns the new state
// (null clears it) or undefined for "no change". Never call mutate() inside fn.
function mutate(fn) {
  const run = queue.then(async () => {
    const { state = null } = await store.get('state');
    const next = await fn(state);
    if (next !== undefined) await store.set({ state: next });
    return next;
  });
  queue = run.catch(() => {});
  return run;
}

const fail = error => ({ ok: false, error });
const slotOf = (state, tabId) => SLOTS.find(k => state.slots[k] === tabId);

// ---------- badge ----------

async function updateBadge() {
  const { state = null } = await store.get('state');
  if (!state) {
    await chrome.action.setBadgeText({ text: '' });
    return;
  }
  const s = await getSettings();
  const sec = activeSeconds(state);
  let text;
  let color = '#3b7a6a';
  if (state.rest) {
    text = 'rest';
    color = '#c58a2b';
  } else if (state.pausedAt != null) {
    text = 'II';
    color = '#888888';
  } else {
    text = sec >= 3600 ? `${Math.floor(sec / 3600)}h${pad2(Math.floor((sec % 3600) / 60))}` : `${Math.floor(sec / 60)}m`;
  }
  await chrome.action.setBadgeBackgroundColor({ color });
  await chrome.action.setBadgeText({ text });
}

// ---------- notification blocking ----------

async function setBlocking(on) {
  try {
    if (on) await chrome.contentSettings.notifications.set({ primaryPattern: '<all_urls>', setting: 'block' });
    else await chrome.contentSettings.notifications.clear({});
  } catch (e) {
    console.warn('contentSettings.notifications failed', e);
  }
  try { await chrome.scripting.unregisterContentScripts({ ids: ['notify-block'] }); } catch (e) { /* not registered */ }
  if (on) {
    try {
      await chrome.scripting.registerContentScripts([{
        id: 'notify-block', js: ['notify-block.js'], matches: ['<all_urls>'],
        runAt: 'document_start', world: 'MAIN', allFrames: true
      }]);
    } catch (e) {
      console.warn('registerContentScripts failed', e);
    }
  }
}

async function injectNotifyBlock(tabIds) {
  for (const tabId of tabIds) {
    try {
      await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['notify-block.js'], world: 'MAIN' });
    } catch (e) { /* chrome:// pages, discarded tabs, file:// without access */ }
  }
}

// ---------- Windows companion (optional) ----------

const COMPANION = 'com.focusup.host';

// Ask the companion to turn Windows notifications off (active) or restore them.
// Never throws: without the companion the extension still works, browser-only.
async function syncCompanion(active) {
  let companion;
  try {
    const s = await getSettings();
    const res = await chrome.runtime.sendNativeMessage(COMPANION, { type: 'sync', active, blockedApps: s.blockedApps });
    companion = res && res.ok
      ? { ok: true, active, closed: res.closed || [], at: Date.now() }
      : { ok: false, error: (res && res.error) || 'The companion reported an error.', at: Date.now() };
  } catch (e) {
    companion = { ok: false, error: String((e && e.message) || e), at: Date.now() };
  }
  await store.set({ companion });
  return companion;
}

// ---------- projects ----------

// Every project/session edit goes through the same queue as the session lifecycle,
// so an edit can never interleave with endSession() writing a new session.
// fn(projects, sessions) returns { error } or { id?, projects?, sessions? }.
async function editProjects(fn) {
  let out;
  await mutate(async () => {
    const { projects = [], sessions = [] } = await store.get(['projects', 'sessions']);
    out = fn(projects, sessions);
    if (out.error) return;
    await store.set({ projects: out.projects || projects, sessions: out.sessions || sessions });
  });
  return out.error ? fail(out.error) : { ok: true, id: out.id };
}

function siblingClash(projects, parentId, name, exceptId) {
  const n = name.toLowerCase();
  return projects.some(p => p.id !== exceptId && (p.parentId || null) === (parentId || null) && p.name.toLowerCase() === n);
}

function createProject(rawName, parentId = null) {
  const name = cleanProjectName(rawName);
  return editProjects(projects => {
    if (!name) return { error: 'Give the project a name.' };
    if (parentId && !projects.some(p => p.id === parentId)) return { error: 'The parent project no longer exists.' };
    if (siblingClash(projects, parentId, name)) return { error: `"${name}" already exists there.` };
    const id = crypto.randomUUID();
    return { id, projects: [...projects, { id, name, parentId: parentId || null, createdAt: Date.now() }] };
  });
}

function renameProject(id, rawName) {
  const name = cleanProjectName(rawName);
  return editProjects(projects => {
    const p = projects.find(x => x.id === id);
    if (!p) return { error: 'Project not found.' };
    if (!name) return { error: 'Give the project a name.' };
    if (siblingClash(projects, p.parentId, name, id)) return { error: `"${name}" already exists there.` };
    return { projects: projects.map(x => (x.id === id ? { ...x, name } : x)) };
  });
}

// Re-parent a project (null = top level). A project can't move into itself or its own subprojects.
function moveProject(id, newParentId = null) {
  return editProjects(projects => {
    const p = projects.find(x => x.id === id);
    if (!p) return { error: 'Project not found.' };
    if (newParentId && !projects.some(x => x.id === newParentId)) return { error: 'The destination no longer exists.' };
    if (newParentId && descendantIds(projects, id).has(newParentId)) return { error: 'A project cannot go inside itself or one of its subprojects.' };
    if (siblingClash(projects, newParentId, p.name, id)) return { error: `"${p.name}" already exists in that place.` };
    return { projects: projects.map(x => (x.id === id ? { ...x, parentId: newParentId || null } : x)) };
  });
}

// Subprojects and sessions move up to the deleted project's parent, so no time is lost.
function deleteProject(id) {
  return editProjects((projects, sessions) => {
    const p = projects.find(x => x.id === id);
    if (!p) return { error: 'Project not found.' };
    const up = p.parentId || null;
    const rest = projects.filter(x => x.id !== id).map(x => (x.parentId === id ? { ...x, parentId: up } : x));
    // Moving children up could collide with a sibling of the same name there; rename the later one.
    const seen = new Set();
    const fixed = rest.map(x => {
      let name = x.name;
      const key = () => `${x.parentId || ''}|${name.toLowerCase()}`;
      for (let i = 2; seen.has(key()); i++) name = `${x.name} (${i})`;
      seen.add(key());
      return name === x.name ? x : { ...x, name };
    });
    return { projects: fixed, sessions: sessions.map(s => (s.projectId === id ? { ...s, projectId: up } : s)) };
  });
}

function setSessionProject(sessionId, projectId = null) {
  return editProjects((projects, sessions) => {
    if (projectId && !projects.some(p => p.id === projectId)) return { error: 'That project no longer exists.' };
    if (!sessions.some(s => s.id === sessionId)) return { error: 'Session not found.' };
    return { sessions: sessions.map(s => (s.id === sessionId ? { ...s, projectId: projectId || null } : s)) };
  });
}

// Ask the companion to start the desktop app.
async function openApp() {
  try {
    const res = await chrome.runtime.sendNativeMessage(COMPANION, { type: 'open-app' });
    return res && res.ok ? { ok: true } : fail((res && res.error) || 'The companion could not open the app.');
  } catch (e) {
    return fail('The Windows companion is not installed. Run companion\\install.ps1 (see the README).');
  }
}

// ---------- session lifecycle ----------

async function startSession({ name = '', planned = 0, picks = {}, projectId = null }) {
  const { state: existing = null, projects = [] } = await store.get(['state', 'projects']);
  if (existing) return fail('A session is already running.');
  const project = projectId ? projects.find(p => p.id === projectId) : null;
  if (projectId && !project) return fail('That project no longer exists.');
  const s = await getSettings();

  const tabs = await chrome.tabs.query({});
  const byId = new Map(tabs.map(t => [t.id, t]));
  const chosen = SLOTS.filter(k => picks[k] != null);
  const ids = chosen.map(k => picks[k]);
  if (new Set(ids).size !== ids.length) return fail('Each slot needs a different tab.');

  let workLock = null;
  for (const k of chosen) {
    const t = byId.get(picks[k]);
    const url = t && (t.url || t.pendingUrl);
    if (!t) return fail('A selected tab no longer exists.');
    if (k === 'work') {
      workLock = makeLock(url);
      if (!workLock) return fail('The Work tab must be a web page or a local file.');
    } else if (k === 'research') {
      // A blank/new-tab page is fine, it gets sent to Google below.
      if (/^https?:/.test(url) && !isAllowed('research', url, null, s)) {
        return fail(`The Research tab (${hostOf(url)}) is on the blocklist.`);
      }
    } else if (!isAllowed(k, url, null, s)) {
      return fail(`The ${SLOT_LABELS[k]} tab (${hostOf(url) || url}) isn't allowed in that slot. Edit the allowlist in Settings or pick another tab.`);
    }
  }

  const slots = { music: null, research: null, work: null };
  for (const k of chosen) slots[k] = picks[k];

  // Build the focus window. Nothing else is touched: other tabs stay where they are.
  allowCreateUntil = Date.now() + 3000;
  let win;
  if (slots.research != null) {
    win = await chrome.windows.create({ tabId: slots.research, state: 'maximized', focused: true });
    if (!/^https?:/.test(byId.get(slots.research).url || '')) await chrome.tabs.update(slots.research, { url: GOOGLE });
  } else {
    win = await chrome.windows.create({ url: GOOGLE, state: 'maximized', focused: true });
    slots.research = win.tabs[0].id;
    byId.set(slots.research, win.tabs[0]);
  }
  for (const k of ['work', 'music']) {
    if (slots[k] != null) await chrome.tabs.move(slots[k], { windowId: win.id, index: -1 });
  }

  const lastUrls = {};
  for (const k of SLOTS) {
    const t = slots[k] != null && byId.get(slots[k]);
    if (t && t.url && /^(https?|file):/.test(t.url)) lastUrls[k] = t.url;
  }

  const state = {
    id: crypto.randomUUID(),
    name: String(name).trim().slice(0, 120) || (project ? project.name : ''),
    projectId: project ? project.id : null,
    plannedMinutes: Math.max(0, Math.floor(Number(planned) || 0)),
    startedAt: Date.now(),
    pausedAt: null,
    pauses: [],
    windowId: win.id,
    slots,
    workLock,
    lastUrls,
    blockedAttempts: 0,
    stretchStartSec: 0, // active seconds at the start of the current stretch of focus
    breaksTaken: 0,
    skippedBreaks: 0,
    rest: null,
    restWindowId: null
  };
  await store.set({ state, lastProjectId: project ? project.id : null });

  await setBlocking(true);
  await injectNotifyBlock(Object.values(slots).filter(v => v != null));
  chrome.alarms.create('tick', { periodInMinutes: 1 });
  await updateBadge();
  scheduleRest();
  syncCompanion(true);
  return { ok: true };
}

// Ends the running session. With discard=true (a session started by mistake) nothing is saved:
// no history entry, no calendar time, no project time.
async function endSession(early, discard = false) {
  let saved = null;
  let ended = false;
  let restWindow = null;
  await mutate(async st => {
    if (!st) return;
    ended = true;
    restWindow = st.restWindowId;
    if (discard) return null;
    const now = Date.now();
    const pauses = [...st.pauses];
    if (st.pausedAt != null) pauses.push({ start: st.pausedAt, end: now });
    const slotSummary = {};
    for (const k of SLOTS) {
      const u = st.lastUrls && st.lastUrls[k];
      if (!u) continue;
      slotSummary[k] = k === 'work' && st.workLock && st.workLock.kind === 'file' ? st.workLock.path : hostOf(u);
    }
    saved = {
      id: st.id,
      name: st.name || 'Focus session',
      start: new Date(st.startedAt).toISOString(),
      end: new Date(now).toISOString(),
      activeSeconds: activeSeconds({ ...st, pausedAt: null, pauses }, now),
      pauses: pauses.map(p => ({ start: new Date(p.start).toISOString(), end: new Date(p.end).toISOString() })),
      endedEarly: !!early,
      blockedAttempts: st.blockedAttempts,
      plannedMinutes: st.plannedMinutes,
      projectId: st.projectId || null,
      breaks: st.breaksTaken || 0,
      skippedBreaks: st.skippedBreaks || 0,
      device: await getDeviceName(),
      slots: slotSummary
    };
    const { sessions = [] } = await store.get('sessions');
    sessions.push(saved);
    await store.set({ sessions });
    return null;
  });
  if (!ended) return fail('No session is running.');
  await setBlocking(false);
  chrome.alarms.clear('tick');
  chrome.alarms.clear('rest-due');
  chrome.alarms.clear('rest-end');
  if (restWindow != null) { try { await chrome.windows.remove(restWindow); } catch (e) { /* already closed */ } }
  await updateBadge();
  await syncCompanion(false);
  return { ok: true };
}

async function pauseSession() {
  await mutate(st => {
    if (st && st.pausedAt == null) { st.pausedAt = Date.now(); return st; }
  });
  await updateBadge();
  return { ok: true };
}

async function resumeSession() {
  const s = await getSettings();
  let wasRest = false;
  await mutate(st => {
    if (!st || st.pausedAt == null) return;
    const now = Date.now();
    if (st.rest) {
      wasRest = true; // pressing Resume during a rest is the same as skipping it
      return finishRest(st, now, true);
    }
    const pausedFor = now - st.pausedAt;
    st.pauses.push({ start: st.pausedAt, end: now });
    st.pausedAt = null;
    // A manual pause at least as long as a rest counts as one: don't nag straight after it.
    if (s.breaks.enabled && pausedFor >= s.breaks.rest * 60000) st.stretchStartSec = activeSeconds(st, now);
    return st;
  });
  await updateBadge();
  await scheduleRest();
  if (wasRest) await refocusSessionWindow();
  return { ok: true };
}

// Open a tab for an empty slot, inside the focus window. The only way to get a new tab mid-session.
async function openSlot(slot, url) {
  const [{ state = null }, s] = [await store.get('state'), await getSettings()];
  if (!state) return fail('No session is running.');
  if (!SLOTS.includes(slot)) return fail('Unknown slot.');
  if (state.slots[slot] != null) {
    try { await chrome.tabs.get(state.slots[slot]); return fail('That slot already has a tab.'); } catch (e) { /* tab is gone */ }
  }
  if (!/^https?:\/\//.test(url || '')) return fail('Enter a full URL starting with https://');

  let lock = null;
  if (slot === 'work') {
    lock = makeLock(url);
    if (!lock) return fail('The Work tab must be a web page.');
  } else if (!isAllowed(slot, url, state, s)) {
    return fail(`${hostOf(url) || url} isn't allowed in the ${SLOT_LABELS[slot]} slot.`);
  }

  allowCreateUntil = Date.now() + 3000;
  const props = { url };
  if (state.windowId != null) props.windowId = state.windowId;
  let tab;
  try {
    tab = await chrome.tabs.create(props);
  } catch (e) {
    tab = await chrome.tabs.create({ url }); // the focus window is gone
  }
  await mutate(st => {
    if (!st) return;
    st.slots[slot] = tab.id;
    st.windowId = tab.windowId;
    if (lock) st.workLock = lock;
    st.lastUrls = { ...st.lastUrls, [slot]: url };
    return st;
  });
  await injectNotifyBlock([tab.id]);
  return { ok: true };
}

async function relockWork() {
  const { state = null } = await store.get('state');
  if (!state || state.slots.work == null) return fail('There is no Work tab.');
  const tab = await chrome.tabs.get(state.slots.work);
  const lock = makeLock(tab.url);
  if (!lock) return fail('Open a web page or file in the Work tab first.');
  await mutate(st => {
    if (!st) return;
    st.workLock = lock;
    st.lastUrls = { ...st.lastUrls, work: tab.url };
    return st;
  });
  return { ok: true };
}

// ---------- rest breaks ----------
// After `breaks.work` minutes of focus the session pauses itself for a rest and opens a small
// rest window. Rest time is recorded as a pause, so it is never counted as focus. Restrictions
// stay on during a rest. state.rest = { start, until, minutes, long } while resting.

function beginRest(st, breaks, now) {
  const plan = breakPlan(st, breaks, now); // computed before breaksTaken changes
  st.pausedAt = now;
  st.rest = { start: now, until: now + plan.restMin * 60000, minutes: plan.restMin, long: plan.isLong };
  st.breaksTaken = (st.breaksTaken || 0) + 1;
  return st;
}

function finishRest(st, now, skipped = false) {
  st.pauses.push({ start: st.pausedAt, end: now });
  st.pausedAt = null;
  st.rest = null;
  st.restWindowId = null;
  st.stretchStartSec = activeSeconds(st, now); // a fresh stretch of focus starts now
  if (skipped) st.skippedBreaks = (st.skippedBreaks || 0) + 1;
  return st;
}

async function openRestWindow() {
  allowCreateUntil = Date.now() + 3000;
  try {
    const win = await chrome.windows.create({ url: chrome.runtime.getURL('rest.html'), type: 'popup', width: 460, height: 430, focused: true });
    await mutate(st => {
      if (st && st.rest) { st.restWindowId = win.id; return st; }
    });
  } catch (e) {
    console.warn('could not open the rest window', e);
  }
}

async function refocusSessionWindow() {
  const { state = null } = await store.get('state');
  if (state && state.windowId != null) {
    try { await chrome.windows.update(state.windowId, { focused: true }); } catch (e) { /* window is gone */ }
  }
}

// Start or end a rest when it is due. Safe to call at any time; it only acts when something is due.
async function checkRest() {
  const s = await getSettings();
  let event = null;
  await mutate(st => {
    if (!st) return;
    const now = Date.now();
    if (st.rest) {
      if (now < st.rest.until) return;
      event = 'end';
      return finishRest(st, now);
    }
    if (!s.breaks.enabled || st.pausedAt != null) return;
    if (breakPlan(st, s.breaks, now).dueIn > 0) return;
    event = 'start';
    return beginRest(st, s.breaks, now);
  });
  if (event === 'start') await openRestWindow();
  if (event === 'end') await refocusSessionWindow();
  if (event) await updateBadge();
  await scheduleRest();
}

// Precise one-shot alarms (the once-a-minute tick is the backstop).
async function scheduleRest() {
  chrome.alarms.clear('rest-due');
  chrome.alarms.clear('rest-end');
  const [{ state = null }, s] = [await store.get('state'), await getSettings()];
  if (!state) return;
  if (state.rest) {
    chrome.alarms.create('rest-end', { when: Math.max(Date.now() + 1000, state.rest.until) });
    return;
  }
  if (!s.breaks.enabled || state.pausedAt != null) return;
  chrome.alarms.create('rest-due', { when: Date.now() + Math.max(1, breakPlan(state, s.breaks).dueIn) * 1000 });
}

// End a rest early. snoozeMinutes > 0 means "remind me again in that many minutes" instead of
// starting a fresh full stretch.
async function skipRest(snoozeMinutes = 0) {
  const s = await getSettings();
  let did = false;
  await mutate(st => {
    if (!st || !st.rest) return;
    did = true;
    const now = Date.now();
    finishRest(st, now, true);
    const m = Math.max(0, Math.min(120, Math.floor(Number(snoozeMinutes) || 0)));
    if (m > 0) st.stretchStartSec = activeSeconds(st, now) - s.breaks.work * 60 + m * 60;
    return st;
  });
  if (!did) return fail('There is no rest to skip.');
  await updateBadge();
  await scheduleRest();
  await refocusSessionWindow();
  return { ok: true };
}

// ---------- enforcement ----------

async function countBlocked() {
  await mutate(st => {
    if (st) { st.blockedAttempts++; return st; }
  });
}

async function enforce(tabId, url) {
  const { state = null } = await store.get('state');
  if (!state) return;
  const slot = slotOf(state, tabId);
  if (!slot) return;
  const s = await getSettings();
  if (isAllowed(slot, url, state, s)) return;
  await countBlocked();
  const page = chrome.runtime.getURL('blocked.html') + '?slot=' + slot + '&url=' + encodeURIComponent(url);
  chrome.tabs.update(tabId, { url: page });
}

chrome.webNavigation.onBeforeNavigate.addListener(d => { if (d.frameId === 0) enforce(d.tabId, d.url); });
chrome.webNavigation.onHistoryStateUpdated.addListener(d => { if (d.frameId === 0) enforce(d.tabId, d.url); });

chrome.tabs.onCreated.addListener(async tab => {
  if (Date.now() < allowCreateUntil) return; // checked synchronously, before any await
  const { state = null, graceUntil = 0 } = await store.get(['state', 'graceUntil']);
  if (!state || Date.now() < graceUntil) return;

  const url = tab.pendingUrl || tab.url || '';
  if (url.startsWith('chrome-extension://' + chrome.runtime.id)) return;

  // No slot tab is open at all (e.g. the focus window was closed): adopt this tab as Research.
  const live = Object.values(state.slots).filter(v => v != null);
  if (!live.length) {
    await mutate(st => {
      if (st) { st.slots.research = tab.id; st.windowId = tab.windowId; return st; }
    });
    return;
  }

  const fromResearch = tab.openerTabId != null && tab.openerTabId === state.slots.research;
  if (fromResearch && /^https?:/.test(url)) {
    // Link opened in a new tab from Research: load it in the Research tab instead.
    chrome.tabs.update(state.slots.research, { url });
  } else {
    await countBlocked();
  }
  chrome.tabs.remove(tab.id);
});

chrome.tabs.onRemoved.addListener(tabId => {
  mutate(st => {
    if (!st) return;
    const k = slotOf(st, tabId);
    if (!k) return;
    st.slots[k] = null;
    return st;
  });
});

// Remember where each slot tab last was, so slots can be rebuilt after a browser restart.
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (!info.url || !/^(https?|file):/.test(info.url)) return;
  mutate(async st => {
    if (!st) return;
    const k = slotOf(st, tabId);
    if (!k || !isAllowed(k, info.url, st, await getSettings())) return;
    st.lastUrls = { ...st.lastUrls, [k]: info.url };
    return st;
  });
});

// ---------- window lock ----------

// Switching to another Brave window snaps back to the focus window. Focus leaving
// the browser entirely (WINDOW_ID_NONE, e.g. alt-tab to the Discord app) is allowed.
chrome.windows.onFocusChanged.addListener(async windowId => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  const { state = null, graceUntil = 0 } = await store.get(['state', 'graceUntil']);
  if (!state || state.windowId == null || windowId === state.windowId || windowId === state.restWindowId || Date.now() < graceUntil) return;
  try {
    await chrome.windows.update(state.windowId, { focused: true });
    await countBlocked();
  } catch (e) { /* focus window no longer exists */ }
});

chrome.windows.onRemoved.addListener(windowId => {
  mutate(st => {
    if (!st) return;
    if (st.windowId === windowId) { st.windowId = null; return st; }
    if (st.restWindowId === windowId) { st.restWindowId = null; return st; } // the rest itself carries on
  });
});

// A slot tab dragged out of the focus window goes straight back in.
chrome.tabs.onAttached.addListener((tabId, info) => {
  store.get('state').then(async ({ state = null }) => {
    if (!state || state.windowId == null || info.newWindowId === state.windowId || !slotOf(state, tabId)) return;
    try {
      await chrome.tabs.move(tabId, { windowId: state.windowId, index: -1 });
      await countBlocked();
    } catch (e) { /* focus window no longer exists */ }
  });
});

// ---------- restart recovery ----------

function sameSite(a, b) {
  const x = parseUrl(a);
  const y = parseUrl(b);
  if (!x || !y) return false;
  if (x.protocol === 'file:' || y.protocol === 'file:') return x.protocol === y.protocol && x.pathname === y.pathname;
  return x.hostname === y.hostname;
}

// After a browser restart tab and window ids are new. Re-link slots by URL; other tabs are left alone.
async function reconcile() {
  await mutate(async st => {
    if (!st) {
      await setBlocking(false);
      return;
    }
    const tabs = await chrome.tabs.query({});
    const used = new Set();
    const slots = { ...st.slots };

    for (const k of SLOTS) {
      if (slots[k] != null && !used.has(slots[k]) && tabs.some(t => t.id === slots[k])) {
        used.add(slots[k]);
        continue;
      }
      slots[k] = null;
      const last = st.lastUrls && st.lastUrls[k];
      const match = last && tabs.find(t => !used.has(t.id) && sameSite(t.url, last));
      if (match) { slots[k] = match.id; used.add(match.id); }
    }

    let windowId = null;
    if (slots.research == null) {
      allowCreateUntil = Date.now() + 3000;
      const win = await chrome.windows.create({ url: GOOGLE, state: 'maximized', focused: true });
      slots.research = win.tabs[0].id;
      windowId = win.id;
    } else {
      windowId = tabs.find(t => t.id === slots.research).windowId;
    }
    // Pull every slot tab into one window.
    for (const k of SLOTS) {
      const t = slots[k] != null && tabs.find(x => x.id === slots[k]);
      if (t && t.windowId !== windowId) await chrome.tabs.move(t.id, { windowId, index: -1 });
    }

    await setBlocking(true);
    await injectNotifyBlock(Object.values(slots).filter(v => v != null));
    return { ...st, slots, windowId, restWindowId: null };
  });
  await updateBadge();
  syncCompanion(true);
  checkRest();
}

chrome.runtime.onStartup.addListener(async () => {
  scheduleSync(5000);
  const { state = null } = await store.get('state');
  if (!state) {
    await setBlocking(false);
    syncCompanion(false);
    return;
  }
  // Give Brave time to restore the previous tabs before we look for the slot tabs.
  await store.set({ graceUntil: Date.now() + 30000 });
  chrome.alarms.create('reconcile', { when: Date.now() + 35000 });
  chrome.alarms.create('tick', { periodInMinutes: 1 });
});

chrome.runtime.onInstalled.addListener(async () => {
  scheduleSync(5000);
  const { state = null } = await store.get('state');
  if (state) chrome.alarms.create('tick', { periodInMinutes: 1 });
  else {
    await setBlocking(false);
    syncCompanion(false);
  }
  await updateBadge();
});

chrome.alarms.onAlarm.addListener(a => {
  if (a.name === 'rest-due' || a.name === 'rest-end') checkRest();
  if (a.name === 'sync' || a.name === 'sync-soon') syncNow();
  if (a.name === 'tick') {
    updateBadge();
    checkRest();
    store.get('state').then(({ state }) => { if (state) syncCompanion(true); });
  }
  if (a.name === 'reconcile') reconcile();
  if (a.name === 'bridge') connectBridge();
});

// ---------- desktop app bridge ----------
// A long-lived native port to the companion host, which relays to the desktop app.
// While the port is open Brave also keeps this service worker alive.

let bridge = null;

function sendApp(payload) {
  if (!bridge) return;
  try { bridge.postMessage({ type: 'app', payload }); } catch (e) { /* port just closed */ }
}

async function pushState() {
  const { state = null } = await store.get('state');
  const s = await getSettings();
  sendApp({ type: 'state', state, breaks: s.breaks });
}

async function pushProjects() {
  const { projects = [], lastProjectId = null } = await store.get(['projects', 'lastProjectId']);
  sendApp({ type: 'projects', projects, lastProjectId });
}

async function pushSessions() {
  const { sessions = [] } = await store.get('sessions');
  sendApp({ type: 'sessions', sessions });
}

function connectBridge() {
  if (bridge) return;
  let port;
  try {
    port = chrome.runtime.connectNative(COMPANION);
  } catch (e) {
    return; // companion not installed
  }
  bridge = port;
  port.onMessage.addListener(onAppMessage);
  port.onDisconnect.addListener(() => {
    void chrome.runtime.lastError; // read it so Brave doesn't log "unchecked" errors
    if (bridge === port) bridge = null;
  });
  port.postMessage({ type: 'bridge-hello' });
  pushState();
  pushSessions();
  pushProjects();
}

async function listTabs() {
  const s = await getSettings();
  const tabs = (await chrome.tabs.query({})).filter(t => !(t.url || '').startsWith('chrome-extension://'));
  // Same guesses as the popup: music by allowlist, work by PDF/file, research by the active tab.
  const guess = { music: null, research: null, work: null };
  const free = () => tabs.filter(t => !Object.values(guess).includes(t.id));
  guess.music = (free().find(t => hostMatches(hostOf(t.url), s.musicAllow)) || {}).id ?? null;
  guess.work = (free().find(t => /^file:/.test(t.url || '') || /\.pdf($|\?)/i.test(t.url || '')) || {}).id ?? null;
  const active = free().find(t => t.active && /^https?:/.test(t.url || '') && isAllowed('research', t.url, null, s));
  guess.research = active ? active.id : null;
  return {
    ok: true,
    guess,
    tabs: tabs.map(t => ({ id: t.id, title: t.title || 'Untitled', host: hostOf(t.url) || 'page' }))
  };
}

async function editSession(id, change) {
  let found = false;
  await mutate(async () => { // runs inside the same queue as endSession, so writes can't interleave
    const { sessions = [] } = await store.get('sessions');
    const next = change(sessions);
    found = next.found;
    if (found) await store.set({ sessions: next.sessions });
  });
  return found ? { ok: true } : fail('Session not found.');
}

async function handleAppCmd(m) {
  switch (m.cmd) {
    case 'start': return startSession({ name: m.name, planned: m.planned, picks: m.picks || {}, projectId: m.projectId || null });
    case 'pause': return pauseSession();
    case 'resume': return resumeSession();
    case 'end': return endSession(!!m.early);
    case 'discard': return endSession(false, true);
    case 'openSlot': return openSlot(m.slot, m.url);
    case 'listTabs': return listTabs();
    case 'skipRest': return skipRest(m.snoozeMinutes);
    case 'createProject': return createProject(m.name, m.parentId);
    case 'renameProject': return renameProject(m.id, m.name);
    case 'moveProject': return moveProject(m.id, m.parentId);
    case 'deleteProject': return deleteProject(m.id);
    case 'setSessionProject': return setSessionProject(m.sessionId, m.projectId);
    case 'rename':
      return editSession(m.id, list => {
        const s = list.find(x => x.id === m.id);
        if (s) s.name = String(m.name || '').trim().slice(0, 120) || 'Focus session';
        return { found: !!s, sessions: list };
      });
    case 'delete':
      return editSession(m.id, list => ({ found: list.some(x => x.id === m.id), sessions: list.filter(x => x.id !== m.id) }));
    default: return fail('Unknown command.');
  }
}

async function onAppMessage(msg) {
  if (!msg || msg.type !== 'app' || !msg.payload) return;
  const m = msg.payload;
  if (m.type === 'request-sync') {
    pushState();
    pushSessions();
    pushProjects();
    return;
  }
  if (m.type !== 'cmd') return;
  let result;
  try { result = await handleAppCmd(m); } catch (e) { result = fail(String((e && e.message) || e)); }
  sendApp({ type: 'reply', id: m.id, result });
}

// Keep the app's view current whenever the stored data changes.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.state || changes.settings) pushState();
  if (changes.sessions) pushSessions();
  if ((changes.sessions || changes.projects) && !syncMerging) scheduleSync();
  if (changes.projects || changes.lastProjectId) pushProjects();
  if (changes.settings) scheduleRest();
});

// Alarms don't survive a browser restart, so (re)create this on every worker start.
ensureAlarm('bridge', { periodInMinutes: 1 });
connectBridge();

// ---------- cloud sync (see sync.js) ----------

// Sync soon (debounced by the alarm), but only if someone is signed in.
async function scheduleSync(delayMs = 10000) {
  const { syncAuth = null } = await store.get('syncAuth');
  if (syncAuth) chrome.alarms.create('sync-soon', { when: Date.now() + delayMs });
}

async function accountSignIn(msg) {
  const res = await syncSignIn(msg.email, msg.password, { create: !!msg.create, confirmSwitch: !!msg.confirmSwitch });
  if (res.ok && !res.needsConfirmation) res.sync = await syncNow();
  return res;
}

// Alarms don't survive a browser restart, so make sure they exist on every start. But never re-create
// one that is already running: creating an alarm with the same name restarts its countdown, and a
// worker that wakes up often would keep postponing it forever.
async function ensureAlarm(name, info) {
  const existing = await chrome.alarms.get(name);
  if (!existing) chrome.alarms.create(name, info);
}
ensureAlarm('sync', { periodInMinutes: 5 });

// ---------- messages from the popup ----------

async function handle(msg) {
  switch (msg.type) {
    case 'start': return startSession(msg);
    case 'pause': return pauseSession();
    case 'resume': return resumeSession();
    case 'end': return endSession(msg.early);
    case 'discard': return endSession(false, true);
    case 'openSlot': return openSlot(msg.slot, msg.url);
    case 'relockWork': return relockWork();
    case 'openApp': return openApp();
    case 'syncConfig': return syncSetConfig(msg.url, msg.anonKey);
    case 'syncSignIn': return accountSignIn(msg);
    case 'syncSignOut': return syncSignOut();
    case 'syncNow': return syncNow();
    case 'syncDevice': return syncSetDevice(msg.name);
    case 'skipRest': return skipRest(msg.snoozeMinutes);
    case 'createProject': return createProject(msg.name, msg.parentId);
    case 'renameProject': return renameProject(msg.id, msg.name);
    case 'moveProject': return moveProject(msg.id, msg.parentId);
    case 'deleteProject': return deleteProject(msg.id);
    case 'setSessionProject': return setSessionProject(msg.sessionId, msg.projectId);
    default: return fail('Unknown message.');
  }
}

chrome.runtime.onMessage.addListener((msg, sender, send) => {
  if (sender.id !== chrome.runtime.id) return;
  handle(msg).then(send).catch(e => send(fail(String((e && e.message) || e))));
  return true;
});
