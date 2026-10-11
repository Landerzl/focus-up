const params = new URLSearchParams(location.search);
const slot = params.get('slot');
let host = '';
try { host = new URL(params.get('url') || '').hostname; } catch (e) { /* ignore */ }

const labels = { music: 'Music', research: 'Research', work: 'Work' };
document.getElementById('what').textContent =
  `${host || 'That page'} isn't allowed in your ${labels[slot] || ''} tab during this session.`.replace('  ', ' ');

const back = document.getElementById('back');
if (history.length > 1) {
  back.hidden = false;
  back.addEventListener('click', () => history.back());
}
