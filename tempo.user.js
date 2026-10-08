// ==UserScript==
// @name         Tempo Capacity Planner Parent Display - Merged
// @namespace    capacity-planner-parent-display
// @version      2.7.2
// @description  Displays responsive Jira parent links and cleaned parent summaries on Tempo Planner cards across days and list views.
// @author       Ali Zimmerman / Yaxche Manrique
// @match        https://levelaccess-services.atlassian.net/*
// @match        https://*.atlassian-dev.net/*
// @match        https://*.tempo.io/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        GM_openInTab
// @connect      levelaccess-services.atlassian.net
// @connect      atlassian.net
// @updateURL    https://raw.githubusercontent.com/Pod-Apollo/tempo-planner-parent-task/refs/heads/main/tempo.user.js
// @downloadURL  https://raw.githubusercontent.com/Pod-Apollo/tempo-planner-parent-task/refs/heads/main/tempo.user.js
// ==/UserScript==

(function () {
    'use strict';

    // ================================ CONFIG =================================
    const JIRA_HOST = 'levelaccess-services.atlassian.net';
    const JIRA = 'https://' + JIRA_HOST;
    const PLANNER_PATH_RE = /\/planner(?:\/|$)/;

    // Leave blank to use the existing browser session. Populate only if the
    // console reports 401 or 403 and your organization's policy permits it.
    const EMAIL = '';
    const API_TOKEN = '';

    const CARD_SELECTOR = '[draggable="true"], [data-handler-id]';
    const WEEKS_KEY_SELECTOR = 'a[data-testid^="plan-item-key-"]';
    const ISSUE_KEY_RE = /^[A-Z][A-Z0-9_]{1,9}-\d+$/;
    const ISSUE_KEY_IN_URL_RE = /\/browse\/([A-Z][A-Z0-9_]{1,9}-\d+)/;
    const ISSUE_KEY_ANYWHERE_RE = /\b([A-Z][A-Z0-9_]{1,9}-\d+)\b/;

    const MIN_INLINE_WIDTH = 110;
    const MIN_CELL_WIDTH = 40;
    const COMPACT_WIDTH = 170;
    const BATCH_SIZE = 50;
    const DEBOUNCE_MS = 350;
    const REQUEST_TIMEOUT_MS = 30000;
    const PARENT_LABEL = 'Parent:';
    const DEBUG = false;

    // Summary prefixes that are useful in Jira but repetitive in Capacity Planner.
    const SUMMARY_PREFIX_RE = /^\s*(?:VPAT\s+Creation|Creation|Technical\s+Question)\s*[-:]+\s*/i;

    const BADGE_CLASS = 'az-parent-badge';
    const DONE_ATTR = 'data-az-parent-for';
    const WIDTH_ATTR = 'data-az-parent-width';
    const CACHE_KEY = 'az-tempo-parent-cache-v3';
    const MESSAGE_TAG = 'az-tempo-parent-context-v3';
    const IS_TOP = window.top === window;

    const log = (...args) => {
        if (DEBUG) {
            console.log('[Tempo Parent Display]', IS_TOP ? '(top)' : '(frame)', ...args);
        }
    };

    const frameOriginAllowed = (origin) =>
        /^https:\/\/([a-z0-9-]+\.)*atlassian-dev\.net$/.test(origin) ||
        /^https:\/\/([a-z0-9-]+\.)*tempo\.io$/.test(origin) ||
        origin === JIRA;

    // ============================== TOP WINDOW ================================
    // The top Jira page owns the real planner URL. It tells embedded Tempo frames
    // whether scanning should be active and which layout is currently displayed.
    if (IS_TOP) {
        if (location.hostname !== JIRA_HOST) {
            return;
        }

        const listeners = [];

        function getContext() {
            const viewType = (
                new URLSearchParams(location.search).get('viewType') || ''
            ).toLowerCase();

            return {
                tag: MESSAGE_TAG,
                type: 'context',
                enabled: PLANNER_PATH_RE.test(location.pathname),
                listView: Boolean(viewType) && viewType !== 'days'
            };
        }

        function reply(source, origin) {
            try {
                source.postMessage(getContext(), origin);
            } catch (error) {
                log('Could not reply to frame:', error.message);
            }
        }

        window.addEventListener('message', (event) => {
            const data = event.data;
            if (!data || data.tag !== MESSAGE_TAG || data.type !== 'request-context') {
                return;
            }
            if (!frameOriginAllowed(event.origin) || !event.source) {
                return;
            }
            if (!listeners.some((listener) => listener.source === event.source)) {
                listeners.push({ source: event.source, origin: event.origin });
            }
            reply(event.source, event.origin);
        });

        let lastHref = location.href;
        setInterval(() => {
            if (location.href === lastHref) {
                return;
            }
            lastHref = location.href;
            listeners.forEach((listener) => reply(listener.source, listener.origin));
        }, 500);

        log('Top-window gate active');
        return;
    }

    // =============================== APP FRAME ================================
    let enabled = false;
    let listView = false;
    let observer = null;
    let scanTimer = null;
    let contextAnswered = false;

    const cache = new Map();
    const inflight = new Set();

    try {
        const stored = JSON.parse(sessionStorage.getItem(CACHE_KEY) || '{}');
        Object.entries(stored).forEach(([key, value]) => cache.set(key, value));
    } catch (error) {
        log('Session cache unavailable:', error.message);
    }

    function persistCache() {
        try {
            sessionStorage.setItem(
                CACHE_KEY,
                JSON.stringify(Object.fromEntries(cache))
            );
        } catch (error) {
            log('Could not persist cache:', error.message);
        }
    }

    // ================================ API =====================================
    function apiGet(path) {
        const headers = { Accept: 'application/json' };
        if (EMAIL && API_TOKEN) {
            headers.Authorization = 'Basic ' + btoa(`${EMAIL}:${API_TOKEN}`);
        }

        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url: JIRA + path,
                headers,
                anonymous: false,
                timeout: REQUEST_TIMEOUT_MS,
                onload: (response) => {
                    if (response.status >= 200 && response.status < 300) {
                        try {
                            resolve(JSON.parse(response.responseText));
                        } catch (error) {
                            reject(new Error('Invalid JSON returned from ' + path));
                        }
                        return;
                    }

                    if (response.status === 401 || response.status === 403) {
                        reject(new Error(
                            response.status +
                            ' unauthorized. Confirm your Jira session or configure credentials.'
                        ));
                        return;
                    }

                    reject(new Error(response.status + ' returned from ' + path));
                },
                onerror: () => reject(new Error('Network error on ' + path)),
                ontimeout: () => reject(new Error('Request timed out on ' + path))
            });
        });
    }

    function recordIssue(issue) {
        const parent = issue && issue.fields && issue.fields.parent;
        cache.set(
            issue.key,
            parent && parent.key
                ? {
                    key: parent.key,
                    summary:
                        parent.fields && parent.fields.summary
                            ? parent.fields.summary
                            : ''
                }
                : null
        );
    }

    async function lookupIssues(keys) {
        const jql = encodeURIComponent(`key in (${keys.join(',')})`);

        try {
            const data = await apiGet(
                `/rest/api/3/search/jql?jql=${jql}&fields=parent&maxResults=${keys.length}`
            );
            const seen = new Set();

            for (const issue of data.issues || []) {
                seen.add(issue.key);
                recordIssue(issue);
            }

            // The batch request succeeded, so absent keys are safe to remember as
            // having no usable result for this session.
            keys.forEach((key) => {
                if (!seen.has(key)) {
                    cache.set(key, null);
                }
            });
        } catch (batchError) {
            log('Batch request failed; using per-issue fallback:', batchError.message);

            for (const key of keys) {
                try {
                    const issue = await apiGet(
                        `/rest/api/3/issue/${encodeURIComponent(key)}?fields=parent`
                    );
                    recordIssue(issue);
                } catch (issueError) {
                    // Do not cache transient failures as "no parent". A later scan
                    // can retry them after the in-flight state is cleared.
                    console.warn(
                        '[Tempo Parent Display] Could not retrieve',
                        key + ':',
                        issueError.message
                    );
                }
            }
        }

        persistCache();
    }

    // =============================== DISPLAY ==================================
    function injectStyles() {
        if (document.getElementById('az-parent-badge-style')) {
            return;
        }

        const style = document.createElement('style');
        style.id = 'az-parent-badge-style';
        style.textContent = `
            .${BADGE_CLASS} {
                display: flex;
                flex-direction: column;
                color: var(--az-parent-text, #FFFFFF);
                min-width: 0;
            }
            .${BADGE_CLASS}.az-eyebrow {
                margin: 0 0 5px 0;
                padding: 0 0 4px 8px;
                border-bottom: 1px solid rgba(9, 30, 66, .14);
                font-size: 10.5px;
                line-height: 1.25;
                letter-spacing: .01em;
            }
            .${BADGE_CLASS}.az-cell {
                margin: 3px 0 0 0;
                font-size: 10.5px;
                line-height: 1.35;
            }
            .${BADGE_CLASS} .az-label {
                color: var(--az-parent-text, #FFFFFF);
                font-weight: 600;
            }
            .${BADGE_CLASS} a {
                color: var(--az-parent-link, #5CD5FF);
                font-weight: 600;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }
            .${BADGE_CLASS} .az-summary {
                color: var(--az-parent-text, #FFFFFF);
                font-weight: 600;
                white-space: normal;
                overflow-wrap: anywhere;
            }
            .${BADGE_CLASS} a + .az-summary {
                margin-top: 2px;
            }
            .${BADGE_CLASS}.az-compact {
                gap: 3px;
                font-size: 10.5px;
            }
            .${BADGE_CLASS}.az-compact a {
                font-size: 10px;
            }
        `;
        (document.head || document.documentElement).appendChild(style);
    }

    function parseCssColor(color) {
        if (!color || color === 'transparent') {
            return null;
        }
        const match = color.match(/rgba?\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)(?:\s*,\s*(\d*(?:\.\d+)?))?\s*\)/i);
        if (!match) {
            return null;
        }
        return {
            r: Number(match[1]),
            g: Number(match[2]),
            b: Number(match[3]),
            a: match[4] === undefined || match[4] === '' ? 1 : Number(match[4])
        };
    }

    function findBackgroundColor(element) {
        let node = element;
        while (node && node.nodeType === Node.ELEMENT_NODE) {
            const color = parseCssColor(getComputedStyle(node).backgroundColor);
            if (color && color.a > 0.05) {
                return color;
            }
            node = node.parentElement;
        }
        return null;
    }

    function isLightColor(color) {
        const luminance = (0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b) / 255;
        return luminance > 0.55;
    }

    function applyBadgeTheme(badge, surface) {
        const background = findBackgroundColor(surface || badge.parentElement);
        const lightSurface = background
            ? isLightColor(background)
            : Boolean(window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches);

        badge.style.setProperty('--az-parent-text', lightSurface ? '#172B4D' : '#FFFFFF');
        badge.style.setProperty('--az-parent-link', lightSurface ? '#0052CC' : '#5CD5FF');
    }

    function escapeRegExp(value) {
        return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    function createDisplaySummary(parentSummary, childTitle) {
        if (!parentSummary) {
            return '';
        }

        let label = parentSummary.trim();
        const trimmedChildTitle = (childTitle || '').trim();

        if (trimmedChildTitle) {
            label = label.replace(
                new RegExp(escapeRegExp(trimmedChildTitle), 'ig'),
                ' '
            );
        }

        return label
            .replace(SUMMARY_PREFIX_RE, '')
            .replace(/\s+/g, ' ')
            .replace(/^[-: |]+|[-: |]+$/g, '')
            .trim();
    }

    function innerWidth(host) {
        const styles = getComputedStyle(host);
        const width =
            host.getBoundingClientRect().width -
            (parseFloat(styles.paddingLeft) || 0) -
            (parseFloat(styles.paddingRight) || 0);
        return Math.max(40, Math.round(width));
    }

    function fitBadge(badge, width) {
        badge.style.maxWidth = width + 'px';
        badge.classList.toggle('az-compact', width < COMPACT_WIDTH);
    }

    function getTitleLeaf(card, keyElement) {
        const walker = document.createTreeWalker(
            card,
            NodeFilter.SHOW_ELEMENT
        );
        let node;

        while ((node = walker.nextNode())) {
            if (
                node === keyElement ||
                node.contains(keyElement) ||
                node.closest('.' + BADGE_CLASS)
            ) {
                continue;
            }
            if (node.children.length) {
                continue;
            }
            if ((node.textContent || '').trim()) {
                return node;
            }
        }

        return null;
    }

    function renderBadge(card, row, parentInfo, mode, keyElement) {
        if (!parentInfo || card.querySelector('.' + BADGE_CLASS)) {
            return;
        }

        const title = mode === 'eyebrow' ? getTitleLeaf(card, keyElement) : null;
        const box = title && title.parentElement ? title.parentElement : card;
        const width = innerWidth(box);
        const minimumWidth = mode === 'eyebrow' ? MIN_INLINE_WIDTH : MIN_CELL_WIDTH;

        if (width < minimumWidth) {
            return;
        }

        injectStyles();

        const badge = document.createElement('div');
        badge.className = `${BADGE_CLASS} ${mode === 'eyebrow' ? 'az-eyebrow' : 'az-cell'}`;
        badge.setAttribute(WIDTH_ATTR, String(width));
        badge.setAttribute('data-child-key', card.getAttribute(DONE_ATTR) || '');
        badge.setAttribute('data-parent-key', parentInfo.key);
        fitBadge(badge, width);
        applyBadgeTheme(badge, box);

        if (mode === 'cell') {
            const label = document.createElement('span');
            label.className = 'az-label';
            label.textContent = PARENT_LABEL;
            badge.appendChild(label);
        }

        const link = document.createElement('a');
        link.href = `${JIRA}/browse/${parentInfo.key}`;
        link.textContent = parentInfo.key;
        link.title = parentInfo.summary || parentInfo.key;

        ['mousedown', 'pointerdown', 'dragstart'].forEach((eventName) => {
            link.addEventListener(eventName, (event) => event.stopPropagation());
        });

        link.addEventListener('click', (event) => {
            event.stopPropagation();
            event.preventDefault();
            const url = `${JIRA}/browse/${parentInfo.key}`;
            if (typeof GM_openInTab === 'function') {
                GM_openInTab(url, { active: true, insert: true });
            } else {
                window.open(url, '_blank', 'noopener');
            }
        });
        badge.appendChild(link);

        // Keep the parent link first so it is clearly associated with the
        // parent summary below, rather than with the subtask title that follows.
        // If cleanup removes the entire string, fall back to the full Jira
        // summary so the useful context never disappears.
        const childTitle = title ? (title.textContent || '').trim() : '';
        const cleanedSummary = createDisplaySummary(
            parentInfo.summary,
            childTitle
        );
        const displaySummary = cleanedSummary || parentInfo.summary || '';

        if (displaySummary) {
            const summary = document.createElement('span');
            summary.className = 'az-summary';
            summary.textContent = displaySummary;
            summary.title = parentInfo.summary || displaySummary;
            badge.appendChild(summary);
        }

        const boxStyles = getComputedStyle(box);
        if (
            /flex/.test(boxStyles.display) &&
            !/column/.test(boxStyles.flexDirection) &&
            boxStyles.flexWrap === 'nowrap'
        ) {
            box.style.flexWrap = 'wrap';
        }

        if (title) {
            box.insertBefore(badge, title);
        } else if (mode === 'eyebrow') {
            card.insertBefore(badge, card.firstChild);
        } else if (row && row.parentElement === card) {
            card.insertBefore(badge, row.nextSibling);
        } else {
            card.appendChild(badge);
        }
    }

    function refitCard(card) {
        const badge = card.querySelector('.' + BADGE_CLASS);
        if (!badge || !badge.parentElement) {
            return;
        }

        const previousWidth = Number(badge.getAttribute(WIDTH_ATTR)) || 0;
        badge.style.maxWidth = '';
        const currentWidth = innerWidth(badge.parentElement);

        if (Math.abs(currentWidth - previousWidth) < 8) {
            badge.style.maxWidth = previousWidth + 'px';
            return;
        }

        badge.setAttribute(WIDTH_ATTR, String(currentWidth));
        fitBadge(badge, currentWidth);
    }

    function clearAllBadges() {
        document.querySelectorAll('.' + BADGE_CLASS).forEach((badge) => badge.remove());
        document.querySelectorAll('[' + DONE_ATTR + ']').forEach((card) => {
            card.removeAttribute(DONE_ATTR);
            card.removeAttribute(WIDTH_ATTR);
        });
    }

    // ============================== DOM DISCOVERY =============================
    const NOWHERE = { card: null, mode: null, row: null };

    function findCard(element) {
        if (listView) {
            // Weeks/months main grid: place the parent information beneath the
            // issue key in the left-hand work-item row.
            const planKey = element.closest(WEEKS_KEY_SELECTOR);
            if (planKey && planKey.parentElement) {
                return {
                    card: planKey.parentElement,
                    mode: 'cell',
                    row: planKey
                };
            }

            // The Work Items rail still uses full-size draggable cards in Weeks
            // view. Support those as normal cards, while rejecting the narrow
            // timeline chips in the grid.
            const railCard = element.closest(CARD_SELECTOR);
            if (railCard) {
                const width = railCard.getBoundingClientRect().width;
                if (width >= MIN_INLINE_WIDTH && width <= 500) {
                    return { card: railCard, mode: 'eyebrow', row: null };
                }
            }

            return NOWHERE;
        }

        const marked = element.closest(CARD_SELECTOR);
        if (marked && marked.getBoundingClientRect().width <= 500) {
            return { card: marked, mode: 'eyebrow', row: null };
        }

        return NOWHERE;
    }

    function getIssueKeyElements() {
        const results = [];
        const ownBadgeSelector = '.' + BADGE_CLASS;

        document.querySelectorAll('a[href*="/browse/"]').forEach((link) => {
            if (link.closest(ownBadgeSelector)) {
                return;
            }
            const match = (link.getAttribute('href') || '').match(ISSUE_KEY_IN_URL_RE);
            if (match) {
                results.push({ element: link, key: match[1] });
            }
        });

        document.querySelectorAll('span, div, td, p, b, strong, small').forEach((element) => {
            if (element.children.length || element.closest(ownBadgeSelector)) {
                return;
            }
            const text = (element.textContent || '').trim();
            if (text && text.length <= 20 && ISSUE_KEY_RE.test(text)) {
                results.push({ element, key: text });
            }
        });

        // Work Items rail fallback. Some rail cards render the issue key as
        // ordinary text within a container instead of a /browse/ link or a
        // dedicated leaf node. Scan each full-size draggable card's visible
        // text and attach one issue key to the card itself. This is deliberately
        // limited to card-like containers so we do not treat arbitrary page
        // text as work items.
        document.querySelectorAll(CARD_SELECTOR).forEach((card) => {
            if (card.closest(ownBadgeSelector)) {
                return;
            }
            const width = card.getBoundingClientRect().width;
            if (width < MIN_INLINE_WIDTH || width > 500) {
                return;
            }
            const text = (card.innerText || card.textContent || '').trim();
            const match = text.match(ISSUE_KEY_ANYWHERE_RE);
            if (match) {
                results.push({ element: card, key: match[1] });
            }
        });

        return results;
    }

    // ================================= SCAN ====================================
    async function scan() {
        if (!enabled) {
            return;
        }

        const found = getIssueKeyElements();
        if (!found.length) {
            return;
        }

        const pendingKeys = [];

        for (const { element, key } of found) {
            const { card, mode, row: anchorRow } = findCard(element);
            if (!card || !mode) {
                continue;
            }

            const row = anchorRow || (element.parentElement === card ? element : null);

            if (card.hasAttribute(DONE_ATTR)) {
                if (card.getAttribute(DONE_ATTR) === key) {
                    refitCard(card);
                }
                continue;
            }

            if (cache.has(key)) {
                const parentInfo = cache.get(key);
                card.setAttribute(DONE_ATTR, key);
                if (parentInfo) {
                    renderBadge(card, row, parentInfo, mode, element);
                }
            } else if (!inflight.has(key)) {
                pendingKeys.push(key);
            }
        }

        const uniqueKeys = [...new Set(pendingKeys)];
        if (!uniqueKeys.length) {
            return;
        }

        uniqueKeys.forEach((key) => inflight.add(key));
        log('Looking up', uniqueKeys.length, 'unique issue(s)');

        try {
            for (let index = 0; index < uniqueKeys.length; index += BATCH_SIZE) {
                if (!enabled) {
                    return;
                }
                await lookupIssues(uniqueKeys.slice(index, index + BATCH_SIZE));
            }
        } finally {
            uniqueKeys.forEach((key) => inflight.delete(key));
        }

        await scan();
    }

    function scheduleScan() {
        if (!enabled) {
            return;
        }
        clearTimeout(scanTimer);
        scanTimer = setTimeout(() => {
            scan().catch((error) => {
                console.warn('[Tempo Parent Display]', error.message);
            });
        }, DEBOUNCE_MS);
    }

    function setEnabled(nextEnabled) {
        if (nextEnabled === enabled) {
            return;
        }

        enabled = nextEnabled;

        if (enabled) {
            observer = new MutationObserver(scheduleScan);
            observer.observe(document.body, { childList: true, subtree: true });
            window.addEventListener('resize', scheduleScan);
            scheduleScan();
        } else {
            if (observer) {
                observer.disconnect();
                observer = null;
            }
            window.removeEventListener('resize', scheduleScan);
            clearTimeout(scanTimer);
            clearAllBadges();
        }
    }

    // ========================= TOP-FRAME HANDSHAKE ============================
    window.addEventListener('message', (event) => {
        const data = event.data;
        if (!data || data.tag !== MESSAGE_TAG || data.type !== 'context') {
            return;
        }
        if (event.origin !== JIRA) {
            return;
        }

        contextAnswered = true;
        const previousListView = listView;
        const wasEnabled = enabled;
        listView = Boolean(data.listView);
        setEnabled(Boolean(data.enabled));

        if (enabled && wasEnabled && listView !== previousListView) {
            clearAllBadges();
            scheduleScan();
        }
    });

    function requestContext() {
        try {
            window.top.postMessage(
                { tag: MESSAGE_TAG, type: 'request-context' },
                JIRA
            );
        } catch (error) {
            log('Could not request context:', error.message);
        }
    }

    requestContext();

    let contextTries = 0;
    const retryContext = setInterval(() => {
        contextTries += 1;
        if (contextAnswered || contextTries > 12) {
            clearInterval(retryContext);
            return;
        }
        requestContext();
    }, 400);
})();
