from contextlib import asynccontextmanager
from datetime import date, timedelta
from hashlib import sha256
import os
from pathlib import Path
import secrets

from dotenv import load_dotenv
from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse
from fastapi.security import HTTPBasic, HTTPBasicCredentials
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
import httpx

from app.providers.balldontlie import BallDontLie
from app.providers.collegefootballdata import CollegeFootballData
from app.scoreboard import Scoreboard

ROOT = Path(__file__).resolve().parent
load_dotenv(ROOT.parent / '.env')
security = HTTPBasic(auto_error=False)


def authenticate(credentials: HTTPBasicCredentials | None = Depends(security)):
    username = os.getenv('SCOREBOARD_USERNAME', '')
    password = os.getenv('SCOREBOARD_PASSWORD', '')
    if not username and not password:
        return
    valid = credentials is not None and bool(username and password)
    if valid:
        valid = secrets.compare_digest(credentials.username.encode(), username.encode()) & secrets.compare_digest(credentials.password.encode(), password.encode())
    if not valid:
        raise HTTPException(401, 'Authentication required', headers={'WWW-Authenticate': 'Basic'})


@asynccontextmanager
async def lifespan(app):
    async with httpx.AsyncClient(timeout=15) as client:
        app.state.scoreboard = Scoreboard({
            'nfl': BallDontLie(os.getenv('BALLDONTLIE_API_KEY', ''), client),
            'cfb': CollegeFootballData(os.getenv('COLLEGEFOOTBALLDATA_API_KEY', ''), client),
        })
        yield


app = FastAPI(lifespan=lifespan, dependencies=[Depends(authenticate)], docs_url=None, redoc_url=None, openapi_url=None)
app.mount('/static', StaticFiles(directory=ROOT / 'static'), name='static')
templates = Jinja2Templates(directory=ROOT / 'templates')


@app.get('/', response_class=HTMLResponse)
async def index(request: Request):
    asset_versions = {
        name: sha256((ROOT / 'static' / name).read_bytes()).hexdigest()[:16]
        for name in ('app.js', 'styles.css')
    }
    return templates.TemplateResponse(
        request=request, name='index.html', context={'asset_versions': asset_versions},
        headers={'Cache-Control': 'no-cache'},
    )


@app.get('/api/scoreboard')
async def scoreboard(request: Request, start: date, end: date, league: str = 'nfl'):
    if league not in request.app.state.scoreboard.providers:
        raise HTTPException(400, 'Unsupported league')
    if not timedelta(0) <= end - start <= timedelta(days=8):
        raise HTTPException(400, 'Choose a date range of up to eight days')
    return await request.app.state.scoreboard.get(league, start.isoformat(), end.isoformat())
