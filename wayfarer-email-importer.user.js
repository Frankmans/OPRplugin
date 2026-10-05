// ==UserScript==
// @name         Wayfarer Email Importer
// @namespace    https://github.com/Frankmans/OPRplugin
// @version      3.6.0
// @description  Imports Niantic Wayfarer/Spatial/OPR emails -- directly from Gmail via OAuth, or from .eml files -- using a port of bilde2910/OPR-Tools' email parser, and stores them for the Spatial Nominations Panel script to search.
// @author       Frankmans
// @match        https://wayfarer.scopely.com/new/nominations*
// @grant        GM_xmlhttpRequest
// @connect      gmail.googleapis.com
// @connect      accounts.google.com
// @require      https://raw.githubusercontent.com/Frankmans/OPRplugin/refs/heads/main/opr-email-lib.js
// @require      https://raw.githubusercontent.com/Frankmans/OPRplugin/refs/heads/main/wst-storage.js
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/Frankmans/OPRplugin/refs/heads/main/wayfarer-email-importer.user.js
// @downloadURL  https://raw.githubusercontent.com/Frankmans/OPRplugin/refs/heads/main/wayfarer-email-importer.user.js
// ==/UserScript==

/*
 * Companion to wayfarer-spatial-nominations-panel.user.js. This script's
 * ONLY job is getting your raw emails into the shared IndexedDB store
 * ("wst_spatial_email_store", see wst-storage.js) as parsed-but-unclassified
 * records -- headers + body, nothing more. It does NOT try to figure out
 * what kind of email something is, match decisions to nominations, or build
 * a submissions list -- that's the panel script's job (wst-business-logic.js).
 *
 * TWO WAYS IN:
 *   1. Connect Gmail -- OAuth (read-only) + the Gmail API, fetches matching
 *      messages directly. No manual export step, incremental after the
 *      first sync. Needs a one-time Google Cloud OAuth Client ID -- see the
 *      setup steps you were given alongside this script.
 *   2. Drop .eml files -- unchanged from before, useful as a fallback (a
 *      work computer where you can't/won't set up OAuth, a handful of
 *      one-off messages, etc).
 *
 * v3 CHANGE FROM v2: @grant went from "none" to "GM_xmlhttpRequest" so the
 * Gmail API calls run through Tampermonkey's own request machinery instead
 * of the page's fetch() -- that sidesteps Wayfarer's page CSP, which would
 * otherwise likely block a page-context request to googleapis.com. This
 * shouldn't change anything about the .eml/backup features below; @require'd
 * scripts and this script still share one execution context either way.
 *
 * GMAIL OAUTH DESIGN NOTES:
 * Uses Google Identity Services' token client (a popup-based implicit OAuth
 * flow) rather than a redirect flow, specifically because it needs no
 * redirect_uri / backend of any kind -- the token comes back to this page's
 * JS directly. The access token lives in memory only (a page variable, never
 * persisted) and is re-requested each time this page is loaded; that's a
 * deliberate simplicity/security tradeoff for a personal tool, not an
 * oversight. Your Client ID (not a secret -- it's fine to store) is kept in
 * localStorage so you don't have to repaste it constantly.
 */

