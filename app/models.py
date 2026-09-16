from pydantic import BaseModel


class Team(BaseModel):
    name: str
    abbreviation: str
    score: int | None = None
    timeouts: int | None = None


class Game(BaseModel):
    id: str
    league: str
    kickoff: str
    state: str
    status: str
    home: Team
    away: Team
    period: str | None = None
    clock: str | None = None


class ProviderError(Exception):
    def __init__(self, message: str, retry_after: int = 60):
        super().__init__(message)
        self.retry_after = retry_after
