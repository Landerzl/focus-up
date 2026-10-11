const $ = id => document.getElementById(id);
const send = msg => chrome.runtime.sendMessage(msg);
const EARLY_PHRASE = 'I am choosing to end my focus early';
const SLOT_DEFAULT_URL = {
  music: 'https://open.spotify.com',
  research: 'https://www.google.com',
  work: ''
};

let state = null;
let settings = null;
let companion = null;
let idleBuilt = false;
let allTabs = [];
let projects = [];
let lastProjectId = null;
let chosenProject = null; // null until the user (or the last-used default) picks one
let newParent = null; // parent for the project being created

async function load() {
  const d = await chrome.storage.local.get(['state', 'companion', 'projects', 'lastProjectId', 'syncConfig', 'syncAuth', 'syncMeta']);
  state = d.state || null;
  companion = d.companion || null;
  projects = d.projects || [];
  lastProjectId = d.lastProjectId || null;
  const line = $('syncLine');
  const meta = d.syncMeta || {};
  line.hidden = !d.syncConfig;
  if (d.syncConfig) {
    line.textContent = !d.syncAuth ? 'Cloud sync: not signed in'
      : meta.lastError ? 'Cloud sync problem: ' + meta.lastError
      : `Cloud sync on · ${d.syncAuth.email}`;
  }
  settings = await getSettings();
  await render();
}

async function render() {
  $('idle').hidden = !!state;
  $('active').hidden = !state;
  if (state) {
    idleBuilt = false;
    renderActive();
  } else {
    await renderIdle();
  }
}

// ---------- idle ----------

function showError(id, msg) {
  const e = $(id);
  e.hidden = !msg;
  e.textContent = msg || '';
}

