# Anichess Tracker — Project Guide

## Project Overview
Real-time player stats dashboard for Anichess ranked mode.
Tracks specific wallet addresses, displaying each player's ELO/rating, rank, and history.

## Agent Team
- **project-manager** — oversees scope, priorities, and cross-agent coordination
- **backend-dev** — Node.js/Express API server, data fetching, caching
- **frontend-dev** — Dashboard UI (HTML/CSS/JS), real-time updates
- **uiux-designer** — Reads the uploaded branding kit PDF, produces implementation-ready design specs, hands off to frontend-dev

## Tech Stack
- **Backend**: Node.js + Express, node-cron for polling, axios for API calls
- **Frontend**: Vanilla HTML/CSS/JS (no framework), served from backend
- **Data**: Anichess ranked leaderboard API (see backend/api-notes.md)

## Workflow
1. Backend polls Anichess API on interval, caches player data in memory/JSON
2. Frontend fetches from local `/api/players` endpoint
3. Auto-refresh every 60s on dashboard

## Tracked Players
Player wallet addresses are stored in `backend/watched-wallets.json`.

## Branding Workflow
1. Upload the branding kit PDF via the Admin panel (`/admin` → Branding Kit section)
2. Say: **"Apply the branding kit to the dashboard"**
3. The UIUX Designer agent reads `backend/branding/*.pdf`, produces a design spec
4. The Frontend Developer agent implements the spec into `frontend/style.css` and HTML

## File Structure
```
anichess-tracker/
  backend/
    server.js          # Express server + API polling
    api-notes.md       # Anichess API documentation
    watched-wallets.json
    branding/          # Uploaded branding kit PDFs (admin-only)
  frontend/
    index.html         # Main dashboard
    style.css
    app.js
    badges/            # Tier badge images (admin-uploaded)
  agents/
    project-manager.md
    backend-dev.md
    frontend-dev.md
    uiux-designer.md   # Branding kit → design spec workflow
```

## Running
```bash
cd backend && npm install && node server.js
```
Server runs on port 4000, serves frontend at root `/`.
