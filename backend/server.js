const express = require('express');
const axios = require('axios');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const multer = require('multer');

// Simple in-process rate limiter for /api/refresh (no extra dep required)
function makeRateLimiter(windowMs, maxRequests) {
  const hits = new Map(); // ip -> [timestamp, ...]
  return (req, res, next) => {
    const ip = req.ip || req.connection.remoteAddress || 'unknown';
    const now = Date.now();
    const window = hits.get(ip) || [];
    const recent = window.filter(t => now - t < windowMs);
    if (recent.length >= maxRequests) {
      return res.status(429).json({ error: 'Too many requests — please wait before refreshing again.' });
    }
    recent.push(now);
    hits.set(ip, recent);
    next();
  };
}
// Allow at most 2 manual refreshes per IP per minute
const refreshRateLimit = makeRateLimiter(60 * 1000, 2);

const app = express();
const PORT = 4000;

const WALLETS_FILE       = path.join(__dirname, 'watched-wallets.json');
const WINS_FILE          = path.join(__dirname, 'wins-store.json');
const FRONTEND_DIR       = path.join(__dirname, '..', 'frontend');
const BADGES_DIR         = path.join(FRONTEND_DIR, 'badges');
const BRANDING_DIR       = path.join(__dirname, 'branding');

if (!fs.existsSync(BADGES_DIR))   fs.mkdirSync(BADGES_DIR,   { recursive: true });
if (!fs.existsSync(BRANDING_DIR)) fs.mkdirSync(BRANDING_DIR, { recursive: true });

const VALID_TIERS        = new Set(['pawn','knight','bishop','rook','queen','king','legend']);
const BG_EXTS            = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
const LOGO_EXTS          = ['.jpg', '.jpeg', '.png', '.webp', '.svg'];
const TOURNAMENT_DETAILS_FILE  = path.join(__dirname, 'tournament-details.json');
const QUALIFIERS_FILE          = path.join(__dirname, 'qualifiers.json');
const ABSENT_FILE              = path.join(__dirname, 'absent.json');
const EXCLUDED_WALLETS_FILE    = path.join(__dirname, 'excluded-wallets.json');
const BRACKETS_FILE            = path.join(__dirname, 'brackets.json');
const PLAYER_META_FILE         = path.join(__dirname, 'player-meta.json');
const MANUAL_FINALISTS_FILE    = path.join(__dirname, 'manual-finalists.json');
const SITE_STATE_FILE          = path.join(__dirname, 'site-state.json');
const RESULTS_STATUS_FILE      = path.join(__dirname, 'results-status.json'); // legacy migration source

const VALID_STATES = ['leaderboard', 'finalizing', 'confirmed'];

function findBgImage() {
  for (const ext of BG_EXTS) {
    const file = `bg-image${ext}`;
    if (fs.existsSync(path.join(FRONTEND_DIR, file))) return file;
  }
  return null;
}

function findBracketBgImage() {
  for (const ext of BG_EXTS) {
    const file = `bracket-bg-image${ext}`;
    if (fs.existsSync(path.join(FRONTEND_DIR, file))) return file;
  }
  return null;
}

function findLogoImage() {
  for (const ext of LOGO_EXTS) {
    const file = `logo-image${ext}`;
    if (fs.existsSync(path.join(FRONTEND_DIR, file))) return file;
  }
  return null;
}

function findTournamentLogo() {
  for (const ext of LOGO_EXTS) {
    const file = `tournament-logo${ext}`;
    if (fs.existsSync(path.join(FRONTEND_DIR, file))) return file;
  }
  return null;
}

function loadTournamentDetails() {
  try { return JSON.parse(fs.readFileSync(TOURNAMENT_DETAILS_FILE, 'utf8')); } catch { return { details: '' }; }
}

function saveTournamentDetails(data) {
  try { fs.writeFileSync(TOURNAMENT_DETAILS_FILE, JSON.stringify(data, null, 2)); }
  catch (err) { console.error('[saveTournamentDetails] Write failed:', err.message); throw err; }
}

const EMPTY_QUALIFIERS = {
  qualifier1: { first: '', second: '', third: '' },
  qualifier2: { first: '', second: '', third: '' },
};

function loadQualifiers() {
  try { return JSON.parse(fs.readFileSync(QUALIFIERS_FILE, 'utf8')); }
  catch { return EMPTY_QUALIFIERS; }
}

function saveQualifiers(data) {
  try { fs.writeFileSync(QUALIFIERS_FILE, JSON.stringify(data, null, 2)); }
  catch (err) { console.error('[saveQualifiers] Write failed:', err.message); throw err; }
}

function loadAbsent() {
  try { return JSON.parse(fs.readFileSync(ABSENT_FILE, 'utf8')); } catch { return []; }
}

function saveAbsent(wallets) {
  try { fs.writeFileSync(ABSENT_FILE, JSON.stringify(wallets, null, 2)); }
  catch (err) { console.error('[saveAbsent] Write failed:', err.message); throw err; }
}

function loadExcludedWallets() {
  try { return JSON.parse(fs.readFileSync(EXCLUDED_WALLETS_FILE, 'utf8')); }
  catch { return []; }
}

function saveExcludedWallets(list) {
  try { fs.writeFileSync(EXCLUDED_WALLETS_FILE, JSON.stringify(list, null, 2)); }
  catch (err) { console.error('[saveExcludedWallets] Write failed:', err.message); throw err; }
}

function loadBrackets() {
  try { return JSON.parse(fs.readFileSync(BRACKETS_FILE, 'utf8')); }
  catch { return { status: 'setup', playerCount: 8, seeds: [], rounds: [], champion: null, bracketName: '' }; }
}
function saveBrackets(data) {
  fs.writeFileSync(BRACKETS_FILE, JSON.stringify(data, null, 2));
}

const badgeUpload = multer({
  storage: multer.diskStorage({
    destination: BADGES_DIR,
    filename: (req, file, cb) => cb(null, file.originalname.toLowerCase()),
  }),
  fileFilter: (req, file, cb) => {
    const name = path.basename(file.originalname, path.extname(file.originalname)).toLowerCase();
    const ext  = path.extname(file.originalname).toLowerCase();
    if (!VALID_TIERS.has(name)) return cb(new Error(`Filename must be one of: ${[...VALID_TIERS].join(', ')}`));
    if (!/^\.(png|jpg|jpeg|webp|gif|svg)$/.test(ext)) return cb(new Error('Only image files allowed'));
    cb(null, true);
  },
  limits: { fileSize: 2 * 1024 * 1024 },
});

