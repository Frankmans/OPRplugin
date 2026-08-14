// ==UserScript==
// @name         Spatial Nominations Panel (Portal Submission Tracker)
// @namespace    https://github.com/Frankmans/OPRplugin
// @version      2.0.0
// @description  Shows your imported Portal nominations/photos/edits in a panel on the Wayfarer contributions page, classified and matched via a port of bilde2910/OPR-Tools' email parser.
// @author       you
// @match        https://wayfarer.nianticlabs.com/new/nominations*
// @grant        none
// @require      https://raw.githubusercontent.com/Frankmans/OPRplugin/main/opr-email-lib.js
// @require      https://raw.githubusercontent.com/Frankmans/OPRplugin/main/wst-storage.js
// @require      https://raw.githubusercontent.com/Frankmans/OPRplugin/main/wst-business-logic.js
// @run-at       document-idle
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
 * SETUP NOTE ON THE @require LINES ABOVE: see the note in
 * wayfarer-email-importer.user.js -- same deal, all three scripts need to
 * point at wherever you saved opr-email-lib.js / wst-storage.js /
 * wst-business-logic.js (a local file:/// path with "Allow access to file
 * URLs" enabled, or a hosted raw URL like a GitHub Gist).
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
      position:fixed; bottom:20px; right:220px; z-index:9999;
      background:#0a0e0c; color:#3ec6ff; border:1px solid #3ec6ff;
      font-family:monospace; font-size:13px; padding:10px 16px; border-radius:6px;
      cursor:pointer; box-shadow:0 4px 12px rgba(0,0,0,.4);
    }
    #wsnp-btn:hover{ background:#10160f; }
    #wsnp-panel{
      position:fixed; bottom:70px; right:220px; z-index:9999;
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
    #wsnp-filters select{
      flex:1; background:#161d19; color:#d7f5e6; border:1px solid #223026; border-radius:4px;
      padding:5px 6px; font-family:monospace; font-size:11.5px;
    }
    #wsnp-panel button{
      background:#161d19; color:#d7f5e6; border:1px solid #223026; border-radius:4px;
      padding:6px 10px; cursor:pointer; font-family:monospace; font-size:11.5px; margin-right:6px;
    }
    #wsnp-panel button.primary{ background:#00e08a; color:#04140d; border-color:#00e08a; }
    #wsnp-list{ margin-top:8px; }
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
    .wsnp-detail{ font-size:11px; color:#a8c9b8; margin-top:6px; border-top:1px solid #223026; padding-top:6px; display:none; }
    .wsnp-detail.open{ display:block; }
    .wsnp-detail div{ margin-bottom:4px; }
    .wsnp-detail img{ max-width:100%; border-radius:4px; margin-top:4px; }
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
      <h3>Portal Submissions</h3>
      <div class="wsnp-sub" id="wsnp-summary">Loading...</div>
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
      </div>
      <div>
        <button id="wsnp-refresh" class="primary">Refresh</button>
        <button id="wsnp-close">Close</button>
      </div>
      <div id="wsnp-list"></div>
    `;
    document.body.appendChild(panel);

    let allSubmissions = [];
    let unclassifiedCount = 0;

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
      if (s.source) rows.push(`<div><b>Source:</b> ${escapeHtml(s.source)}</div>`);
      return rows.join('');
    }

    function render() {
      const listEl = panel.querySelector('#wsnp-list');
      const query = panel.querySelector('#wsnp-search').value.trim().toLowerCase();
      const typeFilter = panel.querySelector('#wsnp-type-filter').value;
      const statusFilter = panel.querySelector('#wsnp-status-filter').value;
      const filtered = allSubmissions.filter((s) => matchesFilters(s, query, typeFilter, statusFilter));

      if (filtered.length === 0) {
        listEl.innerHTML = `<div class="wsnp-empty">${allSubmissions.length === 0
          ? 'No imported submissions found yet. Use the companion Email Importer script to add some .eml files first.'
          : 'Nothing matches the current search/filters.'}</div>`;
        return;
      }

      listEl.innerHTML = filtered.map((s, i) => {
        const color = STATUS_COLORS[s.status] || '#6b8579';
        const icon = TYPE_ICONS[s.submission_type] || '';
        return `
          <div class="wsnp-row" data-idx="${i}">
            <div class="wsnp-row-top">
              <span class="wsnp-portal" title="${escapeHtml(s.portal)}">${icon} ${escapeHtml(s.portal)}</span>
              <span class="wsnp-badge" style="color:${color};">${escapeHtml((s.status || '').toUpperCase())}</span>
            </div>
            <div class="wsnp-meta">${escapeHtml(s.submission_type || '')} &middot; submitted ${escapeHtml(s.submitted_date || 'unknown date')}</div>
            ${s.notes ? `<div class="wsnp-notes">⚠ ${escapeHtml(s.notes)}</div>` : ''}
            <div class="wsnp-detail">${detailHtml(s)}</div>
          </div>
        `;
      }).join('');

      listEl.querySelectorAll('.wsnp-row').forEach((row) => {
        row.addEventListener('click', () => {
          row.querySelector('.wsnp-detail').classList.toggle('open');
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
        for (const record of stored) {
          const email = new OPREmail.Email(record.headers, record.body);
          let classification;
          try {
            classification = email.classify();
          } catch (e) {
            unclassifiedCount++;
            continue;
          }
          const dateIso = WST.parseEmailDate(email.getFirstHeaderValue('Date', ''));
          classifiedEmails.push({ email, classification, dateIso });
        }

        allSubmissions = WST.search(classifiedEmails);

        const parts = [`${allSubmissions.length} submission(s) from ${stored.length} imported email(s)`];
        if (unclassifiedCount) parts.push(`${unclassifiedCount} email(s) didn't match a known template`);
        summaryEl.textContent = parts.join(' \u2014 ');
      } catch (e) {
        summaryEl.textContent = `Could not load stored emails: ${e.message || e}`;
        allSubmissions = [];
      }
      render();
    }

    btn.addEventListener('click', () => { panel.classList.toggle('open'); if (panel.classList.contains('open')) refresh(); });
    panel.querySelector('#wsnp-close').addEventListener('click', () => panel.classList.remove('open'));
    panel.querySelector('#wsnp-refresh').addEventListener('click', refresh);
    panel.querySelector('#wsnp-search').addEventListener('input', render);
    panel.querySelector('#wsnp-type-filter').addEventListener('change', render);
    panel.querySelector('#wsnp-status-filter').addEventListener('change', render);

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
