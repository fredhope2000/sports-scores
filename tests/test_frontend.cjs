const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {test} = require('node:test');

test('league switching ignores late responses and preserves the other league pins', async () => {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      value: '', hidden: false, textContent: '', innerHTML: '',
      setAttribute() {}, addEventListener() {},
    });
    return elements.get(id);
  };
  const game = league => ({
    id: `${league}:1`, league, kickoff: new Date().toISOString(),
    state: 'in_progress', status: 'Live', period: 'Q3', clock: '10:00',
    home: {name: `${league} home`, abbreviation: '', score: 0},
    away: {name: `${league} away`, abbreviation: '', score: 7},
    possession: 'home', situation: '2nd & 5', last_play: '<script>bad()</script>',
  });
  let stored = JSON.stringify({'nfl:1': game('nfl'), 'cfb:1': game('cfb')});
  const pending = [];
  const context = vm.createContext({
    document: {getElementById: element, hidden: false, addEventListener() {}},
    localStorage: {getItem: key => key === 'sideline.pins' ? stored : null, setItem: (key, value) => {if (key === 'sideline.pins') stored=value;}},
    setInterval() {},
    fetch: url => new Promise(resolve => pending.push({url, resolve})),
  });
  const settle = () => new Promise(resolve => setImmediate(resolve));
  const respond = (request, league) => request.resolve({
    ok: true, json: async () => ({games: [game(league)], updated_at: new Date().toISOString(), stale: false}),
  });
  vm.runInContext(fs.readFileSync('app/static/app.js', 'utf8'), context);
  assert.match(pending[0].url, /league=nfl/);
  element('cfb').onclick();
  respond(pending[0], 'nfl');
  await settle();
  assert.equal(pending.length, 2);
  assert.match(pending[1].url, /league=cfb/);
  assert.doesNotMatch(element('games').innerHTML, /nfl home/);
  respond(pending[1], 'cfb');
  await settle();
  assert.match(element('games').innerHTML, /cfb home/);
  assert.match(element('games').innerHTML, /Q3 · 10:00/);
  assert.match(element('games').innerHTML, /aria-label="Possession"/);
  assert.doesNotMatch(element('games').innerHTML, /<script>/);
  assert.match(element('games').innerHTML, /&lt;script&gt;/);
  assert.equal(element('count').textContent, 1);
  element('clear').onclick();
  assert.deepEqual(Object.keys(JSON.parse(stored)), ['nfl:1']);
  element('nfl').onclick();
  assert.match(element('games').innerHTML, /nfl home/);
  assert.doesNotMatch(element('games').innerHTML, /cfb home/);
  respond(pending[2], 'nfl');
  await settle();
});

test('restores the league and selects a game date on switching, but respects manual dates', async () => {
  const storage = new Map([['sideline.league', 'cfb']]);
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      value: '', hidden: false, textContent: '', innerHTML: '', handlers: {},
      setAttribute() {}, addEventListener(event, handler) {this.handlers[event] = handler;},
    });
    return elements.get(id);
  };
  const pending = [];
  const context = vm.createContext({
    document: {getElementById: element, hidden: false, addEventListener() {}},
    localStorage: {getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value)},
    setInterval() {}, fetch: url => new Promise(resolve => pending.push({url, resolve})),
  });
  const settle = () => new Promise(resolve => setImmediate(resolve));
  const respond = games => pending.at(-1).resolve({
    ok: true, json: async () => ({games, updated_at: new Date().toISOString(), stale: false}),
  });
  const game = (day, state = 'final') => ({
    id: `cfb:${day}`, league: 'cfb', kickoff: new Date(`${day}T12:00:00`).toISOString(),
    state, status: state, home: {name: 'Home'}, away: {name: 'Away'},
  });
  vm.runInContext(fs.readFileSync('app/static/app.js', 'utf8'), context);
  assert.match(pending[0].url, /league=cfb/);
  respond([]); await settle();
  element('nfl').onclick();
  assert.equal(storage.get('sideline.league'), 'nfl');
  respond([]); await settle();
  element('date').value = '2026-09-20';
  element('cfb').onclick();
  assert.equal(storage.get('sideline.league'), 'cfb');
  respond([game('2026-09-17'), game('2026-09-19')]); await settle();
  assert.equal(element('date').value, '2026-09-19');
  element('date').value = '2026-09-20';
  element('date').handlers.change();
  respond([game('2026-09-19')]); await settle();
  assert.equal(element('date').value, '2026-09-20');
  assert.match(element('games').innerHTML, /No games scheduled/);
  element('nfl').onclick(); respond([]); await settle();
  element('cfb').onclick();
  respond([game('2026-09-19'), game('2026-09-18', 'in_progress')]); await settle();
  assert.equal(element('date').value, '2026-09-18');
});
