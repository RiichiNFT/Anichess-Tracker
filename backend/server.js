require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const axios = require('axios');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const multer = require('multer');
const { randomUUID } = require('crypto');

// Simple in-process rate limiter for /api/refresh (no extra dep required)
function makeRateLimiter(windowMs, maxRequests) {
  const hits = new Map(); // ip -> [timestamp, ...]
  setInterval(() => {
    const now = Date.now();
    for (const [ip, times] of hits.entries()) {
      const recent = times.filter(t => now - t < windowMs);
      if (recent.length === 0) hits.delete(ip);
      else hits.set(ip, recent);
    }
  }, 10 * 60 * 1000).unref();
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
// Allow at most 30 admin actions per IP per minute
const adminRateLimit = makeRateLimiter(60 * 1000, 30);

const app = express();
const PORT = parseInt(process.env.PORT || '4000', 10);

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "cdn.jsdelivr.net", "www.googletagmanager.com", "www.google-analytics.com"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", "fonts.googleapis.com"],
      fontSrc: ["'self'", "fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "https:", "flagcdn.com", "*.flagcdn.com", "avatar.anichess.com", "*.anichess.com"],
      connectSrc: ["'self'", "www.google-analytics.com"],
      frameSrc: ["'self'"],
      frameAncestors: ["'self'", "*"],
    },
  },
  crossOriginResourcePolicy: false,   // avatar images served cross-origin
  frameguard: false,                  // bracket-public.html supports ?embed=1 on external sites
}));

const WALLETS_FILE       = path.join(__dirname, 'watched-wallets.json');
const WINS_FILE          = path.join(__dirname, 'wins-store.json');
const FRONTEND_DIR       = path.join(__dirname, '..', 'frontend');
const BADGES_DIR         = path.join(FRONTEND_DIR, 'badges');
const BRANDING_DIR       = path.join(__dirname, 'branding');
const FINALS_AVATARS_DIR = path.join(FRONTEND_DIR, 'finals-avatars');

if (!fs.existsSync(BADGES_DIR))         fs.mkdirSync(BADGES_DIR,         { recursive: true });
if (!fs.existsSync(BRANDING_DIR))       fs.mkdirSync(BRANDING_DIR,       { recursive: true });
if (!fs.existsSync(FINALS_AVATARS_DIR)) fs.mkdirSync(FINALS_AVATARS_DIR, { recursive: true });

const VALID_TIERS        = new Set(['pawn','knight','bishop','rook','queen','king','legend']);
const BG_EXTS            = ['.webp', '.jpg', '.jpeg', '.png', '.gif'];
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
const MATCH_BASELINE_FILE      = path.join(__dirname, 'match-baseline.json');
const TOURNAMENT_CONFIG_FILE   = path.join(__dirname, 'tournament-config.json');
const PAST_EVENTS_FILE         = path.join(__dirname, 'past-events.json');
const GUIDES_FILE              = path.join(__dirname, 'guides.json');
const GAME_UPDATES_FILE        = path.join(__dirname, 'game-updates.json');
const FINALS_FILE              = path.join(__dirname, 'finals-data.json');
const PLAYER_CACHE_FILE        = path.join(__dirname, 'player-cache.json');

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

function deleteImageFiles(dir, prefix, exts) {
  exts.forEach(ext => {
    const f = path.join(dir, `${prefix}${ext}`);
    try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch {}
  });
}

function loadTournamentDetails() {
  try { return JSON.parse(fs.readFileSync(TOURNAMENT_DETAILS_FILE, 'utf8')); } catch { return { details: '' }; }
}

function saveTournamentDetails(data) {
  try { fs.writeFileSync(TOURNAMENT_DETAILS_FILE, JSON.stringify(data, null, 2)); }
  catch (err) { console.error('[saveTournamentDetails] Write failed:', err.message); throw err; }
}

