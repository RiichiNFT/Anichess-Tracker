(function () {
  var NAV_LINKS = [
    { href: '/',                label: 'Home',               internal: true },
    { href: '/tournament.html', label: 'Tournament Details', internal: true },
    { href: '/guides.html',     label: 'Guides',             internal: true },
    { href: '/past-events.html',label: 'Past Events',        internal: true },
    { href: '/updates.html',    label: 'Game Updates',       internal: true, badge: 'Jun 10' },
    'sep',
    { href: 'https://www.anichess.com', label: 'Play Anichess', external: true },
    { href: 'https://discord.com/invite/anichess', label: 'Discord', external: true },
  ];

  function init() {
    var headerInner = document.querySelector('.header-inner');
    if (!headerInner) return;

    // ── Hamburger button ──────────────────────────────────────
    var menuBtn = document.createElement('button');
    menuBtn.className = 'mob-menu-btn';
    menuBtn.setAttribute('aria-label', 'Open menu');
    menuBtn.setAttribute('aria-expanded', 'false');
    menuBtn.innerHTML =
      '<span class="mob-menu-line"></span>' +
      '<span class="mob-menu-line"></span>' +
      '<span class="mob-menu-line"></span>';
    headerInner.appendChild(menuBtn);

    // ── Overlay ───────────────────────────────────────────────
    var overlay = document.createElement('div');
    overlay.className = 'mob-overlay';
    document.body.appendChild(overlay);

    // ── Drawer ────────────────────────────────────────────────
    var currentPath = window.location.pathname;

    var drawer = document.createElement('nav');
    drawer.className = 'mob-drawer';
    drawer.setAttribute('aria-label', 'Site navigation');

    var drawerInner = document.createElement('div');
    drawerInner.className = 'mob-drawer-inner';

    // Header row inside drawer (logo text + close)
    var drawerHead = document.createElement('div');
    drawerHead.className = 'mob-drawer-head';
    drawerHead.innerHTML =
      '<span class="mob-drawer-title">ANICHESS <span class="mob-drawer-accent">TRACKER</span></span>' +
      '<button class="mob-drawer-close" aria-label="Close menu">&#10005;</button>';
    drawerInner.appendChild(drawerHead);

    // Links
    var linkList = document.createElement('div');
    linkList.className = 'mob-drawer-links';

    NAV_LINKS.forEach(function (item) {
      if (item === 'sep') {
        var sep = document.createElement('div');
        sep.className = 'mob-drawer-sep';
        linkList.appendChild(sep);
        return;
      }

      var a = document.createElement('a');
      a.href = item.href;
      a.className = 'mob-drawer-link';

      if (item.external) {
        a.target = '_blank';
        a.rel = 'noopener';
        a.className += ' mob-drawer-ext';
      }

      var isActive = item.internal && (
        currentPath === item.href ||
        (item.href === '/' && (currentPath === '/' || currentPath === '/magnus.html'))
      );
      if (isActive) a.className += ' active';

      // Label
      var label = document.createElement('span');
      label.className = 'mob-drawer-link-label';
      label.textContent = item.label;
      a.appendChild(label);

      // Badge (e.g. Game Updates)
      if (item.badge) {
        var badge = document.createElement('span');
        badge.className = 'mob-drawer-badge';
        badge.innerHTML = '<span class="mob-drawer-dot"></span>' + item.badge;
        a.appendChild(badge);
      }

      // External arrow
      if (item.external) {
        var arrow = document.createElement('span');
        arrow.className = 'mob-drawer-arrow';
        arrow.innerHTML = '<svg width="11" height="11" viewBox="0 0 13 13" fill="none"><path d="M6.5 1H12v5.5M12 1L5 8M3 2H1.5A.5.5 0 001 2.5v9a.5.5 0 00.5.5h9a.5.5 0 00.5-.5V10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
        a.appendChild(arrow);
      }

      linkList.appendChild(a);
    });

    drawerInner.appendChild(linkList);
    drawer.appendChild(drawerInner);
    document.body.appendChild(drawer);

    // ── Open / close ──────────────────────────────────────────
    function openDrawer() {
      drawer.classList.add('open');
      overlay.classList.add('open');
      document.body.style.overflow = 'hidden';
      menuBtn.classList.add('active');
      menuBtn.setAttribute('aria-expanded', 'true');
    }

    function closeDrawer() {
      drawer.classList.remove('open');
      overlay.classList.remove('open');
      document.body.style.overflow = '';
      menuBtn.classList.remove('active');
      menuBtn.setAttribute('aria-expanded', 'false');
    }

    menuBtn.addEventListener('click', function () {
      drawer.classList.contains('open') ? closeDrawer() : openDrawer();
    });
    overlay.addEventListener('click', closeDrawer);
    drawerHead.querySelector('.mob-drawer-close').addEventListener('click', closeDrawer);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeDrawer();
    });
  }

  function updateNavBadge() {
    fetch('/api/game-updates')
      .then(function(r) { return r.json(); })
      .then(function(entries) {
        if (!entries || !entries.length) return;
        var d = new Date(entries[0].date + 'T12:00:00Z');
        var label = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
        // Update desktop chips
        document.querySelectorAll('.nav-update-chip').forEach(function(chip) {
          chip.childNodes.forEach(function(node) {
            if (node.nodeType === 3) node.textContent = label;
          });
        });
        // Update mobile drawer badges
        document.querySelectorAll('.mob-drawer-badge').forEach(function(badge) {
          badge.childNodes.forEach(function(node) {
            if (node.nodeType === 3) node.textContent = label;
          });
        });
      })
      .catch(function() {});
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() { init(); updateNavBadge(); });
  } else {
    init();
    updateNavBadge();
  }
})();