const logoUpload = multer({
  storage: multer.diskStorage({
    destination: FRONTEND_DIR,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `logo-image${ext}`);
    },
  }),
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!LOGO_EXTS.includes(ext)) return cb(new Error('Only image files allowed (jpg, png, webp, svg)'));
    cb(null, true);
  },
  limits: { fileSize: 2 * 1024 * 1024 },
});

const tournamentLogoUpload = multer({
  storage: multer.diskStorage({
    destination: FRONTEND_DIR,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `tournament-logo${ext}`);
    },
  }),
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!LOGO_EXTS.includes(ext)) return cb(new Error('Only image files allowed (jpg, png, webp, svg)'));
    cb(null, true);
  },
  limits: { fileSize: 2 * 1024 * 1024 },
});

const bgUpload = multer({
  storage: multer.diskStorage({
    destination: FRONTEND_DIR,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `bg-image${ext}`);
    },
  }),
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!BG_EXTS.includes(ext)) return cb(new Error('Only image files allowed (jpg, png, webp, gif)'));
    cb(null, true);
  },
  limits: { fileSize: 10 * 1024 * 1024 },
});

const bracketBgUpload = multer({
  storage: multer.diskStorage({
    destination: FRONTEND_DIR,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `bracket-bg-image${ext}`);
    },
  }),
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!BG_EXTS.includes(ext)) return cb(new Error('Only image files allowed (jpg, png, webp, gif)'));
    cb(null, true);
  },
  limits: { fileSize: 10 * 1024 * 1024 },
});

const pdfUpload = multer({
  storage: multer.diskStorage({
    destination: BRANDING_DIR,
    filename: (req, file, cb) => cb(null, file.originalname.toLowerCase()),
  }),
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext !== '.pdf') return cb(new Error('Only PDF files are allowed'));
    cb(null, true);
  },
  limits: { fileSize: 20 * 1024 * 1024 },
});

const LEADERBOARD_URL       = 'https://apiv2.pvp.anichess.com/rating/leaderboard';
const PLAYER_RATING_URL     = 'https://apiv2.pvp.anichess.com/player/rating';
const MATCH_HISTORY_PAG_URL = 'https://apiv2.pvp.anichess.com/player/match-history-pagination';
const PROFILES_URL          = 'https://api.auth.anichess.com/v4/profiles';
const GAMBIT_URL            = 'https://apiv2.pvp.anichess.com/match/gambit-leaderboard';

const ANICHESS_HEADERS = { Origin: 'https://anichess.com', Referer: 'https://anichess.com/' };

const CUTOFF_MS  = 1778284800 * 1000; // May 8 2026 00:00:00 UTC — leaderboard locks after this

const ADMIN_USER = 'admin';
const ADMIN_PASS = 'dropofmagic2026';

function requireAdmin(req, res, next) {
  const auth = req.headers['authorization'];
  if (!auth || !auth.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="Anichess Admin"');
    return res.status(401).send('Authentication required');
  }
  const [user, pass] = Buffer.from(auth.slice(6), 'base64').toString('utf8').split(':');
  if (user !== ADMIN_USER || pass !== ADMIN_PASS) {
    res.set('WWW-Authenticate', 'Basic realm="Anichess Admin"');
    return res.status(401).send('Invalid credentials');
  }
  next();
}

app.use(cors({
  origin: ['https://anichesstracker.com', 'https://www.anichesstracker.com', 'http://localhost:4000'],
  credentials: true,
}));
app.use(express.json());

// Serve uploaded logo as favicon (Content-Type derived from file extension)
app.get('/favicon.ico', (req, res) => {
  const filename = findLogoImage();
  if (!filename) return res.status(204).end();
  const ext = path.extname(filename).toLowerCase();
  const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
  res.setHeader('Content-Type', mime[ext] || 'image/png');
  res.sendFile(path.join(FRONTEND_DIR, filename));
});

// Root redirect based on site state
app.get('/', (req, res, next) => {
  const { state } = loadSiteState();
  if (state === 'finalizing') return res.redirect('/preview.html');
  if (state === 'confirmed')  return res.redirect('/results.html');
  next();
});

// results.html: public only when state=confirmed
app.get('/results.html', (req, res, next) => {
  if (loadSiteState().state !== 'confirmed') return requireAdmin(req, res, next);
  next();
}, (req, res) => {
  res.sendFile(path.join(FRONTEND_DIR, 'results.html'));
});

// Protect admin panel before static middleware intercepts it
app.get('/admin.html', requireAdmin, (req, res) => {
  res.sendFile(path.join(FRONTEND_DIR, 'admin.html'));
});

// preview.html: public only when state=finalizing
app.get('/preview.html', (req, res, next) => {
  if (loadSiteState().state !== 'finalizing') return requireAdmin(req, res, next);
  next();
}, (req, res) => {
  res.sendFile(path.join(FRONTEND_DIR, 'preview.html'));
});

// Protect bracket manager page (admin-only)
app.get('/brackets.html', requireAdmin, (req, res) => {
  res.sendFile(path.join(FRONTEND_DIR, 'brackets.html'));
});

app.use(express.static(FRONTEND_DIR));

let playerCache = {};
let lastRefreshed = null;

function loadWallets() {
  try { return JSON.parse(fs.readFileSync(WALLETS_FILE, 'utf8')); } catch { return []; }
}

function saveWallets(wallets) {
  try { fs.writeFileSync(WALLETS_FILE, JSON.stringify(wallets, null, 2)); }
  catch (err) { console.error('[saveWallets] Write failed:', err.message); throw err; }
}

function loadWinsStore() {
  try { return JSON.parse(fs.readFileSync(WINS_FILE, 'utf8')); } catch { return {}; }
}

function saveWinsStore(store) {
  try { fs.writeFileSync(WINS_FILE, JSON.stringify(store, null, 2)); }
  catch (err) { console.error('[saveWinsStore] Write failed:', err.message); throw err; }
}

function loadPlayerMeta() {
  try { return JSON.parse(fs.readFileSync(PLAYER_META_FILE, 'utf8')); } catch { return {}; }
}

function savePlayerMeta(meta) {
  try { fs.writeFileSync(PLAYER_META_FILE, JSON.stringify(meta, null, 2)); }
  catch (err) { console.error('[savePlayerMeta] Write failed:', err.message); throw err; }
}

function loadManualFinalists() {
  try { return JSON.parse(fs.readFileSync(MANUAL_FINALISTS_FILE, 'utf8')); }
  catch { return { top8: [], wildcards: [] }; }
}

