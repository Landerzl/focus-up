const $ = id => document.getElementById(id);

function el(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  Object.assign(e, props);
  e.append(...kids);
  return e;
}

let sessions = [];
let projects = [];
let projectFilter = ''; // '' = all, 'none' = no project, else a project id (and its subprojects)
let view = new Date();
view.setDate(1);
let selected = dateKey(new Date());

// ---------- data ----------

async function loadSessions() {
  const d = await chrome.storage.local.get(['sessions', 'projects']);
  sessions = d.sessions || [];
  projects = d.projects || [];
}

function deviceNames() {
  return new Set(sessions.map(s => s.device).filter(Boolean));
}

function visibleSessions() {
  if (!projectFilter) return sessions;
  if (projectFilter === 'none') return sessions.filter(s => !projects.some(p => p.id === s.projectId));
  const ids = descendantIds(projects, projectFilter);
  return sessions.filter(s => ids.has(s.projectId));
}

async function saveSessions() {
  await chrome.storage.local.set({ sessions });
}

function byDay() {
  const map = new Map();
  for (const s of visibleSessions()) {
    const k = dateKey(new Date(s.start));
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(s);
  }
  return map;
}

const dayTotal = list => (list || []).reduce((sum, s) => sum + s.activeSeconds, 0);

// ---------- stats ----------

function renderStats() {
  const days = byDay();
  const now = new Date();
  const weekStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7));
  let week = 0;
  for (let i = 0; i < 7; i++) {
    const d = new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() + i);
    week += dayTotal(days.get(dateKey(d)));
  }
  const elapsed = ((now.getDay() + 6) % 7) + 1;

  // Streak counts back from today, or from yesterday if today has no session yet.
  let streak = 0;
  const cursor = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (!days.has(dateKey(cursor))) cursor.setDate(cursor.getDate() - 1);
  while (days.has(dateKey(cursor))) {
    streak++;
    cursor.setDate(cursor.getDate() - 1);
  }

  const vs = visibleSessions();
  const longest = vs.reduce((m, s) => Math.max(m, s.activeSeconds), 0);
  const tiles = [
    ['This week', fmtDuration(week)],
    ['Daily average', fmtDuration(Math.round(week / elapsed))],
    ['Streak', `${streak} day${streak === 1 ? '' : 's'}`],
    ['Longest session', fmtDuration(longest)],
    ['Sessions', String(vs.length)]
  ];
  $('stats').textContent = '';
  for (const [k, v] of tiles) {
    $('stats').appendChild(el('div', { className: 'stat' }, el('div', { className: 'v', textContent: v }), el('div', { className: 'k', textContent: k })));
  }
}

// ---------- calendar ----------

function level(sec) {
  if (sec <= 0) return 0;
  if (sec < 1800) return 1;
  if (sec < 3600) return 2;
  if (sec < 7200) return 3;
  return 4;
}

