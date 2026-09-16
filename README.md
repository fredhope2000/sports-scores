# Sideline

A personal NFL scoreboard with searchable matchups and pinned games. Python 3.11, FastAPI, Jinja, and vanilla JavaScript. Provider-specific fields are normalized behind a small adapter so CFB can be added later.

## Run locally

```bash
python -m venv .venv
.venv/bin/pip install -r requirements.txt
source ~/.secrets
export BALLDONTLIE_API_KEY
.venv/bin/uvicorn app.main:app --reload
```

Alternatively copy `.env.example` to `.env` and enter your key there. Existing environment variables take precedence. Open http://127.0.0.1:8000. Never commit keys.

Pins are saved in this browser's local storage, not synchronized across devices. Search covers the selected NFL week and saved pins. Finished pins remain until cleared. Pins outside the fetched week are saved snapshots; choose their date to refresh them.

The free NFL Games endpoint provides scores and status text. Separate quarter, clock, and timeouts are not currently mapped because they are not documented in this endpoint. Missing fields are omitted rather than guessed. Game clocks are not simulated.

## Checks

```bash
.venv/bin/python -m pytest
node --check app/static/app.js
```

## Hosting

Use one application worker: the cache and provider request budget are in memory. Protect the site with HTTPS through nginx and set both `SCOREBOARD_USERNAME` and `SCOREBOARD_PASSWORD` to enable HTTP Basic authentication for the page and score API. Static assets contain no private data. Without these variables the site has no authentication. A worker restart clears the score cache, but browser pins remain.

The provider is queried at most once every 15 seconds per process; identical successful requests are cached for 30 seconds. Errors preserve cached scores and back off. No polling occurs without browser requests. Multiple workers would require a shared cache and request budget.