function saveManualFinalists(data) {
  fs.writeFileSync(MANUAL_FINALISTS_FILE, JSON.stringify(data, null, 2));
}

let _siteStateCache = null;
function loadSiteState() {
  if (_siteStateCache !== null) return _siteStateCache;
  try {
    const data = JSON.parse(fs.readFileSync(SITE_STATE_FILE, 'utf8'));
    if (VALID_STATES.includes(data.state)) { _siteStateCache = data; return _siteStateCache; }
  } catch {}
  // Migrate from old results-status.json
  try {
    const old = JSON.parse(fs.readFileSync(RESULTS_STATUS_FILE, 'utf8'));
    if (old.published) { _siteStateCache = { state: 'confirmed' }; return _siteStateCache; }
  } catch {}
  _siteStateCache = { state: 'leaderboard' };
  return _siteStateCache;
}
function saveSiteState(state) {
  const data = { state };
  fs.writeFileSync(SITE_STATE_FILE, JSON.stringify(data, null, 2));
  _siteStateCache = data;
}

async function fetchLeaderboard() {
  try {
    const res = await axios.get(LEADERBOARD_URL, { headers: ANICHESS_HEADERS, timeout: 10000 });
    return res.data?.data || [];
  } catch { return []; }
}

async function fetchPlayerRating(wallet) {
  try {
    const res = await axios.get(`${PLAYER_RATING_URL}/${wallet}`, { headers: ANICHESS_HEADERS, timeout: 8000 });
    return res.data;
  } catch (err) {
    if (err.response?.status === 404) return null;
    throw err;
  }
}

// Paginate match-history-pagination from newest → oldest, stopping once we reach
// a matchId we've already processed. Returns { newWins, maxMatchId }.
async function fetchRankedWinsSince(wallet, lastMatchId) {
  const limit = 50;
  let offset = 0;
  let newWins = 0;
  let maxMatchId = lastMatchId;

  while (true) {
    let res;
    try {
      res = await axios.get(`${MATCH_HISTORY_PAG_URL}/${wallet}`, {
        params: { offset, limit },
        headers: ANICHESS_HEADERS,
        timeout: 15000,
      });
    } catch { break; }

    const data = res.data?.data;
    const items = data?.matchHistories || [];
    const total = data?.totalMatches || 0;
    if (!items.length) break;

    let reachedOld = false;
    for (const m of items) {
      if (m.matchId <= lastMatchId) { reachedOld = true; break; }
      maxMatchId = Math.max(maxMatchId, m.matchId);
      if (m.matchType === 'RANK' && m.matchOutcome === 'WIN') newWins++;
    }

    if (reachedOld || offset + items.length >= total) break;
    offset += items.length;
  }

  return { newWins, maxMatchId };
}

async function fetchProfiles(walletAddresses) {
  if (walletAddresses.length === 0) return [];
  const BATCH = 20;
  const all = [];
  for (let i = 0; i < walletAddresses.length; i += BATCH) {
    const batch = walletAddresses.slice(i, i + BATCH);
    try {
      const res = await axios.get(PROFILES_URL, {
        params: { walletAddresses: batch.join(',') },
        headers: ANICHESS_HEADERS,
        timeout: 10000,
      });
      all.push(...(res.data?.list || []));
    } catch { /* skip failed batch */ }
  }
  return all;
}

async function fetchGambitLeaderboard() {
  try {
    const res = await axios.get(GAMBIT_URL, { headers: ANICHESS_HEADERS, timeout: 10000 });
    return res.data?.data || [];
  } catch { return []; }
}

function parseMatches(matchesArr) {
  const out = { RANK: 0, GAMBIT: 0, M8_ARENA: 0, QUICK: 0, FRIEND: 0 };
  (matchesArr || []).forEach(m => {
    if (m.room_type in out) out[m.room_type] = Number(m.count);
  });
  return out;
}

async function refreshPlayerData() {
  const wallets = loadWallets();
  if (wallets.length === 0) return;

  try {
    const [leaderboard, gambitBoard] = await Promise.all([
      fetchLeaderboard(),
      fetchGambitLeaderboard(),
    ]);

    const lbByWallet = {};
    leaderboard.forEach(e => {
      const key = e.walletAddress?.toLowerCase();
      if (key) lbByWallet[key] = e;
    });

    const gambitByWallet = {};
    gambitBoard.forEach(e => {
      const key = e.walletAddress?.toLowerCase();
      if (key) gambitByWallet[key] = e;
    });

    const [ratingResults, profiles] = await Promise.all([
      Promise.all(wallets.map(w => fetchPlayerRating(w).then(d => ({ wallet: w, data: d })).catch(() => ({ wallet: w, data: null })))),
      fetchProfiles(wallets).catch(() => []),
    ]);

    const profilesByWallet = {};
    profiles.forEach(p => {
      profilesByWallet[p.walletAddress?.toLowerCase()] = p;
    });

    // Paginate full match history per wallet to accumulate accurate lifetime ranked wins.
    // On first run (lastMatchId=0) fetches all pages; on subsequent runs fetches only new pages.
    const winsStore = loadWinsStore();

    const winsResults = await Promise.all(
      wallets.map(async w => {
        const key = w.toLowerCase();
        const stored = winsStore[key] || { rankedWins: 0, lastMatchId: 0 };
        try {
          const { newWins, maxMatchId } = await fetchRankedWinsSince(w, stored.lastMatchId);
          return { wallet: w, newWins, maxMatchId };
        } catch {
          return { wallet: w, newWins: 0, maxMatchId: stored.lastMatchId };
        }
      })
    );

    let winsChanged = false;
    winsResults.forEach(({ wallet, newWins, maxMatchId }) => {
      const key = wallet.toLowerCase();
      if (!winsStore[key]) winsStore[key] = { rankedWins: 0, lastMatchId: 0 };
      if (maxMatchId > (winsStore[key].lastMatchId || 0)) {
        winsStore[key].rankedWins += newWins;
        winsStore[key].lastMatchId = maxMatchId;
        winsChanged = true;
      }
    });

    if (winsChanged) saveWinsStore(winsStore);

    ratingResults.forEach(({ wallet, data }) => {
      const key = wallet.toLowerCase();
      const lb = lbByWallet[key];
      const profile = profilesByWallet[key];
      const gambit = gambitByWallet[key];

      const username    = profile?.username || lb?.username || wallet;
      const avatar      = profile?.image || lb?.pfpUrl || null;
      const gambitScore = gambit ? Number(gambit.score) : null;
      const gambitRank  = gambit ? Number(gambit.rank) : null;
      const rankedWins  = winsStore[key]?.rankedWins ?? 0;

      if (data) {
        playerCache[key] = {
          wallet,
          username,
          avatar,
          rank:        lb?.ranking ?? null,
          rankTier:    lb?.rankingCode ?? null,
          rating:      data.rating,
          matches:     parseMatches(data.matches),
          rankedWins,
          gambitScore,
          gambitRank,
          inTopHundred: !!lb,
          lastUpdated: new Date().toISOString(),
        };
      } else if (playerCache[key]) {
        playerCache[key].gambitScore = gambitScore;
        playerCache[key].gambitRank  = gambitRank;
        playerCache[key].rankedWins  = rankedWins;
        playerCache[key].lastUpdated = new Date().toISOString();
      } else {
        playerCache[key] = {
          wallet,
          username,
          avatar,
          rank:        lb?.ranking ?? null,
          rankTier:    lb?.rankingCode ?? null,
          rating:      null,
          matches:     null,
          rankedWins,
          gambitScore,
          gambitRank,
          inTopHundred: false,
          lastUpdated: new Date().toISOString(),
        };
      }
    });

    lastRefreshed = new Date().toISOString();
    console.log(`[Refresh] Updated ${Object.keys(playerCache).length} players at ${lastRefreshed}`);
  } catch (err) {
    console.error('[Refresh] Error:', err.message);
  }
}

