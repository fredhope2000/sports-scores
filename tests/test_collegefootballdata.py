import asyncio
from datetime import datetime, timezone

import httpx
import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.models import ProviderError
from app.providers.collegefootballdata import CollegeFootballData, normalize


def sample():
    return {'id': 123, 'startDate': '2026-09-19T23:00:00Z',
            'status': 'in_progress', 'period': 4, 'clock': '08:11',
            'homeTeam': {'name': 'Clemson Tigers', 'points': 0},
            'awayTeam': {'name': 'North Carolina Tar Heels', 'points': None},
            'situation': '2nd & Goal', 'possession': 'away',
            'lastPlay': 'Rush for 1 yard', 'tv': 'ESPN'}


def historical(kickoff, game_id=123):
    return {'id': game_id, 'startDate': kickoff, 'completed': True,
            'homeTeam': 'Clemson', 'awayTeam': 'North Carolina',
            'homePoints': 10, 'awayPoints': 20}


def test_live_mapping():
    game = normalize(sample())
    assert game.id == 'cfb:cfbd:123'
    assert game.state == 'in_progress'
    assert game.period == 'Q4' and game.clock == '08:11'
    assert game.home.score == 0 and game.away.score is None
    assert game.home.abbreviation == ''
    assert game.possession == 'away' and game.situation == '2nd & Goal'
    assert game.last_play == 'Rush for 1 yard' and game.broadcast == 'ESPN'
    assert normalize({**sample(), 'period': 6}).period == 'OT2'
    final = normalize({**sample(), 'status': 'completed'})
    assert final.state == 'final' and final.period is None and final.clock is None
    scheduled = normalize({**sample(), 'status': 'scheduled', 'startTimeTBD': True})
    assert scheduled.kickoff_tbd and scheduled.home.score is None


def test_live_overlay_dates_and_schedule_cache():
    today = datetime.now(timezone.utc).date()
    kickoff = f'{today}T23:00:00Z'
    calls = []

    def handler(request):
        calls.append(request.url.path)
        assert request.headers['Authorization'] == 'Bearer example'
        assert request.url.params['classification'] == 'fbs'
        if request.url.path == '/games':
            assert request.url.params['seasonType'] == 'both'
            return httpx.Response(200, json=[historical(kickoff), historical('2000-01-01T00:00:00Z', 9)])
        return httpx.Response(200, json=[{**sample(), 'startDate': kickoff}])

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            provider = CollegeFootballData('example', client)
            for _ in range(2):
                games = await provider.games(str(today), str(today))
                assert len(games) == 1
                assert games[0].home.score == 0 and games[0].state == 'in_progress'
            assert calls == ['/games', '/scoreboard', '/scoreboard']
    asyncio.run(run())


def test_january_postseason_and_no_live_request_for_old_dates():
    def handler(request):
        assert request.url.path == '/games'
        assert request.url.params['year'] == '2025'
        return httpx.Response(200, json=[historical('2026-01-02T01:00:00Z')])

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            games = await CollegeFootballData('example', client).games('2025-12-30', '2026-01-06')
            assert len(games) == 1 and games[0].state == 'final'
    asyncio.run(run())


def test_unfinished_past_game_is_not_reported_as_upcoming_or_live():
    raw = historical('2020-01-01T00:00:00Z')
    raw['completed'] = False
    assert normalize(raw, live=False).state == 'unknown'


@pytest.mark.parametrize('status,message', [(401, 'API key'), (403, 'subscription'), (429, 'rate limit'), (500, 'temporarily unavailable')])
def test_provider_errors(status, message):
    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda r: httpx.Response(status))) as client:
            with pytest.raises(ProviderError, match=message):
                await CollegeFootballData('example', client).games('2026-09-19', '2026-09-19')
    asyncio.run(run())


def test_cfb_route_missing_key_and_league_isolation(monkeypatch):
    monkeypatch.delenv('SCOREBOARD_USERNAME', raising=False)
    monkeypatch.delenv('SCOREBOARD_PASSWORD', raising=False)
    monkeypatch.delenv('COLLEGEFOOTBALLDATA_API_KEY', raising=False)
    with TestClient(app) as client:
        response = client.get('/api/scoreboard?league=cfb&start=2026-09-19&end=2026-09-19')
        assert response.status_code == 200
        assert response.json()['stale']
        assert 'COLLEGEFOOTBALLDATA_API_KEY' in response.json()['message']
        assert 'nfl' not in app.state.scoreboard.next_request


def test_live_failure_preserves_previous_scores():
    from app.scoreboard import Scoreboard

    today = datetime.now(timezone.utc).date()
    failed = False

    def handler(request):
        if request.url.path == '/games':
            return httpx.Response(200, json=[])
        return httpx.Response(403) if failed else httpx.Response(200, json=[{**sample(), 'startDate': f'{today}T20:00:00Z'}])

    async def run():
        nonlocal failed
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            service = Scoreboard({'cfb': CollegeFootballData('example', client)}, ttl=0)
            first = await service.get('cfb', str(today), str(today))
            failed = True
            service.next_request['cfb'] = 0
            fallback = await service.get('cfb', str(today), str(today))
            assert fallback['stale'] and fallback['games'] == first['games']
            assert fallback['updated_at'] == first['updated_at']
    asyncio.run(run())
