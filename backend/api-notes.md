# Anichess API Notes

## Per-Player Rating — Primary Source (No Auth, Any Player)
**GET** `https://apiv2.pvp.anichess.com/player/rating/{walletAddress}`
- No auth required — works for **any** wallet, not just top 100
- Response: `{ rating: 1670, matches: [ { room_type, count } ] }`
- `room_type` values: `RANK`, `GAMBIT`, `M8_ARENA`, `QUICK`, `FRIEND`
- 404 if wallet has never played
- **This is the primary ELO source in the current refresh flow**

## Ranked Leaderboard — Rank Position + Tier Only
**GET** `https://apiv2.pvp.anichess.com/rating/leaderboard`
- No auth required
- Returns top 100 players sorted by rating descending
- Response: `{ status, message, data: [ { ranking, username, pfpUrl, walletAddress, rankingCode, rating } ] }`
- `rankingCode`: rank tier string (e.g. `GUARDIAN`, `KNIGHT`, `APPRENTICE`)
- Used only to get `rank` position and `rankTier` — not for ELO (individual endpoint is authoritative)

## Profile Lookup — Username + Avatar
**GET** `https://api.auth.anichess.com/v4/profiles?walletAddresses={addr1},{addr2},...`
- No auth required, bulk comma-separated lookup
- Response: `{ total, list: [ { walletAddress, username, image, emailVerified } ] }`

## Gambit Leaderboard
**GET** `https://apiv2.pvp.anichess.com/match/gambit-leaderboard`
- No auth required
- Returns: `{ data: [ { walletAddress, score, rank } ] }` (rank is a string)

## Per-Player Leaderboard Rank (Auth Required — not used)
**GET** `https://apiv2.pvp.anichess.com/rating/player-leaderboard-ranking/{walletAddress}`
- Requires JWT session cookie — returns 401 without auth

## Current Refresh Flow
1. `GET /rating/leaderboard` + `GET /match/gambit-leaderboard` (parallel, 1 call each)
2. `GET /player/rating/{wallet}` for each tracked wallet (parallel)
3. `GET /v4/profiles?walletAddresses=...` bulk call for all tracked wallets
4. Merge: rating from step 2, rank/tier from step 1, username/avatar from step 3, gambit from step 1

## Other Base URLs
- `apiv2.pvp.anichess.com` — match, rating, gambit
- `api.auth.anichess.com/v4` — profiles, auth
- `api.arena.pvp.anichess.com/v1.0` — arena mode (auth required)
- `api.inventory.anichess.com/api` — spells/inventory