// ── Routes ──────────────────────────────────────────────────────────────────

// Proxy avatar images to same-origin so browser screenshot tools can render them
app.get('/api/proxy-image', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).end();
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== 'avatar.anichess.com') return res.status(403).end();
    const response = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 5000,
      headers: { 'User-Agent': 'AnichessTracker/1.0' },
    });
    res.set('Content-Type', response.headers['content-type'] || 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=3600');
    res.send(Buffer.from(response.data));
  } catch {
    res.status(502).end();
  }
});

app.get('/api/players', (req, res) => {
  const wallets = loadWallets();
  const winsStore = loadWinsStore();
  const playerMeta = loadPlayerMeta();
  const players = wallets.map(w => {
    const key = w.toLowerCase();
    const base = playerCache[key] || {
      wallet: w,
      username: w,
      avatar: null,
      rank: null,
      rankTier: null,
      rating: null,
      matches: null,
      rankedWins: winsStore[key]?.rankedWins ?? 0,
      gambitScore: null,
      gambitRank: null,
      inTopHundred: false,
      lastUpdated: null,
    };
    return { ...base, country: playerMeta[key]?.country || null };
  });

  players.sort((a, b) => {
    if (a.rating == null && b.rating == null) return 0;
    if (a.rating == null) return 1;
    if (b.rating == null) return -1;
    return b.rating - a.rating;
  });

  players.forEach((p, i) => { p.localRank = p.rating != null ? i + 1 : null; });
  res.json(players);
});

app.get('/api/players/:wallet', (req, res) => {
  const raw = req.params.wallet;
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) {
    return res.status(400).json({ error: 'Invalid wallet address format' });
  }
  const key = raw.toLowerCase();
  const cached = playerCache[key];
  if (!cached) return res.status(404).json({ error: 'Player not found or not tracked' });
  res.json(cached);
});

app.get('/api/wallets', requireAdmin, (req, res) => res.json(loadWallets()));

app.post('/api/wallets', requireAdmin, (req, res) => {
  const { address } = req.body;
  if (!address || typeof address !== 'string') return res.status(400).json({ error: 'address is required' });
  if (!/^0x[0-9a-fA-F]{40}$/.test(address.trim())) {
    return res.status(400).json({ error: 'Invalid wallet address format (expected 0x + 40 hex chars)' });
  }
  const wallets = loadWallets();
  const norm = address.trim().toLowerCase();
  if (wallets.some(w => w.toLowerCase() === norm)) {
    return res.status(409).json({ error: 'Wallet already tracked' });
  }
  wallets.push(address.trim());
  try {
    saveWallets(wallets);
  } catch {
    return res.status(500).json({ error: 'Failed to save wallets (disk error)' });
  }
  refreshPlayerData();
  res.json({ ok: true, address: address.trim() });
});

app.post('/api/wallets/bulk', requireAdmin, (req, res) => {
  const { addresses, replace } = req.body;
  if (!Array.isArray(addresses) || addresses.length === 0) {
    return res.status(400).json({ error: 'addresses array is required' });
  }

  if (replace) {
    playerCache = {};
    saveWallets([]);
  }

  const wallets = replace ? [] : loadWallets();
  const existingSet = new Set(wallets.map(w => w.toLowerCase()));
  const added = [], skipped = [], invalid = [];

  addresses.forEach(raw => {
    const addr = (raw || '').trim();
    if (!addr) return;
    if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) { invalid.push(addr); return; }
    if (existingSet.has(addr.toLowerCase())) {
      skipped.push(addr);
    } else {
      wallets.push(addr);
      existingSet.add(addr.toLowerCase());
      added.push(addr);
    }
  });

  try {
    saveWallets(wallets);
  } catch {
    return res.status(500).json({ error: 'Failed to save wallets (disk error)' });
  }
  if (added.length > 0) refreshPlayerData();
  res.json({ ok: true, replaced: !!replace, added: added.length, skipped: skipped.length, invalid: invalid.length, addedList: added });
});

app.delete('/api/wallets/:address', requireAdmin, (req, res) => {
  const norm = req.params.address.toLowerCase();
  const wallets = loadWallets().filter(w => w.toLowerCase() !== norm);
  try {
    saveWallets(wallets);
    delete playerCache[norm];
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'Failed to save wallets (disk error)' });
  }
});

app.delete('/api/wallets', requireAdmin, (req, res) => {
  try {
    saveWallets([]);
    playerCache = {};
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'Failed to clear wallets (disk error)' });
  }
});

// ── Player metadata (country flags, etc.) ────────────────────────────────────

app.get('/api/player-meta', requireAdmin, (req, res) => {
  res.json(loadPlayerMeta());
});

// Public endpoint — returns only country codes, no auth required
app.get('/api/player-countries', (req, res) => {
  const meta = loadPlayerMeta();
  const result = {};
  for (const [key, val] of Object.entries(meta)) {
    if (val.country) result[key] = val.country;
  }
  res.json(result);
});

