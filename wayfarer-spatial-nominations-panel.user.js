// ==UserScript==
// @name         Spatial Nominations Panel (Portal Submission Tracker)
// @namespace    https://github.com/Frankmans/OPRplugin
// @version      2.8.1
// @description  Shows your imported Wayspot nominations/photos/edits in a panel on the Wayfarer contributions page, classified and matched via a port of bilde2910/OPR-Tools' email parser.
// @author       you
// @match        https://wayfarer.nianticlabs.com/new/nominations*
// @grant        none
// @require      https://raw.githubusercontent.com/Frankmans/OPRplugin/refs/heads/main/opr-email-lib.js
// @require      https://raw.githubusercontent.com/Frankmans/OPRplugin/refs/heads/main/wst-storage.js
// @require      https://raw.githubusercontent.com/Frankmans/OPRplugin/refs/heads/main/wst-business-logic.js
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/Frankmans/OPRplugin/refs/heads/main/wayfarer-spatial-nominations-panel.user.js
// @downloadURL  https://raw.githubusercontent.com/Frankmans/OPRplugin/refs/heads/main/wayfarer-spatial-nominations-panel.user.js
// ==/UserScript==

/*
 * Companion to wayfarer-email-importer.user.js. That script's only job is
 * getting raw .eml files into the shared IndexedDB store as parsed-but-
 * unclassified records. THIS script does the actual "search": for every
 * stored email it runs OPREmail.Email#classify() (a port of OPR-Tools'
 * subject-line template matching), then hands the classified set to
 * WST.search() (wst-business-logic.js) -- a direct port of
 * gmail_wayspot_export.py's parsing + matching logic (portal name/photo/
 * coordinate extraction, received<->decided matching, appeal status flips,
 * title-rename reconciliation) -- to build the same submissions list the
 * old Python script used to produce, entirely client-side.
 *
 * Nothing here talks to Gmail directly. If you haven't imported any emails
 * yet, use the Import Emails button from the companion script first.
 *
 * SETUP NOTE ON THE @require LINES ABOVE: they point at this script's own
 * GitHub repo (Frankmans/OPRplugin) for opr-email-lib.js / wst-storage.js /
 * wst-business-logic.js. If you fork/move the repo, update these three URLs
 * (and the matching two in wayfarer-email-importer.user.js) to match.
 */

