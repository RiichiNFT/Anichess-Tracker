const REFRESH_INTERVAL = 30 * 60 * 1000; // 30 minutes

// If bg was pre-loaded from sessionStorage in the head script, mark body immediately
if (document.documentElement.classList.contains('bg-preloaded')) {
  document.body.classList.add('has-bg');
}
let absentSet = new Set();
let lastFetchTime = 0;
let CUTOFF_MS = 1779494400 * 1000;    // May 23 2026 00:00:00 UTC (overridden from API)
let tournamentConfig = null;

// Sort state — persists across refreshes within the session
let _sortKey = 'rating';
let _sortDir = 'desc';
let _activePlayers = [];

// HTML-escape helper — prevents XSS when inserting user-supplied strings into innerHTML
function esc(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

function isPastCutoff() { return window.__PREVIEW_FINALIZED__ || window.__RESULTS_FINAL__ || Date.now() >= CUTOFF_MS; }
function isResultsFinal() { return !!window.__RESULTS_FINAL__; }

function trackClick(label, category = 'engagement') {
  if (typeof gtag === 'function') gtag('event', 'click', { event_category: category, event_label: label });
}

// Single delegated listener for all tracked clicks
document.addEventListener('click', e => {
  // data-track elements (nav links, buttons)
  const tracked = e.target.closest('[data-track]');
  if (tracked) trackClick(tracked.dataset.track, tracked.dataset.trackCategory || 'engagement');
  // Player profile links in leaderboard and qualifier sections
  const playerLink = e.target.closest('a.player-link');
  if (playerLink) trackClick(playerLink.textContent.trim() || playerLink.title, 'player_profile');
});

// Chess piece tier system — rating range based
const TIER_CONFIG = {
  LEGEND: { label: 'Legend', symbol: '✦', cls: 'tier-LEGEND' },
  KING:   { label: 'King',   symbol: '♚', cls: 'tier-KING'   },
  QUEEN:  { label: 'Queen',  symbol: '♛', cls: 'tier-QUEEN'  },
  ROOK:   { label: 'Rook',   symbol: '♜', cls: 'tier-ROOK'   },
  BISHOP: { label: 'Bishop', symbol: '♝', cls: 'tier-BISHOP' },
  KNIGHT: { label: 'Knight', symbol: '♞', cls: 'tier-KNIGHT' },
  PAWN:   { label: 'Pawn',   symbol: '♟', cls: 'tier-PAWN'   },
};

function getTier(rating) {
  if (rating == null) return null;
  if (rating >= 2000) return 'LEGEND';
  if (rating >= 1900) return 'KING';
  if (rating >= 1700) return 'QUEEN';
  if (rating >= 1500) return 'ROOK';
  if (rating >= 1300) return 'BISHOP';
  if (rating >= 1100) return 'KNIGHT';
  return 'PAWN';
}

const RANK_META = {
  1: { cls: 'gold',   label: '1' },
  2: { cls: 'silver', label: '2' },
  3: { cls: 'bronze', label: '3' },
};

function fmtWallet(addr) {
  if (!addr || addr.length < 10) return addr || '—';
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function fmtTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString([], { dateStyle: 'short', timeStyle: 'medium' });
}

function renderRankGapRow(colCount) {
  return `<tr class="rank-gap-row"><td colspan="${colCount}" class="rank-gap-cell"><span class="rank-gap-label">▼ Qualification Line · Top 8 Qualify for Finals</span></td></tr>`;
}

function rankCell(rank) {
  if (!rank) return `<td class="rank-cell"><span class="rank-unranked">—</span></td>`;
  const meta = RANK_META[rank];
  if (meta) return `<td class="rank-cell"><div class="rank-badge ${meta.cls}">${meta.label}</div></td>`;
  const cls = rank <= 8 ? 'qualified' : 'default';
  return `<td class="rank-cell"><div class="rank-badge ${cls}">${rank}</div></td>`;
}

function isEVMAddress(str) {
  return !str || /^0x[0-9a-fA-F]{40}$/i.test(str);
}

function showCopiedToast() {
  const toast = document.createElement('div');
  toast.textContent = 'Copied!';
  toast.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#00aefa;color:#fff;padding:8px 18px;border-radius:6px;font-size:0.85rem;z-index:9999;pointer-events:none;';
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 1800);
}

function playerCell(p) {
  const hasName = !isEVMAddress(p.username);
  const displayName = hasName ? p.username : fmtWallet(p.wallet);
  const profileUrl = `https://anichess.com/profile/${esc(p.wallet)}/`;
  const absent = absentSet.has((p.wallet || '').toLowerCase())
    ? `<span class="absent-tag">Absent</span>` : '';
  return `<td class="player-cell">
    <a class="player-name player-link" href="${profileUrl}" target="_blank" rel="noopener" title="${esc(p.wallet)}">${esc(displayName)}</a><button class="copy-wallet-btn" data-wallet="${esc(p.wallet)}" title="Copy wallet address" aria-label="Copy wallet address">⧉</button>${absent}
  </td>`;
}