app.post('/api/player-meta/:wallet', requireAdmin, (req, res) => {
  const raw = req.params.wallet;
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) {
    return res.status(400).json({ error: 'Invalid wallet address format' });
  }
  const key = raw.toLowerCase();
  const country = (req.body.country || '').trim().toUpperCase().slice(0, 2);
  const meta = loadPlayerMeta();
  if (country) {
    meta[key] = { ...meta[key], country };
  } else {
    if (meta[key]) {
      delete meta[key].country;
      if (Object.keys(meta[key]).length === 0) delete meta[key];
    }
  }
  try {
    savePlayerMeta(meta);
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'Failed to save player metadata' });
  }
});

app.get('/api/refresh', refreshRateLimit, async (req, res) => {
  if (Date.now() >= CUTOFF_MS) {
    return res.json({ ok: false, cutoff: true, lastRefreshed });
  }
  await refreshPlayerData();
  res.json({ ok: true, lastRefreshed });
});

// Admin-only force refresh — bypasses cutoff gate, for updating names/avatars post-tournament
app.post('/api/admin/force-refresh', requireAdmin, async (req, res) => {
  try {
    await refreshPlayerData();
    res.json({ ok: true, lastRefreshed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Site state ───────────────────────────────────────────────────────────────

app.get('/api/site-state', (req, res) => {
  res.json(loadSiteState());
});

app.post('/api/site-state', requireAdmin, (req, res) => {
  const { state } = req.body;
  if (!VALID_STATES.includes(state)) return res.status(400).json({ error: 'Invalid state' });
  saveSiteState(state);
  res.json({ ok: true, state });
});

// Legacy alias — kept for any cached browser requests
app.get('/api/results-status', (req, res) => {
  const { state } = loadSiteState();
  res.json({ state, published: state === 'confirmed' });
});

// Lightweight session check — returns { admin } without triggering a 401
app.get('/api/session', (req, res) => {
  const auth = req.headers['authorization'];
  if (!auth || !auth.startsWith('Basic ')) return res.json({ admin: false });
  const [user, pass] = Buffer.from(auth.slice(6), 'base64').toString('utf8').split(':');
  res.json({ admin: user === ADMIN_USER && pass === ADMIN_PASS });
});

app.get('/api/results-data', (req, res, next) => {
  if (loadSiteState().state !== 'confirmed') return requireAdmin(req, res, next);
}, (req, res) => {
  const norm = w => (w || '').trim().toLowerCase();
  const { state } = loadSiteState();
  const quals = loadQualifiers();
  const manual = loadManualFinalists();
  const playerMeta = loadPlayerMeta();
  const wallets = loadWallets();
  const excluded = new Set(loadExcludedWallets().map(norm));

  const allPlayers = wallets.map(w => {
    const key = w.toLowerCase();
    const base = playerCache[key] || { wallet: w, username: w, avatar: null, rank: null, rankTier: null, rating: null, matches: null };
    return { ...base, country: playerMeta[key]?.country || null };
  });

  const lookup = w => allPlayers.find(p => norm(p.wallet) === norm(w)) || { wallet: w, username: w, rating: null, matches: null, avatar: null, country: null };

  const q1 = [quals.qualifier1?.first, quals.qualifier1?.second, quals.qualifier1?.third].filter(Boolean);
  const q2 = [quals.qualifier2?.first, quals.qualifier2?.second, quals.qualifier2?.third].filter(Boolean);
  const qualSet = new Set([...q1, ...q2].map(norm));

  const manualTop8 = (manual.top8 || []).map(norm).filter(Boolean);
  const manualWc   = (manual.wildcards || []).map(norm).filter(Boolean);

  let top8;
  if (manualTop8.length > 0) {
    top8 = manualTop8.map(lookup);
  } else {
    top8 = [...allPlayers]
      .filter(p => !qualSet.has(norm(p.wallet)))
      .sort((a, b) => (b.rating || 0) - (a.rating || 0))
      .slice(0, 8);
  }

  const top8Set = new Set(top8.map(p => norm(p.wallet)));
  const counted = new Set([...qualSet, ...top8Set]);

  let wildcards;
  if (manualWc.length > 0) {
    wildcards = manualWc.map(lookup);
  } else {
    wildcards = [...allPlayers]
      .filter(p => !counted.has(norm(p.wallet)) && !excluded.has(norm(p.wallet)))
      .sort((a, b) => (b.matches || 0) - (a.matches || 0))
      .slice(0, 2);
  }

  res.json({
    state,
    qualifier1: q1.map(lookup),
    qualifier2: q2.map(lookup),
    top8,
    wildcards,
    absent: loadAbsent(),
  });
});

// ── Manual finalists override ────────────────────────────────────────────────

app.get('/api/manual-finalists', requireAdmin, (req, res) => {
  res.json(loadManualFinalists());
});

app.post('/api/manual-finalists', requireAdmin, (req, res) => {
  const clean = (arr, max) =>
    (Array.isArray(arr) ? arr : [])
      .map(w => (typeof w === 'string' ? w.trim() : ''))
      .filter(w => w === '' || /^0x[0-9a-fA-F]{40}$/i.test(w))
      .slice(0, max);
  try {
    saveManualFinalists({
      top8:      clean(req.body.top8,      8),
      wildcards: clean(req.body.wildcards, 2),
    });
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'Failed to save manual finalists' });
  }
});

// ── Badge management (admin-only) ────────────────────────────────────────────

app.get('/api/badges', requireAdmin, (req, res) => {
  const files = fs.existsSync(BADGES_DIR) ? fs.readdirSync(BADGES_DIR) : [];
  res.json(files);
});

app.post('/api/badges', requireAdmin, (req, res) => {
  badgeUpload.single('badge')(req, res, err => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No file received' });
    res.json({ ok: true, filename: req.file.filename });
  });
});

app.delete('/api/badges/:filename', requireAdmin, (req, res) => {
  const filename = path.basename(req.params.filename);
  const filepath = path.join(BADGES_DIR, filename);
  try { fs.unlinkSync(filepath); } catch { /* already gone */ }
  res.json({ ok: true });
});

// ── Background image ─────────────────────────────────────────────────────────

app.get('/api/background', (req, res) => {
  const filename = findBgImage();
  if (!filename) return res.json({ exists: false, filename: null });
  try {
    const stats = fs.statSync(path.join(FRONTEND_DIR, filename));
    res.json({ exists: true, filename, size: stats.size, uploaded: stats.mtime });
  } catch {
    // File disappeared between findBgImage and statSync
    res.json({ exists: false, filename: null });
  }
});

app.post('/api/background', requireAdmin, (req, res) => {
  BG_EXTS.forEach(ext => {
    const f = path.join(FRONTEND_DIR, `bg-image${ext}`);
    try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch {}
  });
  bgUpload.single('background')(req, res, err => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No file received' });
    res.json({ ok: true, filename: req.file.filename });
  });
});

app.delete('/api/background', requireAdmin, (req, res) => {
  BG_EXTS.forEach(ext => {
    const f = path.join(FRONTEND_DIR, `bg-image${ext}`);
    try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch {}
  });
  res.json({ ok: true });
});

// ── Logo image ───────────────────────────────────────────────────────────

app.get('/api/logo', (req, res) => {
  const filename = findLogoImage();
  if (!filename) return res.json({ exists: false, filename: null });
  try {
    const stats = fs.statSync(path.join(FRONTEND_DIR, filename));
    res.json({ exists: true, filename, size: stats.size });
  } catch {
    res.json({ exists: false, filename: null });
  }
});

app.post('/api/logo', requireAdmin, (req, res) => {
  LOGO_EXTS.forEach(ext => {
    const f = path.join(FRONTEND_DIR, `logo-image${ext}`);
    try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch {}
  });
  logoUpload.single('logo')(req, res, err => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No file received' });
    res.json({ ok: true, filename: req.file.filename });
  });
});