const EMPTY_QUALIFIERS = {
  qualifier1: { label: 'Top 3 · LICHESS QUALIFIERS III', confirmed: false, first: '', second: '', third: '' },
  qualifier2: { label: 'Top 3 · Lichess Team Battle',    confirmed: false, first: '', second: '', third: '' },
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

const DEFAULT_ROUND_FORMATS = { r16: 1, qf: 1, sf: 3, '3rd': 3, gf: 5 };

function loadBrackets() {
  try {
    const data = JSON.parse(fs.readFileSync(BRACKETS_FILE, 'utf8'));
    if (!data.roundFormats) data.roundFormats = { ...DEFAULT_ROUND_FORMATS };
    return data;
  } catch {
    return { status: 'setup', playerCount: 8, seeds: [], rounds: [], champion: null, bracketName: '', roundFormats: { ...DEFAULT_ROUND_FORMATS } };
  }
}
function saveBrackets(data) {
  fs.writeFileSync(BRACKETS_FILE, JSON.stringify(data, null, 2));
}

function loadTournamentConfig() {
  try { return JSON.parse(fs.readFileSync(TOURNAMENT_CONFIG_FILE, 'utf8')); }
  catch {
    return {
      tournamentNumber: 2, name: 'Anichess Rising Stars Tournament #2',
      finalDate: 'May 23, 2026', finalTime: '13:00 UTC', prizePool: '$600 USD',
      cutoffTimestamp: 1779408000, cutoffDisplay: 'MAY 21ST · UTC 00:00',
      qualifyCount: 16, registrationUrl: 'https://forms.gle/EpSddHt3G7DauEiu5',
      lichessQualifierUrl: 'https://lichess.org/tournament/eQiOIvDu',
      qualifier1Label: 'Top 3 · LICHESS QUALIFIERS III',
      qualifier2Label: 'Top 3 · Lichess Team Battle',
      discordUrl: 'https://discord.com/invite/anichess',
    };
  }
}
function saveTournamentConfig(data) {
  fs.writeFileSync(TOURNAMENT_CONFIG_FILE, JSON.stringify(data, null, 2));
}

function loadPastEvents() {
  try { return JSON.parse(fs.readFileSync(PAST_EVENTS_FILE, 'utf8')); }
  catch { return []; }
}
function savePastEvents(data) {
  fs.writeFileSync(PAST_EVENTS_FILE, JSON.stringify(data, null, 2));
}
function loadGuides() {
  try { return JSON.parse(fs.readFileSync(GUIDES_FILE, 'utf8')); }
  catch { return []; }
}
function saveGuides(data) {
  fs.writeFileSync(GUIDES_FILE, JSON.stringify(data, null, 2));
}
function loadGameUpdates() {
  try { return JSON.parse(fs.readFileSync(GAME_UPDATES_FILE, 'utf8')); }
  catch { return []; }
}
function saveGameUpdates(data) {
  fs.writeFileSync(GAME_UPDATES_FILE, JSON.stringify(data, null, 2));
}

const FINALS_DEFAULT_PLAYERS = [
  { id: 1, wallet: '', name: '', title: '', country: '' },
  { id: 2, wallet: '', name: '', title: '', country: '' },
  { id: 3, wallet: '', name: '', title: '', country: '' },
  { id: 4, wallet: '', name: '', title: '', country: '' },
  { id: 5, wallet: '', name: '', title: '', country: '' },
  { id: 6, wallet: '', name: '', title: '', country: '' },
];
const FINALS_DEFAULT_ROUNDS = Array.from({ length: 5 }, (_, i) => ({
  n: i + 1,
  games: [
    { white: null, black: null, result: null },
    { white: null, black: null, result: null },
    { white: null, black: null, result: null },
  ],
}));
function loadFinals() {
  try { return JSON.parse(fs.readFileSync(FINALS_FILE, 'utf8')); }
  catch {
    return {
      status: 'upcoming',
      players: FINALS_DEFAULT_PLAYERS.map(p => ({ ...p })),
      rounds: FINALS_DEFAULT_ROUNDS.map(r => ({ ...r, games: r.games.map(g => ({ ...g })) })),
      grandFinal: { p1: null, p2: null, result: null, format: 'bo1', scoreP1: 0, scoreP2: 0 },
    };
  }
}
function saveFinals(data) {
  fs.writeFileSync(FINALS_FILE, JSON.stringify(data, null, 2));
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

const finalsAvatarUpload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (req, file, cb) => {
    if (!/^image\/(png|jpeg|webp|gif)$/.test(file.mimetype)) {
      return cb(new Error('Only image files allowed (PNG, JPG, WebP, GIF)'));
    }
    cb(null, true);
  },
  limits: { fileSize: 5 * 1024 * 1024 },
});

const LEADERBOARD_URL       = 'https://apiv2.pvp.anichess.com/rating/leaderboard';
const PLAYER_RATING_URL     = 'https://apiv2.pvp.anichess.com/player/rating';
const MATCH_HISTORY_PAG_URL = 'https://apiv2.pvp.anichess.com/player/match-history-pagination';
const PROFILES_URL          = 'https://api.auth.anichess.com/v4/profiles';
const GAMBIT_URL            = 'https://apiv2.pvp.anichess.com/match/gambit-leaderboard';

const ANICHESS_HEADERS = { Origin: 'https://anichess.com', Referer: 'https://anichess.com/' };

const CUTOFF_MS  = parseInt(process.env.CUTOFF_TIMESTAMP || '1778284800', 10) * 1000;

const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS;

if (!ADMIN_PASS) {
  console.error('[Fatal] ADMIN_PASS env var is not set. Create backend/.env — see .env.example');
  process.exit(1);
}
if (!ADMIN_USER) {
  console.error('[Fatal] ADMIN_USER env var is not set. Create backend/.env — see .env.example');
  process.exit(1);
}

function requireAdmin(req, res, next) {
  adminRateLimit(req, res, () => {
    const auth = req.headers['authorization'];
    if (!auth || !auth.startsWith('Basic ')) {
      res.set('WWW-Authenticate', 'Basic realm="Anichess Admin"');
      return res.status(401).send('Authentication required');
    }
    const [user, ...rest] = Buffer.from(auth.slice(6), 'base64').toString('utf8').split(':');
    const pass = rest.join(':');
    if (user !== ADMIN_USER || pass !== ADMIN_PASS) {
      res.set('WWW-Authenticate', 'Basic realm="Anichess Admin"');
      return res.status(401).send('Invalid credentials');
    }
    // CSRF: require custom header on state-changing requests
    if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) {
      if (req.headers['x-requested-with'] !== 'XMLHttpRequest') {
        return res.status(403).json({ error: 'CSRF check failed' });
      }
    }
    next();
  });
}

