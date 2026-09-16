const $ = id => document.getElementById(id);
const localDate = date => `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
const today = () => localDate(new Date());
let saved = {};
try { saved = JSON.parse(localStorage.getItem('sideline.pins') || '{}'); } catch {}
if (!saved || Array.isArray(saved) || typeof saved !== 'object') saved = {};
let pins = saved, games = [], onlyPinned = false, loading = false, updatedAt = null, stale = false;
let initial = true, requestedDate = null;
$('date').value = today();
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function persist() { try { localStorage.setItem('sideline.pins', JSON.stringify(pins)); } catch {} }
function dateOf(game) { return localDate(new Date(game.kickoff)); }
function card(game) {
  const pinned = Boolean(pins[game.id]);
  let status = game.state === 'scheduled' ? new Date(game.kickoff).toLocaleString([], {weekday:'short',hour:'numeric',minute:'2-digit'}) : [game.period,game.clock].filter(Boolean).join(' · ') || game.status;
  if (!games.some(current => current.id === game.id)) status += ' · saved snapshot';
  const team = data => `<div class="team"><span class="abbr">${escapeHTML(data.abbreviation)}</span><span class="team-name">${escapeHTML(data.name)}${data.timeouts == null ? '' : `<span class="timeouts">${escapeHTML(data.timeouts)} timeouts left</span>`}</span><span class="score">${data.score == null ? '—' : escapeHTML(data.score)}</span></div>`;
  return `<article class="card ${pinned ? 'is-pinned' : ''}"><div class="card-top"><span class="game-status ${game.state === 'in_progress' ? 'live' : ''}">${escapeHTML(status)}</span><button class="pin" data-pin="${escapeHTML(game.id)}" aria-pressed="${pinned}" aria-label="${pinned ? 'Unpin' : 'Pin'} ${escapeHTML(game.away.name)} at ${escapeHTML(game.home.name)}">${pinned ? '★ Pinned' : '☆ Pin'}</button></div>${team(game.away)}${team(game.home)}</article>`;
}
function render() {
  const query = $('search').value.trim().toLowerCase();
  const all = new Map(Object.values(pins).filter(g => g && g.id && g.home && g.away).map(g => [g.id,g]));
  games.forEach(g => all.set(g.id,g));
  const selected = [...all.values()].filter(g => {
    if (onlyPinned && !pins[g.id]) return false;
    if (!query && !onlyPinned && !pins[g.id] && dateOf(g) !== $('date').value) return false;
    return !query || `${g.home.name} ${g.home.abbreviation} ${g.away.name} ${g.away.abbreviation}`.toLowerCase().includes(query);
  }).sort((a,b) => a.kickoff.localeCompare(b.kickoff));
  const groups = [['Pinned',g => Boolean(pins[g.id])],['Live',g => !pins[g.id] && g.state === 'in_progress'],['Upcoming',g => !pins[g.id] && g.state === 'scheduled'],['Finished',g => !pins[g.id] && g.state === 'final'],['Other games',g => !pins[g.id] && !['scheduled','in_progress','final'].includes(g.state)]];
  $('games').innerHTML = selected.length ? groups.map(([name,test]) => {const list = selected.filter(test); return list.length ? `<section><h2 class="group-title">${name}</h2><div class="grid">${list.map(card).join('')}</div></section>` : '';}).join('') : `<div class="empty">${query ? 'No matching games in this week. Try another date or team.' : onlyPinned ? 'Pin a game to keep it here.' : 'No games scheduled for this date. Choose another day.'}</div>`;
  $('count').textContent = Object.keys(pins).length;
  $('clear').disabled = !Object.keys(pins).length;
  $('all').setAttribute('aria-pressed', !onlyPinned);
  $('pinned').setAttribute('aria-pressed', onlyPinned);
  $('date-label').textContent = query ? 'Search results · selected week and pinned games' : new Date(`${$('date').value}T12:00:00`).toLocaleDateString([], {weekday:'long',month:'long',day:'numeric'});
}
function freshness() {
  if (loading) return;
  $('freshness').textContent = updatedAt ? `${stale ? 'Last successful update' : 'Updated'} ${new Date(updatedAt).toLocaleTimeString([], {hour:'numeric',minute:'2-digit',second:'2-digit'})}${stale ? ' · retrying' : ''}` : 'No score update yet';
}
async function refresh() {
  if (loading || document.hidden) return;
  loading = true; $('refresh').disabled = true; $('freshness').textContent = 'Refreshing…';
  const value = $('date').value || today();
  requestedDate = value;
  const start = new Date(`${value}T12:00:00`);
  // Tuesday–Tuesday captures an entire NFL slate, including Monday night in UTC.
  start.setDate(start.getDate() - (start.getDay()+5)%7);
  const end = new Date(start); end.setDate(end.getDate()+7);
  try {
    const response = await fetch(`/api/scoreboard?league=nfl&start=${localDate(start)}&end=${localDate(end)}`);
    if (!response.ok) throw new Error(response.status === 401 ? 'Sign in again to load scores.' : 'Unable to load scores. Retrying shortly.');
    const data = await response.json();
    if ($('date').value !== value) return;
    if (data.updated_at) {
      games = data.games;
      games.forEach(g => { if (pins[g.id]) pins[g.id] = g; }); persist();
      updatedAt = data.updated_at;
    }
    stale = data.stale;
    $('notice').hidden = !data.message; $('notice').textContent = data.message || '';
    if (initial && data.updated_at) {
      initial = false;
      if (!games.some(g => dateOf(g) === value)) {
        const upcoming = games.filter(g => new Date(g.kickoff) > new Date()).sort((a,b) => a.kickoff.localeCompare(b.kickoff));
        if (upcoming.length) $('date').value = dateOf(upcoming[0]);
      }
    }
    render();
  } catch(error) { stale = true; $('notice').hidden = false; $('notice').textContent = error.message; }
  finally { loading = false; $('refresh').disabled = false; freshness(); if ($('date').value !== requestedDate && !games.some(g => dateOf(g) === $('date').value)) refresh(); }
}
$('games').addEventListener('click', event => {
  const button = event.target.closest('[data-pin]'); if (!button) return;
  const id = button.dataset.pin;
  if (pins[id]) delete pins[id]; else { const game = games.find(g => g.id === id); if (game) pins[id] = game; }
  persist(); render();
});
$('search').addEventListener('input', render);
$('date').addEventListener('change', () => {if (!$('date').value) $('date').value=today(); initial=false; games=[]; render(); refresh();});
$('today').onclick = () => { $('date').value=today(); initial=false; games=[]; render(); refresh(); };
$('refresh').onclick = refresh;
$('all').onclick = () => {onlyPinned=false;render();};
$('pinned').onclick = () => {onlyPinned=true;render();};
$('clear').onclick = () => {pins={};persist();render();};
document.addEventListener('visibilitychange', () => {if (!document.hidden) refresh();});
setInterval(() => { if (games.some(g => g.state === 'in_progress') || stale || !updatedAt || Date.now()-new Date(updatedAt).getTime() >= 120000) refresh(); },30000);
render(); refresh();
