const $ = id => document.getElementById(id);
const localDate = date => `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
const today = () => localDate(new Date());
let saved = {};
try { saved = JSON.parse(localStorage.getItem('sideline.pins') || '{}'); } catch {}
if (!saved || Array.isArray(saved) || typeof saved !== 'object') saved = {};
let pins = saved, games = [], onlyPinned = false, loading = false, updatedAt = null, stale = false;
let initial = true, requestedDate = null;
let league = 'nfl', selectionVersion = 0;
try { if (localStorage.getItem('sideline.league') === 'cfb') league = 'cfb'; } catch {}
$('date').value = today();
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function persist() { try { localStorage.setItem('sideline.pins', JSON.stringify(pins)); } catch {} }
function dateOf(game) { return localDate(new Date(game.kickoff)); }
function card(game) {
  const pinned = Boolean(pins[game.id]);
  let status = game.state === 'scheduled' ? (game.kickoff_tbd ? 'Time TBD' : new Date(game.kickoff).toLocaleString([], {weekday:'short',hour:'numeric',minute:'2-digit'})) : [game.period,game.clock].filter(Boolean).join(' · ') || game.status;
  if (!games.some(current => current.id === game.id)) status += ' · saved snapshot';
  const team = (data, side) => `<div class="team">${data.abbreviation ? `<span class="abbr">${escapeHTML(data.abbreviation)}</span>` : ''}<span class="team-name">${escapeHTML(data.name)}${game.state === 'in_progress' && game.possession === side ? '<span class="possession" aria-label="Possession" title="Possession"> ●</span>' : ''}${data.timeouts == null ? '' : `<span class="timeouts">${escapeHTML(data.timeouts)} timeouts left</span>`}</span><span class="score">${data.score == null ? '—' : escapeHTML(data.score)}</span></div>`;
  const details = [game.state === 'in_progress' ? game.situation : null, game.broadcast].filter(Boolean);
  return `<article class="card ${pinned ? 'is-pinned' : ''}"><div class="card-top"><span class="game-status ${game.state === 'in_progress' ? 'live' : ''}">${escapeHTML(status)}</span><button class="pin" data-pin="${escapeHTML(game.id)}" aria-pressed="${pinned}" aria-label="${pinned ? 'Unpin' : 'Pin'} ${escapeHTML(game.away.name)} at ${escapeHTML(game.home.name)}">${pinned ? '★ Pinned' : '☆ Pin'}</button></div>${team(game.away, 'away')}${team(game.home, 'home')}${details.length ? `<p class="game-details">${details.map(escapeHTML).join(' · ')}</p>` : ''}${game.last_play ? `<details class="last-play"><summary>Last play</summary><p>${escapeHTML(game.last_play)}</p></details>` : ''}</article>`;
}
function render() {
  const query = $('search').value.trim().toLowerCase();
  const all = new Map(Object.values(pins).filter(g => g && g.id && g.home && g.away).map(g => [g.id,g]));
  games.forEach(g => all.set(g.id,g));
  const selected = [...all.values()].filter(g => {
    if (g.league !== league) return false;
    if (onlyPinned && !pins[g.id]) return false;
    if (!query && !onlyPinned && !pins[g.id] && dateOf(g) !== $('date').value) return false;
    return !query || `${g.home.name} ${g.home.abbreviation} ${g.away.name} ${g.away.abbreviation}`.toLowerCase().includes(query);
  }).sort((a,b) => a.kickoff.localeCompare(b.kickoff));
  const groups = [['Pinned',g => Boolean(pins[g.id])],['Live',g => !pins[g.id] && g.state === 'in_progress'],['Upcoming',g => !pins[g.id] && g.state === 'scheduled'],['Finished',g => !pins[g.id] && g.state === 'final'],['Other games',g => !pins[g.id] && !['scheduled','in_progress','final'].includes(g.state)]];
  $('games').innerHTML = selected.length ? groups.map(([name,test]) => {const list = selected.filter(test); return list.length ? `<section><h2 class="group-title">${name}</h2><div class="grid">${list.map(card).join('')}</div></section>` : '';}).join('') : `<div class="empty">${query ? 'No matching games in this week. Try another date or team.' : onlyPinned ? 'Pin a game to keep it here.' : 'No games scheduled for this date. Choose another day.'}</div>`;
  const pinCount = Object.values(pins).filter(g => g && g.league === league).length;
  $('count').textContent = pinCount;
  $('clear').disabled = !pinCount;
  $('nfl').setAttribute('aria-pressed', league === 'nfl');
  $('cfb').setAttribute('aria-pressed', league === 'cfb');
  $('source').textContent = league === 'cfb' ? 'FBS · Data: College Football Data' : 'Data: BALLDONTLIE';
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
  const requestLeague = league, version = selectionVersion;
  requestedDate = value;
  const start = new Date(`${value}T12:00:00`);
  // Tuesday–Tuesday captures an entire NFL slate, including Monday night in UTC.
  start.setDate(start.getDate() - (start.getDay()+5)%7);
  const end = new Date(start); end.setDate(end.getDate()+7);
  try {
    const response = await fetch(`/api/scoreboard?league=${requestLeague}&start=${localDate(start)}&end=${localDate(end)}`);
    if (!response.ok) throw new Error(response.status === 401 ? 'Sign in again to load scores.' : 'Unable to load scores. Retrying shortly.');
    const data = await response.json();
    if (version !== selectionVersion) return;
    if (data.updated_at) {
      games = data.games;
      games.forEach(g => { if (pins[g.id]) pins[g.id] = g; }); persist();
      updatedAt = data.updated_at;
    }
    stale = data.stale;
    $('notice').hidden = !data.message; $('notice').textContent = data.message || '';
    if (initial && data.updated_at && !data.stale) {
      initial = false;
      if (!games.some(g => dateOf(g) === value)) {
        const distance = g => Math.abs(new Date(`${dateOf(g)}T12:00:00`) - new Date(`${value}T12:00:00`));
        const candidates = [...games].sort((a,b) =>
          Number(b.state === 'in_progress') - Number(a.state === 'in_progress') ||
          distance(a) - distance(b) || b.kickoff.localeCompare(a.kickoff));
        if (candidates.length) $('date').value = dateOf(candidates[0]);
      }
    }
    render();
  } catch(error) { if (version === selectionVersion) { stale = true; $('notice').hidden = false; $('notice').textContent = error.message; } }
  finally { loading = false; $('refresh').disabled = false; freshness(); if (version !== selectionVersion || ($('date').value !== requestedDate && !games.some(g => dateOf(g) === $('date').value))) refresh(); }
}
function changeSelection(selectGameDate = false) {
  selectionVersion++; initial=selectGameDate; games=[]; updatedAt=null; stale=false;
  $('notice').hidden=true; render(); freshness(); refresh();
}
$('games').addEventListener('click', event => {
  const button = event.target.closest('[data-pin]'); if (!button) return;
  const id = button.dataset.pin;
  if (pins[id]) delete pins[id]; else { const game = games.find(g => g.id === id); if (game) pins[id] = game; }
  persist(); render();
});
$('search').addEventListener('input', render);
$('date').addEventListener('change', () => {if (!$('date').value) $('date').value=today(); changeSelection();});
$('today').onclick = () => { $('date').value=today(); changeSelection(); };
for (const name of ['nfl', 'cfb']) $(name).onclick = () => {
  if (league !== name) {
    league=name;
    try { localStorage.setItem('sideline.league', league); } catch {}
    changeSelection(true);
  }
};
$('refresh').onclick = refresh;
$('all').onclick = () => {onlyPinned=false;render();};
$('pinned').onclick = () => {onlyPinned=true;render();};
$('clear').onclick = () => {for (const [id, game] of Object.entries(pins)) if (game && game.league === league) delete pins[id]; persist();render();};
document.addEventListener('visibilitychange', () => {if (!document.hidden) refresh();});
setInterval(() => { if (games.some(g => g.state === 'in_progress') || stale || !updatedAt || Date.now()-new Date(updatedAt).getTime() >= 120000) refresh(); },30000);
render(); refresh();