const ALLOWED_ORIGINS = ['https://anichesstracker.com', 'https://www.anichesstracker.com'];
if (process.env.NODE_ENV !== 'production') {
  ALLOWED_ORIGINS.push('http://localhost:4000');
}
app.use(cors({
  origin: ALLOWED_ORIGINS,
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

// Admin panel — auth is handled client-side; all API mutations still require requireAdmin
app.get('/admin.html', (req, res) => {
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

// Guides pages — admin-only
app.get('/guides.html', (req, res) => {
  res.sendFile(path.join(FRONTEND_DIR, 'guides.html'));
});
app.get('/guides-admin.html', requireAdmin, (req, res) => {
  res.sendFile(path.join(FRONTEND_DIR, 'guides-admin.html'));
});

app.get('/magnus.html', (req, res) => {
  res.sendFile(path.join(FRONTEND_DIR, 'magnus.html'));
});

app.get('/updates.html', (req, res) => {
  res.sendFile(path.join(FRONTEND_DIR, 'updates.html'));
});

app.get('/updates-admin.html', requireAdmin, (req, res) => {
  res.sendFile(path.join(FRONTEND_DIR, 'updates-admin.html'));
});

app.get('/magnus-finals-admin.html', requireAdmin, (req, res) => {
  res.sendFile(path.join(FRONTEND_DIR, 'magnus-finals-admin.html'));
});

app.use(express.static(FRONTEND_DIR));

let playerCache = {};
let lastRefreshed = null;

// Restore playerCache from disk immediately so names/avatars are available on startup
// before the async refreshPlayerData() call finishes.
try {
  const saved = JSON.parse(fs.readFileSync(PLAYER_CACHE_FILE, 'utf8'));
  if (saved && typeof saved === 'object') {
    playerCache = saved;
    console.log(`[Startup] Restored playerCache for ${Object.keys(playerCache).length} players from disk`);
  }
} catch { /* file not yet created — first run */ }

let _walletsCache = null;
let _winsStoreCache = null;
function loadWallets() {
  if (_walletsCache !== null) return _walletsCache;
  try { _walletsCache = JSON.parse(fs.readFileSync(WALLETS_FILE, 'utf8')); }
  catch { _walletsCache = []; }
  return _walletsCache;
}

function saveWallets(wallets) {
  try {
    fs.writeFileSync(WALLETS_FILE, JSON.stringify(wallets, null, 2));
    _walletsCache = wallets;
  }
  catch (err) { console.error('[saveWallets] Write failed:', err.message); throw err; }
}

function loadWinsStore() {
  if (_winsStoreCache !== null) return _winsStoreCache;
  try { _winsStoreCache = JSON.parse(fs.readFileSync(WINS_FILE, 'utf8')); }
  catch { _winsStoreCache = {}; }
  return _winsStoreCache;
}

function saveWinsStore(store) {
  try {
    fs.writeFileSync(WINS_FILE, JSON.stringify(store, null, 2));
    _winsStoreCache = store;
  }
  catch (err) { console.error('[saveWinsStore] Write failed:', err.message); throw err; }
}

function loadMatchBaseline() {
  try { return JSON.parse(fs.readFileSync(MATCH_BASELINE_FILE, 'utf8')); } catch { return { timestamp: null, baselines: {} }; }
}

function saveMatchBaseline(data) {
  try { fs.writeFileSync(MATCH_BASELINE_FILE, JSON.stringify(data, null, 2)); }
  catch (err) { console.error('[saveMatchBaseline] Write failed:', err.message); throw err; }
}

let _playerMetaCache = null;
function loadPlayerMeta() {
  if (_playerMetaCache !== null) return _playerMetaCache;
  try { _playerMetaCache = JSON.parse(fs.readFileSync(PLAYER_META_FILE, 'utf8')); }
  catch { _playerMetaCache = {}; }
  return _playerMetaCache;
}

function savePlayerMeta(meta) {
  try {
    fs.writeFileSync(PLAYER_META_FILE, JSON.stringify(meta, null, 2));
    _playerMetaCache = meta;
  }
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
  } catch (err) { console.error('[fetchLeaderboard]', err.message); return []; }
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
    } catch (err) { console.error('[fetchRankedWinsSince] pagination failed:', err.message); break; }

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

// Count matches by type that ended on or after cutoffIso (newest-first pagination).
// Stops as soon as a match is found before the cutoff — efficient for recent baselines.
async function countMatchesAfterTimestamp(wallet, cutoffIso) {
  const cutoff = new Date(cutoffIso).getTime();
  const limit = 50;
  let offset = 0;
  const counts = { RANK: 0, GAMBIT: 0, M8_ARENA: 0, QUICK: 0, FRIEND: 0 };

  while (true) {
    let res;
    try {
      res = await axios.get(`${MATCH_HISTORY_PAG_URL}/${wallet}`, {
        params: { offset, limit },
        headers: ANICHESS_HEADERS,
        timeout: 15000,
      });
    } catch (err) { console.error('[countMatchesAfterTimestamp] pagination failed:', err.message); break; }

    const data = res.data?.data;
    const items = data?.matchHistories || [];
    const total = data?.totalMatches || 0;
    if (!items.length) break;

    let reachedBefore = false;
    for (const m of items) {
      const t = m.gameEndTimestamp ? new Date(m.gameEndTimestamp).getTime() : 0;
      if (t < cutoff) { reachedBefore = true; break; }
      if (m.matchType in counts) counts[m.matchType]++;
    }

    if (reachedBefore || offset + items.length >= total) break;
    offset += items.length;
  }

  return counts;
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
    } catch (err) { console.error('[fetchProfiles] batch failed:', err.message); }
  }
  return all;
}

async function fetchGambitLeaderboard() {
  try {
    const res = await axios.get(GAMBIT_URL, { headers: ANICHESS_HEADERS, timeout: 10000 });
    return res.data?.data || [];
  } catch (err) { console.error('[fetchGambitLeaderboard]', err.message); return []; }
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
      Promise.all(wallets.map(w => fetchPlayerRating(w).then(d => ({ wallet: w, data: d })).catch(err => { console.error('[refreshPlayerData] fetchPlayerRating failed for', w, err.message); return { wallet: w, data: null }; }))),
      fetchProfiles(wallets).catch(err => { console.error('[refreshPlayerData] fetchProfiles failed:', err.message); return []; }),
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
        } catch (err) {
          console.error('[refreshPlayerData] fetchRankedWinsSince failed for', w, err.message);
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
    // Persist cache to disk so it survives server restarts
    try { fs.writeFileSync(PLAYER_CACHE_FILE, JSON.stringify(playerCache)); }
    catch (e) { console.error('[Refresh] Failed to save player cache:', e.message); }
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
  res.set('Cache-Control', 'no-store');
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
  if (!raw || raw.length > 200) return res.status(400).json({ error: 'Invalid key' });
  const key = raw.toLowerCase();
  const { country, alias } = req.body;
  const meta = loadPlayerMeta();
  if (!meta[key]) meta[key] = {};

  if (country !== undefined) {
    const c = (country || '').trim().toUpperCase().slice(0, 2);
    if (c) meta[key].country = c; else delete meta[key].country;
  }
  if (alias !== undefined) {
    const a = (alias || '').trim().slice(0, 100);
    if (a) meta[key].alias = a; else delete meta[key].alias;
  }

  if (Object.keys(meta[key]).length === 0) delete meta[key];
  try {
    savePlayerMeta(meta);
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'Failed to save player metadata' });
  }
});

