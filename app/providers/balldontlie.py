from datetime import date, timedelta

import httpx

from app.models import Game, ProviderError, Team


def normalize(raw: dict) -> Game:
    def team(side: str) -> Team:
        data = raw[f'{side}_team']
        return Team(name=data['full_name'], abbreviation=data['abbreviation'],
                    score=raw.get(f'{side}_team_score'))

    return Game(id=f'nfl:balldontlie:{raw["id"]}', league='nfl',
                kickoff=raw['date'], state=raw.get('status_state', 'unknown'),
                status=raw.get('status') or 'Status unavailable',
                home=team('home'), away=team('visitor'))


class BallDontLie:
    def __init__(self, key: str, client: httpx.AsyncClient):
        self.key, self.client = key, client

    async def games(self, start: str, end: str) -> list[Game]:
        if not self.key:
            raise ProviderError('Add BALLDONTLIE_API_KEY to your environment or .env file.')
        # A short date range fits comfortably in one NFL response.
        first, last = date.fromisoformat(start), date.fromisoformat(end)
        params = [('per_page', '100')]
        params.extend(('dates[]', (first + timedelta(days=i)).isoformat())
                      for i in range((last - first).days + 1))
        response = await self.client.get(
            'https://api.balldontlie.io/nfl/v1/games',
            headers={'Authorization': self.key},
            params=params,
        )
        if response.status_code == 429:
            raise ProviderError('Score provider is busy. Retrying shortly.', 60)
        if response.status_code in (401, 403):
            raise ProviderError('The score provider rejected the API key. Check your configuration.')
        if response.is_error:
            raise ProviderError('Scores are temporarily unavailable from the provider.')
        payload = response.json()
        if payload.get('meta', {}).get('next_cursor'):
            raise ProviderError('The score provider returned too many games for this date range.')
        return [normalize(game) for game in payload['data']]