function renderCalendar() {
  $('monthLabel').textContent = view.toLocaleDateString([], { month: 'long', year: 'numeric' });
  const days = byDay();
  const cal = $('cal');
  cal.textContent = '';
  for (const d of ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']) cal.appendChild(el('div', { className: 'dow', textContent: d }));

  const lead = (view.getDay() + 6) % 7;
  for (let i = 0; i < lead; i++) cal.appendChild(el('div', { className: 'day blank' }));

  const count = new Date(view.getFullYear(), view.getMonth() + 1, 0).getDate();
  const todayKey = dateKey(new Date());
  for (let n = 1; n <= count; n++) {
    const key = dateKey(new Date(view.getFullYear(), view.getMonth(), n));
    const total = dayTotal(days.get(key));
    const cell = el('button', { className: `day l${level(total)}` }, el('span', { className: 'n', textContent: String(n) }), el('span', { className: 't', textContent: total ? fmtDuration(total) : '' }));
    if (key === todayKey) cell.classList.add('today');
    if (key === selected) cell.classList.add('sel');
    cell.addEventListener('click', () => {
      selected = key;
      renderCalendar();
      renderDay();
    });
    cal.appendChild(cell);
  }
}

function renderDay() {
  const panel = $('dayPanel');
  panel.textContent = '';
  const [y, m, d] = selected.split('-').map(Number);
  const list = (byDay().get(selected) || []).sort((a, b) => a.start.localeCompare(b.start));
  panel.appendChild(el('h3', { textContent: new Date(y, m - 1, d).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' }) + (list.length ? ` · ${fmtDuration(dayTotal(list))}` : '') }));
  if (!list.length) {
    panel.appendChild(el('p', { className: 'muted', textContent: 'No sessions this day.' }));
    return;
  }
  const time = iso => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  for (const s of list) {
    const name = el('input', { type: 'text', value: s.name, maxLength: 120 });
    name.addEventListener('change', async () => {
      s.name = name.value.trim() || 'Focus session';
      await saveSessions();
    });
    const del = el('button', { className: 'danger small', textContent: 'Delete' });
    del.addEventListener('click', async () => {
      if (!confirm(`Delete "${s.name}"?`)) return;
      sessions = sessions.filter(x => x.id !== s.id);
      await saveSessions();
      renderAll();
    });
    const bits = [
      `${time(s.start)}–${time(s.end)}`,
      fmtDuration(s.activeSeconds),
      `${s.blockedAttempts} blocked attempt${s.blockedAttempts === 1 ? '' : 's'}`
    ];
    if (s.device && deviceNames().size > 1) bits.push(s.device);
    if (s.breaks) bits.push(`${s.breaks} rest${s.breaks === 1 ? '' : 's'}`);
    if (s.endedEarly) bits.push('ended early');
    const proj = el('select', { className: 'proj', title: 'Project for this session' });
    fillProjectSelect(proj, { none: '— no project —', value: s.projectId || '' });
    proj.addEventListener('change', async () => {
      const res = await send({ type: 'setSessionProject', sessionId: s.id, projectId: proj.value || null });
      if (!res.ok) alert(res.error);
    });
    panel.appendChild(el('div', { className: 'session' }, name, del, el('div', { className: 'meta', textContent: bits.join(' · ') }), proj));
  }
}

function renderAll() {
  renderFilter();
  renderProjects();
  renderStats();
  renderCalendar();
  renderDay();
}

$('prev').addEventListener('click', () => { view.setMonth(view.getMonth() - 1); renderCalendar(); });
$('next').addEventListener('click', () => { view.setMonth(view.getMonth() + 1); renderCalendar(); });
$('today').addEventListener('click', () => {
  view = new Date();
  view.setDate(1);
  selected = dateKey(new Date());
  renderCalendar();
  renderDay();
});

// ---------- projects ----------

const send = msg => chrome.runtime.sendMessage(msg);
const indent = depth => '\u00a0\u00a0'.repeat(depth) + (depth ? '↳ ' : '');

function fillProjectSelect(sel, { none, exclude = new Set(), value = '' }) {
  sel.textContent = '';
  sel.appendChild(new Option(none, ''));
  for (const { project, depth } of flattenProjects(projects)) {
    if (!exclude.has(project.id)) sel.appendChild(new Option(indent(depth) + project.name, project.id));
  }
  sel.value = projects.some(p => p.id === value) ? value : '';
}

function renderFilter() {
  const sel = $('projectFilter');
  const want = projectFilter;
  fillProjectSelect(sel, { none: 'All projects' });
  sel.insertBefore(new Option('No project', 'none'), sel.children[1] || null);
  if (want === 'none' || projects.some(p => p.id === want)) {
    sel.value = want;
  } else {
    projectFilter = '';
    sel.value = '';
  }
}
$('projectFilter').addEventListener('change', e => {
  projectFilter = e.target.value;
  renderAll();
});

async function projectAction(msg) {
  const res = await send(msg);
  $('projectMsg').textContent = res.ok ? '' : res.error;
  return res;
}

function pickProject(title, exclude, current) {
  return new Promise(resolve => {
    const dlg = $('pickDialog');
    $('pickTitle').textContent = title;
    fillProjectSelect($('pickSelect'), { none: '— top level —', exclude, value: current || '' });
    const done = v => { dlg.close(); resolve(v); };
    $('pickOk').onclick = () => done($('pickSelect').value);
    $('pickCancel').onclick = () => done(null);
    dlg.oncancel = () => resolve(null); // Esc
    dlg.showModal();
  });
}

function renderProjects() {
  const box = $('projectTree');
  box.textContent = '';
  if (!projects.length) {
    box.appendChild(el('p', { className: 'muted', textContent: 'No projects yet. Add one above, then pick it when you start a session.' }));
    return;
  }
  const now = new Date();
  const weekStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7));
  const all = projectTotals(projects, sessions);
  const week = projectTotals(projects, sessions, s => new Date(s.start) >= weekStart);

  for (const { project: p, depth } of flattenProjects(projects)) {
    const t = all.get(p.id);
    const kids = projects.filter(x => x.parentId === p.id).length;
    const row = el('div', { className: 'proj-row' });
    row.style.paddingLeft = depth * 22 + 'px';
    const nums = `${fmtDuration(t.total)} total · ${fmtDuration(week.get(p.id).total)} this week` + (kids && t.own ? ` · ${fmtDuration(t.own)} own` : '');
    const btn = (text, onclick, cls = '') => {
      const b = el('button', { type: 'button', textContent: text, className: cls });
      b.addEventListener('click', onclick);
      return b;
    };
    row.append(
      el('span', { className: 'proj-name', textContent: p.name }),
      el('span', { className: 'nums muted small', textContent: nums }),
      btn('+ Sub', async () => {
        const name = prompt(`New subproject of "${p.name}":`);
        if (name) await projectAction({ type: 'createProject', name, parentId: p.id });
      }),
      btn('Rename', async () => {
        const name = prompt('Rename project:', p.name);
        if (name) await projectAction({ type: 'renameProject', id: p.id, name });
      }),
      btn('Move', async () => {
        const dest = await pickProject(`Move "${p.name}" to:`, descendantIds(projects, p.id), p.parentId);
        if (dest !== null) await projectAction({ type: 'moveProject', id: p.id, parentId: dest || null });
      }),
      btn('Delete', async () => {
        const up = p.parentId ? `"${projects.find(x => x.id === p.parentId)?.name}"` : 'no project';
        const n = sessions.filter(s => s.projectId === p.id).length;
        if (!confirm(`Delete "${p.name}"?\n\nIts ${kids} subproject(s) and ${n} session(s) move up to ${up}. No time is lost.`)) return;
        await projectAction({ type: 'deleteProject', id: p.id });
      }, 'danger')
    );
    box.appendChild(row);
  }
}

async function addTopLevelProject() {
  const input = $('newProjectName');
  const res = await projectAction({ type: 'createProject', name: input.value, parentId: null });
  if (res.ok) input.value = '';
}
$('addProject').addEventListener('click', addTopLevelProject);
$('newProjectName').addEventListener('keydown', e => { if (e.key === 'Enter') addTopLevelProject(); });

// Used by import: accept only well-formed projects, then break any cycle or dangling parent.
function cleanProject(p) {
  if (!p || typeof p.id !== 'string' || !p.id) return null;
  const name = cleanProjectName(p.name);
  if (!name) return null;
  return { id: p.id.slice(0, 64), name, parentId: typeof p.parentId === 'string' && p.parentId ? p.parentId.slice(0, 64) : null, createdAt: Number(p.createdAt) || Date.now() };
}

function repairProjects(list) {
  const byId = new Map(list.map(p => [p.id, p]));
  const fixed = list.map(p => ({ ...p, parentId: byId.has(p.parentId) ? p.parentId : null }));
  const parentOf = new Map(fixed.map(p => [p.id, p.parentId]));
  for (const p of fixed) {
    const seen = new Set([p.id]);
    for (let cur = parentOf.get(p.id); cur; cur = parentOf.get(cur)) {
      if (seen.has(cur)) { parentOf.set(p.id, null); break; } // cycle: cut it here
      seen.add(cur);
    }
  }
  return fixed.map(p => ({ ...p, parentId: parentOf.get(p.id) }));
}

// ---------- export / import ----------

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = el('a', { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function csvCell(v) {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // stop spreadsheet formula injection
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

$('exportJson').addEventListener('click', () => {
  download(`focus-up-${dateKey(new Date())}.json`, JSON.stringify({ app: 'focus-up', version: 2, projects, sessions }, null, 2), 'application/json');
});

$('exportCsv').addEventListener('click', () => {
  const head = ['id', 'name', 'start', 'end', 'activeSeconds', 'endedEarly', 'blockedAttempts', 'plannedMinutes', 'music', 'research', 'work', 'project'];
  const rows = sessions.map(s => [s.id, s.name, s.start, s.end, s.activeSeconds, s.endedEarly, s.blockedAttempts, s.plannedMinutes || 0, s.slots?.music, s.slots?.research, s.slots?.work, projectPath(projects, s.projectId)]);
  download(`focus-up-${dateKey(new Date())}.csv`, [head, ...rows].map(r => r.map(csvCell).join(',')).join('\n'), 'text/csv');
});

function cleanSession(s) {
  if (!s || typeof s.start !== 'string' || typeof s.end !== 'string') return null;
  if (isNaN(Date.parse(s.start)) || isNaN(Date.parse(s.end))) return null;
  const secs = Number(s.activeSeconds);
  if (!Number.isFinite(secs) || secs < 0) return null;
  const slots = {};
  for (const k of ['music', 'research', 'work']) if (s.slots && typeof s.slots[k] === 'string') slots[k] = s.slots[k].slice(0, 300);
  return {
    id: typeof s.id === 'string' && s.id ? s.id.slice(0, 64) : crypto.randomUUID(),
    name: String(s.name || 'Focus session').slice(0, 120),
    start: new Date(s.start).toISOString(),
    end: new Date(s.end).toISOString(),
    activeSeconds: Math.floor(secs),
    pauses: Array.isArray(s.pauses) ? s.pauses.filter(p => p && !isNaN(Date.parse(p.start)) && !isNaN(Date.parse(p.end))).map(p => ({ start: p.start, end: p.end })) : [],
    endedEarly: !!s.endedEarly,
    blockedAttempts: Math.max(0, Math.floor(Number(s.blockedAttempts) || 0)),
    plannedMinutes: Math.max(0, Math.floor(Number(s.plannedMinutes) || 0)),
    projectId: typeof s.projectId === 'string' && s.projectId ? s.projectId.slice(0, 64) : null,
    device: typeof s.device === 'string' && s.device ? s.device.slice(0, 40) : undefined,
    breaks: Math.max(0, Math.floor(Number(s.breaks) || 0)),
    skippedBreaks: Math.max(0, Math.floor(Number(s.skippedBreaks) || 0)),
    slots
  };
}

$('importFile').addEventListener('change', async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const incoming = (Array.isArray(data) ? data : data.sessions || []).map(cleanSession).filter(Boolean);
    const ids = new Set(sessions.map(s => s.id));
    const fresh = incoming.filter(s => !ids.has(s.id));
    sessions = [...sessions, ...fresh];
    const knownProjects = new Set(projects.map(p => p.id));
    const newProjects = (Array.isArray(data.projects) ? data.projects : []).map(cleanProject).filter(p => p && !knownProjects.has(p.id));
    projects = repairProjects([...projects, ...newProjects]);
    const valid = new Set(projects.map(p => p.id));
    sessions = sessions.map(s => (s.projectId && !valid.has(s.projectId) ? { ...s, projectId: null } : s));
    await chrome.storage.local.set({ sessions, projects });
    renderAll();
    $('ioMsg').textContent = `Imported ${fresh.length} session${fresh.length === 1 ? '' : 's'}` + (incoming.length - fresh.length ? ` (${incoming.length - fresh.length} already present)` : '') + '.';
  } catch (err) {
    $('ioMsg').textContent = 'Could not read that file.';
  }
});

$('openAppDash').addEventListener('click', async () => {
  const res = await send({ type: 'openApp' });
  if (!res.ok) alert(res.error);
});

// ---------- account / cloud sync ----------

function timeAgo(ms) {
  if (!ms) return 'never';
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

let syncBusy = false;

async function renderAccount() {
  const d = await chrome.storage.local.get(['syncConfig', 'syncAuth', 'syncMeta']);
  const cfg = d.syncConfig, auth = d.syncAuth, meta = d.syncMeta || {};
  if (cfg && document.activeElement !== $('sbUrl')) $('sbUrl').value = cfg.url;
  if (cfg && document.activeElement !== $('sbKey')) $('sbKey').value = cfg.anonKey;
  $('acctLogin').hidden = !cfg || !!auth;
  $('acctIn').hidden = !auth;
  if (auth) {
    $('acctEmail').textContent = auth.email;
    if (document.activeElement !== $('deviceName')) $('deviceName').value = meta.deviceName || '';
    $('syncStatus').textContent = meta.lastError
      ? `Last sync failed: ${meta.lastError}`
      : `Last synced ${timeAgo(meta.lastSync)}. It also syncs by itself every few minutes and after each change.`;
    $('syncStatus').classList.toggle('error', !!meta.lastError);
  } else if (meta.lastError && cfg) {
    $('loginMsg').textContent = $('loginMsg').textContent || meta.lastError;
  }
  $('syncNowBtn').disabled = syncBusy;
}

$('sbSave').addEventListener('click', async () => {
  const res = await send({ type: 'syncConfig', url: $('sbUrl').value, anonKey: $('sbKey').value });
  $('sbMsg').textContent = res.ok ? '' : res.error;
  if (res.ok) renderAccount();
});

async function accountSignIn(create) {
  const email = $('acctEmailInput').value.trim();
  const password = $('acctPassword').value;
  $('loginMsg').classList.add('error');
  $('loginMsg').textContent = '';
  let res = await send({ type: 'syncSignIn', email, password, create });
  if (res.needsSwitchConfirm && confirm(`${res.error}\n\nContinue?`)) {
    res = await send({ type: 'syncSignIn', email, password, create, confirmSwitch: true });
  }
  $('acctPassword').value = '';
  if (res.ok && res.needsConfirmation) {
    $('loginMsg').classList.remove('error');
    $('loginMsg').textContent = res.message;
  } else if (!res.ok) {
    $('loginMsg').textContent = res.error;
  } else {
    $('syncMsg').textContent = res.sync && res.sync.ok ? `Signed in. Downloaded ${res.sync.pulled}, uploaded ${res.sync.pushed}.` : (res.sync && res.sync.error) || '';
  }
  renderAccount();
}
$('acctSignIn').addEventListener('click', () => accountSignIn(false));
$('acctCreate').addEventListener('click', () => accountSignIn(true));
$('acctPassword').addEventListener('keydown', e => { if (e.key === 'Enter') accountSignIn(false); });

$('syncNowBtn').addEventListener('click', async () => {
  syncBusy = true;
  $('syncNowBtn').disabled = true;
  $('syncMsg').textContent = 'Syncing…';
  const res = await send({ type: 'syncNow' });
  syncBusy = false;
  $('syncMsg').textContent = res.ok ? `Done. Downloaded ${res.pulled}, uploaded ${res.pushed}.` : res.error;
  renderAccount();
});

$('deviceSave').addEventListener('click', async () => {
  const res = await send({ type: 'syncDevice', name: $('deviceName').value });
  $('syncMsg').textContent = res.ok ? 'Saved.' : res.error;
});

$('acctSignOut').addEventListener('click', async () => {
  if (!confirm('Sign out? Your sessions and projects stay on this computer; syncing stops until you sign in again.')) return;
  await send({ type: 'syncSignOut' });
  $('syncMsg').textContent = '';
  renderAccount();
});

// ---------- tabs ----------

for (const b of document.querySelectorAll('nav button')) {
  b.addEventListener('click', () => {
    for (const x of document.querySelectorAll('nav button')) x.classList.toggle('on', x === b);
    $('tab-calendar').hidden = b.dataset.tab !== 'calendar';
    $('tab-projects').hidden = b.dataset.tab !== 'projects';
    $('tab-account').hidden = b.dataset.tab !== 'account';
    $('tab-settings').hidden = b.dataset.tab !== 'settings';
  });
}

// ---------- settings ----------

const LIST_FIELDS = ['musicAllow', 'blocklist', 'blockExceptions', 'workAllow', 'blockedApps'];

function cleanDomain(line) {
  return line.trim().toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/^www\./, '').split('/')[0];
}

async function loadSettings() {
  const s = await getSettings();
  for (const k of LIST_FIELDS) $(k).value = s[k].join('\n');
  $('brEnabled').checked = s.breaks.enabled;
  $('brWork').value = s.breaks.work;
  $('brRest').value = s.breaks.rest;
  $('brLongRest').value = s.breaks.longRest;
  $('brLongEvery').value = s.breaks.longEvery;
  const { state = null } = await chrome.storage.local.get('state');
  $('lockNote').hidden = !state;
  $('settingsForm').classList.toggle('locked', !!state);
}

$('settingsForm').addEventListener('submit', async e => {
  e.preventDefault();
  const settings = {};
  for (const k of LIST_FIELDS) {
    const lines = $(k).value.split('\n').map(l => k === 'blockedApps' ? l.trim() : cleanDomain(l)).filter(Boolean);
    settings[k] = [...new Set(lines)];
  }
  settings.breaks = clampBreaks({
    enabled: $('brEnabled').checked,
    work: $('brWork').value,
    rest: $('brRest').value,
    longRest: $('brLongRest').value,
    longEvery: $('brLongEvery').value
  });
  await chrome.storage.local.set({ settings });
  await loadSettings();
  $('saveMsg').textContent = 'Saved.';
  setTimeout(() => { $('saveMsg').textContent = ''; }, 2000);
});

for (const b of document.querySelectorAll('.presets button')) {
  b.addEventListener('click', () => {
    $('brWork').value = b.dataset.work;
    $('brRest').value = b.dataset.rest;
    $('brLongRest').value = b.dataset.long;
  });
}

$('resetSettings').addEventListener('click', async () => {
  if (!confirm('Reset all settings to the defaults?')) return;
  await chrome.storage.local.remove('settings');
  await loadSettings();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.sessions || changes.projects) loadSessions().then(renderAll);
  if (changes.state) loadSettings();
  if (changes.syncAuth || changes.syncMeta || changes.syncConfig) renderAccount();
});

(async () => {
  await loadSessions();
  renderAll();
  await loadSettings();
  await renderAccount();
})();