function tierCell(rating) {
  const tierKey = getTier(rating);
  if (!tierKey) return `<td class="tier-cell col-hide-mobile"><span class="tier-pill tier-none">—</span></td>`;
  const t = TIER_CONFIG[tierKey];
  const badgeName = tierKey.toLowerCase();
  return `<td class="tier-cell col-hide-mobile">
    <div class="tier-cell-wrap">
      <img class="tier-badge-img" src="/badges/${badgeName}.png"
           alt="${t.label}"
           onerror="this.style.display='none';this.nextElementSibling.style.display='inline-flex'">
      <span class="tier-pill ${t.cls}" style="display:none"><span class="tier-symbol">${t.symbol}</span>${t.label}</span>
    </div>
  </td>`;
}

function ratingCell(rating) {
  if (rating == null) return `<td class="rating-cell"><span class="rating-none">—</span></td>`;
  return `<td class="rating-cell"><span class="rating-val">${rating.toLocaleString()}</span></td>`;
}

function matchesCell(matches) {
  const count = matches?.RANK ?? null;
  if (count == null) return `<td class="matches-cell col-hide-mobile"><span class="stat-none">—</span></td>`;
  return `<td class="matches-cell col-hide-mobile"><span class="stat-val">${count.toLocaleString()}</span></td>`;
}

function winsCell(wins) {
  if (wins == null) return `<td class="wins-cell col-hide-mobile"><span class="stat-none">—</span></td>`;
  return `<td class="wins-cell col-hide-mobile"><span class="stat-val wins-val">${wins.toLocaleString()}<span class="mobile-stat-label"> W</span></span></td>`;
}

function winRateCell(wins, matches) {
  const total = matches?.RANK ?? null;
  if (wins == null || total == null || total === 0) {
    return `<td class="winrate-cell col-hide-mobile"><span class="stat-none">—</span></td>`;
  }
  const pct = Math.round((wins / total) * 100);
  const barWidth = Math.min(pct, 100);
  return `<td class="winrate-cell col-hide-mobile">
    <div class="winrate-wrap">
      <span class="winrate-pct"><span class="mobile-winrate-label">Win Rate: </span>${pct}%</span>
      <div class="winrate-bar-track">
        <div class="winrate-bar-fill" style="width:0%" data-w="${barWidth}"></div>
      </div>
    </div>
  </td>`;
}

function renderRow(p) {
  const rank = p.localRank;
  const podiumCls = rank && rank <= 3 ? ` rank-${rank}` : '';
  const rowCls = rank && rank <= 8 ? `qualified-row${podiumCls}` : podiumCls.trim();
  const clsAttr = rowCls ? `class="${rowCls}"` : '';
  const wins = p.rankedWins ?? null;
  const total = p.matches?.RANK ?? null;
  const pct = wins != null && total != null && total > 0 ? Math.round((wins / total) * 100) : null;
  const dataAttrs = [
    wins != null ? `data-wins="${wins}"` : '',
    total != null ? `data-matches="${total}"` : '',
    pct != null ? `data-pct="${pct}"` : '',
  ].filter(Boolean).join(' ');
  return `<tr ${clsAttr} ${dataAttrs}>
    ${rankCell(p.localRank)}
    ${playerCell(p)}
    ${tierCell(p.rating)}
    ${ratingCell(p.rating)}
    ${matchesCell(p.matches)}
    ${winsCell(wins)}
    ${winRateCell(wins, p.matches)}
    <td class="expand-cell"><button class="expand-btn" aria-label="More info" aria-expanded="false">▾</button></td>
  </tr>`;
}

function sortAndRenderTable(players) {
  const tbody = document.getElementById('lb-body');
  if (!tbody) return;
  const colCount = document.getElementById('lb-table')?.querySelectorAll('thead th').length || 8;

  const sorted = [...players].sort((a, b) => {
    const va = _sortKey === 'matches' ? (a.matches?.RANK ?? -1) : (a.rating ?? -1);
    const vb = _sortKey === 'matches' ? (b.matches?.RANK ?? -1) : (b.rating ?? -1);
    return _sortDir === 'asc' ? va - vb : vb - va;
  });

  const rows = [];
  sorted.forEach(p => {
    rows.push(renderRow(p));
    if (_sortKey === 'rating' && _sortDir === 'desc' && p.localRank === 8) {
      rows.push(renderRankGapRow(colCount));
    }
  });
  tbody.innerHTML = rows.join('');

  tbody.querySelectorAll('tr:not(.rank-gap-row)').forEach((row, i) => {
    row.style.setProperty('--row-delay', `${i * 38}ms`);
    row.classList.add('row-enter');
  });
  requestAnimationFrame(() => {
    tbody.querySelectorAll('.winrate-bar-fill[data-w]').forEach(bar => {
      bar.style.width = bar.dataset.w + '%';
    });
  });

  // Refresh sort indicators in header
  document.querySelectorAll('.th-sortable').forEach(th => {
    th.classList.toggle('sort-active', th.dataset.sort === _sortKey);
    th.setAttribute('aria-sort', th.dataset.sort === _sortKey
      ? (_sortDir === 'asc' ? 'ascending' : 'descending') : 'none');
  });
}