// Public endpoint — returns only aliases, no auth required
app.get('/api/player-aliases', (req, res) => {
  const meta = loadPlayerMeta();
  const result = {};
  for (const [key, val] of Object.entries(meta)) {
    if (val.alias) result[key] = val.alias;
  }
  res.set('Cache-Control', 'no-store');
  res.json(result);
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
  res.set('Cache-Control', 'public, max-age=30');
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
  const [user, ...rest] = Buffer.from(auth.slice(6), 'base64').toString('utf8').split(':');
  const pass = rest.join(':');
  res.json({ admin: user === ADMIN_USER && pass === ADMIN_PASS });
});

app.get('/api/results-data', (req, res, next) => {
  if (loadSiteState().state !== 'confirmed') return requireAdmin(req, res, next);
  next();
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

  res.set('Cache-Control', 'public, max-age=30');
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

// ── Match baseline (wildcard qualifying period start) ────────────────────────

app.get('/api/match-baseline', (req, res) => {
  res.json(loadMatchBaseline());
});

app.post('/api/match-baseline/snapshot', requireAdmin, async (req, res) => {
  const wallets = loadWallets();
  const customTs = req.body?.timestamp && !isNaN(Date.parse(req.body.timestamp))
    ? new Date(req.body.timestamp).toISOString()
    : null;
  const timestamp = customTs || new Date().toISOString();
  const usePagination = customTs && new Date(customTs) < Date.now();

  const baselines = {};

  await Promise.all(wallets.map(async w => {
    const key = w.toLowerCase();
    const p = playerCache[key];
    if (!p || !p.matches) return;

    if (usePagination) {
      // Accurate: subtract matches played after the cutoff from current totals
      const after = await countMatchesAfterTimestamp(w, timestamp);
      baselines[key] = {
        RANK:     Math.max(0, (p.matches.RANK     || 0) - (after.RANK     || 0)),
        GAMBIT:   Math.max(0, (p.matches.GAMBIT   || 0) - (after.GAMBIT   || 0)),
        M8_ARENA: Math.max(0, (p.matches.M8_ARENA || 0) - (after.M8_ARENA || 0)),
        QUICK:    Math.max(0, (p.matches.QUICK    || 0) - (after.QUICK    || 0)),
        FRIEND:   Math.max(0, (p.matches.FRIEND   || 0) - (after.FRIEND   || 0)),
      };
    } else {
      baselines[key] = {
        RANK:     p.matches.RANK     || 0,
        GAMBIT:   p.matches.GAMBIT   || 0,
        M8_ARENA: p.matches.M8_ARENA || 0,
        QUICK:    p.matches.QUICK    || 0,
        FRIEND:   p.matches.FRIEND   || 0,
      };
    }
  }));

  const data = { timestamp, baselines };
  try {
    saveMatchBaseline(data);
    res.json({ ok: true, timestamp: data.timestamp, count: Object.keys(baselines).length });
  } catch {
    res.status(500).json({ error: 'Failed to save match baseline' });
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
  deleteImageFiles(FRONTEND_DIR, 'bg-image', BG_EXTS);
  bgUpload.single('background')(req, res, err => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No file received' });
    res.json({ ok: true, filename: req.file.filename });
  });
});

app.delete('/api/background', requireAdmin, (req, res) => {
  deleteImageFiles(FRONTEND_DIR, 'bg-image', BG_EXTS);
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
  deleteImageFiles(FRONTEND_DIR, 'logo-image', LOGO_EXTS);
  logoUpload.single('logo')(req, res, err => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No file received' });
    res.json({ ok: true, filename: req.file.filename });
  });
});

app.delete('/api/logo', requireAdmin, (req, res) => {
  deleteImageFiles(FRONTEND_DIR, 'logo-image', LOGO_EXTS);
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
  deleteImageFiles(FRONTEND_DIR, 'tournament-logo', LOGO_EXTS);
  tournamentLogoUpload.single('logo')(req, res, err => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No file received' });
    res.json({ ok: true, filename: req.file.filename });
  });
});