app.delete('/api/logo', requireAdmin, (req, res) => {
  LOGO_EXTS.forEach(ext => {
    const f = path.join(FRONTEND_DIR, `logo-image${ext}`);
    try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch {}
  });
  res.json({ ok: true });
});

// ── Tournament ───────────────────────────────────────────────────────────────

app.get('/api/tournament', (req, res) => {
  const logoFile = findTournamentLogo();
  const { details } = loadTournamentDetails();
  res.json({
    logo: logoFile ? { exists: true, filename: logoFile } : { exists: false, filename: null },
    details: details || '',
  });
});

app.post('/api/tournament/logo', requireAdmin, (req, res) => {
  LOGO_EXTS.forEach(ext => {
    const f = path.join(FRONTEND_DIR, `tournament-logo${ext}`);
    try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch {}
  });
  tournamentLogoUpload.single('logo')(req, res, err => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No file received' });
    res.json({ ok: true, filename: req.file.filename });
  });
});

app.delete('/api/tournament/logo', requireAdmin, (req, res) => {
  LOGO_EXTS.forEach(ext => {
    const f = path.join(FRONTEND_DIR, `tournament-logo${ext}`);
    try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch {}
  });
  res.json({ ok: true });
});

app.post('/api/tournament/details', requireAdmin, (req, res) => {
  const { details } = req.body;
  if (typeof details !== 'string') return res.status(400).json({ error: 'details must be a string' });
  try {
    saveTournamentDetails({ details });
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'Failed to save tournament details (disk error)' });
  }
});

// ── Playoff qualifiers ───────────────────────────────────────────────────────

app.get('/api/qualifiers', (req, res) => {
  res.json(loadQualifiers());
});

app.post('/api/qualifiers', requireAdmin, (req, res) => {
  const { qualifier1, qualifier2 } = req.body;
  if (!qualifier1 || !qualifier2) return res.status(400).json({ error: 'qualifier1 and qualifier2 required' });
  try {
    saveQualifiers({ qualifier1, qualifier2 });
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'Failed to save qualifiers (disk error)' });
  }
});

app.get('/api/absent', (req, res) => {
  res.json(loadAbsent());
});

app.post('/api/absent', requireAdmin, (req, res) => {
  const { wallets } = req.body;
  if (!Array.isArray(wallets)) return res.status(400).json({ error: 'wallets array required' });
  const valid = wallets.filter(w => typeof w === 'string' && w.trim()).map(w => w.trim().toLowerCase());
  try {
    saveAbsent(valid);
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'Failed to save absent list' });
  }
});

app.get('/api/excluded-wallets', (req, res) => {
  res.json(loadExcludedWallets());
});

app.post('/api/excluded-wallets', requireAdmin, (req, res) => {
  const { addresses } = req.body;
  if (!Array.isArray(addresses)) return res.status(400).json({ error: 'addresses array required' });
  const valid = addresses
    .filter(a => typeof a === 'string')
    .map(a => a.trim().toLowerCase())
    .filter(a => /^0x[0-9a-f]{40}$/.test(a));
  try {
    saveExcludedWallets(valid);
    res.json({ ok: true, count: valid.length });
  } catch {
    res.status(500).json({ error: 'Failed to save exclusions (disk error)' });
  }
});

app.delete('/api/excluded-wallets', requireAdmin, (req, res) => {
  try {
    saveExcludedWallets([]);
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'Failed to clear exclusions (disk error)' });
  }
});

// ── Branding kit (admin-only) ────────────────────────────────────────────────

app.get('/api/branding/pdf', requireAdmin, (req, res) => {
  try {
    const files = fs.existsSync(BRANDING_DIR)
      ? fs.readdirSync(BRANDING_DIR).filter(f => f.endsWith('.pdf'))
      : [];
    const details = files.reduce((acc, f) => {
      try {
        const stats = fs.statSync(path.join(BRANDING_DIR, f));
        acc.push({ filename: f, size: stats.size, uploaded: stats.mtime });
      } catch { /* file disappeared between readdir and stat — skip it */ }
      return acc;
    }, []);
    res.json(details);
  } catch (err) {
    console.error('[/api/branding/pdf] Read error:', err.message);
    res.status(500).json({ error: 'Failed to list branding files' });
  }
});

app.post('/api/branding/pdf', requireAdmin, (req, res) => {
  pdfUpload.single('pdf')(req, res, err => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No file received' });
    res.json({ ok: true, filename: req.file.filename });
  });
});

app.delete('/api/branding/pdf/:filename', requireAdmin, (req, res) => {
  const filename = path.basename(req.params.filename);
  const filepath = path.join(BRANDING_DIR, filename);
  try { fs.unlinkSync(filepath); } catch { /* already gone */ }
  res.json({ ok: true });
});

app.get('/api/status', (req, res) => {
  res.json({ tracked: loadWallets().length, cached: Object.keys(playerCache).length, lastRefreshed, pastCutoff: Date.now() >= CUTOFF_MS });
});

// ── Brackets ──────────────────────────────────────────────────────────────────

app.get('/api/brackets', (req, res) => res.json(loadBrackets()));

app.post('/api/brackets/setup', requireAdmin, (req, res) => {
  const { playerCount, seeds } = req.body;
  if (![8, 16].includes(playerCount)) return res.status(400).json({ error: 'playerCount must be 8 or 16' });
  if (!Array.isArray(seeds)) return res.status(400).json({ error: 'seeds array required' });
  const data = loadBrackets();
  data.playerCount = playerCount;
  data.seeds = seeds;
  data.status = 'setup';
  try { saveBrackets(data); res.json({ ok: true }); }
  catch { res.status(500).json({ error: 'Failed to save bracket' }); }
});

