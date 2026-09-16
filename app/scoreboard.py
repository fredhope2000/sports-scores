import asyncio
from datetime import datetime, timezone
import time

from app.models import ProviderError


class Scoreboard:
    """One shared request budget/cache per provider, including browser tabs."""

    def __init__(self, providers, ttl=30):
        self.providers = providers
        self.ttl = ttl
        self.cache = {}
        self.locks = {name: asyncio.Lock() for name in providers}
        self.next_request = {}

    async def get(self, league, start, end):
        key = (league, start, end)
        async with self.locks[league]:
            now = time.monotonic()
            cached = self.cache.get(key)
            if cached and now - cached['stored'] < self.ttl:
                return cached['payload']
            if now < self.next_request.get(league, 0):
                return self.fallback(cached, 'Waiting for the next score update.')
            # Leave headroom under the free five-requests/minute limit.
            self.next_request[league] = now + 15
            try:
                games = await self.providers[league].games(start, end)
            except Exception as exc:
                message = str(exc) if isinstance(exc, ProviderError) else 'Unable to refresh scores. Please try again shortly.'
                self.next_request[league] = now + (exc.retry_after if isinstance(exc, ProviderError) else 30)
                return self.fallback(cached, message)
            payload = {'games': [game.model_dump() for game in games],
                       'updated_at': datetime.now(timezone.utc).isoformat(),
                       'stale': False, 'message': None}
            if len(self.cache) >= 32:
                self.cache.pop(next(iter(self.cache)))
            self.cache[key] = {'stored': time.monotonic(), 'payload': payload}
            return payload

    @staticmethod
    def fallback(cached, message):
        return {**(cached['payload'] if cached else {'games': [], 'updated_at': None}),
                'stale': True, 'message': message}