function dismissLoader() {
  const loader = document.getElementById('page-loader');
  if (!loader) return;
  loader.classList.add('fading');
  loader.addEventListener('transitionend', () => loader.remove(), { once: true });
}

function resolveDisplayName(wallet, playerMap) {
  if (!wallet) return null;
  const p = playerMap[wallet.toLowerCase()];
  if (p) return !isEVMAddress(p.username) ? p.username : fmtWallet(p.wallet);
  return fmtWallet(wallet);
}

function totalMatchCount(p) {
  if (!p.matches) return 0;
  return (p.matches.RANK || 0) + (p.matches.GAMBIT || 0) + (p.matches.M8_ARENA || 0) + (p.matches.QUICK || 0) + (p.matches.FRIEND || 0);
}

let _countdownTimer = null;

function startCutoffCountdown(targetMs) {
  if (_countdownTimer) clearInterval(_countdownTimer);
  function tick() {
    const el = document.getElementById('qs-countdown');
    if (!el) { clearInterval(_countdownTimer); return; }
    const diff = targetMs - Date.now();
    if (diff <= 0) { el.textContent = 'ENDED'; clearInterval(_countdownTimer); return; }
    const d = Math.floor(diff / 86400000);
    const h = Math.floor((diff % 86400000) / 3600000);
    const m = Math.floor((diff % 3600000) / 60000);
    const s = Math.floor((diff % 60000) / 1000);
    el.textContent = d > 0
      ? `${d}d ${String(h).padStart(2,'0')}h ${String(m).padStart(2,'0')}m ${String(s).padStart(2,'0')}s`
      : `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  }
  tick();
  _countdownTimer = setInterval(tick, 1000);
}

function renderQualifiedSection(qualifiers, playerMap, wildcards, top8 = [], matchBaseline = {}, baselineSinceLabel = null) {
  const section = document.getElementById('qualified-section');
  if (!section) return;

  const PLACES = [
    { key: 'first',  cls: 'gold',   label: '1st' },
    { key: 'second', cls: 'silver', label: '2nd' },
    { key: 'third',  cls: 'bronze', label: '3rd' },
  ];

  const hasQ1 = qualifiers.qualifier1?.confirmed === true;
  const hasQ2 = qualifiers.qualifier2?.confirmed === true;
  const hasWC = wildcards && wildcards.length > 0;

  if (isResultsFinal() && !hasQ1 && !hasQ2 && !hasWC && top8.length === 0) { section.classList.add('hidden'); return; }

  const profileUrl = wallet => `https://anichess.com/profile/${esc(wallet)}/`;

  const renderEvent = (q, label) => {
    const rows = PLACES.map(({ key, cls, label: pos }) => {
      const wallet = q?.[key] || '';
      const name   = wallet ? resolveDisplayName(wallet, playerMap) : '—';
      const absent = wallet && absentSet.has(wallet.toLowerCase())
        ? `<span class="absent-tag">Absent</span>` : '';
      const inner  = wallet
        ? `<a class="qs-name player-link" href="${profileUrl(wallet)}" target="_blank" rel="noopener" title="${esc(wallet)}">${esc(name)}</a>${absent}`
        : `<span class="qs-name qs-empty">${esc(name)}</span>`;
      return `<div class="qs-row${wallet ? '' : ' qs-empty'}">
        <div class="qs-place ${cls}">${pos}</div>
        ${inner}
      </div>`;
    }).join('');
    return `<div class="qualifier-event qualifier-event-half">
      <div class="qualifier-event-label">${esc(label)}</div>
      ${rows}
    </div>`;
  };

  // ── Results-final state: single merged card ──────────────────────────────
  if (isResultsFinal()) {
    const q1Block = renderEvent(qualifiers.qualifier1, qualifiers.qualifier1?.label || 'Top 3 · LICHESS QUALIFIERS III');
    const q2Block = renderEvent(qualifiers.qualifier2, qualifiers.qualifier2?.label || 'Top 3 · Lichess Team Battle');

    const TOP8_ORDINALS = ['1st','2nd','3rd','4th','5th','6th','7th','8th'];
    const TOP8_CLS      = ['gold','silver','bronze','plain','plain','plain','plain','plain'];
    // Four columns, each holding a pair: [1st,2nd] [3rd,4th] [5th,6th] [7th,8th]
    const top8Cols = [0, 2, 4, 6].map(start => {
      const rows = top8.slice(start, start + 2).map((p, j) => {
        const i = start + j;
        const name = resolveDisplayName(p.wallet, playerMap);
        return `<div class="qs-row">
          <div class="qs-place ${TOP8_CLS[i]}">${TOP8_ORDINALS[i]}</div>
          <a class="qs-name player-link" href="${profileUrl(p.wallet)}" target="_blank" rel="noopener" title="${esc(p.wallet)}">${esc(name)}</a>
        </div>`;
      }).join('');
      return `<div class="qualifier-event qualifier-event-half">${rows}</div>`;
    });
    const top8Grid = top8Cols.join('<div class="qualifier-divider"></div>');

    const wcRows = wildcards.map((p, i) => {
      const cls  = i === 0 ? 'gold' : 'silver';
      const pos  = i === 0 ? '1st' : '2nd';
      const name = resolveDisplayName(p.wallet, playerMap);
      return `<div class="qs-row">
        <div class="qs-place ${cls}">${pos}</div>
        <a class="qs-name player-link" href="${profileUrl(p.wallet)}" target="_blank" rel="noopener" title="${esc(p.wallet)}">${esc(name)}</a>
        <span class="qs-wc-matches">${totalMatchCount(p).toLocaleString()} Matches</span>
      </div>`;
    }).join('');

    section.innerHTML = `<div class="qualified-stack"><div class="qualified-card">
      <div class="qualified-card-header">
        <span class="qualified-card-title">CONFIRMED FINALISTS</span>
        <span class="qualified-card-sub">All 16 finalists confirmed</span>
      </div>
      ${(hasQ1 || hasQ2) ? `<div class="qualified-body">
        ${q1Block}
        <div class="qualifier-divider"></div>
        ${q2Block}
      </div>` : ''}
      ${top8.length > 0 ? `<div class="qs-subsection">
        <div class="qs-subsection-header"><div class="qualifier-event-label">Top 8 · Highest Rating</div></div>
        <div class="qualified-body">${top8Grid}</div>
      </div>` : ''}
      ${wildcards.length > 0 ? `<div class="qualified-card-section">
        <div class="qualifier-event-label">Top 2 · Most Matches</div>
        ${wcRows}
      </div>` : ''}
      <p class="qualified-absence-note">Note: In the event of an absence, the next highest rated player outside the top 8 will be selected instead.</p>
    </div></div>`;
    section.classList.remove('hidden');
    return;
  }

  const lichessUrl = (tournamentConfig && tournamentConfig.lichessQualifierUrl) || 'https://lichess.org/tournament/eQiOIvDu';
  const q1Label    = qualifiers.qualifier1?.label || (tournamentConfig && tournamentConfig.qualifier1Label) || 'Top 3 · LICHESS QUALIFIERS III';
  const q2Label    = qualifiers.qualifier2?.label || (tournamentConfig && tournamentConfig.qualifier2Label) || 'Top 3 · Lichess Team Battle';

  const confirmedCard = (hasQ1 || hasQ2) ? `
    <div class="qualified-card">
      <div class="qualified-card-header">
        <span class="qualified-card-title">Confirmed Finalists</span>
        <span class="qualified-card-sub">Players confirmed for the final stage · May 23, 2026</span>
      </div>
      <div class="qualified-body">
        ${hasQ1 ? renderEvent(qualifiers.qualifier1, q1Label) : ''}
        ${hasQ1 && hasQ2 ? '<div class="qualifier-divider"></div>' : ''}
        ${hasQ2 ? renderEvent(qualifiers.qualifier2, q2Label) : ''}
      </div>
      <p class="qualified-absence-note">Note: In the event of an absence, the next highest rated player outside the top 8 will be selected instead.</p>
    </div>` : '';

  const upcomingCard = !hasQ2 ? `
    <div class="qualified-card">
      <div class="qualified-card-header">
        <span class="qualified-card-title">UPCOMING QUALIFIERS</span>
        <span class="qualified-card-sub">Compete to earn your spot in the finals</span>
      </div>
      <div class="qualified-body">
        <div class="qualifier-event qualifier-event-half">
          <div class="qualifier-event-label">${esc(q2Label)}</div>
          <a class="qs-lichess-link" href="${esc(lichessUrl)}" target="_blank" rel="noopener">View Details</a>
        </div>
      </div>
    </div>` : '';

  const ongoingCard = (() => {
    const wcRows = hasWC ? wildcards.map((p, i) => {
      const cls   = i === 0 ? 'gold' : 'silver';
      const pos   = i === 0 ? '1st' : '2nd';
      const name  = resolveDisplayName(p.wallet, playerMap);
      const bObj  = matchBaseline[p.wallet.toLowerCase()];
      const bSum  = bObj && typeof bObj === 'object'
        ? (bObj.RANK || 0) + (bObj.GAMBIT || 0) + (bObj.M8_ARENA || 0) + (bObj.QUICK || 0) + (bObj.FRIEND || 0)
        : 0;
      const delta = Math.max(0, totalMatchCount(p) - bSum);
      return `<div class="qs-row">
        <div class="qs-place ${cls}">${pos}</div>
        <a class="qs-name player-link" href="${profileUrl(p.wallet)}" target="_blank" rel="noopener" title="${esc(p.wallet)}">${esc(name)}</a>
        <span class="qs-wc-matches">${delta.toLocaleString()} Matches</span>
      </div>`;
    }).join('') : '';
    const finalized = isPastCutoff();
    const cutoffBadge = finalized
      ? ''
      : `<div class="qs-cutoff-badge qs-cutoff-header">
          <strong>CUT OFF IN:</strong>
          <strong id="qs-countdown"></strong>
        </div>`;
    const ongoingSub = finalized
      ? 'Cutoff reached · Results being finalized'
      : 'Live standings · not yet finalized';

    return `<div class="qualified-card">
      <div class="qualified-card-header">
        <span class="qualified-card-title ongoing-title">${finalized ? 'RESULTS BEING FINALIZED' : 'ONGOING'}</span>
        <span class="qualified-card-sub">${ongoingSub}</span>
        ${cutoffBadge}
      </div>
      <div class="qualified-body">
        <div class="qualifier-event qualifier-event-half qualifier-event-top8">
          <div class="qs-top8-label-row">
            <div class="qualifier-event-label">Top 8 · Highest Rating</div>
            <a class="qs-rewards-tag" href="https://lichess.org/forum/team-anichess-community/anichess-rating-milestone-rewards?page=1" target="_blank" rel="noopener">CLIMB FOR REWARDS</a>
          </div>
          <span class="qs-see-below">See below</span>
        </div>
        <div class="qualifier-divider"></div>
        <div class="qualifier-event qualifier-event-half">
          <div class="qualifier-event-label">Top 2 · Most Matches${baselineSinceLabel ? ` (since ${baselineSinceLabel} UTC 00:00)` : ''}</div>
          ${hasWC ? wcRows : '<span class="qs-standing-note">Calculating…</span>'}
        </div>
      </div>
    </div>`;
  })();

  section.innerHTML = `<div class="qualified-stack">${confirmedCard}${upcomingCard}${ongoingCard}</div>`;
  section.classList.remove('hidden');
  if (!isPastCutoff()) startCutoffCountdown(CUTOFF_MS);
}

async function renderChampionCard(playerMap) {
  const section = document.getElementById('champion-card');
  if (!section) return;
  try {
    const data = await fetch('/api/brackets').then(r => r.ok ? r.json() : null);
    if (!data || !data.champion) return;
    const wallet = data.champion;
    const name = resolveDisplayName(wallet, playerMap);
    const profileUrl = `https://anichess.com/profile/${esc(wallet)}/`;
    section.innerHTML = `<div class="champion-wrap">
      <div class="champion-card-inner">
        <span class="champion-trophy">🏆</span>
        <div class="champion-body">
          <div class="champion-eyebrow">TOURNAMENT CHAMPION</div>
          <a class="champion-name player-link" href="${profileUrl}" target="_blank" rel="noopener" title="${esc(wallet)}">${esc(name)}</a>
          <div class="champion-sub">Anichess Rising Stars Tournament #2 · May 24, 2026</div>
        </div>
      </div>
    </div>`;
    section.classList.remove('hidden');
  } catch {}
}

async function fetchPlayers() {
  const tbody    = document.getElementById('lb-body');
  const errBanner = document.getElementById('error-banner');
  const countEl  = document.getElementById('player-count'); // may be null if element removed
  const updatedEl = document.getElementById('last-updated');

  try {
    const [playersRes, qualifiersRes, excludedRes, absentRes, baselineRes, configRes] = await Promise.all([
      fetch('/api/players'),
      fetch('/api/qualifiers'),
      fetch('/api/excluded-wallets'),
      fetch('/api/absent'),
      fetch('/api/match-baseline'),
      fetch('/api/tournament-config'),
    ]);
    if (!playersRes.ok) throw new Error(`HTTP ${playersRes.status}`);
    const [players, qualifiers, excludedRaw, absentRaw, baselineRaw, configRaw] = await Promise.all([
      playersRes.json(),
      qualifiersRes.ok ? qualifiersRes.json().catch(() => ({})) : Promise.resolve({}),
      excludedRes.ok  ? excludedRes.json().catch(() => [])      : Promise.resolve([]),
      absentRes.ok    ? absentRes.json().catch(() => [])        : Promise.resolve([]),
      baselineRes.ok  ? baselineRes.json().catch(() => ({}))    : Promise.resolve({}),
      configRes.ok    ? configRes.json().catch(() => null)       : Promise.resolve(null),
    ]);

    if (configRaw) {
      tournamentConfig = configRaw;
      if (configRaw.cutoffTimestamp) CUTOFF_MS = configRaw.cutoffTimestamp * 1000;
      const numEl    = document.getElementById('tournament-num');
      const prizeEl  = document.getElementById('prize-pool-tag');
      const dateEl   = document.getElementById('final-date-time');
      const cutoffEl = document.getElementById('cutoff-display');
      const regLink  = document.getElementById('register-link');
      if (numEl)    numEl.textContent    = `Tournament #${configRaw.tournamentNumber}`;
      if (prizeEl)  prizeEl.textContent  = `${configRaw.prizePool} Prize Pool`;
      if (dateEl)   dateEl.textContent   = `${configRaw.finalDate} · ${configRaw.finalTime}`;
      if (cutoffEl) cutoffEl.textContent = configRaw.cutoffDisplay;
      if (regLink)  regLink.href         = configRaw.registrationUrl;
      // Hero banner fields
      const heroNum    = document.getElementById('hero-tournament-num');
      const heroPrize  = document.getElementById('hero-prize');
      const heroBig    = document.getElementById('hero-prize-big');
      const heroDate   = document.getElementById('hero-date');
      const heroReg    = document.getElementById('hero-register-link');
      if (heroNum)   heroNum.textContent  = `Tournament #${configRaw.tournamentNumber}`;
      if (heroPrize) heroPrize.textContent = configRaw.prizePool;
      if (heroBig)   heroBig.textContent  = configRaw.prizePool.replace(/\s*USD.*/, '');
      if (heroDate)  heroDate.textContent = configRaw.finalDate;
      if (heroReg && configRaw.registrationUrl) heroReg.href = configRaw.registrationUrl;
    }
    const matchBaseline = (baselineRaw && typeof baselineRaw.baselines === 'object') ? baselineRaw.baselines : {};
    const baselineSinceLabel = (() => {
      const ts = baselineRaw && baselineRaw.timestamp;
      if (!ts) return null;
      const d = new Date(ts);
      if (isNaN(d)) return null;
      return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
    })();
    // Guard: server could return a non-array on error
    const excludedWallets = Array.isArray(excludedRaw) ? excludedRaw : [];
    absentSet = new Set(Array.isArray(absentRaw) ? absentRaw.map(w => w.toLowerCase()) : []);

    errBanner.classList.add('hidden');

    const active = players.filter(p => {
      if (!p.matches) return false;
      return (p.matches.RANK || 0) + (p.matches.GAMBIT || 0) + (p.matches.M8_ARENA || 0) + (p.matches.QUICK || 0) + (p.matches.FRIEND || 0) > 0;
    });

    // Build wallet→player map for qualifier name resolution
    const playerMap = {};
    players.forEach(p => { playerMap[p.wallet.toLowerCase()] = p; });

    // Top 8 by rating → excluded from wild card consideration
    const byRating    = [...active].sort((a, b) => (b.rating ?? -1) - (a.rating ?? -1));
    const top8wallets = new Set(byRating.slice(0, 8).map(p => p.wallet.toLowerCase()));
    const excludedSet = new Set(excludedWallets.map(w => w.toLowerCase()));
    const baselineTotal = wallet => {
      const b = matchBaseline[wallet.toLowerCase()];
      if (!b || typeof b !== 'object') return 0;
      return (b.RANK || 0) + (b.GAMBIT || 0) + (b.M8_ARENA || 0) + (b.QUICK || 0) + (b.FRIEND || 0);
    };
    const matchesSinceBaseline = p => Math.max(0, totalMatchCount(p) - baselineTotal(p.wallet));
    // Wild cards: top 2 by matches since baseline, excluding top 8 and manually excluded wallets
    const wildcards   = active
      .filter(p => !top8wallets.has(p.wallet.toLowerCase()) && !excludedSet.has(p.wallet.toLowerCase()))
      .sort((a, b) => matchesSinceBaseline(b) - matchesSinceBaseline(a))
      .slice(0, 2);

    // When showing final results, use manually-overridden finalists data
    let renderedQualified = false;
    if (isResultsFinal()) {
      try {
        const rd = await fetch('/api/results-data').then(r => r.ok ? r.json() : null);
        if (rd) {
          const toObj = arr => ({
            first:  (arr[0] || {}).wallet || '',
            second: (arr[1] || {}).wallet || '',
            third:  (arr[2] || {}).wallet || '',
          });
          const overrideQuals = {
            qualifier1: toObj(rd.qualifier1 || []),
            qualifier2: toObj(rd.qualifier2 || []),
          };
          rd.top8.forEach(p => { if (p.wallet) playerMap[p.wallet.toLowerCase()] = p; });
          rd.wildcards.forEach(p => { if (p.wallet) playerMap[p.wallet.toLowerCase()] = p; });
          renderQualifiedSection(overrideQuals, playerMap, rd.wildcards, rd.top8, matchBaseline, baselineSinceLabel);
          renderedQualified = true;
        }
      } catch { /* fall through to auto-calc */ }
    }

    // Render qualifier section (auto-calc if not already rendered via results-data)
    if (!renderedQualified) renderQualifiedSection(qualifiers, playerMap, wildcards, byRating.slice(0, 8), matchBaseline, baselineSinceLabel);

    if (active.length === 0) {
      tbody.innerHTML = `<tr><td colspan="8" class="loading-cell"><span>No players with matches yet.</span></td></tr>`;
      if (countEl) countEl.textContent = '0';
    } else {
      if (countEl) countEl.textContent = active.length;
      _activePlayers = active;
      sortAndRenderTable(active);
    }

    if (isResultsFinal()) renderChampionCard(playerMap);

    if (updatedEl) {
      const update = () => {
        const diff = Math.floor((Date.now() - lastFetchTime) / 1000);
        updatedEl.textContent = diff < 60 ? 'Updated just now' : `Updated ${Math.floor(diff / 60)}m ago`;
      };
      lastFetchTime = Date.now();
      update();
      clearInterval(window._updatedInterval);
      window._updatedInterval = setInterval(update, 30000);
    }
  } catch (err) {
    errBanner.classList.remove('hidden');
    if (updatedEl) updatedEl.textContent = 'Fetch failed';
    console.error(err);
  } finally {
    // Dismiss on first load; no-op on subsequent 30-min auto-refreshes (loader already removed)
    dismissLoader();
  }
}

async function forceRefresh() {
  if (isPastCutoff()) return;
  trackClick('Refresh', 'engagement');
  const btn = document.getElementById('refresh-btn');
  btn.classList.add('spinning');
  btn.disabled = true;

  // Re-enable button after 35s regardless — prevents permanent disabled state if server is slow
  const safetyTimer = setTimeout(() => {
    btn.classList.remove('spinning');
    btn.disabled = false;
  }, 35000);

  try {
    const res = await fetch('/api/refresh', { signal: AbortSignal.timeout ? AbortSignal.timeout(32000) : undefined });
    clearTimeout(safetyTimer);
    if (!res.ok) throw new Error(`Refresh failed: ${res.status}`);
    location.reload();
  } catch (err) {
    clearTimeout(safetyTimer);
    console.error(err);
    btn.classList.remove('spinning');
    btn.disabled = false;
    document.getElementById('error-banner').classList.remove('hidden');
  }
}

async function applyLogo() {
  const logoImg  = document.getElementById('logo-img');
  const logoIcon = document.getElementById('logo-icon');
  if (!logoImg || !logoIcon) return;

  // Apply cached path immediately — eliminates the pawn flash on every load/refresh
  const cached = localStorage.getItem('anichess-logo');
  if (cached) {
    logoImg.src = cached;
    logoImg.style.display = 'block';
    logoIcon.style.display = 'none';
  }

  try {
    const res = await fetch('/api/logo');
    if (!res.ok) return;
    const data = await res.json();
    if (data.exists && data.filename) {
      const path = `/${data.filename}`;
      localStorage.setItem('anichess-logo', path);
      logoImg.src = path;
      logoImg.style.display = 'block';
      logoIcon.style.display = 'none';
      // Keep favicon in sync with the logo
      const favicon = document.getElementById('favicon');
      if (favicon) favicon.href = '/favicon.ico';
    } else {
      // Logo removed — clear cache and restore pawn
      localStorage.removeItem('anichess-logo');
      logoImg.style.display = 'none';
      logoIcon.style.display = '';
    }
  } catch {}
}

async function applyBackground() {
  try {
    const res = await fetch('/api/background');
    if (!res.ok) return;
    const data = await res.json();
    if (data.exists && data.filename) {
      const url = `/${data.filename}`;
      sessionStorage.setItem('anichess-bg-url', url);
      document.documentElement.style.setProperty('--bg-image', `url(${url})`);
      // Double RAF: ensures background-image is painted before opacity transition fires
      requestAnimationFrame(() => requestAnimationFrame(() => {
        document.body.classList.add('has-bg');
      }));
    } else {
      sessionStorage.removeItem('anichess-bg-url');
      document.documentElement.style.setProperty('--bg-image', 'none');
      document.body.classList.remove('has-bg');
    }
  } catch {}
}

// Click-to-copy wallet address via the copy icon button
document.getElementById('lb-body').addEventListener('click', function(e) {
  const copyBtn = e.target.closest('.copy-wallet-btn');
  if (!copyBtn) return;
  e.preventDefault();
  e.stopPropagation();
  const wallet = copyBtn.dataset.wallet;
  if (!wallet) return;
  navigator.clipboard.writeText(wallet).then(() => {
    showCopiedToast();
  }).catch(() => {
    // Fallback for browsers without clipboard API
    try {
      const tmp = document.createElement('textarea');
      tmp.value = wallet;
      tmp.style.cssText = 'position:fixed;opacity:0;';
      document.body.appendChild(tmp);
      tmp.select();
      document.execCommand('copy');
      tmp.remove();
      showCopiedToast();
    } catch {}
  });
});

// Expand/collapse per-player detail row (mobile only)
document.getElementById('lb-body').addEventListener('click', function(e) {
  const btn = e.target.closest('.expand-btn');
  if (!btn) return;
  const row = btn.closest('tr');
  const isExpanded = btn.classList.contains('expanded');

  // Close any other open detail rows first
  this.querySelectorAll('.expand-btn.expanded').forEach(otherBtn => {
    if (otherBtn === btn) return;
    const otherNext = otherBtn.closest('tr').nextElementSibling;
    if (otherNext && otherNext.classList.contains('detail-row')) otherNext.remove();
    otherBtn.classList.remove('expanded');
    otherBtn.textContent = '▾';
    otherBtn.setAttribute('aria-expanded', 'false');
  });

  const next = row.nextElementSibling;
  if (isExpanded) {
    if (next && next.classList.contains('detail-row')) next.remove();
    btn.classList.remove('expanded');
    btn.textContent = '▾';
    btn.setAttribute('aria-expanded', 'false');
  } else {
    const fmtNum = v => (v != null && v !== '') ? Number(v).toLocaleString() : '—';
    const wins = row.dataset.wins;
    const matches = row.dataset.matches;
    const pct = row.dataset.pct;
    const detail = document.createElement('tr');
    detail.className = 'detail-row';
    detail.innerHTML =
      `<td colspan="8" class="detail-cell"><div class="detail-inner">` +
      `<div class="detail-stat"><span class="detail-label">Wins</span><span class="detail-value">${fmtNum(wins)}</span></div>` +
      `<div class="detail-stat"><span class="detail-label">Matches</span><span class="detail-value">${fmtNum(matches)}</span></div>` +
      `<div class="detail-stat"><span class="detail-label">Win Rate</span><span class="detail-value">${pct != null && pct !== '' ? pct + '%' : '—'}</span></div>` +
      `</div></td>`;
    row.after(detail);
    btn.classList.add('expanded');
    btn.textContent = '▴';
    btn.setAttribute('aria-expanded', 'true');
  }
});

// Remove nav gradient when scrolled to the rightmost end
const headerNav = document.querySelector('.header-nav');
if (headerNav) {
  const syncNavMask = () => {
    const atEnd = headerNav.scrollLeft + headerNav.clientWidth >= headerNav.scrollWidth - 1;
    headerNav.classList.toggle('nav-end', atEnd);
  };
  headerNav.addEventListener('scroll', syncNavMask, { passive: true });
  syncNavMask();
}

function csvEscape(val) {
  const s = val == null ? '' : String(val);
  // Wrap in double-quotes if the value contains a comma, double-quote, or newline
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function exportLeaderboardCSV() {
  const tbody = document.getElementById('lb-body');
  if (!tbody) return;

  const rows = tbody.querySelectorAll('tr:not(.detail-row)');
  if (!rows.length) return;

  const lines = ['Rank,Player,Rating,Matches,Wins,Win Rate'];

  rows.forEach(row => {
    // Skip the loading/empty placeholder row (no data attributes, no rank cell content)
    const rankEl = row.querySelector('.rank-badge, .rank-unranked');
    const playerEl = row.querySelector('.player-name');
    const ratingEl = row.querySelector('.rating-val, .rating-none');
    if (!playerEl) return; // loading row — skip

    const rank = rankEl ? rankEl.textContent.trim() : '—';
    const player = playerEl.title || playerEl.textContent.trim(); // prefer full wallet address from title
    const rating = ratingEl ? ratingEl.textContent.trim() : '—';
    const matches = row.dataset.matches != null && row.dataset.matches !== '' ? row.dataset.matches : '—';
    const wins = row.dataset.wins != null && row.dataset.wins !== '' ? row.dataset.wins : '—';
    const winRate = row.dataset.pct != null && row.dataset.pct !== '' ? row.dataset.pct + '%' : '—';

    lines.push([rank, player, rating, matches, wins, winRate].map(csvEscape).join(','));
  });

  const csv = lines.join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `anichess-leaderboard-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

document.getElementById('export-csv-btn')?.addEventListener('click', exportLeaderboardCSV);

function initSortHeaders() {
  document.querySelectorAll('.th-sortable').forEach(th => {
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      if (_sortKey === key) {
        _sortDir = _sortDir === 'desc' ? 'asc' : 'desc';
      } else {
        _sortKey = key;
        _sortDir = 'desc';
      }
      if (_activePlayers.length) sortAndRenderTable(_activePlayers);
    });
  });
}

applyLogo();
applyBackground();
fetchPlayers();
initSortHeaders();

if (isPastCutoff()) {
  const btn = document.getElementById('refresh-btn');
  if (btn) { btn.disabled = true; btn.title = 'Results being finalized — no further updates'; }
  document.getElementById('finalized-banner')?.classList.remove('hidden');
  const footer = document.querySelector('footer span:nth-child(3)');
  if (footer) footer.textContent = 'Results Being Finalized';

  // Replace "TOP 8 QUALIFIES FOR PLAYOFF" badge with ENDED badge in the leaderboard
  const qualifyBadge = document.querySelector('.qualify-badge');
  if (qualifyBadge) {
    qualifyBadge.className = 'qs-cutoff-badge qs-cutoff-ended';
    qualifyBadge.innerHTML = '<span><strong>ENDED</strong></span>';
  }
} else {
  setInterval(fetchPlayers, REFRESH_INTERVAL);
}