app.post('/api/brackets/generate', requireAdmin, (req, res) => {
  try {
    const data = loadBrackets();
    const pc = data.playerCount;
    if (!Array.isArray(data.seeds) || data.seeds.length < pc) {
      return res.status(400).json({ error: `Need ${pc} seeds, got ${(data.seeds||[]).length}. Save seeds first.` });
    }
    const empty = data.seeds.filter(s => !s.wallet || !s.wallet.trim());
    if (empty.length > 0) {
      return res.status(400).json({ error: `${empty.length} seed slot(s) are empty` });
    }
    data.rounds = generateBracketRounds(data.seeds, pc);
    data.status = 'active';
    data.champion = null;
    saveBrackets(data);
    res.json({ ok: true });
  } catch (err) {
    console.error('[/api/brackets/generate] Error:', err.message, '\n', err.stack);
    if (!res.headersSent) res.status(500).json({ error: err.message || 'Failed to generate bracket' });
  }
});

app.post('/api/brackets/game', requireAdmin, (req, res) => {
  const { roundId, matchIndex, result } = req.body;
  if (!['p1', 'p2', 'draw'].includes(result)) return res.status(400).json({ error: 'result must be p1, p2, or draw' });
  const data = loadBrackets();
  const round = data.rounds.find(r => r.id === roundId);
  if (!round) return res.status(404).json({ error: 'Round not found' });
  const match = round.matches[matchIndex];
  if (!match) return res.status(404).json({ error: 'Match not found' });
  if (match.winner) return res.status(400).json({ error: 'Match already decided' });
  match.games.push(result);
  match.status = 'live';
  match.score = match.games.reduce((acc, g) => {
    if (g === 'p1') acc.p1++;
    else if (g === 'p2') acc.p2++;
    return acc;
  }, { p1: 0, p2: 0 });
  if (match.score.p1 >= round.winsNeeded) {
    match.winner = match.p1.wallet; match.loser = match.p2.wallet; match.status = 'done';
    propagateBracketResult(data, roundId, matchIndex);
  } else if (match.score.p2 >= round.winsNeeded) {
    match.winner = match.p2.wallet; match.loser = match.p1.wallet; match.status = 'done';
    propagateBracketResult(data, roundId, matchIndex);
  }
  try { saveBrackets(data); res.json({ ok: true, match }); }
  catch { res.status(500).json({ error: 'Failed to save bracket' }); }
});

app.post('/api/brackets/undo', requireAdmin, (req, res) => {
  const { roundId, matchIndex } = req.body;
  const data = loadBrackets();
  const round = data.rounds.find(r => r.id === roundId);
  if (!round) return res.status(404).json({ error: 'Round not found' });
  const match = round.matches[matchIndex];
  if (!match || match.games.length === 0) return res.status(400).json({ error: 'No games to undo' });
  const hadWinner = !!match.winner;
  match.games.pop();
  match.score = match.games.reduce((acc, g) => {
    if (g === 'p1') acc.p1++;
    else if (g === 'p2') acc.p2++;
    return acc;
  }, { p1: 0, p2: 0 });
  match.winner = null; match.loser = null;
  match.status = match.games.length ? 'live' : 'upcoming';
  // If the undone game was the deciding game, clear the propagated slot in subsequent rounds
  if (hadWinner) clearPropagated(data, roundId, matchIndex);
  try { saveBrackets(data); res.json({ ok: true, match }); }
  catch { res.status(500).json({ error: 'Failed to save bracket' }); }
});

app.delete('/api/brackets', requireAdmin, (req, res) => {
  try {
    const existing = loadBrackets();
    saveBrackets({ status: 'setup', playerCount: 8, seeds: [], rounds: [], champion: null, bracketName: existing.bracketName || '' });
    res.json({ ok: true });
  } catch { res.status(500).json({ error: 'Failed to reset bracket' }); }
});

app.post('/api/brackets/name', requireAdmin, (req, res) => {
  try {
    const data = loadBrackets();
    data.bracketName = (req.body.name || '').trim().slice(0, 200);
    saveBrackets(data);
    res.json({ ok: true });
  } catch { res.status(500).json({ error: 'Failed to save name' }); }
});

app.get('/api/bracket-background', (req, res) => {
  const filename = findBracketBgImage();
  if (!filename) return res.json({ exists: false, filename: null });
  try {
    fs.statSync(path.join(FRONTEND_DIR, filename));
    res.json({ exists: true, filename });
  } catch { res.json({ exists: false, filename: null }); }
});

app.post('/api/bracket-background', requireAdmin, (req, res) => {
  BG_EXTS.forEach(ext => {
    const f = path.join(FRONTEND_DIR, `bracket-bg-image${ext}`);
    try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch {}
  });
  bracketBgUpload.single('background')(req, res, err => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No file received' });
    res.json({ ok: true, filename: req.file.filename });
  });
});

app.delete('/api/bracket-background', requireAdmin, (req, res) => {
  BG_EXTS.forEach(ext => {
    const f = path.join(FRONTEND_DIR, `bracket-bg-image${ext}`);
    try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch {}
  });
  res.json({ ok: true });
});

function generateBracketRounds(seeds, playerCount) {
  const winsNeeded = bo => Math.ceil(bo / 2);
  const makeMatch = id => ({ id, p1: null, p2: null, games: [], score: { p1: 0, p2: 0 }, winner: null, loser: null, status: 'pending' });

  const roundDefs = playerCount === 16 ? [
    { id: 'r16', name: 'Round of 16', bestOf: 1, matchCount: 8 },
    { id: 'qf',  name: 'Quarterfinals', bestOf: 1, matchCount: 4 },
    { id: 'sf',  name: 'Semifinals', bestOf: 3, matchCount: 2 },
    { id: '3rd', name: 'Third Place', bestOf: 3, matchCount: 1, isThirdPlace: true },
    { id: 'gf',  name: 'Grand Final', bestOf: 5, matchCount: 1 },
  ] : [
    { id: 'qf',  name: 'Quarterfinals', bestOf: 1, matchCount: 4 },
    { id: 'sf',  name: 'Semifinals', bestOf: 3, matchCount: 2 },
    { id: '3rd', name: 'Third Place', bestOf: 3, matchCount: 1, isThirdPlace: true },
    { id: 'gf',  name: 'Grand Final', bestOf: 5, matchCount: 1 },
  ];

  const rounds = roundDefs.map(d => ({
    ...d,
    winsNeeded: winsNeeded(d.bestOf),
    matches: Array.from({ length: d.matchCount }, (_, i) => makeMatch(`${d.id}-${i}`)),
  }));

  const s = seeds.map(sd => sd.wallet ? { wallet: sd.wallet, seed: sd.seed } : null);

  if (playerCount === 16) {
    const pairs = [[0,15],[7,8],[3,12],[4,11],[1,14],[6,9],[2,13],[5,10]];
    const firstRound = rounds[0].matches;
    pairs.forEach(([a, b], i) => {
      firstRound[i].p1 = s[a]; firstRound[i].p2 = s[b];
      if (firstRound[i].p1 && firstRound[i].p2) firstRound[i].status = 'upcoming';
    });
  } else {
    const pairs = [[0,7],[3,4],[1,6],[2,5]];
    const firstRound = rounds[0].matches;
    pairs.forEach(([a, b], i) => {
      firstRound[i].p1 = s[a]; firstRound[i].p2 = s[b];
      if (firstRound[i].p1 && firstRound[i].p2) firstRound[i].status = 'upcoming';
    });
  }
  return rounds;
}

