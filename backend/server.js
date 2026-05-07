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
const EXCLUDED_WALLETS_FILE    = path.join(__dirname, 'excluded-wallets.json');

function findBgImage() {
  for (const ext of BG_EXTS) {
    const file = `bg-image${ext}`;
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

function loadExcludedWallets() {
  try { return JSON.parse(fs.readFileSync(EXCLUDED_WALLETS_FILE, 'utf8')); }
  catch { return []; }
}

function saveExcludedWallets(list) {
  try { fs.writeFileSync(EXCLUDED_WALLETS_FILE, JSON.stringify(list, null, 2)); }
  catch (err) { console.error('[saveExcludedWallets] Write failed:', err.message); throw err; }
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

app.use(cors());
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

// Protect admin panel before static middleware intercepts it
app.get('/admin.html', requireAdmin, (req, res) => {
  res.sendFile(path.join(FRONTEND_DIR, 'admin.html'));
});

// Protect preview page (admin-only finalized state preview)
app.get('/preview.html', requireAdmin, (req, res) => {
  res.sendFile(path.join(FRONTEND_DIR, 'preview.html'));
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

app.get('/api/players', (req, res) => {
  const wallets = loadWallets();
  const winsStore = loadWinsStore();
  const players = wallets.map(w => {
    const key = w.toLowerCase();
    return playerCache[key] || {
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

app.get('/api/refresh', refreshRateLimit, async (req, res) => {
  if (Date.now() >= CUTOFF_MS) {
    return res.json({ ok: false, cutoff: true, lastRefreshed });
  }
  await refreshPlayerData();
  res.json({ ok: true, lastRefreshed });
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
