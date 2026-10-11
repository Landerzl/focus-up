const $ = id => document.getElementById(id);
const TIPS = [
  'Stand up and walk around for a minute.',
  'Look at something about 6 m (20 ft) away for 20 seconds.',
  'Drink some water.',
  'Roll your shoulders and stretch your neck and wrists.',
  'Step away from screens: no phone, no feeds.',
  'Breathe slowly: in for 4, out for 6, a few times.'
];

let state = null;
let chimedStart = false;
let finished = false;

// Best-effort chime. Browsers may keep audio muted until you interact with the page.
function chime() {
  try {
    const ctx = new AudioContext();
    const t = ctx.currentTime;
    for (const [freq, at] of [[660, 0], [880, 0.22], [1100, 0.44]]) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = freq;
      osc.connect(gain);
      gain.connect(ctx.destination);
      gain.gain.setValueAtTime(0.0001, t + at);
      gain.gain.exponentialRampToValueAtTime(0.18, t + at + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + at + 0.5);
      osc.start(t + at);
      osc.stop(t + at + 0.55);
    }
    if (ctx.resume) ctx.resume();
  } catch (e) { /* no audio available */ }
}

async function load() {
  const d = await chrome.storage.local.get('state');
  state = d.state || null;
  render();
}

function render() {
  if (!state) {            // the session ended
    window.close();
    return;
  }
  if (state.rest) {
    $('title').textContent = state.rest.long ? 'Time for a long rest' : 'Time to rest';
    $('sub').textContent = `You have focused ${fmtDuration(activeSeconds(state))} this session. Take ${state.rest.minutes} minutes.`;
    const n = (state.breaksTaken || 1) - 1;
    $('tips').textContent = '';
    for (let i = 0; i < 3; i++) {
      const li = document.createElement('li');
      li.textContent = TIPS[(n * 3 + i) % TIPS.length];
      $('tips').appendChild(li);
    }
    $('more').hidden = $('skip').hidden = false;
    if (!chimedStart) { chimedStart = true; chime(); }
    tick();
  } else if (!finished) {  // the rest is over and the session is running again
    finished = true;
    chime();
    $('title').textContent = 'Back to focus';
    $('sub').textContent = 'Your session is running again.';
    $('clock').textContent = '00:00';
    $('tips').textContent = '';
    $('more').hidden = $('skip').hidden = true;
    setTimeout(() => window.close(), 3500);
  }
}

function tick() {
  if (state && state.rest) $('clock').textContent = fmtMS(Math.max(0, Math.ceil((state.rest.until - Date.now()) / 1000)));
}
setInterval(tick, 250);

$('skip').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'skipRest', snoozeMinutes: 0 }));
$('more').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'skipRest', snoozeMinutes: 10 }));
chrome.storage.onChanged.addListener(load);
load();
