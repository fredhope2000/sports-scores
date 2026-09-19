import asyncio
from hashlib import sha256
import re
import httpx

from fastapi.testclient import TestClient

from app.main import app
from app.models import ProviderError
from app.providers.balldontlie import normalize
from app.providers.balldontlie import BallDontLie
from app.scoreboard import Scoreboard


def test_asset_urls_change_when_script_changes(monkeypatch, tmp_path):
    import app.main as main

    monkeypatch.delenv('SCOREBOARD_USERNAME', raising=False)
    monkeypatch.delenv('SCOREBOARD_PASSWORD', raising=False)
    static = tmp_path / 'static'
    static.mkdir()
    for name in ('app.js', 'styles.css'):
        (static / name).write_bytes((main.ROOT / 'static' / name).read_bytes())
    monkeypatch.setattr(main, 'ROOT', tmp_path)
    with TestClient(app) as client:
        first = client.get('/')
        assert first.headers['cache-control'] == 'no-cache'
        script_url = re.search(r'src="([^"]+)"', first.text).group(1)
        expected = sha256((static / 'app.js').read_bytes()).hexdigest()[:16]
        assert script_url == f'/static/app.js?v={expected}'
        assert client.get(script_url).status_code == 200
        with (static / 'app.js').open('a') as script:
            script.write('\n// Updated script\n')
        second = client.get('/')
        assert script_url not in second.text


def sample():
    return {'id': 1, 'date': '2026-09-18T00:15:00Z', 'status': 'Final',
            'status_state': 'final', 'home_team': {'full_name': 'Buffalo Bills', 'abbreviation': 'BUF'},
            'visitor_team': {'full_name': 'Detroit Lions', 'abbreviation': 'DET'},
            'home_team_score': 0, 'visitor_team_score': None}


def test_mapping_preserves_zero_and_missing():
    game = normalize(sample())
    assert game.home.score == 0
    assert game.away.score is None
    assert game.home.timeouts is None
    assert game.clock is None
    assert game.id == 'nfl:balldontlie:1'


def test_provider_date_filters():
    def handler(request):
        assert request.url.params.get_list('dates[]') == ['2026-09-17', '2026-09-18']
        assert request.headers['Authorization'] == 'example'
        return httpx.Response(200, json={'data': [sample()], 'meta': {'per_page': 100}})

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            games = await BallDontLie('example', client).games('2026-09-17', '2026-09-18')
            assert len(games) == 1
    asyncio.run(run())


def test_shared_cache_and_error_fallback():
    class Provider:
        calls = 0
        async def games(self, start, end):
            self.calls += 1
            if self.calls > 1:
                raise ProviderError('Unavailable')
            return [normalize(sample())]

    async def run():
        provider = Provider()
        service = Scoreboard({'nfl': provider})
        args = ('nfl', '2026-09-15', '2026-09-22')
        a, b = await asyncio.gather(service.get(*args), service.get(*args))
        assert provider.calls == 1 and a == b
        service.cache[args]['stored'] -= 31
        service.next_request['nfl'] = 0
        fallback = await service.get(*args)
        assert fallback['stale'] and fallback['games'] == a['games']
        assert fallback['updated_at'] == a['updated_at']
        await service.get(*args)
        assert provider.calls == 2
    asyncio.run(run())


def test_routes_and_auth(monkeypatch):
    monkeypatch.delenv('SCOREBOARD_USERNAME', raising=False)
    monkeypatch.delenv('SCOREBOARD_PASSWORD', raising=False)
    with TestClient(app) as client:
        assert client.get('/').status_code == 200
        assert client.get('/api/scoreboard?start=2026-09-01&end=2026-10-01').status_code == 400
        assert client.get('/api/scoreboard?start=2026-09-01&end=2026-09-02&league=invalid').status_code == 400
        monkeypatch.setenv('SCOREBOARD_USERNAME', 'test')
        monkeypatch.setenv('SCOREBOARD_PASSWORD', 'secret')
        assert client.get('/').status_code == 401
        assert client.get('/api/scoreboard?start=2026-09-01&end=2026-09-02').status_code == 401
        assert client.get('/', auth=('test', 'secret')).status_code == 200