function trunc(s, n) {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function renderProjectSelect() {
  const sel = $('sel-project');
  sel.textContent = '';
  sel.appendChild(new Option('— no project —', ''));
  for (const { project, depth } of flattenProjects(projects)) {
    sel.appendChild(new Option('\u00a0\u00a0'.repeat(depth) + (depth ? '↳ ' : '') + project.name, project.id));
  }
  // First time: continue where the last session left off.
  if (chosenProject === null) chosenProject = projects.some(p => p.id === lastProjectId) ? lastProjectId : '';
  sel.value = projects.some(p => p.id === chosenProject) ? chosenProject : '';
  sel.title = sel.value ? projectPath(projects, sel.value) : '';
  $('newSub').disabled = !sel.value;
}

function openProjectForm(parentId) {
  newParent = parentId;
  const parent = parentId && projects.find(p => p.id === parentId);
  $('projectName').placeholder = parent ? `Subproject of ${parent.name}` : 'New project name';
  $('projectForm').hidden = false;
  $('projectName').focus();
}

async function createProject() {
  const res = await send({ type: 'createProject', name: $('projectName').value, parentId: newParent });
  if (!res.ok) return showError('idleError', res.error);
  chosenProject = res.id; // select what was just created
  await load(); // re-read so the new project is in the list and selected
  $('projectName').value = '';
  $('projectForm').hidden = true;
  showError('idleError', '');
}

$('sel-project').addEventListener('change', e => {
  chosenProject = e.target.value;
  e.target.title = chosenProject ? projectPath(projects, chosenProject) : '';
  $('newSub').disabled = !chosenProject;
  $('projectForm').hidden = true;
});
$('newProject').addEventListener('click', () => openProjectForm(null));
$('newSub').addEventListener('click', () => openProjectForm($('sel-project').value || null));
$('projectCreate').addEventListener('click', createProject);
$('projectName').addEventListener('keydown', e => { if (e.key === 'Enter') createProject(); });

async function renderIdle() {
  renderProjectSelect();
  if (idleBuilt) return;
  idleBuilt = true;

  const [current] = await chrome.tabs.query({ active: true, currentWindow: true });
  allTabs = (await chrome.tabs.query({})).filter(t => !(t.url || '').startsWith('chrome-extension://'));

  const guess = { music: null, research: null, work: null };
  const free = () => allTabs.filter(t => !Object.values(guess).includes(t.id));
  guess.music = (free().find(t => hostMatches(hostOf(t.url), settings.musicAllow)) || {}).id ?? null;
  guess.work = (free().find(t => /^file:/.test(t.url || '') || /\.pdf($|\?)/i.test(t.url || '')) || {}).id ?? null;
  if (current && !Object.values(guess).includes(current.id) && /^https?:/.test(current.url || '')
      && isAllowed('research', current.url, null, settings)) {
    guess.research = current.id;
  }

  for (const k of ['research', 'work', 'music']) {
    const sel = $('sel-' + k);
    sel.textContent = '';
    const none = document.createElement('option');
    none.value = '';
    none.textContent = k === 'research' ? '— open a new Google tab —' : '— none (open later) —';
    sel.appendChild(none);
    for (const t of allTabs) {
      const o = document.createElement('option');
      o.value = String(t.id);
      o.textContent = `${trunc(t.title || 'Untitled', 30)} · ${hostOf(t.url) || 'page'}`;
      sel.appendChild(o);
    }
    sel.value = guess[k] != null ? String(guess[k]) : '';
    sel.onchange = () => showError('idleError', '');
  }
}

function picks() {
  const out = {};
  for (const k of ['research', 'work', 'music']) {
    const v = $('sel-' + k).value;
    out[k] = v === '' ? null : Number(v);
  }
  return out;
}

$('start').addEventListener('click', async () => {
  $('start').disabled = true;
  const res = await send({ type: 'start', name: $('name').value, planned: $('planned').value, picks: picks(), projectId: chosenProject || null });
  $('start').disabled = false;
  if (!res.ok) showError('idleError', res.error);
});

for (const id of ['openDash', 'openDashActive']) $(id).addEventListener('click', () => chrome.runtime.openOptionsPage());
for (const id of ['openApp', 'openAppActive']) {
  $(id).addEventListener('click', async () => {
    const res = await send({ type: 'openApp' });
    showError(state ? 'activeError' : 'idleError', res.ok ? '' : res.error);
    if (res.ok) window.close();
  });
}

// ---------- active ----------

function renderActive() {
  $('sName').textContent = state.name || 'Focus session';
  $('sProject').textContent = state.projectId ? projectPath(projects, state.projectId) : '';
  $('attempts').textContent = `Blocked attempts: ${state.blockedAttempts}`;
  const c = $('companion');
  if (!companion) c.textContent = 'Windows companion: checking…';
  else if (!companion.ok) c.textContent = 'Windows companion not connected (browser-only mode)';
  else c.textContent = 'Windows notifications off' + (companion.closed.length ? ' · closed ' + companion.closed.join(', ') : '');
  c.title = companion && !companion.ok ? companion.error : '';
  $('goal').textContent = state.plannedMinutes ? `Goal: ${state.plannedMinutes} min` : '';
  $('pause').textContent = state.pausedAt != null ? 'Resume' : 'Pause';
  $('pause').hidden = !!state.rest;
  $('skipRest').hidden = !state.rest;
  tick();
  if (!(document.activeElement && document.activeElement.closest('#slots'))) renderSlots();
}

function tick() {
  if (!state) return;
  const sec = activeSeconds(state);
  const timer = $('timer');
  timer.textContent = fmtClock(sec);
  timer.classList.toggle('paused', state.pausedAt != null);
  const plan = breakPlan(state, settings.breaks);
  let phase = '';
  if (plan.inRest) phase = `${plan.isLong ? 'Long rest' : 'Rest'}: ${fmtMS(plan.restLeft)} left`;
  else if (state.pausedAt != null) phase = 'Paused (restrictions still on)';
  else if (plan.enabled) phase = `Next rest in ${fmtMS(plan.dueIn)}`;
  $('phase').textContent = phase;
}
setInterval(tick, 1000);

function renderSlots() {
  const box = $('slots');
  box.textContent = '';
  for (const k of SLOTS) {
    const row = document.createElement('div');
    row.className = 'slot';
    const head = document.createElement('div');
    head.className = 'head';
    const label = document.createElement('strong');
    label.textContent = SLOT_LABELS[k];
    const status = document.createElement('span');
    status.className = 'tag';
    head.append(label, status);
    row.appendChild(head);

    if (state.slots[k] != null) {
      const last = state.lastUrls && state.lastUrls[k];
      status.textContent = k === 'work' && state.workLock
        ? 'locked to ' + (state.workLock.kind === 'file' ? 'this file' : state.workLock.host)
        : hostOf(last || '') || 'open';
      if (k === 'work') {
        const b = document.createElement('button');
        b.className = 'small';
        b.textContent = 'Lock Work to its current page';
        b.addEventListener('click', async () => {
          const res = await send({ type: 'relockWork' });
          showError('activeError', res.ok ? '' : res.error);
        });
        row.appendChild(b);
      }
    } else {
      status.textContent = 'empty';
      const line = document.createElement('div');
      line.className = 'row';
      const input = document.createElement('input');
      input.type = 'url';
      input.placeholder = 'https://…';
      input.value = SLOT_DEFAULT_URL[k];
      const open = document.createElement('button');
      open.textContent = 'Open';
      open.addEventListener('click', async () => {
        const res = await send({ type: 'openSlot', slot: k, url: input.value.trim() });
        showError('activeError', res.ok ? '' : res.error);
      });
      line.append(input, open);
      row.appendChild(line);
    }
    box.appendChild(row);
  }
}

$('skipRest').addEventListener('click', () => send({ type: 'skipRest', snoozeMinutes: 0 }));
$('pause').addEventListener('click', () => send({ type: state.pausedAt != null ? 'resume' : 'pause' }));

$('end').addEventListener('click', () => {
  resetDiscard();
  const sec = activeSeconds(state);
  const early = state.plannedMinutes && sec < state.plannedMinutes * 60;
  $('endBox').hidden = false;
  $('endPhrase').hidden = !early;
  $('endPhrase').value = '';
  $('endConfirm').disabled = !!early;
  $('endMsg').textContent = early
    ? `You planned ${state.plannedMinutes} min and are at ${fmtDuration(sec)}. To end early, type: "${EARLY_PHRASE}"`
    : `End this session at ${fmtDuration(sec)}?`;
  $('endBox').dataset.early = early ? '1' : '';
});

$('endPhrase').addEventListener('input', () => {
  $('endConfirm').disabled = $('endPhrase').value.trim().toLowerCase() !== EARLY_PHRASE.toLowerCase();
});

$('endCancel').addEventListener('click', () => { $('endBox').hidden = true; resetDiscard(); });

// Discard: stop the session and save nothing. A session with real work in it needs a second click.
let discardArmed = false;
function resetDiscard() {
  discardArmed = false;
  $('endDiscard').textContent = 'Discard';
}
$('endDiscard').addEventListener('click', async () => {
  const sec = activeSeconds(state);
  if (sec >= 300 && !discardArmed) {
    discardArmed = true;
    $('endDiscard').textContent = `Really discard ${fmtDuration(sec)} of work?`;
    return;
  }
  resetDiscard();
  const res = await send({ type: 'discard' });
  $('endBox').hidden = true;
  if (!res.ok) showError('activeError', res.error);
});

$('endConfirm').addEventListener('click', async () => {
  const res = await send({ type: 'end', early: !!$('endBox').dataset.early });
  $('endBox').hidden = true;
  if (!res.ok) showError('activeError', res.error);
});

chrome.storage.onChanged.addListener(load);
load();