app.delete('/api/tournament/logo', requireAdmin, (req, res) => {
  deleteImageFiles(FRONTEND_DIR, 'tournament-logo', LOGO_EXTS);
  res.json({ ok: true });
});

app.post('/api/tournament/details', requireAdmin, (req, res) => {
  const { details } = req.body;
  if (typeof details !== 'string') return res.status(400).json({ error: 'details must be a string' });
  if (details.length > 20000) return res.status(400).json({ error: 'details text too long (max 20000 chars)' });
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
    .filter(a => /^0x[0-9a-fA-F]{40}$/i.test(a));
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

app.get('/api/brackets', (req, res) => {
  const event = (req.query.event || '').replace(/[^a-z0-9-]/g, '');
  if (event) {
    const archivePath = path.join(__dirname, `brackets-${event}.json`);
    if (!fs.existsSync(archivePath)) return res.status(404).json({ error: 'Event not found' });
    try { return res.json(JSON.parse(fs.readFileSync(archivePath, 'utf8'))); }
    catch { return res.status(500).json({ error: 'Failed to read archived bracket' }); }
  }
  res.json(loadBrackets());
});

app.post('/api/brackets/setup', requireAdmin, (req, res) => {
  const { playerCount, seeds, placementMode } = req.body;
  if (![8, 16].includes(playerCount)) return res.status(400).json({ error: 'playerCount must be 8 or 16' });
  if (!Array.isArray(seeds)) return res.status(400).json({ error: 'seeds array required' });
  for (let i = 0; i < seeds.length; i++) {
    const s = seeds[i];
    if (s === null || typeof s !== 'object' || Array.isArray(s)) {
      return res.status(400).json({ error: `Seed at index ${i} must be a plain object` });
    }
    // Accept both EVM wallet addresses and plain player names
    if (typeof s.wallet !== 'string') {
      return res.status(400).json({ error: `Seed at index ${i} has a missing player identifier` });
    }
  }
  const data = loadBrackets();
  data.playerCount = playerCount;
  data.seeds = seeds;
  data.status = 'setup';
  if (placementMode === 'manual' || placementMode === 'auto') data.placementMode = placementMode;
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
    data.rounds = generateBracketRounds(data.seeds, pc, data.roundFormats || {}, data.placementMode);
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
  if (typeof roundId !== 'string' || roundId.trim().length === 0 || roundId.length > 50) {
    return res.status(400).json({ error: 'roundId must be a non-empty string (max 50 chars)' });
  }
  if (!Number.isInteger(matchIndex) || matchIndex < 0) {
    return res.status(400).json({ error: 'matchIndex must be a non-negative integer' });
  }
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

app.post('/api/brackets/formats', requireAdmin, (req, res) => {
  const { formats } = req.body;
  if (!formats || typeof formats !== 'object' || Array.isArray(formats)) {
    return res.status(400).json({ error: 'formats must be a plain object' });
  }
  const VALID_IDS = new Set(['r16', 'qf', 'sf', '3rd', 'gf']);
  const VALID_BO  = new Set([1, 3, 5]);
  const sanitized = {};
  for (const [id, bo] of Object.entries(formats)) {
    if (!VALID_IDS.has(id)) return res.status(400).json({ error: `Unknown round id: ${id}` });
    if (!VALID_BO.has(Number(bo))) return res.status(400).json({ error: `bestOf for '${id}' must be 1, 3, or 5` });
    sanitized[id] = Number(bo);
  }
  try {
    const data = loadBrackets();
    data.roundFormats = { ...DEFAULT_ROUND_FORMATS, ...sanitized };
    // Hot-patch existing live rounds so winsNeeded updates immediately
    if (Array.isArray(data.rounds)) {
      data.rounds.forEach(r => {
        if (sanitized[r.id] !== undefined) {
          r.bestOf = sanitized[r.id];
          r.winsNeeded = Math.ceil(sanitized[r.id] / 2);
        }
      });
    }
    saveBrackets(data);
    res.json({ ok: true, roundFormats: data.roundFormats });
  } catch { res.status(500).json({ error: 'Failed to save formats' }); }
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
  deleteImageFiles(FRONTEND_DIR, 'bracket-bg-image', BG_EXTS);
  bracketBgUpload.single('background')(req, res, err => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No file received' });
    res.json({ ok: true, filename: req.file.filename });
  });
});

app.delete('/api/bracket-background', requireAdmin, (req, res) => {
  deleteImageFiles(FRONTEND_DIR, 'bracket-bg-image', BG_EXTS);
  res.json({ ok: true });
});

function generateBracketRounds(seeds, playerCount, formats = {}, placementMode = 'auto') {
  const winsNeeded = bo => Math.ceil(bo / 2);
  const makeMatch = id => ({ id, p1: null, p2: null, games: [], score: { p1: 0, p2: 0 }, winner: null, loser: null, status: 'pending' });
  const bo = id => formats[id] ?? DEFAULT_ROUND_FORMATS[id] ?? 1;

  const roundDefs = playerCount === 16 ? [
    { id: 'r16', name: 'Round of 16',  bestOf: bo('r16'), matchCount: 8 },
    { id: 'qf',  name: 'Quarterfinals', bestOf: bo('qf'),  matchCount: 4 },
    { id: 'sf',  name: 'Semifinals',    bestOf: bo('sf'),  matchCount: 2 },
    { id: '3rd', name: 'Third Place',   bestOf: bo('3rd'), matchCount: 1, isThirdPlace: true },
    { id: 'gf',  name: 'Grand Final',   bestOf: bo('gf'),  matchCount: 1 },
  ] : [
    { id: 'qf',  name: 'Quarterfinals', bestOf: bo('qf'),  matchCount: 4 },
    { id: 'sf',  name: 'Semifinals',    bestOf: bo('sf'),  matchCount: 2 },
    { id: '3rd', name: 'Third Place',   bestOf: bo('3rd'), matchCount: 1, isThirdPlace: true },
    { id: 'gf',  name: 'Grand Final',   bestOf: bo('gf'),  matchCount: 1 },
  ];

  const rounds = roundDefs.map(d => ({
    ...d,
    winsNeeded: winsNeeded(d.bestOf),
    matches: Array.from({ length: d.matchCount }, (_, i) => makeMatch(`${d.id}-${i}`)),
  }));

  const s = seeds.map(sd => sd.wallet ? { wallet: sd.wallet, seed: sd.seed } : null);

  const autoPairs16 = [[0,15],[7,8],[3,12],[4,11],[1,14],[6,9],[2,13],[5,10]];
  const autoPairs8  = [[0,7],[3,4],[1,6],[2,5]];
  const manualPairs = (n) => Array.from({ length: n / 2 }, (_, i) => [i * 2, i * 2 + 1]);

  const pairs = placementMode === 'manual'
    ? manualPairs(playerCount)
    : (playerCount === 16 ? autoPairs16 : autoPairs8);

  const firstRound = rounds[0].matches;
  pairs.forEach(([a, b], i) => {
    firstRound[i].p1 = s[a]; firstRound[i].p2 = s[b];
    if (firstRound[i].p1 && firstRound[i].p2) firstRound[i].status = 'upcoming';
  });
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

// ── Tournament Config ──────────────────────────────────────────────────────

app.get('/api/tournament-config', (req, res) => { res.set('Cache-Control', 'no-cache'); res.json(loadTournamentConfig()); });

app.post('/api/tournament-config', requireAdmin, (req, res) => {
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return res.status(400).json({ error: 'Body must be a plain object' });
  }
  const ALLOWED_KEYS = new Set([
    'tournamentNumber', 'name', 'finalDate', 'finalTime', 'prizePool',
    'cutoffTimestamp', 'cutoffDisplay', 'qualifyCount', 'registrationUrl',
    'lichessQualifierUrl', 'qualifier1Label', 'qualifier2Label', 'discordUrl',
  ]);
  const NUMBER_FIELDS = new Set(['tournamentNumber', 'cutoffTimestamp', 'qualifyCount']);
  const sanitized = {};
  for (const key of ALLOWED_KEYS) {
    if (!(key in body)) continue;
    const val = body[key];
    if (NUMBER_FIELDS.has(key)) {
      if (typeof val !== 'number') {
        return res.status(400).json({ error: `Field '${key}' must be a number` });
      }
    } else {
      if (typeof val !== 'string') {
        return res.status(400).json({ error: `Field '${key}' must be a string` });
      }
      if (val.length > 500) {
        return res.status(400).json({ error: `Field '${key}' exceeds 500 character limit` });
      }
    }
    sanitized[key] = val;
  }
  try { saveTournamentConfig(sanitized); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Game Updates ───────────────────────────────────────────────────────────

app.get('/api/game-updates', (req, res) => {
  res.set('Cache-Control', 'public, max-age=30');
  res.json(loadGameUpdates());
});

app.post('/api/game-updates', requireAdmin, (req, res) => {
  const { title, date, content } = req.body || {};
  if (!title || typeof title !== 'string' || !title.trim()) return res.status(400).json({ error: 'title is required' });
  if (!content || typeof content !== 'string' || !content.trim()) return res.status(400).json({ error: 'content is required' });
  if (content.length > 20000) return res.status(400).json({ error: 'content too long (max 20000 chars)' });
  const updates = loadGameUpdates();
  const entry = {
    id: Date.now().toString(36),
    title: title.trim().slice(0, 200),
    date: date && typeof date === 'string' ? date.trim().slice(0, 20) : new Date().toISOString().slice(0, 10),
    content: content.trim(),
    createdAt: new Date().toISOString(),
  };
  updates.unshift(entry);
  try { saveGameUpdates(updates); res.json({ ok: true, entry }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/game-updates/:id', requireAdmin, (req, res) => {
  const { title, date, content } = req.body || {};
  if (!title || typeof title !== 'string' || !title.trim()) return res.status(400).json({ error: 'title is required' });
  if (!content || typeof content !== 'string' || !content.trim()) return res.status(400).json({ error: 'content is required' });
  if (content.length > 20000) return res.status(400).json({ error: 'content too long (max 20000 chars)' });
  const updates = loadGameUpdates();
  const idx = updates.findIndex(u => u.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  updates[idx] = {
    ...updates[idx],
    title: title.trim().slice(0, 200),
    date: date && typeof date === 'string' ? date.trim().slice(0, 20) : updates[idx].date,
    content: content.trim(),
    updatedAt: new Date().toISOString(),
  };
  try { saveGameUpdates(updates); res.json({ ok: true, entry: updates[idx] }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/game-updates/:id', requireAdmin, (req, res) => {
  const updates = loadGameUpdates();
  const filtered = updates.filter(u => u.id !== req.params.id);
  if (filtered.length === updates.length) return res.status(404).json({ error: 'Not found' });
  try { saveGameUpdates(filtered); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Past Events ────────────────────────────────────────────────────────────

app.get('/api/past-events', (req, res) => { res.set('Cache-Control', 'public, max-age=30'); res.json(loadPastEvents()); });

app.post('/api/past-events', requireAdmin, (req, res) => {
  if (!Array.isArray(req.body)) return res.status(400).json({ error: 'Body must be an array' });
  if (req.body.length > 100) return res.status(400).json({ error: 'Array must not exceed 100 events' });
  const ALLOWED_EVENT_KEYS = new Set([
    'id', 'name', 'date', 'bracketUrl', 'bracketFile', 'resultsUrl',
    'winner', 'prizePool', 'playerCount', 'youtubeUrl', 'thumbnailUrl',
    'qualifier1', 'qualifier2',
  ]);
  const sanitizedEvents = [];
  for (let i = 0; i < req.body.length; i++) {
    const event = req.body[i];
    if (!event || typeof event !== 'object' || Array.isArray(event)) {
      return res.status(400).json({ error: `Element at index ${i} must be a plain object` });
    }
    const sanitizedEvent = {};
    for (const key of ALLOWED_EVENT_KEYS) {
      if (!(key in event)) continue;
      const val = event[key];
      if (typeof val !== 'string') {
        return res.status(400).json({ error: `Field '${key}' at index ${i} must be a string` });
      }
      if (val.length > 500) {
        return res.status(400).json({ error: `Field '${key}' at index ${i} exceeds 500 character limit` });
      }
      sanitizedEvent[key] = val;
    }
    sanitizedEvents.push(sanitizedEvent);
  }
  try { savePastEvents(sanitizedEvents); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Bracket Archive ────────────────────────────────────────────────────────

app.post('/api/brackets/archive/:eventId', requireAdmin, (req, res) => {
  const eventId = (req.params.eventId || '').replace(/[^a-z0-9-]/g, '');
  if (!eventId) return res.status(400).json({ error: 'Invalid event ID' });
  if (eventId.length > 100) return res.status(400).json({ error: 'Event ID too long' });
  try {
    const data = loadBrackets();
    const bracketDest = path.join(__dirname, `brackets-${eventId}.json`);
    fs.writeFileSync(bracketDest, JSON.stringify(data, null, 2));
    // Snapshot current player cache to frontend static file for bracket viewer
    const players = Object.values(playerCache).map((p, i) => ({ ...p, localRank: i + 1 }));
    const playerDest = path.join(FRONTEND_DIR, `players-${eventId}.json`);
    fs.writeFileSync(playerDest, JSON.stringify(players, null, 2));
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Guides ────────────────────────────────────────────────────────────────

function isAdminReq(req) {
  const auth = req.headers['authorization'];
  if (!auth || !auth.startsWith('Basic ')) return false;
  const [user, pass] = Buffer.from(auth.slice(6), 'base64').toString('utf8').split(':');
  return user === ADMIN_USER && pass === ADMIN_PASS;
}

app.get('/api/guides', (req, res) => {
  const guides = loadGuides();
  res.json(isAdminReq(req) ? guides : guides.filter(g => g.published));
});

app.get('/api/guides/:id', (req, res) => {
  const guide = loadGuides().find(g => g.id === req.params.id);
  if (!guide) return res.status(404).json({ error: 'Not found' });
  if (!guide.published && !isAdminReq(req)) return res.status(404).json({ error: 'Not found' });
  res.json(guide);
});

app.post('/api/guides', requireAdmin, (req, res) => {
  const { title, category, excerpt, content, published } = req.body || {};
  if (!title || !content) return res.status(400).json({ error: 'title and content are required' });
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const now = Math.floor(Date.now() / 1000);
  const guide = { id: randomUUID(), title, slug, category: category || 'General', excerpt: excerpt || '', content, published: !!published, createdAt: now, updatedAt: now };
  try { const list = loadGuides(); list.push(guide); saveGuides(list); res.json(guide); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/guides/:id', requireAdmin, (req, res) => {
  try {
    const list = loadGuides();
    const idx = list.findIndex(g => g.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Not found' });
    const { title, category, excerpt, content, published } = req.body || {};
    const slug = title ? title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') : list[idx].slug;
    list[idx] = { ...list[idx], ...(title !== undefined && { title, slug }), ...(category !== undefined && { category }), ...(excerpt !== undefined && { excerpt }), ...(content !== undefined && { content }), ...(published !== undefined && { published: !!published }), updatedAt: Math.floor(Date.now() / 1000) };
    saveGuides(list);
    res.json(list[idx]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/guides/:id', requireAdmin, (req, res) => {
  try {
    const list = loadGuides();
    const idx = list.findIndex(g => g.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Not found' });
    list.splice(idx, 1);
    saveGuides(list);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

cron.schedule('*/5 * * * *', () => {
  if (Date.now() >= CUTOFF_MS) {
    console.log('[Cron] Past cutoff — skipping refresh');
    return;
  }
  console.log('[Cron] Refreshing player data...');
  refreshPlayerData();
});

// Profile name refresh — runs every 30 min regardless of cutoff so usernames
// stay current even after the qualifying period ends.
cron.schedule('*/30 * * * *', () => {
  console.log('[Cron] 30-min profile refresh...');
  refreshPlayerData();
});

// Catch any unhandled promise rejections so they don't crash the process silently
process.on('unhandledRejection', (reason, promise) => {
  console.error('[UnhandledRejection] Unhandled promise rejection:', reason);
  process.exit(1);
});

// ── Finals (Road to Magnus Finals · Jun 16) ─────────────────────────────────
app.get('/api/finals', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(loadFinals());
});

app.post('/api/finals/status', requireAdmin, (req, res) => {
  const { status } = req.body;
  if (!['upcoming', 'active', 'complete'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
  const data = loadFinals();
  data.status = status;
  saveFinals(data);
  res.json({ ok: true });
});

app.post('/api/finals/players', requireAdmin, (req, res) => {
  const { players } = req.body;
  if (!Array.isArray(players) || players.length !== 6) return res.status(400).json({ error: 'Must provide exactly 6 players' });
  const data = loadFinals();
  const existing = data.players || [];
  data.players = players.map((p, i) => ({
    id: i + 1,
    wallet: /^0x[0-9a-fA-F]{40}$/i.test(p.wallet || '') ? p.wallet.toLowerCase() : '',
    name: (p.name || '').trim().slice(0, 100),
    title: (p.title || '').trim().slice(0, 20),
    country: (p.country || '').trim().toUpperCase().slice(0, 2),
    avatar: existing[i]?.avatar || null,
  }));
  saveFinals(data);
  res.json({ ok: true });
});

app.post('/api/finals/round', requireAdmin, (req, res) => {
  const { round, games } = req.body;
  if (!Number.isInteger(round) || round < 1 || round > 5) return res.status(400).json({ error: 'Invalid round (1–5)' });
  if (!Array.isArray(games) || games.length !== 3) return res.status(400).json({ error: 'Must provide exactly 3 games' });
  const data = loadFinals();
  data.rounds[round - 1].games = games.map(g => ({
    white: Number.isInteger(g.white) && g.white >= 1 && g.white <= 6 ? g.white : null,
    black: Number.isInteger(g.black) && g.black >= 1 && g.black <= 6 ? g.black : null,
    result: ['white', 'black', 'draw', null].includes(g.result) ? g.result : null,
  }));
  saveFinals(data);
  res.json({ ok: true });
});

app.post('/api/finals/game', requireAdmin, (req, res) => {
  const { round, game, result } = req.body;
  if (!Number.isInteger(round) || round < 1 || round > 5) return res.status(400).json({ error: 'Invalid round' });
  if (!Number.isInteger(game) || game < 0 || game > 2) return res.status(400).json({ error: 'Invalid game index (0–2)' });
  if (!['white', 'black', 'draw', null].includes(result)) return res.status(400).json({ error: 'Invalid result' });
  const data = loadFinals();
  data.rounds[round - 1].games[game].result = result;
  saveFinals(data);
  res.json({ ok: true });
});

app.post('/api/finals/grand-final', requireAdmin, (req, res) => {
  const { p1, p2, result, format, scoreP1, scoreP2 } = req.body;
  if (!['p1', 'p2', 'draw', null, undefined].includes(result)) return res.status(400).json({ error: 'Invalid result' });
  const fmt = ['bo1', 'bo3', 'bo5'].includes(format) ? format : 'bo1';
  const clinch = fmt === 'bo5' ? 3 : fmt === 'bo3' ? 2 : 1;
  const clampScore = s => (Number.isInteger(s) && s >= 0 && s <= clinch ? s : 0);
  const s1 = fmt === 'bo1' ? 0 : clampScore(scoreP1);
  const s2 = fmt === 'bo1' ? 0 : clampScore(scoreP2);
  // For multi-game formats the winner is derived from the series score; BO1 keeps the explicit pick.
  const finalResult = fmt === 'bo1'
    ? (result || null)
    : (s1 > s2 ? 'p1' : s2 > s1 ? 'p2' : null);
  const data = loadFinals();
  data.grandFinal = {
    p1: Number.isInteger(p1) && p1 >= 1 && p1 <= 6 ? p1 : null,
    p2: Number.isInteger(p2) && p2 >= 1 && p2 <= 6 ? p2 : null,
    result: finalResult,
    format: fmt,
    scoreP1: s1,
    scoreP2: s2,
  };
  saveFinals(data);
  res.json({ ok: true });
});

app.post('/api/finals/avatar/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id) || id < 1 || id > 6) return res.status(400).json({ error: 'Invalid player id (1–6)' });
  finalsAvatarUpload.single('avatar')(req, res, err => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const mimeToExt = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' };
    const ext = mimeToExt[req.file.mimetype] || '.png';
    // Remove any previous avatar files for this player
    try {
      fs.readdirSync(FINALS_AVATARS_DIR)
        .filter(f => f.startsWith(`player-${id}.`))
        .forEach(f => fs.unlinkSync(path.join(FINALS_AVATARS_DIR, f)));
    } catch {}
    const filename = `player-${id}${ext}`;
    fs.writeFileSync(path.join(FINALS_AVATARS_DIR, filename), req.file.buffer);
    const avatarUrl = `/finals-avatars/${filename}`;
    const data = loadFinals();
    const player = (data.players || []).find(p => p.id === id);
    if (player) player.avatar = avatarUrl;
    saveFinals(data);
    res.json({ ok: true, avatar: avatarUrl });
  });
});

app.delete('/api/finals/avatar/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id) || id < 1 || id > 6) return res.status(400).json({ error: 'Invalid player id (1–6)' });
  const data = loadFinals();
  const player = (data.players || []).find(p => p.id === id);
  if (player?.avatar) {
    const filename = path.basename(player.avatar);
    try { fs.unlinkSync(path.join(FINALS_AVATARS_DIR, filename)); } catch {}
    player.avatar = null;
    saveFinals(data);
  }
  res.json({ ok: true });
});

app.get('/health', (req, res) => {
  res.json({ ok: true, uptime: Math.floor(process.uptime()) });
});

app.listen(PORT, () => {
  console.log(`[Server] Anichess Tracker running on http://localhost:${PORT}`);
  refreshPlayerData();
});