(function () {
  'use strict';

  const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
  const SUPPORTED_SENDERS = [
    'notices@recon.nianticspatial.com',
    'notices@wayfarer.nianticlabs.com',
    'nominations@portals.ingress.com',
    'hello@pokemongolive.com',
    'ingress-support@nianticlabs.com',
    'ingress-support@google.com',
  ];
  const CLIENT_ID_KEY = 'wsei_gmail_client_id';
  // One-time convenience: this script's keys used to be 'wei_*', which the
  // AbuseFormImport importer also uses (localStorage is shared per origin),
  // so the two overwrote each other's sync state. They're 'wsei_*' now. The
  // Client ID isn't a secret and is usually the same Google Cloud client, so
  // carry it over once instead of making you paste it again. The old key is
  // left alone (AbuseFormImport still owns it). The last-sync timestamp is
  // deliberately NOT carried over: the new database starts empty, so the
  // first sync must be a full one.
  try {
    if (!localStorage.getItem(CLIENT_ID_KEY)) {
      const legacyClientId = localStorage.getItem('wei_gmail_client_id');
      if (legacyClientId) localStorage.setItem(CLIENT_ID_KEY, legacyClientId);
    }
  } catch (e) { /* non-fatal */ }
  const LAST_SYNC_KEY = 'wsei_gmail_last_sync_ms';
  const AUTOSYNC_ENABLED_KEY = 'wsei_autosync_enabled';
  const AUTOSYNC_INTERVAL_KEY = 'wsei_autosync_interval_min';
  const CONCURRENCY = 5;

  const STYLE = `
    #wsei-btn{
      position:fixed; bottom:20px; right:20px; z-index:9999;
      background:#0a0e0c; color:#00e08a; border:1px solid #00e08a;
      font-family:monospace; font-size:13px; padding:10px 16px; border-radius:6px;
      cursor:pointer; box-shadow:0 4px 12px rgba(0,0,0,.4);
    }
    #wsei-btn:hover{ background:#10160f; }
    #wsei-panel{
      position:fixed; bottom:70px; right:20px; z-index:9999;
      background:#0a0e0c; color:#d7f5e6; border:1px solid #223026; border-radius:8px;
      font-family:monospace; font-size:12.5px; padding:16px; width:420px; max-height:75vh;
      overflow-y:auto; box-shadow:0 8px 24px rgba(0,0,0,.5); display:none;
    }
    #wsei-panel.open{ display:block; }
    #wsei-panel h3{ margin:0 0 4px; font-size:14px; color:#d7f5e6; }
    #wsei-panel h4{ margin:14px 0 4px; font-size:12px; color:#a8c9b8; border-top:1px solid #223026; padding-top:10px; }
    #wsei-panel .wsei-sub{ font-size:11px; color:#6b8579; margin-bottom:10px; }
    #wsei-dropzone{
      border:2px dashed #223026; border-radius:6px; padding:24px 10px; text-align:center;
      color:#6b8579; margin-bottom:10px; cursor:pointer;
    }
    #wsei-dropzone.drag{ border-color:#00e08a; color:#00e08a; }
    #wsei-panel input[type=text]{
      width:100%; box-sizing:border-box; background:#161d19; color:#d7f5e6;
      border:1px solid #223026; border-radius:4px; padding:6px 8px; font-family:monospace;
      font-size:12px; margin-bottom:6px;
    }
    #wsei-panel button{
      background:#161d19; color:#d7f5e6; border:1px solid #223026; border-radius:4px;
      padding:6px 10px; cursor:pointer; font-family:monospace; font-size:11.5px; margin-right:6px; margin-top:6px;
    }
    #wsei-panel button.primary{ background:#00e08a; color:#04140d; border-color:#00e08a; }
    #wsei-panel button.danger{ color:#ff5d5d; border-color:#ff5d5d; }
    #wsei-panel button:disabled{ opacity:0.5; cursor:default; }
    #wsei-gmail-status{ font-size:11px; color:#6b8579; margin:4px 0; }
    .wsei-autosync-row{ display:flex; align-items:center; gap:8px; font-size:11px; color:#d7f5e6; margin:6px 0; }
    .wsei-autosync-row select{
      background:#161d19; color:#d7f5e6; border:1px solid #223026; border-radius:4px;
      padding:3px 6px; font-family:monospace; font-size:11px;
    }
    #wsei-progress{ font-size:11px; color:#3ec6ff; margin:4px 0; min-height:14px; }
    #wsei-log{
      margin-top:10px; max-height:220px; overflow-y:auto; font-size:11px; line-height:1.5;
    }
    #wsei-log div.ok{ color:#00e08a; }
    #wsei-log div.skip{ color:#6b8579; }
    #wsei-log div.err{ color:#ff5d5d; }
  `;

  // ---------------------------------------------------------------------
  // Gmail OAuth + API helpers
  // ---------------------------------------------------------------------

  let accessToken = null;
  let tokenExpiryMs = 0;
  let tokenClient = null;
  let autoSyncTimer = null;
  let autoSyncInProgress = false;
  let wseiSyncRunning = false; // any sync (manual OR auto) -- see runSync()

  function loadGis() {
    return new Promise((resolve, reject) => {
      if (window.google && window.google.accounts && window.google.accounts.oauth2) { resolve(); return; }
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client';
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error(
        'Could not load Google\u2019s sign-in script. If this keeps happening, Wayfarer\u2019s ' +
        'page security policy may be blocking accounts.google.com from loading here.'
      ));
      document.head.appendChild(s);
    });
  }

  function withTimeout(promise, ms, message) {
    return Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error(message || 'Timed out')), ms)),
    ]);
  }

  function requestAccessToken(clientId, interactive) {
    return new Promise((resolve, reject) => {
      loadGis().then(() => {
        tokenClient = google.accounts.oauth2.initTokenClient({
          client_id: clientId,
          scope: GMAIL_SCOPE,
          callback: (resp) => {
            if (resp.error) { reject(new Error(resp.error)); return; }
            accessToken = resp.access_token;
            tokenExpiryMs = Date.now() + (resp.expires_in * 1000) - 60000;
            resolve(accessToken);
          },
        });
        tokenClient.requestAccessToken({ prompt: interactive ? 'consent' : '' });
      }).catch(reject);
    });
  }

  // forceNonInteractive is used by background auto-sync ticks -- a timer
  // callback is never a "user gesture", so browsers will block any popup
  // it tries to open. A non-interactive (prompt: '') request either
  // silently renews via an existing Google session with no visible popup,
  // or fails -- it never falls back to an interactive popup on its own.
  async function getValidToken(clientId, opts) {
    const forceNonInteractive = !!(opts && opts.forceNonInteractive);
    if (accessToken && Date.now() < tokenExpiryMs) return accessToken;
    const interactive = forceNonInteractive ? false : !accessToken;
    const request = requestAccessToken(clientId, interactive);
    // Silent renewal can hang indefinitely (rather than reject) if
    // third-party cookies are blocked -- only relevant for the
    // non-interactive path, since the interactive path legitimately waits
    // on the user to finish a popup.
    return forceNonInteractive ? withTimeout(request, 10000, 'Silent token refresh timed out') : request;
  }

  function gmApiGet(url, token) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        headers: { Authorization: `Bearer ${token}` },
        onload: (res) => {
          if (res.status >= 200 && res.status < 300) {
            try { resolve(JSON.parse(res.responseText)); }
            catch (e) { reject(new Error('Gmail API returned something that wasn\u2019t valid JSON')); }
          } else if (res.status === 401) {
            reject(Object.assign(new Error('Gmail token expired or was revoked'), { authExpired: true, status: 401 }));
          } else {
            // status/retryAfter are tagged on (not just folded into the
            // message) so the fetch engine can act on them directly.
            reject(Object.assign(new Error(`Gmail API error ${res.status}: ${String(res.responseText || '').slice(0, 300)}`), {
              status: res.status,
              retryAfter: Number(res.responseHeaders?.match(/retry-after:\s*(\d+)/i)?.[1]) || null,
            }));
          }
        },
        onerror: () => reject(Object.assign(new Error('Network error calling the Gmail API'), { status: null })),
      });
    });
  }

  function buildGmailQuery(lastSyncMs) {
    const senderClause = '(' + SUPPORTED_SENDERS.map((s) => `from:${s}`).join(' OR ') + ')';
    if (!lastSyncMs) return senderClause;
    // 1-day safety buffer -- same as gmail_wayspot_export.py's incremental
    // sync, since Gmail's after: operator only has day granularity.
    const buffered = new Date(lastSyncMs - 24 * 60 * 60 * 1000);
    const y = buffered.getUTCFullYear();
    const m = String(buffered.getUTCMonth() + 1).padStart(2, '0');
    const d = String(buffered.getUTCDate()).padStart(2, '0');
    return `${senderClause} after:${y}/${m}/${d}`;
  }

  function base64UrlToText(b64url) {
    const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder('utf-8').decode(bytes);
  }

  // ---------------------------------------------------------------------
  // Gmail error classification (shared with the AbuseFormImport importer,
  // which hit all of these against the real API: per-minute "Units per
  // minute per user" quota 403s, dailyLimitExceeded, Retry-After, ...)
  // ---------------------------------------------------------------------
  const WSEI_RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
  function wseiIsDailyLimitError(e) {
    return e?.status === 403 && /dailyLimitExceeded/i.test(e?.message || '');
  }
  function wseiIsRateLimitError(e) {
    if (e?.status === 429) return true;
    if (wseiIsDailyLimitError(e)) return false;
    // Gmail sometimes returns 403 for a rate/quota issue instead of 429 --
    // the distinguishing "reason" only shows up in the response body, not
    // the status code, so a plain 403 (an actual permissions problem) has
    // to be told apart by checking for that text rather than the status
    // alone.
    //
    // BUGFIX (ported from the AbuseFormImport importer): \s* between "quota" and "exceeded" -- a
    // literal quotaExceeded (no space, the older Gmail-specific reason
    // enum this already checked for) does NOT match a real confirmed
    // message using Google's newer, more generic quota-error wording
    // instead: "Quota exceeded for quota metric 'Total Query Cost' and
    // limit 'Units per minute per user'..." -- note the space. That's a
    // plain per-MINUTE quota (about as short-term as a rate limit gets),
    // but fell all the way through to an unhelpful bare "HTTP 403" with
    // zero retries, since neither this check nor wseiIsDailyLimitError's
    // matched it.
    return /rateLimitExceeded|userRateLimitExceeded/i.test(e?.message || '') || /quota\s*exceeded/i.test(e?.message || '');
  }
  function wseiIsRetryableError(e) {
    if (wseiIsDailyLimitError(e)) return false;
    // status === null is gmApiGet()'s network-error case (onerror): a
    // dropped connection is transient, so it's retried with backoff too
    // (it used to fail immediately).
    return wseiIsRateLimitError(e) || WSEI_RETRYABLE_STATUSES.has(e?.status) || e?.status === null;
  }
  function wseiSleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
  function wseiDescribeFetchError(e) {
    if (e?.authExpired) return 'token expired and could not be refreshed (HTTP 401)';
    if (e?.authExpired) return 'token expired and could not be refreshed (HTTP 401)';
    if (wseiIsDailyLimitError(e)) return `daily quota exceeded (HTTP ${e.status})`;
    if (wseiIsRateLimitError(e)) return `rate limited (HTTP ${e.status})`;
    if (WSEI_RETRYABLE_STATUSES.has(e?.status)) return `transient server error (HTTP ${e.status})`;
    if (e?.status) return `HTTP ${e.status}`;
    return 'network error';
  }

  const WSEI_QUOTA_COOLDOWN_MS = 65000;
  let wseiQuotaCooldownUntil = 0;

  // ---------------------------------------------------------------------
  // Gmail fetch engine (v3.6.0)
  //
  // Everything that talks to Gmail for a sync goes through wseiGmailGet(),
  // which combines the pieces that were previously scattered or missing:
  //   - a shared quota cooldown (a "Units per minute per user" 403 is a
  //     budget shared by ALL parallel requests, so one worker hitting it
  //     pauses every worker -- honoring Retry-After when Gmail sends one),
  //   - adaptive pacing (AIMD): the first quota hit starts spacing request
  //     starts out, each further hit doubles the spacing, and a long run of
  //     successes shrinks it again -- so a big sync settles just under the
  //     quota instead of sprinting into it and stalling ~65s over and over,
  //   - one silent token refresh + retry on a 401, deduplicated across
  //     workers (see getToken in runSync()), since a long sync outlives the
  //     ~1h access token,
  //   - a DAILY quota error ends the whole sync early (everything after it
  //     would just burn requests failing the same way),
  //   - backoff retries for transient 5xx / network errors.
  // The same code is used for message listing, which previously had no
  // retry at all (a single quota hit there failed the entire sync).
  // ---------------------------------------------------------------------
  const wsei_MAX_ATTEMPTS = 4;
  const wsei_PACE_MAX_MS = 1000;
  let wseiDailyLimitError = null;
  let wseiPaceMs = 0;
  let wseiNextSlot = 0;
  let wseiSuccessStreak = 0;

  function wseiResetFetchState() {
    wseiQuotaCooldownUntil = 0;
    wseiDailyLimitError = null;
    wseiPaceMs = 0;
    wseiNextSlot = 0;
    wseiSuccessStreak = 0;
  }

  async function wseiPaceGate() {
    if (!wseiPaceMs) return;
    const now = Date.now();
    const at = Math.max(now, wseiNextSlot);
    wseiNextSlot = at + wseiPaceMs;
    if (at > now) await wseiSleep(at - now);
  }

  function wseiNoteRateLimit(e) {
    wseiQuotaCooldownUntil = Math.max(
      wseiQuotaCooldownUntil,
      Date.now() + (e.retryAfter ? e.retryAfter * 1000 : WSEI_QUOTA_COOLDOWN_MS)
    );
    wseiPaceMs = Math.min(wsei_PACE_MAX_MS, Math.max(wseiPaceMs * 2, 100));
    wseiSuccessStreak = 0;
  }

  function wseiNoteSuccess() {
    if (!wseiPaceMs) return;
    if (++wseiSuccessStreak >= 100) {
      wseiSuccessStreak = 0;
      wseiPaceMs = wseiPaceMs < 40 ? 0 : Math.floor(wseiPaceMs * 0.75);
    }
  }

  // getToken(failedToken): returns a currently valid token. Called with
  // null before each request, and with the token that just got a 401 to
  // force one refresh (a no-op if another worker already refreshed it).
  async function wseiGmailGet(url, getToken, onStatus) {
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      if (wseiDailyLimitError) throw wseiDailyLimitError;
      const wait = wseiQuotaCooldownUntil - Date.now();
      if (wait > 0) {
        if (onStatus) onStatus(`Gmail quota reached \u2013 pausing ${Math.ceil(wait / 1000)}s before continuing\u2026`);
        await wseiSleep(wait);
      }
      await wseiPaceGate();
      let token = null;
      try {
        token = await getToken(null);
        const result = await gmApiGet(url, token);
        wseiNoteSuccess();
        return result;
      } catch (e) {
        if (e && e.authExpired && !refreshed) {
          refreshed = true;
          try {
            await getToken(token);
          } catch (refreshErr) {
            throw Object.assign(
              new Error(`Could not refresh the Gmail token: ${(refreshErr && refreshErr.message) || refreshErr}`),
              { authExpired: true, status: 401 }
            );
          }
          attempt--; // a token refresh doesn't use up a retry
          continue;
        }
        if (wseiIsDailyLimitError(e)) { wseiDailyLimitError = e; throw e; }
        if (wseiIsRateLimitError(e)) wseiNoteRateLimit(e);
        if (attempt < wsei_MAX_ATTEMPTS - 1 && wseiIsRetryableError(e)) {
          // Rate limits wait at the top of the loop (shared cooldown);
          // other transient errors back off individually.
          if (!wseiIsRateLimitError(e)) await wseiSleep(e.retryAfter ? e.retryAfter * 1000 : 500 * Math.pow(2, attempt));
          continue;
        }
        throw e;
      }
    }
  }

  async function listAllMessageIds(query, getToken, onProgress, onStatus) {
    const ids = [];
    let pageToken = null;
    do {
      const url = new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages');
      url.searchParams.set('q', query);
      url.searchParams.set('maxResults', '500'); // API max; was 100 (5x the list calls)
      url.searchParams.set('fields', 'messages/id,nextPageToken');
      if (pageToken) url.searchParams.set('pageToken', pageToken);
      const page = await wseiGmailGet(url.toString(), getToken, onStatus);
      for (const m of (page.messages || [])) ids.push(m.id);
      pageToken = page.nextPageToken || null;
      if (onProgress) onProgress(ids.length);
    } while (pageToken);
    return ids;
  }

  // Bounded-concurrency fetch of each message's raw RFC822 content.
  // `fields=raw` trims the response to just what's used (the default
  // response also carries labels, snippet, historyId, etc.).
  async function fetchMessagesRaw(ids, getToken, onProgress, onStatus) {
    const results = new Array(ids.length);
    let cursor = 0, done = 0;
    async function worker() {
      while (cursor < ids.length) {
        const i = cursor++;
        const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${ids[i]}?format=raw&fields=raw`;
        try {
          const msg = await wseiGmailGet(url, getToken, onStatus);
          results[i] = { id: ids[i], raw: msg.raw, error: null };
        } catch (e) {
          results[i] = { id: ids[i], raw: null, error: e };
        }
        done++;
        if (onProgress) onProgress(done, ids.length);
      }
    }
    const workers = Array.from({ length: Math.min(CONCURRENCY, ids.length) }, worker);
    await Promise.all(workers);
    return results;
  }

  // Gmail message ids that are already in the local store, recovered from
  // each record's filename ("gmail:<id>", see emlToRecord() calls in
  // runSync()). A Gmail message never changes once delivered, so fetching
  // one that's already stored is pure wasted quota -- this is what makes a
  // retry after a partial failure, or a "Force full re-sync", cheap.
  // Streamed with a cursor (never holds more than one record) and closes
  // its own connection.
  function getStoredGmailIds() {
    return WSTSpatialStorage.openDB().then((db) => new Promise((resolve, reject) => {
      const found = new Set();
      const tx = db.transaction(WSTSpatialStorage.STORE_NAME, 'readonly');
      const req = tx.objectStore(WSTSpatialStorage.STORE_NAME).openCursor();
      req.onsuccess = () => {
        const cur = req.result;
        if (!cur) return;
        const fn = cur.value && cur.value.filename;
        if (typeof fn === 'string' && fn.startsWith('gmail:')) found.add(fn.slice(6));
        cur.continue();
      };
      tx.oncomplete = () => { db.close(); resolve(found); };
      tx.onerror = tx.onabort = () => { db.close(); reject(tx.error || new Error('Could not read the email store')); };
    }));
  }

  // Checks that the @require'd libraries actually defined their globals.
  // A stale cached copy of opr-email-lib.js (old global name) otherwise
  // shows up as thousands of "could not be parsed" errors.
  function missingLibraries() {
    const missing = [];
    if (typeof OPRSpatialEmail === 'undefined') missing.push('OPRSpatialEmail (opr-email-lib.js)');
    if (typeof WSTSpatialStorage === 'undefined') missing.push('WSTSpatialStorage (wst-storage.js)');
    return missing;
  }

  // ---------------------------------------------------------------------
  // UI
  // ---------------------------------------------------------------------

  function injectUI() {
    if (document.getElementById('wsei-btn')) return;

    const style = document.createElement('style');
    style.textContent = STYLE;
    document.head.appendChild(style);

    const btn = document.createElement('button');
    btn.id = 'wsei-btn';
    btn.textContent = '📥 Import Emails';
    document.body.appendChild(btn);

    const panel = document.createElement('div');
    panel.id = 'wsei-panel';
    panel.innerHTML = `
      <h3>Wayfarer Email Importer</h3>
      <div class="wsei-sub" id="wsei-count">Loading...</div>

      <h4>Connect Gmail</h4>
      <input type="text" id="wsei-client-id" placeholder="OAuth Client ID (ends in .apps.googleusercontent.com)">
      <div id="wsei-gmail-status">Not connected.</div>
      <div id="wsei-progress"></div>
      <div>
        <button id="wsei-sync" class="primary">Sync new emails</button>
        <button id="wsei-full-resync">Force full re-sync</button>
      </div>
      <div class="wsei-autosync-row">
        <label><input type="checkbox" id="wsei-autosync-toggle"> Auto-sync every</label>
        <select id="wsei-autosync-interval">
          <option value="5">5 min</option>
          <option value="15">15 min</option>
          <option value="30">30 min</option>
          <option value="60">60 min</option>
        </select>
      </div>

      <h4>Or drop .eml files</h4>
      <div id="wsei-dropzone">Drop .eml files here, or click to choose</div>
      <input type="file" id="wsei-file-input" accept=".eml" multiple style="display:none;">

      <h4>Backup / maintenance</h4>
      <div>
        <button id="wsei-export">Export backup JSON</button>
        <button id="wsei-import-backup">Import backup JSON</button>
        <input type="file" id="wsei-backup-input" accept=".json,application/json" style="display:none;">
        <button id="wsei-clear" class="danger">Clear all stored emails</button>
        <button id="wsei-close">Close</button>
      </div>
      <div id="wsei-log"></div>
    `;
    document.body.appendChild(panel);

    const dropzone = panel.querySelector('#wsei-dropzone');
    const fileInput = panel.querySelector('#wsei-file-input');
    const backupInput = panel.querySelector('#wsei-backup-input');
    const logEl = panel.querySelector('#wsei-log');
    const countEl = panel.querySelector('#wsei-count');
    const clientIdInput = panel.querySelector('#wsei-client-id');
    const gmailStatusEl = panel.querySelector('#wsei-gmail-status');
    const progressEl = panel.querySelector('#wsei-progress');
    const syncBtn = panel.querySelector('#wsei-sync');
    const fullResyncBtn = panel.querySelector('#wsei-full-resync');

    clientIdInput.value = localStorage.getItem(CLIENT_ID_KEY) || '';
    clientIdInput.addEventListener('change', () => {
      localStorage.setItem(CLIENT_ID_KEY, clientIdInput.value.trim());
    });

    function updateGmailStatus() {
      const lastSync = localStorage.getItem(LAST_SYNC_KEY);
      const auto = loadAutoSyncSettings();
      const autoSuffix = auto.enabled ? ` Auto-sync: every ${auto.intervalMin} min.` : '';
      if (accessToken) {
        gmailStatusEl.textContent = (lastSync
          ? `Connected. Last synced ${new Date(Number(lastSync)).toLocaleString()}.`
          : 'Connected. Never synced yet.') + autoSuffix;
      } else {
        gmailStatusEl.textContent = (lastSync
          ? `Not connected this session. Last synced ${new Date(Number(lastSync)).toLocaleString()}.`
          : 'Not connected.') + autoSuffix;
      }
    }

    function log(msg, cls) {
      const div = document.createElement('div');
      div.className = cls || '';
      div.textContent = msg;
      logEl.prepend(div);
    }

    async function refreshCount() {
      try {
        const n = await WSTSpatialStorage.countEmails();
        countEl.textContent = `${n} email(s) stored. Open the Spatial Nominations Panel to search them.`;
      } catch (e) {
        countEl.textContent = 'Could not read the email store.';
      }
    }

    // ---- .eml import (unchanged from v2) ----

    function normalizeEml(text) {
      return text.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
    }

    function emlToRecord(text, fallbackName) {
      const email = OPRSpatialEmail.parseMIME(normalizeEml(text));
      const messageId = email.getFirstHeaderValue('Message-ID', null);
      const id = messageId || `synthetic:${fallbackName}:${text.length}`;
      return { id, filename: fallbackName, ts: Date.now(), headers: email.headers, body: email.body };
    }

    async function importFiles(files) {
      const missingLibs = missingLibraries();
      if (missingLibs.length) {
        log(`Import aborted: ${missingLibs.join(' and ')} not loaded -- update/reinstall this script and reload the page.`, 'err');
        return;
      }
      const records = [];
      let parseErrors = 0;
      for (const file of files) {
        let text;
        try {
          text = await file.text();
        } catch (e) {
          log(`✗ ${file.name}: could not read file`, 'err');
          parseErrors++;
          continue;
        }
        try {
          records.push(emlToRecord(text, file.name));
        } catch (e) {
          log(`✗ ${file.name}: ${e.message || e}`, 'err');
          parseErrors++;
        }
      }

      if (records.length) {
        const { inserted, updated } = await WSTSpatialStorage.putEmails(records);
        log(`✓ Imported ${records.length} file(s): ${inserted} new, ${updated} updated`, 'ok');
      }
      if (parseErrors) log(`${parseErrors} file(s) could not be parsed as MIME email`, 'err');
      await refreshCount();
    }

    dropzone.addEventListener('click', () => fileInput.click());
    dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('drag'); });
    dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag'));
    dropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropzone.classList.remove('drag');
      const files = Array.from(e.dataTransfer.files).filter((f) => f.name.toLowerCase().endsWith('.eml'));
      if (files.length) importFiles(files);
      else log('No .eml files found in the drop', 'skip');
    });
    fileInput.addEventListener('change', () => {
      const files = Array.from(fileInput.files);
      fileInput.value = '';
      if (files.length) importFiles(files);
    });

    // ---- Gmail sync ----

    async function runSync(forceFull, opts) {
      const auto = !!(opts && opts.auto);
      const clientId = clientIdInput.value.trim();
      if (!clientId) {
        if (!auto) log('Paste your OAuth Client ID first', 'err');
        return;
      }
      localStorage.setItem(CLIENT_ID_KEY, clientId);

      const missingLibs = missingLibraries();
      if (missingLibs.length) {
        log(`Sync aborted: ${missingLibs.join(' and ')} not loaded. Tampermonkey is probably using an old cached copy -- update/reinstall this script (and make sure the matching files are pushed to GitHub), then reload the page.`, 'err');
        return;
      }

      // A manual sync and an auto-sync tick could previously overlap,
      // doubling the request rate against one shared Gmail quota.
      if (wseiSyncRunning) {
        if (!auto) log('A sync is already running -- wait for it to finish', 'skip');
        return;
      }
      wseiSyncRunning = true;
      wseiResetFetchState();

      syncBtn.disabled = true;
      fullResyncBtn.disabled = true;
      progressEl.textContent = auto ? 'Auto-sync: connecting to Gmail\u2026' : 'Connecting to Gmail\u2026';

      const lastSyncMs = forceFull ? null : Number(localStorage.getItem(LAST_SYNC_KEY)) || null;
      const syncStartedAt = Date.now();

      try {
        let token;
        try {
          token = await getValidToken(clientId, { forceNonInteractive: auto });
        } catch (e) {
          if (auto) {
            log('Auto-sync skipped this round: Gmail sign-in needed -- click "Sync new emails" once to reconnect', 'skip');
            return;
          }
          throw e;
        }
        updateGmailStatus();

        // Long syncs outlive the ~1h access token, so every request asks
        // this for a token. Refreshes silently (never a popup -- no user
        // gesture this deep into a sync), and only once even when several
        // parallel workers hit the 401 at the same moment.
        let tokenRefresh = null;
        const getToken = async (failedToken) => {
          const stale = failedToken
            ? failedToken === accessToken
            : !(accessToken && Date.now() < tokenExpiryMs);
          if (!stale) return accessToken;
          if (!tokenRefresh) {
            tokenExpiryMs = 0;
            tokenRefresh = getValidToken(clientId, { forceNonInteractive: true })
              .finally(() => { tokenRefresh = null; });
          }
          return tokenRefresh;
        };
        const onStatus = (text) => { progressEl.textContent = text; };

        const query = buildGmailQuery(lastSyncMs);
        progressEl.textContent = 'Listing matching messages\u2026';
        const allIds = await listAllMessageIds(query, getToken, (n) => {
          progressEl.textContent = `Found ${n} matching message(s) so far\u2026`;
        }, onStatus);

        if (allIds.length === 0) {
          log(auto ? 'Auto-sync: no new messages found' : 'No new messages found', 'skip');
          localStorage.setItem(LAST_SYNC_KEY, String(syncStartedAt));
          updateGmailStatus();
          return;
        }

        // Skip messages that are already stored (see getStoredGmailIds()).
        // Only worth scanning the store for bigger lists: a small
        // incremental sync is cheaper to just re-fetch.
        let ids = allIds;
        let alreadyStored = 0;
        if (allIds.length >= 200) {
          progressEl.textContent = 'Checking which messages are already stored\u2026';
          try {
            const stored = await getStoredGmailIds();
            ids = allIds.filter((id) => !stored.has(id));
            alreadyStored = allIds.length - ids.length;
          } catch (e) { /* non-fatal: just fetch everything */ }
        }
        if (alreadyStored) log(`${alreadyStored} of ${allIds.length} matching message(s) were already stored -- skipped`, 'skip');

        // Fetched, parsed and SAVED in batches: bounds memory for big
        // syncs, and a failure/interruption halfway keeps everything
        // already fetched (the next sync skips it, see above).
        const BATCH_SIZE = 250;
        const fetchErrorCounts = new Map(), fetchErrorSamples = new Map();
        const parseErrorCounts = new Map(), parseErrorSamples = new Map();
        let savedCount = 0, inserted = 0, updated = 0, parseErrors = 0, notAttempted = 0;
        const tally = (counts, samples, label, sample) => {
          counts.set(label, (counts.get(label) || 0) + 1);
          if (!samples.has(label)) samples.set(label, sample);
        };

        for (let start = 0; start < ids.length; start += BATCH_SIZE) {
          if (wseiDailyLimitError) { notAttempted = ids.length - start; break; }
          const batchIds = ids.slice(start, start + BATCH_SIZE);
          const raws = await fetchMessagesRaw(batchIds, getToken, (done) => {
            progressEl.textContent = `Fetching messages\u2026 ${start + done}/${ids.length}`;
          }, onStatus);

          const records = [];
          for (const r of raws) {
            if (r.error) {
              tally(fetchErrorCounts, fetchErrorSamples, wseiDescribeFetchError(r.error), r.error.message || String(r.error));
              continue;
            }
            let stage = 'decode';
            try {
              const text = base64UrlToText(r.raw);
              stage = 'parse';
              records.push(emlToRecord(text, `gmail:${r.id}`));
            } catch (e) {
              parseErrors++;
              tally(parseErrorCounts, parseErrorSamples, `${stage}: ${(e && e.name) || 'Error'}`, `${(e && e.message) || e} (e.g. gmail:${r.id})`);
            }
          }
          if (records.length) {
            const res = await WSTSpatialStorage.putEmails(records);
            savedCount += records.length; inserted += res.inserted; updated += res.updated;
          }
        }

        // The log is newest-first (prepend), so details are logged BEFORE
        // their summary line to read summary-then-details top-down.
        const totalFetchErrors = Array.from(fetchErrorCounts.values()).reduce((x, y) => x + y, 0);
        if (parseErrors) {
          for (const [label, sample] of parseErrorSamples.entries()) log(`   \u21B3 ${label} sample: ${sample}`, 'err');
          const breakdown = Array.from(parseErrorCounts.entries()).sort((x, y) => y[1] - x[1]).map(([label, count]) => `${count} ${label}`).join(', ');
          log(`${parseErrors} message(s) could not be parsed as MIME email: ${breakdown}`, 'err');
        }
        if (wseiDailyLimitError) {
          log(`Gmail's DAILY API quota was reached${notAttempted ? ` -- ${notAttempted} message(s) were not attempted` : ''}. That won't clear for hours: try again later (messages already saved are kept and skipped next time), or check/raise the quota on the Google Cloud project this OAuth Client ID belongs to.`, 'skip');
        }
        if (totalFetchErrors) {
          if (Array.from(fetchErrorCounts.keys()).some((label) => label.startsWith('rate limited'))) {
            log('Those were rate-limited by Gmail even after pausing and retrying. Messages already saved are kept and skipped next time -- just run Sync again in a few minutes.', 'skip');
          }
          for (const [label, sample] of fetchErrorSamples.entries()) log(`   \u21B3 ${label} sample: ${sample}`, 'err');
          const breakdown = Array.from(fetchErrorCounts.entries()).sort((x, y) => y[1] - x[1]).map(([label, count]) => `${count} ${label}`).join(', ');
          log(`\u2717 ${totalFetchErrors} message(s) failed to fetch: ${breakdown}`, 'err');
        }
        if (savedCount) {
          log(`\u2713 ${auto ? 'Auto-sync: synced' : 'Synced'} ${savedCount} message(s) from Gmail: ${inserted} new, ${updated} updated`, 'ok');
        }

        // Only move the "last synced" mark forward after a clean-enough
        // run; otherwise the next incremental sync would start after the
        // messages that failed and never retry them. Retrying is cheap --
        // everything already stored is skipped. A few permanently
        // unparseable messages shouldn't block it forever, so parse
        // failures only hold it back when they outnumber the successes.
        const holdBack = totalFetchErrors > 0 || notAttempted > 0 || (parseErrors > 0 && parseErrors >= savedCount);
        if (holdBack) {
          log('Last-sync time was NOT advanced because of the errors above -- the next "Sync new emails" will pick the missing messages up again.', 'skip');
        } else {
          localStorage.setItem(LAST_SYNC_KEY, String(syncStartedAt));
        }
      } catch (e) {
        log(`${auto ? 'Auto-sync failed: ' : 'Gmail sync failed: '}${e.message || e}`, 'err');
      } finally {
        wseiSyncRunning = false;
        progressEl.textContent = '';
        syncBtn.disabled = false;
        fullResyncBtn.disabled = false;
        updateGmailStatus();
        await refreshCount();
      }
    }

    syncBtn.addEventListener('click', () => runSync(false));
    fullResyncBtn.addEventListener('click', () => {
      if (confirm('Re-fetch your entire matching mailbox history from Gmail, not just what\u2019s new since last sync?')) {
        runSync(true);
      }
    });

    // ---- Auto-sync ----

    const autoSyncToggle = panel.querySelector('#wsei-autosync-toggle');
    const autoSyncInterval = panel.querySelector('#wsei-autosync-interval');

    function loadAutoSyncSettings() {
      return {
        enabled: localStorage.getItem(AUTOSYNC_ENABLED_KEY) === 'true',
        intervalMin: Number(localStorage.getItem(AUTOSYNC_INTERVAL_KEY)) || 15,
      };
    }
    function saveAutoSyncSettings(enabled, intervalMin) {
      localStorage.setItem(AUTOSYNC_ENABLED_KEY, String(enabled));
      localStorage.setItem(AUTOSYNC_INTERVAL_KEY, String(intervalMin));
    }

    function stopAutoSync() {
      if (autoSyncTimer) { clearInterval(autoSyncTimer); autoSyncTimer = null; }
    }

    async function runAutoSyncTick() {
      if (autoSyncInProgress) return; // don't overlap with an in-flight sync
      autoSyncInProgress = true;
      try {
        await runSync(false, { auto: true });
      } finally {
        autoSyncInProgress = false;
      }
    }

    function startAutoSync(intervalMin) {
      stopAutoSync();
      autoSyncTimer = setInterval(runAutoSyncTick, intervalMin * 60 * 1000);
    }

    const savedAutoSync = loadAutoSyncSettings();
    autoSyncToggle.checked = savedAutoSync.enabled;
    autoSyncInterval.value = String(savedAutoSync.intervalMin);
    if (savedAutoSync.enabled) startAutoSync(savedAutoSync.intervalMin);

    autoSyncToggle.addEventListener('change', () => {
      const intervalMin = Number(autoSyncInterval.value);
      saveAutoSyncSettings(autoSyncToggle.checked, intervalMin);
      if (autoSyncToggle.checked) {
        // This click IS a direct user gesture, so an interactive consent
        // popup is allowed here if needed -- establishes the session that
        // subsequent silent background ticks can then reuse.
        runSync(false, { auto: false });
        startAutoSync(intervalMin);
        log(`Auto-sync enabled -- syncing every ${intervalMin} minute(s)`, 'ok');
      } else {
        stopAutoSync();
        log('Auto-sync disabled', 'skip');
      }
    });

    autoSyncInterval.addEventListener('change', () => {
      const intervalMin = Number(autoSyncInterval.value);
      saveAutoSyncSettings(autoSyncToggle.checked, intervalMin);
      if (autoSyncToggle.checked) startAutoSync(intervalMin);
    });

    // ---- Backup / maintenance (unchanged from v2) ----

    panel.querySelector('#wsei-export').addEventListener('click', async () => {
      const all = await WSTSpatialStorage.getAllEmails();
      const blob = new Blob([JSON.stringify({ exported_at: new Date().toISOString(), emails: all })], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `wst-spatial-email-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      log(`Exported ${all.length} email(s) to a backup file`, 'ok');
    });

    panel.querySelector('#wsei-import-backup').addEventListener('click', () => backupInput.click());
    backupInput.addEventListener('change', async () => {
      const file = backupInput.files[0];
      backupInput.value = '';
      if (!file) return;
      try {
        const parsed = JSON.parse(await file.text());
        const emails = Array.isArray(parsed) ? parsed : parsed.emails;
        if (!Array.isArray(emails)) { log('That file doesn\u2019t look like a valid backup', 'err'); return; }
        const { inserted, updated } = await WSTSpatialStorage.putEmails(emails);
        log(`✓ Restored backup: ${inserted} new, ${updated} updated`, 'ok');
        await refreshCount();
      } catch (e) {
        log(`Could not read that backup file: ${e.message || e}`, 'err');
      }
    });

    panel.querySelector('#wsei-clear').addEventListener('click', async () => {
      if (!confirm('Delete every stored email from this browser? This cannot be undone (export a backup first if unsure).')) return;
      await WSTSpatialStorage.clearAll();
      log('All stored emails cleared', 'skip');
      await refreshCount();
    });

    panel.querySelector('#wsei-close').addEventListener('click', () => panel.classList.remove('open'));
    btn.addEventListener('click', () => {
      panel.classList.toggle('open');
      if (panel.classList.contains('open')) { refreshCount(); updateGmailStatus(); }
    });

    refreshCount();
    updateGmailStatus();
  }

  injectUI();
  setInterval(injectUI, 2000);
})();