function propagateBracketResult(data, fromRoundId, matchIndex) {
  const rounds = data.rounds;
  const fromRound = rounds.find(r => r.id === fromRoundId);
  const fromMatch = fromRound.matches[matchIndex];
  const winnerWallet = fromMatch.winner;
  const loserWallet = fromMatch.loser;
  const winnerInfo = winnerWallet === fromMatch.p1.wallet ? fromMatch.p1 : fromMatch.p2;
  const loserInfo  = loserWallet  === fromMatch.p1.wallet ? fromMatch.p1 : fromMatch.p2;

  if (fromRoundId === 'gf') {
    data.champion = winnerWallet;
    data.status = 'complete';
    return;
  }

  if (fromRound.isThirdPlace) return; // Terminal — no further propagation

  if (fromRoundId === 'sf') {
    const gf      = rounds.find(r => r.id === 'gf');
    const tp      = rounds.find(r => r.id === '3rd');
    const sfRound = rounds.find(r => r.id === 'sf');
    const sf0 = sfRound.matches[0];
    const sf1 = sfRound.matches[1];
    // Only populate GF and 3rd-place once BOTH semi-finals are complete
    if (sf0.winner && sf1.winner) {
      const pick = (m, w) => w === m.p1.wallet ? m.p1 : m.p2;
      if (gf) {
        gf.matches[0].p1 = pick(sf0, sf0.winner);
        gf.matches[0].p2 = pick(sf1, sf1.winner);
        gf.matches[0].status = 'upcoming';
      }
      if (tp) {
        tp.matches[0].p1 = pick(sf0, sf0.loser);
        tp.matches[0].p2 = pick(sf1, sf1.loser);
        tp.matches[0].status = 'upcoming';
      }
    }
    return;
  }

  // Standard: find next non-third-place round
  const fromIdx = rounds.findIndex(r => r.id === fromRoundId);
  let nextRound = null;
  for (let i = fromIdx + 1; i < rounds.length; i++) {
    if (!rounds[i].isThirdPlace) { nextRound = rounds[i]; break; }
  }
  if (!nextRound) return;

  const nextMatchIdx = Math.floor(matchIndex / 2);
  const nextMatch = nextRound.matches[nextMatchIdx];
  if (!nextMatch) return;
  if (matchIndex % 2 === 0) nextMatch.p1 = winnerInfo;
  else nextMatch.p2 = winnerInfo;
  if (nextMatch.p1 && nextMatch.p2) nextMatch.status = 'upcoming';
}

function clearPropagated(data, fromRoundId, matchIndex) {
  const rounds = data.rounds;

  if (fromRoundId === 'gf') {
    data.champion = null;
    data.status   = 'active';
    return;
  }

  const fromRound = rounds.find(r => r.id === fromRoundId);
  if (fromRound && fromRound.isThirdPlace) return; // Terminal — nothing to clear forward

  if (fromRoundId === 'sf') {
    const gf = rounds.find(r => r.id === 'gf');
    const tp = rounds.find(r => r.id === '3rd');
    // Both slots were written atomically, so clear both entirely
    if (gf && gf.matches[0]) {
      gf.matches[0].p1 = null; gf.matches[0].p2 = null;
      gf.matches[0].status = 'pending';
      gf.matches[0].winner = null; gf.matches[0].loser = null;
      gf.matches[0].games  = [];   gf.matches[0].score = { p1: 0, p2: 0 };
      data.champion = null;
      if (data.status === 'complete') data.status = 'active';
    }
    if (tp && tp.matches[0]) {
      tp.matches[0].p1 = null; tp.matches[0].p2 = null;
      tp.matches[0].status = 'pending';
      tp.matches[0].winner = null; tp.matches[0].loser = null;
      tp.matches[0].games  = [];   tp.matches[0].score = { p1: 0, p2: 0 };
    }
    return;
  }

  // Standard: find the next non-third-place round and clear the slot
  const fromIdx = rounds.findIndex(r => r.id === fromRoundId);
  let nextRound = null;
  for (let i = fromIdx + 1; i < rounds.length; i++) {
    if (!rounds[i].isThirdPlace) { nextRound = rounds[i]; break; }
  }
  if (!nextRound) return;

  const nextMatchIdx = Math.floor(matchIndex / 2);
  const nextMatch    = nextRound.matches[nextMatchIdx];
  if (!nextMatch) return;

  if (matchIndex % 2 === 0) nextMatch.p1 = null;
  else                      nextMatch.p2 = null;
  nextMatch.status = 'pending';
  // If the next match was already decided, cascade the clear upward
  if (nextMatch.winner) {
    nextMatch.winner = null; nextMatch.loser  = null;
    nextMatch.games  = [];   nextMatch.score  = { p1: 0, p2: 0 };
    clearPropagated(data, nextRound.id, nextMatchIdx);
  }
}

cron.schedule('*/5 * * * *', () => {
  if (Date.now() >= CUTOFF_MS) {
    console.log('[Cron] Past cutoff — skipping refresh');
    return;
  }
  console.log('[Cron] Refreshing player data...');
  refreshPlayerData();
});

// Catch any unhandled promise rejections so they don't crash the process silently
process.on('unhandledRejection', (reason, promise) => {
  console.error('[UnhandledRejection]', reason);
});

app.listen(PORT, () => {
  console.log(`[Server] Anichess Tracker running on http://localhost:${PORT}`);
  refreshPlayerData();
});