(function () {
  'use strict';

  const STATUS_COLORS = {
    Pending: '#ffb703',
    Accepted: '#00e08a',
    Rejected: '#ff5d5d',
    Duplicate: '#6b8579',
    Appeal: '#3ec6ff',
  };

  const TYPE_ICONS = {
    Nomination: '📍',
    Photo: '📷',
    Edit: '✏️',
  };

  const STYLE = `
    #wsnp-btn{
      position:fixed; top:80px; right:460px; z-index:9999;
      background:#0a0e0c; color:#3ec6ff; border:1px solid #3ec6ff;
      font-family:monospace; font-size:13px; padding:10px 16px; border-radius:6px;
      cursor:pointer; box-shadow:0 4px 12px rgba(0,0,0,.4);
    }
    #wsnp-btn:hover{ background:#10160f; }
    #wsnp-panel{
      position:fixed; top:130px; right:460px; z-index:9999;
      background:#0a0e0c; color:#d7f5e6; border:1px solid #223026; border-radius:8px;
      font-family:monospace; font-size:12.5px; padding:16px; width:460px; max-height:75vh;
      overflow-y:auto; box-shadow:0 8px 24px rgba(0,0,0,.5); display:none;
    }
    #wsnp-panel.open{ display:block; }
    #wsnp-panel h3{ margin:0 0 4px; font-size:14px; color:#d7f5e6; }
    #wsnp-panel .wsnp-sub{ font-size:11px; color:#6b8579; margin-bottom:10px; }
    #wsnp-panel input[type=text]{
      width:100%; box-sizing:border-box; background:#161d19; color:#d7f5e6;
      border:1px solid #223026; border-radius:4px; padding:6px 8px; font-family:monospace;
      font-size:12px; margin-bottom:8px;
    }
    #wsnp-filters{ display:flex; gap:6px; margin-bottom:8px; }
    #wsnp-stats{ display:flex; flex-wrap:wrap; gap:6px; margin-bottom:8px; }
    .wsnp-unmatched-toggle{
      font-size:11px; color:#ffb703; margin-bottom:8px; cursor:pointer; text-decoration:underline;
    }
    #wsnp-unmatched-list{
      max-height:180px; overflow-y:auto; margin-bottom:8px; border:1px solid #223026;
      border-radius:5px; padding:8px; font-size:10.5px; background:#10160f;
    }
    #wsnp-unmatched-list div.wsnp-unmatched-row{ margin-bottom:6px; padding-bottom:6px; border-bottom:1px solid #223026; }
    #wsnp-unmatched-list div.wsnp-unmatched-row:last-child{ border-bottom:none; margin-bottom:0; padding-bottom:0; }
    #wsnp-unmatched-list .wsnp-unmatched-subject{ color:#d7f5e6; }
    #wsnp-unmatched-list .wsnp-unmatched-meta{ color:#6b8579; }
    #wsnp-unmatched-copy{
      background:#161d19; color:#d7f5e6; border:1px solid #223026; border-radius:4px;
      padding:4px 8px; cursor:pointer; font-family:monospace; font-size:10.5px; margin-bottom:8px;
    }
    .wsnp-stat{
      font-size:10.5px; padding:3px 8px; border-radius:3px; border:1px solid currentColor;
      cursor:pointer; background:#10160f; user-select:none;
    }
    .wsnp-stat.active{ background:currentColor; }
    .wsnp-stat.active span{ color:#0a0e0c; }
    #wsnp-filters select{
      flex:1; background:#161d19; color:#d7f5e6; border:1px solid #223026; border-radius:4px;
      padding:5px 6px; font-family:monospace; font-size:11.5px;
    }
    #wsnp-panel button{
      background:#161d19; color:#d7f5e6; border:1px solid #223026; border-radius:4px;
      padding:6px 10px; cursor:pointer; font-family:monospace; font-size:11.5px; margin-right:6px;
    }
    #wsnp-panel button.primary{ background:#00e08a; color:#04140d; border-color:#00e08a; }
    #wsnp-list{ margin-top:8px; max-height:42vh; overflow-y:auto; overflow-x:hidden; padding-right:4px; }
    .wsnp-row{
      border:1px solid #223026; border-radius:5px; padding:8px 10px; margin-bottom:6px;
      background:#10160f; cursor:pointer;
    }
    .wsnp-row-top{ display:flex; justify-content:space-between; align-items:center; gap:8px; }
    .wsnp-portal{ font-weight:600; color:#d7f5e6; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .wsnp-badge{
      font-size:10px; padding:2px 7px; border-radius:3px; border:1px solid currentColor;
      white-space:nowrap; flex-shrink:0;
    }
    .wsnp-meta{ font-size:10.5px; color:#6b8579; margin-top:3px; }
    .wsnp-notes{ font-size:10.5px; color:#ffb703; margin-top:3px; }
    .wsnp-resolve{ display:flex; gap:6px; margin-top:4px; }
    .wsnp-resolve select{
      flex:1; background:#161d19; color:#d7f5e6; border:1px solid #223026; border-radius:4px;
      padding:4px 6px; font-family:monospace; font-size:10.5px;
    }
    .wsnp-resolve button{
      background:#161d19; color:#3ec6ff; border:1px solid #3ec6ff; border-radius:4px;
      padding:4px 8px; cursor:pointer; font-family:monospace; font-size:10.5px; margin:0;
    }
    .wsnp-detail{ font-size:11px; color:#a8c9b8; margin-top:6px; border-top:1px solid #223026; padding-top:6px; display:none; }
    .wsnp-detail.open{ display:block; }
    .wsnp-detail div{ margin-bottom:4px; }
    .wsnp-detail img{ max-width:100%; border-radius:4px; margin-top:4px; }
    .wsnp-note-wrap{ margin-top:6px; }
    .wsnp-note-wrap label{ font-size:10px; color:#6b8579; display:block; margin-bottom:3px; }
    .wsnp-note-input{
      width:100%; box-sizing:border-box; background:#161d19; color:#d7f5e6;
      border:1px solid #223026; border-radius:4px; padding:6px 8px; font-family:monospace;
      font-size:11px; resize:vertical; min-height:40px;
    }
    .wsnp-note-saved{ font-size:10px; color:#00e08a; margin-top:2px; display:none; }
    .wsnp-note-saved.show{ display:block; }
    .wsnp-empty{ color:#6b8579; font-size:12px; padding:12px 0; }
  `;

  function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function injectUI() {
    if (document.getElementById('wsnp-btn')) return;

    const style = document.createElement('style');
    style.textContent = STYLE;
    document.head.appendChild(style);

    const btn = document.createElement('button');
    btn.id = 'wsnp-btn';
    btn.textContent = '🛰 Submissions';
    document.body.appendChild(btn);

    const panel = document.createElement('div');
    panel.id = 'wsnp-panel';
    panel.innerHTML = `
      <h3>Wayspot Submissions</h3>
      <div class="wsnp-sub" id="wsnp-summary">Loading...</div>
      <div class="wsnp-unmatched-toggle" id="wsnp-unmatched-toggle" style="display:none;"></div>
      <div id="wsnp-unmatched-list" style="display:none;"></div>
      <div id="wsnp-stats"></div>
      <input type="text" id="wsnp-search" placeholder="Search by portal name...">
      <div id="wsnp-filters">
        <select id="wsnp-type-filter">
          <option value="">All types</option>
          <option value="Nomination">Nominations</option>
          <option value="Photo">Photos</option>
          <option value="Edit">Edits</option>
        </select>
        <select id="wsnp-status-filter">
          <option value="">All statuses</option>
          <option value="Pending">Pending</option>
          <option value="Accepted">Accepted</option>
          <option value="Rejected">Rejected</option>
          <option value="Appeal">Appeal</option>
        </select>
        <select id="wsnp-sort-order">
          <option value="newest">Newest first</option>
          <option value="oldest">Oldest first</option>
        </select>
      </div>
      <div>
        <button id="wsnp-refresh" class="primary">Refresh</button>
        <button id="wsnp-close">Close</button>
      </div>
      <div id="wsnp-list"></div>
    `;
    document.body.appendChild(panel);

    let allSubmissions = [];
    let rawSubmissions = []; // Spatial-filtered results before manual overrides are applied
    let unclassifiedCount = 0;
    let unclassifiedEmails = []; // { subject, from, date, id }

    const MANUAL_OVERRIDES_KEY = 'wsnp_manual_overrides';

    // Stable-ish identity for a submission across refreshes, used to attach
    // manual review decisions to a specific orphaned entry.
    function entryKey(s) {
      return `${s.submission_type}|${s.portal.toLowerCase()}|${s.submitted_date}`;
    }

    function loadOverrides() {
      try {
        const raw = localStorage.getItem(MANUAL_OVERRIDES_KEY);
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed : [];
      } catch (e) {
        return [];
      }
    }

    function saveOverrides(list) {
      try { localStorage.setItem(MANUAL_OVERRIDES_KEY, JSON.stringify(list)); } catch (e) { /* non-fatal */ }
    }

    // Applies saved manual-review decisions to a fresh submissions list.
    // 'dismiss' just clears the review warning (this really is its own
    // entry). 'merge' copies the orphan's status onto the chosen target and
    // drops the orphan row. Overrides whose orphan no longer exists in the
    // current data (e.g. it got auto-matched after a logic fix) are pruned
    // and not re-saved.
    function applyOverrides(list) {
      const overrides = loadOverrides();
      const working = list.map((s) => ({ ...s }));
      const byKey = new Map(working.map((s) => [entryKey(s), s]));
      const toRemove = new Set();
      const stillValid = [];

      for (const ov of overrides) {
        const orphan = byKey.get(ov.orphanKey);
        if (!orphan) continue; // stale -- drop silently
        stillValid.push(ov);
        if (ov.action === 'dismiss') {
          delete orphan.notes;
        } else if (ov.action === 'merge') {
          const target = ov.targetKey ? byKey.get(ov.targetKey) : null;
          if (target && target !== orphan) {
            target.status = orphan.status;
            toRemove.add(orphan);
          } else {
            // Target vanished (e.g. renamed again) -- fall back to just
            // clearing the warning rather than losing the row entirely.
            delete orphan.notes;
          }
        }
      }

      if (stillValid.length !== overrides.length) saveOverrides(stillValid);
      return working.filter((s) => !toRemove.has(s));
    }

    function saveOverrideAndRerender(override) {
      const overrides = loadOverrides().filter((ov) => ov.orphanKey !== override.orphanKey);
      overrides.push(override);
      saveOverrides(overrides);
      allSubmissions = applyOverrides(rawSubmissions);
      render();
    }

    const USER_NOTES_KEY = 'wsnp_user_notes';

    function loadUserNotes() {
      try {
        const raw = localStorage.getItem(USER_NOTES_KEY);
        const parsed = raw ? JSON.parse(raw) : {};
        return parsed && typeof parsed === 'object' ? parsed : {};
      } catch (e) {
        return {};
      }
    }

    function saveUserNote(key, text) {
      const notes = loadUserNotes();
      if (text.trim()) notes[key] = text;
      else delete notes[key];
      try { localStorage.setItem(USER_NOTES_KEY, JSON.stringify(notes)); } catch (e) { /* non-fatal */ }
    }

    function matchesFilters(s, query, typeFilter, statusFilter) {
      if (typeFilter && s.submission_type !== typeFilter) return false;
      if (statusFilter && s.status !== statusFilter) return false;
      if (query && !s.portal.toLowerCase().includes(query)) return false;
      return true;
    }

    function detailHtml(s) {
      const rows = [];
      if (s.edit_field) rows.push(`<div><b>Field:</b> ${escapeHtml(s.edit_field)}</div>`);
      if (s.submission_text) rows.push(`<div>${escapeHtml(s.submission_text)}</div>`);
      if (s.supporting_text) rows.push(`<div>${escapeHtml(s.supporting_text)}</div>`);
      if (s.extra_text && s.extra_text.length) rows.push(`<div>${s.extra_text.map(escapeHtml).join('<br>')}</div>`);
      if (s.latitude && s.longitude) rows.push(`<div>📍 ${escapeHtml(s.latitude)}, ${escapeHtml(s.longitude)}</div>`);
      if (s.submission_photo_url) rows.push(`<img src="${escapeHtml(s.submission_photo_url)}" alt="Submission photo">`);
      if (s.supporting_photo_url) rows.push(`<img src="${escapeHtml(s.supporting_photo_url)}" alt="Supporting photo">`);
      if (s.related_legacy && s.related_legacy.length) {
        rows.push(`<div>🔗 <b>Also nominated via:</b></div>`);
        for (const r of s.related_legacy) {
          rows.push(`<div>&nbsp;&nbsp;${escapeHtml(r.source)} ${escapeHtml(r.submission_type)} \u2014 submitted ${escapeHtml(r.submitted_date || 'unknown date')}, ${escapeHtml(r.status)}</div>`);
        }
      }
      return rows.join('');
    }

    function renderStats() {
      const statsEl = panel.querySelector('#wsnp-stats');
      const query = panel.querySelector('#wsnp-search').value.trim().toLowerCase();
      const typeFilter = panel.querySelector('#wsnp-type-filter').value;
      const activeStatus = panel.querySelector('#wsnp-status-filter').value;

      // Counts ignore the status filter itself (so switching statuses doesn't
      // change the other totals out from under you), but do respect the
      // type filter and search box.
      const inScope = allSubmissions.filter((s) => matchesFilters(s, query, typeFilter, ''));
      const counts = {};
      for (const s of inScope) counts[s.status] = (counts[s.status] || 0) + 1;

      const statuses = ['Pending', 'Accepted', 'Rejected', 'Appeal', 'Duplicate'].filter((st) => counts[st]);
      const chips = [`<div class="wsnp-stat${activeStatus === '' ? ' active' : ''}" data-status="" style="color:#d7f5e6;"><span>Total: ${inScope.length}</span></div>`];
      for (const st of statuses) {
        const color = STATUS_COLORS[st] || '#6b8579';
        chips.push(`<div class="wsnp-stat${activeStatus === st ? ' active' : ''}" data-status="${st}" style="color:${color};"><span>${st}: ${counts[st]}</span></div>`);
      }
      statsEl.innerHTML = chips.join('');

      statsEl.querySelectorAll('.wsnp-stat').forEach((chip) => {
        chip.addEventListener('click', () => {
          panel.querySelector('#wsnp-status-filter').value = chip.dataset.status;
          render();
        });
      });
    }

    function daysPending(submittedDate) {
      if (!submittedDate) return null;
      const submitted = new Date(submittedDate + 'T00:00:00Z').getTime();
      if (isNaN(submitted)) return null;
      return Math.max(0, Math.floor((Date.now() - submitted) / 86400000));
    }

    function daysPendingColor(days) {
      if (days >= 90) return '#ff5d5d';
      if (days >= 30) return '#ffb703';
      return '#6b8579';
    }

    function resolveOptionsHtml(s) {
      const selfKey = entryKey(s);
      return allSubmissions
        .filter((c) => c.submission_type === s.submission_type && entryKey(c) !== selfKey)
        .sort((a, b) => a.portal.localeCompare(b.portal))
        .map((c) => `<option value="${escapeHtml(entryKey(c))}">${escapeHtml(c.portal)} (${escapeHtml(c.submitted_date || 'unknown date')}, ${escapeHtml(c.status)})</option>`)
        .join('');
    }

    function render() {
      const listEl = panel.querySelector('#wsnp-list');
      const query = panel.querySelector('#wsnp-search').value.trim().toLowerCase();
      const typeFilter = panel.querySelector('#wsnp-type-filter').value;
      const statusFilter = panel.querySelector('#wsnp-status-filter').value;
      const sortOrder = panel.querySelector('#wsnp-sort-order').value;
      const filtered = allSubmissions.filter((s) => matchesFilters(s, query, typeFilter, statusFilter));
      const displayList = [...filtered].sort((a, b) => {
        const cmp = (a.submitted_date || '').localeCompare(b.submitted_date || '');
        return sortOrder === 'oldest' ? cmp : -cmp;
      });

      renderStats();

      if (displayList.length === 0) {
        listEl.innerHTML = `<div class="wsnp-empty">${allSubmissions.length === 0
          ? 'No imported submissions found yet. Use the companion Email Importer script to add some .eml files first.'
          : 'Nothing matches the current search/filters.'}</div>`;
        return;
      }

      const userNotes = loadUserNotes();

      listEl.innerHTML = displayList.map((s, i) => {
        const color = STATUS_COLORS[s.status] || '#6b8579';
        const icon = TYPE_ICONS[s.submission_type] || '';
        const days = s.status === 'Pending' ? daysPending(s.submitted_date) : null;
        const daysHtml = days !== null
          ? ` &middot; <span style="color:${daysPendingColor(days)};">⏳ ${days} day${days === 1 ? '' : 's'} pending</span>`
          : '';
        const savedNote = userNotes[entryKey(s)] || '';
        return `
          <div class="wsnp-row" data-idx="${i}">
            <div class="wsnp-row-top">
              <span class="wsnp-portal" title="${escapeHtml(s.portal)}">${icon} ${escapeHtml(s.portal)}${s.related_legacy && s.related_legacy.length ? ' 🔗' : ''} <span class="wsnp-note-badge">${savedNote ? '📝' : ''}</span></span>
              <span class="wsnp-badge" style="color:${color};">${escapeHtml((s.status || '').toUpperCase())}</span>
            </div>
            <div class="wsnp-meta">${escapeHtml(s.submission_type || '')} &middot; submitted ${escapeHtml(s.submitted_date || 'unknown date')}${daysHtml}</div>
            ${s.notes ? `
              <div class="wsnp-notes">⚠ ${escapeHtml(s.notes)}</div>
              <div class="wsnp-resolve">
                <select class="wsnp-resolve-select">
                  <option value="">This is a separate submission -- keep it</option>
                  ${resolveOptionsHtml(s)}
                </select>
                <button class="wsnp-resolve-confirm">Resolve</button>
              </div>
            ` : ''}
            <div class="wsnp-detail">
              ${detailHtml(s)}
              <div class="wsnp-note-wrap">
                <label>Your note</label>
                <textarea class="wsnp-note-input" placeholder="e.g. resubmit with a better photo...">${escapeHtml(savedNote)}</textarea>
                <div class="wsnp-note-saved">Saved</div>
              </div>
            </div>
          </div>
        `;
      }).join('');

      listEl.querySelectorAll('.wsnp-row').forEach((row) => {
        row.addEventListener('click', () => {
          row.querySelector('.wsnp-detail').classList.toggle('open');
        });
      });

      listEl.querySelectorAll('.wsnp-resolve-select, .wsnp-resolve-confirm').forEach((el) => {
        el.addEventListener('click', (e) => e.stopPropagation());
      });
      listEl.querySelectorAll('.wsnp-resolve-confirm').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const row = btn.closest('.wsnp-row');
          const idx = Number(row.dataset.idx);
          const s = displayList[idx];
          const select = row.querySelector('.wsnp-resolve-select');
          const targetKey = select.value;
          const override = targetKey
            ? { orphanKey: entryKey(s), action: 'merge', targetKey }
            : { orphanKey: entryKey(s), action: 'dismiss' };
          saveOverrideAndRerender(override);
        });
      });

      listEl.querySelectorAll('.wsnp-note-input').forEach((textarea) => {
        textarea.addEventListener('click', (e) => e.stopPropagation());
        textarea.addEventListener('blur', () => {
          const row = textarea.closest('.wsnp-row');
          const idx = Number(row.dataset.idx);
          const s = displayList[idx];
          saveUserNote(entryKey(s), textarea.value);

          row.querySelector('.wsnp-note-badge').textContent = textarea.value.trim() ? '📝' : '';

          const savedEl = row.querySelector('.wsnp-note-saved');
          savedEl.classList.add('show');
          clearTimeout(savedEl._hideTimer);
          savedEl._hideTimer = setTimeout(() => savedEl.classList.remove('show'), 1500);
        });
      });
    }

    async function refresh() {
      const summaryEl = panel.querySelector('#wsnp-summary');
      summaryEl.textContent = 'Loading and classifying stored emails...';
      try {
        const stored = await WSTStorage.getAllEmails();
        const classifiedEmails = [];
        unclassifiedCount = 0;
        unclassifiedEmails = [];
        for (const record of stored) {
          const email = new OPREmail.Email(record.headers, record.body);
          let classification;
          try {
            classification = email.classify();
          } catch (e) {
            unclassifiedCount++;
            unclassifiedEmails.push({
              subject: email.getFirstHeaderValue('Subject', '(no subject)'),
              from: email.getFirstHeaderValue('From', '(unknown sender)'),
              date: email.getFirstHeaderValue('Date', '(unknown date)'),
              id: record.id,
            });
            continue;
          }
          const dateIso = WST.parseEmailDate(email.getFirstHeaderValue('Date', ''));
          classifiedEmails.push({ email, classification, dateIso });
        }

        const allEraSubmissions = WST.search(classifiedEmails);
        const legacyByPortal = new Map();
        for (const s of allEraSubmissions) {
          if (s.source === 'Spatial') continue;
          const key = s.portal.toLowerCase();
          if (!legacyByPortal.has(key)) legacyByPortal.set(key, []);
          legacyByPortal.get(key).push(s);
        }
        const legacyCount = allEraSubmissions.length - allEraSubmissions.filter((s) => s.source === 'Spatial').length;
        rawSubmissions = allEraSubmissions
          .filter((s) => s.source === 'Spatial')
          .map((s) => {
            const related = legacyByPortal.get(s.portal.toLowerCase());
            if (!related || !related.length) return s;
            return {
              ...s,
              related_legacy: related.map((r) => ({
                source: r.source, submitted_date: r.submitted_date, status: r.status, submission_type: r.submission_type,
              })),
            };
          });
        allSubmissions = applyOverrides(rawSubmissions);

        const parts = [`${allSubmissions.length} submission(s) from ${stored.length} imported email(s)`];
        if (legacyCount) parts.push(`${legacyCount} legacy Wayfarer/OPR submission(s) hidden (already visible in Wayfarer)`);
        summaryEl.textContent = parts.join(' \u2014 ');

        const unmatchedEl = panel.querySelector('#wsnp-unmatched-toggle');
        const unmatchedListEl = panel.querySelector('#wsnp-unmatched-list');
        if (unclassifiedCount) {
          unmatchedEl.textContent = `⚠ ${unclassifiedCount} email(s) didn't match a known template (click to view)`;
          unmatchedEl.style.display = '';
          if (unmatchedListEl.style.display !== 'none') renderUnmatchedList();
        } else {
          unmatchedEl.style.display = 'none';
          unmatchedListEl.style.display = 'none';
        }
      } catch (e) {
        summaryEl.textContent = `Could not load stored emails: ${e.message || e}`;
        allSubmissions = [];
      }
      render();
    }

    function renderUnmatchedList() {
      const listEl = panel.querySelector('#wsnp-unmatched-list');
      const rows = unclassifiedEmails.map((e) => `
        <div class="wsnp-unmatched-row">
          <div class="wsnp-unmatched-subject">${escapeHtml(e.subject)}</div>
          <div class="wsnp-unmatched-meta">${escapeHtml(e.from)} &middot; ${escapeHtml(e.date)}</div>
        </div>
      `).join('');
      listEl.innerHTML = `
        <button id="wsnp-unmatched-copy">Copy all subject lines</button>
        ${rows}
      `;
      listEl.querySelector('#wsnp-unmatched-copy').addEventListener('click', () => {
        const text = unclassifiedEmails.map((e) => `${e.subject}  [${e.from}, ${e.date}]`).join('\n');
        navigator.clipboard.writeText(text).then(
          () => { listEl.querySelector('#wsnp-unmatched-copy').textContent = 'Copied!'; },
          () => { listEl.querySelector('#wsnp-unmatched-copy').textContent = 'Could not copy -- select the text manually'; }
        );
      });
    }

    panel.querySelector('#wsnp-unmatched-toggle').addEventListener('click', () => {
      const listEl = panel.querySelector('#wsnp-unmatched-list');
      const showing = listEl.style.display !== 'none';
      if (showing) {
        listEl.style.display = 'none';
      } else {
        renderUnmatchedList();
        listEl.style.display = '';
      }
    });

    btn.addEventListener('click', () => { panel.classList.toggle('open'); if (panel.classList.contains('open')) refresh(); });
    panel.querySelector('#wsnp-close').addEventListener('click', () => panel.classList.remove('open'));
    panel.querySelector('#wsnp-refresh').addEventListener('click', refresh);
    panel.querySelector('#wsnp-search').addEventListener('input', render);
    panel.querySelector('#wsnp-type-filter').addEventListener('change', render);
    panel.querySelector('#wsnp-status-filter').addEventListener('change', render);
    panel.querySelector('#wsnp-sort-order').addEventListener('change', render);

    refresh();
  }

  // The nominations page is an Angular SPA route -- if you navigate to it
  // via in-app client-side routing (not a full page load), document-idle
  // may fire before this URL is actually current, or the script may not
  // re-run at all depending on how Tampermonkey handles the route change.
  // Re-checking on a short interval is a blunt but reliable way to recover
  // from that, since injectUI() is a no-op once the panel already exists.
  injectUI();
  setInterval(injectUI, 2000);
})();
