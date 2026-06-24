# Anichess Tracker — Project Overview

## What It Is

Anichess Tracker is a real-time competitive dashboard for [Anichess](https://anichess.com/), a spell-based chess game built on blockchain. It tracks registered player wallets, surfaces live ELO ratings and match stats, and manages the qualification pipeline for the **Rising Stars** tournament series — a recurring event for newcomer players competing for $600 USD in CHECK tokens.

Live at: **https://anichesstracker.com/**

---

## Core Features

### 1. Live Leaderboard
- Tracks up to 303 registered wallet addresses
- Displays ELO rating, rank, total matches, wins, and win rate per player
- Sorted by rating; auto-refreshes every 30 minutes
- Tier badges (Pawn → Legend) based on rating ranges
- CSV export for offline analysis

### 2. Qualifier / Wild Card Section
- **Top 8 by Rating** — automatically determined from live leaderboard
- **Top 2 by Matches (Wild Cards)** — counts games played since May 11, 2026 00:00 UTC, with a baseline snapshot to exclude pre-period matches
- Shows confirmed finalists from past qualifier events (Q3 Lichess qualifiers, Team Battle)
- Countdown timer to cutoff (May 23, 2026 00:00 UTC)

### 3. Tournament Details Panel
- Displays full Rising Stars #2 rules, prize structure, and procedures
- Linked from the main nav; sourced from a server-side JSON file editable via admin

### 4. Bracket Manager (`/brackets.html`)
- Single-elimination bracket for up to 16 players
- Configurable round formats per stage (BO1 / BO3 / BO5)
- Live match score tracking with game-by-game results
- Admin-only seed assignment and bracket generation
- Archived past brackets viewable via `?event=rs1`

### 5. Past Events Archive
- Results from previous tournaments (Rising Stars #1, etc.)
- Static player and bracket snapshots stored as `brackets-{event}.json` and `players-{event}.json`

### 6. Admin Panel (`/admin.html`)
- Manage watched wallets (add/remove players)
- Set player display names and absent status
- Upload branding kit, background image, logo, tier badges
- Configure tournament metadata (number, date, prize pool, cutoff)
- Set match baselines, site state, and qualifier results
- Force data refresh and manage excluded wallets

---

## Tournament: Rising Stars #2

| Field | Value |
|---|---|
| Date | May 24, 2026 · 12:00 UTC |
| Format | Single Elimination, 16 players |
| Match system | All rounds Best of 3 (BO3) |
| Time control | 3 min + 2 sec increment |
| Prize pool | $600 USD in CHECK tokens |
| Cutoff | May 23, 2026 · 00:00 UTC |
| Eligibility | Anichess newcomers (no prior Rising Stars finalist) |

**Qualification paths:**
1. Top 8 by Anichess rating (among newcomer registered players)
2. Top 2 by total games played May 11–23 (wild cards)
3. Top 3 from Rising Stars Q3 Lichess qualifiers
4. Top 3 from Anichess Team Battle I

---

## Technical Architecture

```
anichess-tracker/
  backend/
    server.js               Express API + cron polling (every 5 min)
    watched-wallets.json    Registered wallet addresses
    match-baseline.json     May 11 match snapshot for wild card delta
    tournament-config.json  UI metadata (date, cutoff, prize pool)
    tournament-details.json Full rules text (displayed in Details tab)
    site-state.json         Controls which page the root URL serves
    brackets.json           Live bracket state
    brackets-rs1.json       Archived RS1 bracket
  frontend/
    index.html              Main dashboard
    brackets.html           Bracket manager
    admin.html              Admin panel
    app.js                  Dashboard logic
    style.css               Global styles + theming
```

**Backend:** Node.js + Express on port 4000, managed by pm2  
**Data source:** Anichess ranked leaderboard API (polled every 5 min until cutoff)  
**Auth:** HTTP Basic Auth for all admin API mutations; client-side login overlay for admin panel  
**Caching:** Player data cached in memory; tournament config served with `no-cache`  
**Frontend:** Vanilla HTML/CSS/JS — no framework, no build step

---

## Site States

The server can serve different root-level experiences based on `site-state.json`:

| State | What users see |
|---|---|
| `leaderboard` | Live dashboard (index.html) — default |
| `finalizing` | Preview page (preview.html) — results being prepared |
| `confirmed` | Public results page (results.html) — finalists announced |
