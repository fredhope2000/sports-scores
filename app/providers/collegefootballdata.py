from datetime import date, datetime, timezone
import time

import httpx

from app.models import Game, ProviderError, Team


def normalize(raw: dict, live: bool = True) -> Game:
    state = raw.get('status', 'unknown') if live else ('completed' if raw['completed'] else 'scheduled')
    state = 'final' if state == 'completed' else state
    # An unfinished historical record does not establish that a game is live.
    if not live and state == 'scheduled' and datetime.fromisoformat(raw['startDate'].replace('Z', '+00:00')) < datetime.now(timezone.utc):
        state = 'unknown'

    def team(side):
        data = raw[f'{side}Team'] if live else {'name': raw[f'{side}Team'], 'points': raw.get(f'{side}Points')}
        return Team(name=data['name'], abbreviation=data.get('abbreviation') or '',
                    score=data.get('points') if state != 'scheduled' else None)

    period = raw.get('period') if live and state == 'in_progress' else None
    return Game(
        id=f'cfb:cfbd:{raw["id"]}', league='cfb', kickoff=raw['startDate'],
        kickoff_tbd=raw.get('startTimeTBD', False), state=state,
        status={'final': 'Final', 'scheduled': 'Scheduled', 'in_progress': 'Live',
                'unknown': 'Status unavailable'}.get(state, state.replace('_', ' ').title()),
        home=team('home'), away=team('away'),
        period=(f'Q{period}' if period <= 4 else f'OT{period - 4}') if period else None,
        clock=raw.get('clock') if state == 'in_progress' else None,
        situation=raw.get('situation'), possession=raw.get('possession'),
        last_play=raw.get('lastPlay'), broadcast=raw.get('tv'),
    )


class CollegeFootballData:
    def __init__(self, key: str, client: httpx.AsyncClient):
        self.key, self.client = key, client
        self.schedules = {}

    async def fetch(self, path, params):
        response = await self.client.get(
            f'https://api.collegefootballdata.com/{path}',
            headers={'Authorization': f'Bearer {self.key}'}, params=params)
        if response.status_code == 429:
            raise ProviderError('College Football Data rate limit reached. Retrying shortly.', 60)
        if response.status_code in (401, 403):
            raise ProviderError('College Football Data rejected access. Check your API key and live scoreboard subscription.')
        if response.is_error:
            raise ProviderError('College football scores are temporarily unavailable from the provider.')
        return response.json()

    async def games(self, start: str, end: str) -> list[Game]:
        if not self.key:
            raise ProviderError('Add COLLEGEFOOTBALLDATA_API_KEY to your environment or .env file.')
        first, last = date.fromisoformat(start), date.fromisoformat(end)
        # January/February postseason games belong to the preceding fall season.
        years = {day.year - (day.month <= 2) for day in (first, last)}
        games = {}
        for year in sorted(years):
            cached = self.schedules.get(year)
            if not cached or time.monotonic() - cached[0] >= 3600:
                rows = await self.fetch('games', {'year': year, 'seasonType': 'both', 'classification': 'fbs'})
                if len(self.schedules) >= 4:
                    self.schedules.pop(next(iter(self.schedules)))
                self.schedules[year] = (time.monotonic(), rows)
            for raw in self.schedules[year][1]:
                if start <= raw['startDate'][:10] <= end:
                    game = normalize(raw, live=False)
                    games[game.id] = game
        # The live endpoint has no date filter. Overlay only the requested window.
        if first <= datetime.now(timezone.utc).date() <= last:
            for raw in await self.fetch('scoreboard', {'classification': 'fbs'}):
                if start <= raw['startDate'][:10] <= end:
                    game = normalize(raw)
                    games[game.id] = game
        return sorted(games.values(), key=lambda game: game.kickoff)
