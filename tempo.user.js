// ==UserScript==
// @name         Tempo Planner — show parent task on cards
// @namespace    http://tampermonkey.net/
// @version      2.7.1
// @updateURL    https://raw.githubusercontent.com/Pod-Apollo/tempo-planner-parent-task/refs/heads/main/tempo.user.js
// @downloadURL  https://raw.githubusercontent.com/Pod-Apollo/tempo-planner-parent-task/refs/heads/main/tempo.user.js
// @description  On the Tempo Capacity planner only, reads each card's issue key, looks up the subtask's parent via the Jira REST API, and injects a clickable parent key + name sized to its container.
// @author       Yaxche Manrique
// @match        https://levelaccess-services.atlassian.net/*
// @match        https://*.atlassian-dev.net/*
// @match        https://*.tempo.io/*
// @grant        GM_xmlhttpRequest
// @grant        GM_openInTab
// @connect      levelaccess-services.atlassian.net
// @connect      atlassian.net
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ================================ CONFIG ==================================
  const JIRA_HOST = 'levelaccess-services.atlassian.net';
  const JIRA = 'https://' + JIRA_HOST;

  // The script activates only when the TOP window's path matches this.
  // Every other screen on the instance is left completely alone.
  const PATH_RE = /\/planner\//;

  // Leave both blank to use your existing browser session.
  // Fill in only if the console shows 401/403.
  const EMAIL = '';
  const API_TOKEN = '';

  // Tempo marks each planned-time card as draggable and/or gives it a
  // data-handler-id. That identifies one issue far more reliably than size —
  // sizing alone kept selecting the day cell that wraps every card in a column.
  const CARD_SELECTOR = '[draggable="true"], [data-handler-id]';

  // Fallback bounds, used only when no card element is found above.
  const MAX_HOST_WIDTH = 420;

  // Days view: cards narrower than this are skipped. The weeks view's 36px
  // timeline chips match CARD_SELECTOR too, and this is what excludes them.
  const MIN_INLINE_WIDTH = 110;

  // Weeks view: Tempo's own hook for the row's issue-key link. The trailing id
  // (712020:0bad9bcf-…-886478) differs per row, so match on the prefix. The
  // badge goes into this link's parent div, right after the link.
  const WEEKS_KEY_SELECTOR = 'a[data-testid^="plan-item-key-"]';

  // That column is narrow; this only rejects a collapsed/zero-width one.
  const MIN_CELL_WIDTH = 40;

  // Label above the link in the weeks view.
  const PARENT_LABEL = 'Parent:';

  // Cards narrower than this show the parent key alone, no summary.
  const COMPACT_WIDTH = 170;

  const DEBUG = false;
  // ==========================================================================

  const BATCH_SIZE = 50;
  const DEBOUNCE_MS = 350;
  const BADGE_CLASS = 'ymk-parent';
  const DONE_ATTR = 'data-ymk-parent';
  const WIDTH_ATTR = 'data-ymk-w';
  const KEY_ONLY_RE = /^([A-Z][A-Z0-9_]{1,9}-\d+)$/;
  const MSG = 'ymk-parent-badge';

  const IS_TOP = window.top === window;
  const log = (...a) => DEBUG && console.log('[parent-badge]', IS_TOP ? '(top)' : '(frame)', ...a);

  const FRAME_ORIGIN_OK = (o) =>
    /^https:\/\/([a-z0-9-]+\.)*atlassian-dev\.net$/.test(o) ||
    /^https:\/\/([a-z0-9-]+\.)*tempo\.io$/.test(o) ||
    o === JIRA;

  // ==========================================================================
  // TOP FRAME — the only context that can read the real URL. It owns the on/off
  // decision and tells the app frames. It never scans or modifies anything.
  // ==========================================================================
  if (IS_TOP) {
    if (location.hostname !== JIRA_HOST) return;

    const listeners = [];

    // viewType is absent or "days" in the days view; "weeks" (or "months") in
    // the list-style views, where only the left-hand key column gets a badge.
    const state = () => {
      const vt = (new URLSearchParams(location.search).get('viewType') || '').toLowerCase();
      return {
        tag: MSG,
        type: 'ctx',
        enabled: PATH_RE.test(location.pathname),
        listView: !!vt && vt !== 'days',
      };
    };

    const reply = (source, origin) => {
      try { source.postMessage(state(), origin); } catch (e) { /* frame gone */ }
    };

    window.addEventListener('message', (e) => {
      const d = e.data;
      if (!d || d.tag !== MSG || d.type !== 'req') return;
      if (!FRAME_ORIGIN_OK(e.origin) || !e.source) return;
      if (!listeners.some((l) => l.source === e.source)) {
        listeners.push({ source: e.source, origin: e.origin });
      }
      reply(e.source, e.origin);
    });

    // Tempo is a SPA — changing view or dates rewrites the URL with no reload.
    let lastHref = location.href;
    setInterval(() => {
      if (location.href === lastHref) return;
      lastHref = location.href;
      log('url ->', PATH_RE.test(location.pathname) ? 'enabled' : 'disabled');
      listeners.forEach((l) => reply(l.source, l.origin));
    }, 500);

    log('gate active');
    return;
  }

  // ==========================================================================
  // APP FRAME — does the work, but only after the top frame says so.
  // ==========================================================================
  let enabled = false;
  let listView = false;   // true in the weeks/months views, set by the top frame
  let observer = null;
  let timer = null;
  let answered = false;

  // ------------------------------------------------------------------ cache --
  const cache = new Map();
  const inflight = new Set();

  try {
    const stored = JSON.parse(sessionStorage.getItem('ymk-parent-cache') || '{}');
    for (const [k, v] of Object.entries(stored)) cache.set(k, v);
  } catch (e) { /* sandboxed frame or private mode */ }

  const persist = () => {
    try {
      sessionStorage.setItem('ymk-parent-cache', JSON.stringify(Object.fromEntries(cache)));
    } catch (e) { /* ignore */ }
  };

  // -------------------------------------------------------------- API layer --
  function apiGet(path) {
    const headers = { Accept: 'application/json' };
    if (EMAIL && API_TOKEN) headers.Authorization = 'Basic ' + btoa(`${EMAIL}:${API_TOKEN}`);

    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url: JIRA + path,
        headers,
        anonymous: false,
        onload: (r) => {
          if (r.status >= 200 && r.status < 300) {
            try { resolve(JSON.parse(r.responseText)); }
            catch (e) { reject(new Error('bad JSON from ' + path)); }
          } else if (r.status === 401 || r.status === 403) {
            reject(new Error(`${r.status} unauthorised — set EMAIL and API_TOKEN at the top of the script.`));
          } else {
            reject(new Error(r.status + ' on ' + path));
          }
        },
        onerror: () => reject(new Error('network error on ' + path)),
      });
    });
  }

  function record(issue) {
    const p = issue.fields && issue.fields.parent;
    cache.set(issue.key, p
      ? { parentKey: p.key, parentSummary: (p.fields && p.fields.summary) || '' }
      : null);
  }

  async function lookup(keys) {
    const jql = encodeURIComponent(`key in (${keys.join(',')})`);
    try {
      const data = await apiGet(`/rest/api/3/search/jql?jql=${jql}&fields=parent&maxResults=${keys.length}`);
      const seen = new Set();
      for (const issue of data.issues || []) { seen.add(issue.key); record(issue); }
      for (const k of keys) if (!seen.has(k)) cache.set(k, null);
    } catch (e) {
      log('batch failed, per-issue fallback:', e.message);
      for (const k of keys) {
        try { record(await apiGet(`/rest/api/3/issue/${k}?fields=parent`)); }
        catch (err) { log('failed', k, err.message); cache.set(k, null); }
      }
    }
    persist();
  }

  // ------------------------------------------------------------------ styles --
  function injectStyle() {
    if (document.getElementById('ymk-parent-style')) return;
    const style = document.createElement('style');
    style.id = 'ymk-parent-style';
    style.textContent = `
      .${BADGE_CLASS} {
        display: flex;
        flex-direction: column;
        color: #626F86;
      }

      /* Days view — eyebrow above the card title. */
      .${BADGE_CLASS}.ymk-eyebrow {
        margin: 0 0 5px 0;
        padding-bottom: 4px;
        padding-left: 8px;
        border-bottom: 1px solid rgba(9, 30, 66, .1);
        font-size: 10.5px;
        letter-spacing: .01em;
      }

      /* Weeks view — "Parent:" then the link, under the row's own issue key. */
      .${BADGE_CLASS}.ymk-cell {
        margin: 3px 0 0 0;
        font-size: 10.5px;
        line-height: 1.35;
        min-width: 0;
      }
      .${BADGE_CLASS}.ymk-cell .ymk-label {
        opacity: .75;
      }
      .${BADGE_CLASS}.ymk-cell a {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .${BADGE_CLASS} a {
        color: #0C66E4;
        font-weight: 600;
      }

      .${BADGE_CLASS}.ymk-compact { gap: 3px; font-size: 10.5px; }
      .${BADGE_CLASS}.ymk-compact .ymk-sum { display: none; }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  // -------------------------------------------------------------------- DOM --
  // Find the element representing ONE issue. Tempo's own markup answers this:
  // the nearest draggable / data-handler-id ancestor is the card. Size is only
  // a fallback, because the day cell that wraps a whole column is *wider* than
  // the cards inside it and kept winning a size-based contest.
  // Returns the container plus which of the two placements it wants:
  //   'eyebrow' — a real Tempo timeline card (days view): badge goes on top.
  //   'cell'    — a left-panel table cell (weeks view): badge goes under the key.
  const NOWHERE = { card: null, mode: null };

  function findCard(el) {
    if (listView) {
      // Weeks/months: ONLY the left-hand key column. The timeline chips here
      // are wide enough to look like days-view cards and carry data-handler-id,
      // so they have to be excluded by view, not by size.
      const planKey = el.closest(WEEKS_KEY_SELECTOR);
      if (planKey && planKey.parentElement) {
        return { card: planKey.parentElement, mode: 'cell', row: planKey };
      }
      return NOWHERE;
    }

    // Days view: the timeline card itself.
    const marked = el.closest(CARD_SELECTOR);
    if (marked && marked.getBoundingClientRect().width <= 500) {
      return { card: marked, mode: 'eyebrow' };
    }

    return NOWHERE;
  }

  function keyElements() {
    const out = [];
    const mine = '.' + BADGE_CLASS;

    document.querySelectorAll('a[href*="/browse/"]').forEach((a) => {
      // Never read our own injected links — that is how the badge chain
      // (parent of parent of parent…) started.
      if (a.closest(mine)) return;
      const m = (a.getAttribute('href') || '').match(/\/browse\/([A-Z][A-Z0-9_]{1,9}-\d+)/);
      if (m) out.push({ el: a, key: m[1] });
    });

    document.querySelectorAll('span, div, td, p, b, strong, small').forEach((el) => {
      if (el.children.length) return;
      if (el.closest(mine)) return;
      const t = (el.textContent || '').trim();
      if (!t || t.length > 20) return;
      const m = t.match(KEY_ONLY_RE);
      if (m) out.push({ el, key: m[1] });
    });

    return out;
  }

  function innerWidth(host) {
    const cs = getComputedStyle(host);
    const w = host.getBoundingClientRect().width
      - (parseFloat(cs.paddingLeft) || 0)
      - (parseFloat(cs.paddingRight) || 0);
    return Math.max(40, Math.round(w));
  }

  function fit(badge, width) {
    badge.style.maxWidth = width + 'px';
    badge.classList.toggle('ymk-compact', width < COMPACT_WIDTH);
  }

  // First element inside the card that holds visible text and isn't the issue
  // key — that's the card's title ("Rework", "M9: Influencer page"). Anchoring
  // to it puts the badge inside the white card rather than above it, wherever
  // Tempo nests its wrappers.
  function titleLeaf(card, keyEl) {
    const walker = document.createTreeWalker(card, NodeFilter.SHOW_ELEMENT);
    let n;
    while ((n = walker.nextNode())) {
      if (n === keyEl || n.contains(keyEl) || n.closest('.' + BADGE_CLASS)) continue;
      if (n.children.length) continue;
      if ((n.textContent || '').trim()) return n;
    }
    return null;
  }

  function render(card, row, info, mode, keyEl) {
    if (card.querySelector('.' + BADGE_CLASS)) return;

    // In the days view, sit directly above the title, inside the white card.
    const title = mode === 'eyebrow' ? titleLeaf(card, keyEl) : null;
    const box = title && title.parentElement ? title.parentElement : card;

    // Weeks-view timeline chips are ~36px wide — nothing legible fits, and the
    // parent is shown in the left-hand row instead. Leave them untouched.
    const width = innerWidth(box);
    if (width < (mode === 'eyebrow' ? MIN_INLINE_WIDTH : MIN_CELL_WIDTH)) return;

    injectStyle();

    const badge = document.createElement('div');
    badge.className = `${BADGE_CLASS} ${mode === 'eyebrow' ? 'ymk-eyebrow' : 'ymk-cell'}`;
    fit(badge, width);
    badge.setAttribute(WIDTH_ATTR, String(width));

    // Weeks view: "Parent:" on its own line above the link. The badge is a
    // flex column, so the label and the link stack without a <br>.
    if (mode === 'cell') {
      const lab = document.createElement('span');
      lab.className = 'ymk-label';
      lab.textContent = PARENT_LABEL;
      badge.appendChild(lab);
    }

    const a = document.createElement('a');
    a.href = `${JIRA}/browse/${info.parentKey}`;
    a.textContent = info.parentKey;
    a.title = info.parentSummary ? `${info.parentSummary}` : info.parentKey;
    ['mousedown', 'pointerdown', 'dragstart'].forEach((ev) =>
      a.addEventListener(ev, (e) => e.stopPropagation())
    );
    a.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      const url = `${JIRA}/browse/${info.parentKey}`;
      if (typeof GM_openInTab === 'function') GM_openInTab(url, { active: true, insert: true });
      else window.open(url, '_blank', 'noopener');
    });
    badge.appendChild(a);

    // Days view only — in the weeks view the name lives in the link's tooltip.
    if (mode === 'eyebrow') {
      const parentName = document.createElement('span');
      parentName.className = 'ymk-parent-name';
      parentName.textContent = info.parentSummary ? `${info.parentSummary}` : info.parentKey;
      badge.appendChild(parentName);
    }

    // If the box lays its children out in a row, let them wrap so the badge
    // takes its own line instead of stretching it.
    const cs = getComputedStyle(box);
    if (/flex/.test(cs.display) && !/column/.test(cs.flexDirection) && cs.flexWrap === 'nowrap') {
      box.style.flexWrap = 'wrap';
    }

    if (title) {
      // Immediately above the title text, same container, inside the card.
      box.insertBefore(badge, title);
    } else if (mode === 'eyebrow') {
      card.insertBefore(badge, card.firstChild);
    } else if (row && row.parentElement === card) {
      card.insertBefore(badge, row.nextSibling);
    } else {
      card.appendChild(badge);
    }
  }

  // Re-fit when the card resizes (switching views, resizing columns).
  function refit(card) {
    const badge = card.querySelector('.' + BADGE_CLASS);
    if (!badge || !badge.parentElement) return;
    const prev = Number(badge.getAttribute(WIDTH_ATTR)) || 0;
    badge.style.maxWidth = '';
    const now = innerWidth(badge.parentElement);
    if (Math.abs(now - prev) < 8) { badge.style.maxWidth = prev + 'px'; return; }
    badge.setAttribute(WIDTH_ATTR, String(now));
    fit(badge, now);
  }

  function clearAll() {
    document.querySelectorAll('.' + BADGE_CLASS).forEach((b) => b.remove());
    document.querySelectorAll('[' + DONE_ATTR + ']').forEach((c) => {
      c.removeAttribute(DONE_ATTR);
      c.removeAttribute(WIDTH_ATTR);
    });
  }

  async function scan() {
    if (!enabled) return;

    const found = keyElements();
    if (!found.length) return;

    const pending = [];

    for (const { el, key } of found) {
      const { card, mode, row: anchorRow } = findCard(el);
      if (!card || !mode) continue;
      const row = anchorRow || (el.parentElement === card ? el : null);

      // One badge per card, ever — a card already claimed by another key is
      // left alone rather than stacking a second line onto it.
      if (card.hasAttribute(DONE_ATTR)) {
        if (card.getAttribute(DONE_ATTR) === key) refit(card);
        continue;
      }

      if (cache.has(key)) {
        const info = cache.get(key);
        card.setAttribute(DONE_ATTR, key);
        if (info) render(card, row, info, mode, el);
      } else if (!inflight.has(key)) {
        pending.push(key);
      }
    }

    const unique = [...new Set(pending)];
    if (!unique.length) return;

    unique.forEach((k) => inflight.add(k));
    log('looking up', unique.length, 'issue(s)');
    try {
      for (let i = 0; i < unique.length; i += BATCH_SIZE) {
        if (!enabled) return;
        await lookup(unique.slice(i, i + BATCH_SIZE));
      }
    } finally {
      unique.forEach((k) => inflight.delete(k));
    }

    scan();
  }

  const schedule = () => {
    if (!enabled) return;
    clearTimeout(timer);
    timer = setTimeout(
      () => scan().catch((e) => console.warn('[parent-badge]', e.message)),
      DEBOUNCE_MS
    );
  };

  function setEnabled(on) {
    if (on === enabled) return;
    enabled = on;
    log(on ? 'enabled by top frame' : 'disabled by top frame');

    if (on) {
      observer = new MutationObserver(schedule);
      observer.observe(document.body, { childList: true, subtree: true });
      window.addEventListener('resize', schedule);
      schedule();
    } else {
      if (observer) { observer.disconnect(); observer = null; }
      window.removeEventListener('resize', schedule);
      clearTimeout(timer);
      clearAll();
    }
  }

  // ------------------------------------------------------- handshake with top --
  window.addEventListener('message', (e) => {
    const d = e.data;
    if (!d || d.tag !== MSG || d.type !== 'ctx') return;
    if (e.origin !== JIRA) return;
    answered = true;

    const wasList = listView;
    listView = !!d.listView;
    const wasEnabled = enabled;

    setEnabled(!!d.enabled);

    // Switching days <-> weeks without leaving the planner: the badges that are
    // already placed belong to the other view, so start clean.
    if (enabled && wasEnabled && listView !== wasList) {
      log('view changed ->', listView ? 'list' : 'days');
      clearAll();
      schedule();
    }
  });

  const ask = () => {
    try { window.top.postMessage({ tag: MSG, type: 'req' }, JIRA); } catch (e) { /* ignore */ }
  };

  ask();
  // Retry briefly in case this frame mounted before the top-frame gate did.
  let tries = 0;
  const retry = setInterval(() => {
    if (answered || ++tries > 12) return clearInterval(retry);
    ask();
  }, 400);
})();